import { normalizeUsage } from '@agentome/costs';
import { RUN_CANCELLED_CODE } from '@agentome/shared';
import type { RunEvent } from '@agentome/shared';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { probe, runClaude } from './claude/launcher.js';
import { type CodexBilling, probeCodex, runCodex } from './codex/launcher.js';
import type { ClaudeBilling, ClaudeRunOutcome, RunEventSink } from './claude/launcher.js';
import { backoff, isRetryable, sleep, Unauthorized } from './client.js';
import type { Artifact, FinishBody, LaunchPackage, SeatClient, WireEvent } from './client.js';
import { describe } from './config.js';
import type { Log } from './config.js';
import { branchArtifact, platformHosts, prepareWorkspace, removeRun } from './workspace.js';
import type { Workspace } from './workspace.js';
import { unsandboxed } from './platform.js';

// One run, from the launch package to finish. However it ends, the server hears it twice and the
// same way — a terminal event in the transcript and the status of finish: `runClaude`
// sees to that for the CLI, this file for the workspace around it.

/** Events go out once a second, or as soon as this many are waiting. */
const BATCH = 50;
/** What `summary` and the report may hold. */
const MAX_TEXT = 20_000;

export interface RunDeps {
  client: SeatClient;
  home: string;
  keepWorkspace: boolean;
  log: Log;
  /** Fires when the worker stops: the run is cancelled, and still finished. */
  signal: AbortSignal;
  /** `claude` from the PATH by default. */
  cliPath?: string;
  /** `codex` from the PATH by default. */
  codexPath?: string;
  env?: NodeJS.ProcessEnv;
  /** A server seat: the run takes its model connection's key, never a subscription. */
  server?: boolean;
  /** `endMs`: how long the end of a run is retried; after that, the server's reaper closes it. */
  timing?: Partial<Timing>;
}

type Timing = Record<'flushMs' | 'heartbeatMs' | 'endMs', number> & { backoff: typeof backoff };

type Task = NonNullable<LaunchPackage['task']>;
type Failure = { code: string; message: string };
type Outcome = Pick<ClaudeRunOutcome, 'status' | 'resultText'> & { error?: Failure };

export async function executeRun(launch: LaunchPackage, deps: RunDeps): Promise<Outcome['status']> {
  const { client, log } = deps;
  const { id, token } = launch.run;
  // The service gives a stop 60 s: the CLI stops in 5, these 30 and one last finish fit after.
  const timing = { flushMs: 1000, heartbeatMs: 30_000, endMs: 30_000, backoff, ...deps.timing };
  // The run's time limit covers the clone and the CLI together.
  const deadline = Date.now() + launch.run.limits.maxMinutes * 60_000;
  const left = () => Math.min(Math.max(1, deadline - Date.now()), 2 ** 31 - 1);
  const stop = new AbortController();
  const signal = AbortSignal.any([deps.signal, stop.signal]);
  const pending: RunEvent[] = [];
  const usage: RunEvent[] = [];
  let nextSeq = 0;
  /** The server closed the run: nothing more may be written to it. */
  let gone = false;
  let draining = false;
  /** Finish is under way: a token refused from now on is the token finish ended. */
  let finishing = false;

  const cancel = () => {
    if (signal.aborted || draining) return;
    log('info', `run ${id}: cancelled on the server; stopping it`);
    stop.abort();
  };
  const lose = () => {
    if (gone || finishing) return;
    gone = true;
    log('warn', `run ${id}: the server closed this run; stopping it`);
    stop.abort();
  };

  let sending: Promise<boolean> | undefined;
  let failures = 0;
  let retryAt = 0;
  /** Sends the oldest waiting events; false when the server did not take them. */
  const send = async (giveUp?: AbortSignal): Promise<boolean> => {
    const batch = pending.slice(0, BATCH);
    try {
      const answer = await client.events(id, token, batch.map(toWire), giveUp);
      pending.splice(0, batch.length);
      failures = 0;
      if (answer.cancelRequested) cancel();
      return true;
    } catch (error) {
      if (error instanceof Unauthorized) lose();
      else if (!isRetryable(error)) {
        // Sent again it would be refused again, and hold back the rest of the transcript.
        log('error', `run ${id}: the server refused ${batch.length} events (${describe(error)})`);
        pending.splice(0, batch.length);
        return true;
      } else {
        retryAt = Date.now() + timing.backoff(failures++);
        log('warn', `run ${id}: events not delivered (${describe(error)}); retrying`);
      }
      return false;
    }
  };
  // One batch in flight at a time: two would each remove from `pending` what the other sent.
  const flush = (): void => {
    if (sending || draining || gone || pending.length === 0 || Date.now() < retryAt) return;
    sending = send().finally(() => {
      sending = undefined;
      if (pending.length >= BATCH) flush();
    });
  };
  // A server seat's model key reaches the CLI; whatever way it surfaces in the
  // transcript, its owner and the server never see it there.
  const key = launch.model?.key;
  const hidden = <T>(value: T): T =>
    key && key.length >= 8 && JSON.stringify(value).includes(key)
      ? (JSON.parse(JSON.stringify(value).replaceAll(key, '[the model key]')) as T)
      : value;
  const sink: RunEventSink = (given) => {
    const event = hidden(given);
    nextSeq = event.seq + 1;
    pending.push(event);
    if (event.type === 'usage') usage.push(event);
    if (pending.length >= BATCH) flush();
  };
  /** The run's own ending, when the CLI never started or could not tell it. */
  const end = (code: string, message: string): Outcome => {
    sink({ type: 'error', code, message, fatal: true, seq: nextSeq, at: new Date().toISOString() });
    const status = code === RUN_CANCELLED_CODE ? 'cancelled' : 'failed';
    return { status, error: { code, message } };
  };

  /** The agent's commits; a run that is done leaves them in a repository on this computer. */
  const commits = async (ws: Workspace, keep: boolean): Promise<Artifact | undefined> => {
    try {
      const { artifact, failure } = await branchArtifact(ws, id, keep);
      if (failure !== undefined) {
        const message = `The agent's commits could not be kept in ${ws.remote?.url ?? ws.local}: ${failure}`;
        const at = new Date().toISOString();
        sink({ type: 'error', code: 'push_failed', message, fatal: false, seq: nextSeq, at });
      }
      return artifact;
    } catch (error) {
      log('warn', `run ${id}: its commits could not be read (${describe(error)})`);
      return undefined;
    }
  };

  // How long the run has stood waiting for its owner, as the server counts it: the engine's
  // time limit moves by it.
  let waitedMs = 0;
  let beating = false;
  const heartbeat = setInterval(() => {
    if (beating || gone) return;
    beating = true;
    client
      .heartbeat(id, token)
      .then((answer) => {
        waitedMs = answer.waitedMs;
        return answer.cancelRequested && cancel();
      })
      .catch((error: unknown) => {
        if (error instanceof Unauthorized) lose();
        else log('warn', `run ${id}: heartbeat failed (${describe(error)})`);
      })
      .finally(() => (beating = false));
  }, timing.heartbeatMs);
  const ticker = setInterval(flush, timing.flushMs);

  let workspace: Workspace | undefined;
  let outcome: Outcome;
  try {
    if (launch.task === null) {
      outcome = end('no_task', 'This run has no task, and this worker runs only tasks.');
    } else {
      const seat = { signal, timeout: left(), server: deps.server === true };
      workspace = await prepareWorkspace(deps.home, launch, seat);
      // The agent's engine runs it: Claude Code, or Codex.
      const engine = launch.agent.engine === 'codex' ? codex : claude;
      const waited = () => waitedMs;
      outcome = await engine(launch, launch.task, workspace, left(), sink, signal, deps, waited);
    }
  } catch (error) {
    if (signal.aborted) outcome = end(RUN_CANCELLED_CODE, 'The run was cancelled.');
    else outcome = end(workspace ? 'worker_error' : 'workspace_failed', describe(error));
  }
  clearInterval(ticker);

  try {
    // Before the folder goes, and before the transcript is closed: a failed push goes into it.
    const branch =
      workspace && !gone ? await commits(workspace, outcome.status === 'done') : undefined;
    const giveUp = AbortSignal.timeout(timing.endMs);
    draining = true;
    await sending;
    for (let attempt = 0; pending.length > 0 && !gone;) {
      if (await send(giveUp)) continue;
      if (gone || !(await sleep(timing.backoff(attempt++), giveUp))) break;
    }
    if (pending.length > 0 && !gone) log('error', `run ${id}: ${pending.length} events were lost`);
    finishing = !gone;
    for (let attempt = 0; finishing; attempt++) {
      try {
        const provider = launch.agent.engine === 'codex' ? 'openai' : 'anthropic';
        const body = hidden(finishBody(outcome, normalizeUsage(usage, provider), branch));
        await client.finish(id, token, body, attempt === 0 ? undefined : giveUp);
        break;
      } catch (error) {
        const final = error instanceof Unauthorized || !isRetryable(error);
        if (final || !(await sleep(timing.backoff(attempt), giveUp))) {
          log('error', `run ${id}: the server did not take its finish (${describe(error)})`);
          break;
        }
      }
    }
  } finally {
    clearInterval(heartbeat);
    if (!deps.keepWorkspace) {
      try {
        removeRun(deps.home, id, deps.env ?? process.env);
      } catch (error) {
        log('error', `run ${id}: its folder could not be removed (${describe(error)})`);
      }
    }
  }
  return outcome.status;
}

async function claude(
  launch: LaunchPackage,
  task: Task,
  workspace: Workspace,
  timeoutMs: number,
  sink: RunEventSink,
  signal: AbortSignal,
  deps: RunDeps,
  waitedMs: () => number,
): Promise<ClaudeRunOutcome> {
  const env = deps.env ?? process.env;
  // A computer is its owner's subscription: a key in the environment would bill the
  // person's own account, a personal credential, so the launcher keeps it from the CLI,
  // and a key the server sent is never used there. A server seat uses the key it was sent and
  // nothing else.
  const billing = billingOf(launch, deps.server === true);
  const found = await probe({ cliPath: deps.cliPath, env });
  const version = found.version ?? 'not found';
  const unused = found.billing === 'api' ? '; the API key in the environment is not used' : '';
  const paid =
    billing.mode === 'subscription' ? `the subscription${unused}` : 'its model connection';
  deps.log('info', `run ${launch.run.id}: Claude Code ${version}, ${paid}`);
  const { allowedTools, permissionMode } = launch.workspace.profile.settings;
  const { maxTurns, maxTokens } = launch.run.limits;
  const model = launch.agent.modelPref || undefined;
  const options = {
    cwd: workspace.repo,
    profileDir: workspace.profile,
    mcpConfig: workspace.mcpConfig,
    agents: workspace.agents,
    prompt: promptOf(task),
  };
  const limits = { timeoutMs, maxTurns, maxTokens, waitedMs };
  const run = { ...options, model, allowedTools, permissionMode, limits, billing, env };
  return runClaude({ ...run, cliPath: deps.cliPath }, sink, signal);
}

async function codex(
  launch: LaunchPackage,
  task: Task,
  workspace: Workspace,
  timeoutMs: number,
  sink: RunEventSink,
  signal: AbortSignal,
  deps: RunDeps,
  waitedMs: () => number,
): Promise<ClaudeRunOutcome> {
  const env = deps.env ?? process.env;
  const server = deps.server === true;
  const model = launch.model;
  // A computer is its owner's ChatGPT sign-in; a server seat the connection it was sent.
  const billing: CodexBilling = !server
    ? { mode: 'subscription' }
    : { mode: 'provider', baseUrl: model?.baseUrl ?? '', key: model?.key ?? '' };
  const found = await probeCodex({ cliPath: deps.codexPath, env });
  const paid = server ? 'its model connection' : 'the ChatGPT sign-in';
  deps.log(
    'info',
    `run ${launch.run.id}: Codex ${found.installed ? found.version : 'not found'}, ${paid}`,
  );
  // The profile the worker wrote for Claude Code is the agent's text for Codex too; Codex has no
  // folder beside it, so it is told where that folder is.
  const profile = readFileSync(join(workspace.profile, 'CLAUDE.md'), 'utf8');
  const instructions = `${profile}\nYour profile folder, where this text says "beside this file", is ${workspace.profile}.\n`;
  const { allowedTools } = launch.workspace.profile.settings;
  return runCodex(
    {
      cwd: workspace.repo,
      prompt: promptOf(task),
      instructions,
      ...(launch.workspace.mcp && {
        mcp: { url: launch.workspace.mcp.url, token: launch.run.token },
      }),
      model: launch.agent.modelPref || undefined,
      shell: allowedTools.includes('Bash'),
      server,
      unsandboxed: !server && unsandboxed(),
      // What the agent's commands may read beside its clone, and where its git pushes.
      ...(!server && {
        sandbox: {
          readable: [workspace.profile, ...(workspace.remote ? [workspace.remote.file] : [])],
          hosts: platformHosts(launch.workspace.profile.settings.sandbox),
        },
      }),
      limits: { timeoutMs, maxTokens: launch.run.limits.maxTokens, waitedMs },
      billing,
      cliPath: deps.codexPath,
      env,
    },
    sink,
    signal,
  );
}

/**
 * Who pays for a run. On a server seat, the connection the server sent, or nothing to run with:
 * the launcher then refuses the run, which fails with that reason.
 */
function billingOf(launch: LaunchPackage, server: boolean): ClaudeBilling {
  if (!server) return { mode: 'subscription' };
  const model = launch.model;
  if (!model) return { mode: 'gateway', baseUrl: '', token: '' };
  return model.kind === 'anthropic' && model.baseUrl === 'https://api.anthropic.com'
    ? { mode: 'api', apiKey: model.key }
    : { mode: 'gateway', baseUrl: model.baseUrl, token: model.key };
}

function promptOf(task: Task): string {
  const where =
    task.repository === null
      ? 'There is no repository for this task: the working directory is a new, empty git repository.'
      : `The working directory is a clone of ${task.repository}.`;
  return `${[`# ${task.title}`, task.body.trim(), where].filter((part) => part !== '').join('\n\n')}\n`;
}

function finishBody(outcome: Outcome, usage: FinishBody['usage'], branch?: Artifact): FinishBody {
  const text = outcome.resultText?.trim() ? outcome.resultText.slice(0, MAX_TEXT) : undefined;
  const summary = text ?? outcome.error?.message.slice(0, MAX_TEXT);
  const artifacts: Artifact[] = [];
  if (text !== undefined) artifacts.push({ kind: 'report', ref: 'result', meta: { text } });
  if (branch !== undefined) artifacts.push(branch);
  return {
    status: outcome.status,
    ...(summary ? { summary } : {}),
    ...(outcome.error ? { errorCode: outcome.error.code.slice(0, 64) } : {}),
    artifacts,
    usage,
  };
}

/** `seq`, `type` and `at` on their own, every other field in `payload`. */
function toWire({ seq, type, at, ...payload }: RunEvent): WireEvent {
  return { seq, type, at, payload };
}
