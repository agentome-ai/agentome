import { normalizeUsage } from '@agentome/costs';
import { RUN_CANCELLED_CODE } from '@agentome/shared';
import type { RunEvent } from '@agentome/shared';

import type { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { probe, runClaude } from './claude/launcher.js';
import { type CodexBilling, probeCodex, runCodex } from './codex/launcher.js';
import type { ClaudeBilling, ClaudeRunOutcome, RunEventSink } from './claude/launcher.js';
import { backoff, isRetryable, sleep, Unauthorized } from './client.js';
import type { Artifact, FinishBody, LaunchPackage, SeatClient, WireEvent } from './client.js';
import { describe } from './config.js';
import type { Log } from './config.js';
import {
  branchArtifact,
  foreignHost,
  gitAtServer,
  platformHosts,
  prepareWorkspace,
  removeRun,
} from './workspace.js';
import type { Workspace } from './workspace.js';
import { cliCommand, unsandboxed } from './platform.js';
import { CLI_EXEC_PORT, EXEC_PORT, remoteSpawn, serverReady, tunnelReady } from './remote.js';
import { readySignIn } from './sign-in.js';

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
  /** A person's place on the server: an agent's folder for a repository stays between runs. */
  place?: boolean;
  /** `endMs`: how long the end of a run is retried; after that, the server's reaper closes it. */
  timing?: Partial<Timing>;
  /**
   * In a person's place, where the run's CLI runs in a container of its own: the
   * place's home, whose sign-in folders the run's container mounts. Without it, the CLI runs here.
   */
  signInHome?: string;
  /** Set for the run by `executeRun`: how the CLI is started in the run's container. */
  spawn?: typeof spawn;
  /** Set for the run by `executeRun`: its CLI container's way out and where its sandbox is. */
  split?: Split;
  /** A Codex run in a place: its executor's address, on its CLI container's loopback. */
  execServer?: string;
  /** With `execServer`: the environment a command gets in the run's sandbox. */
  commandEnv?: Record<string, string>;
  /** How this worker's own CLI is started, for its check before a Codex run; the running one by default. */
  self?: string[];
}

type Timing = Record<'flushMs' | 'heartbeatMs' | 'endMs', number> & { backoff: typeof backoff };

type Task = NonNullable<LaunchPackage['task']>;
type Failure = { code: string; message: string };
type Outcome = Pick<ClaudeRunOutcome, 'status' | 'resultText'> & { error?: Failure };

/** A Codex run in a place whose check before the run failed: it does not start. */
class CanaryRefused extends Error {}

export async function executeRun(launch: LaunchPackage, deps: RunDeps): Promise<Outcome['status']> {
  const { client, log } = deps;
  const { id } = launch.run;
  // Who reports the run: in a person's place, the place by its seat's token, since the
  // run's own token is the agent's to hold in its container; elsewhere, the run's token.
  const inContainer = deps.place === true && deps.signInHome !== undefined;
  const token = inContainer ? client.seatToken : launch.run.token;
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
  /** Whether the run has a container of its own to delete at its end. */
  let container = false;
  try {
    // A server seat and a place take the server's word; a computer, only for its own server.
    const strange =
      deps.server === true || deps.place === true
        ? undefined
        : foreignHost(launch, client.serverUrl);
    if (launch.task === null) {
      outcome = end('no_task', 'This run has no task, and this worker runs only tasks.');
    } else if (strange !== undefined) {
      outcome = end('untrusted_launch', strange);
    } else {
      const seat = {
        signal,
        timeout: left(),
        server: deps.server === true,
        place: deps.place === true,
      };
      const local = deps.server === true || deps.place === true;
      workspace = await prepareWorkspace(
        deps.home,
        local ? gitAtServer(launch, client.serverUrl) : launch,
        seat,
      );
      if (workspace.leftover) {
        const message = `What the last run left uncommitted in this folder is saved on ${workspace.leftover}.`;
        sink({
          type: 'error',
          code: 'leftover_saved',
          message,
          fatal: false,
          seq: nextSeq,
          at: new Date().toISOString(),
        });
      }
      // The agent's engine runs it: Claude Code, or Codex.
      const engine = launch.agent.engine === 'codex' ? codex : claude;
      const waited = () => waitedMs;
      let engineDeps = deps;
      if (inContainer && deps.signInHome) {
        // The run's own container: the CLI and what it starts run there, with this run's folders
        // and the sign-in, and go with it at the end.
        readySignIn(deps.signInHome, (text) => log('info', `run ${id}: ${text}`));
        const folder = relative(deps.home, workspace.repo).split(sep).join('/');
        // What the sandbox mounts of the run's folder, made for a run without a git proxy, or with a
        // folder of its agent's, too: a mount needs its folder.
        for (const name of ['git', 'repo'])
          mkdirSync(join(workspace.dir, name), { recursive: true });
        const at = await client.startContainer(
          id,
          folder.startsWith('folders/') ? folder : undefined,
          signal,
        );
        container = true;
        await serverReady(at.cli);
        // The CLI container's bash and git pass every command to the sandbox, with the run's way out.
        const base = deps.env ?? process.env;
        const sandbox = {
          server: at.sandbox,
          env: sandboxEnvOf(base, launch.run.token, launch.workspace.services, at.docker),
        };
        // Codex starts any program by itself, past bash and git: in a place it has no environment
        // of its own, and runs every command and edit on its executor in the sandbox, reached from
        // its container's loopback through the sandbox's server.
        let tunnel: { port: number; to: typeof at.sandbox } | undefined;
        if (launch.agent.engine === 'codex') {
          const [file, ...first] = cliCommand(deps.codexPath ?? 'codex', sandbox.env);
          const executor = remoteSpawn(at.sandbox)(
            file,
            [...first, 'exec-server', '--listen', `ws://127.0.0.1:${EXEC_PORT}`],
            { cwd: workspace.repo, env: sandbox.env },
          );
          // Read by no one, what it says would pile up here as long as the sandbox writes.
          executor.stdout?.resume();
          executor.stderr?.resume();
          await tunnelReady(at.sandbox, EXEC_PORT);
          tunnel = { port: CLI_EXEC_PORT, to: at.sandbox };
          // The unmodified Codex, against a model of the worker's own, before the agent's: it must
          // run its one command on the executor and see no sign-in, or the run does not start.
          const [program = process.execPath, ...own] = deps.self ?? [
            process.execPath,
            ...process.execArgv,
            realpathSync(process.argv[1] ?? ''),
          ];
          const canary = remoteSpawn(at.cli, sandbox, tunnel)(
            program,
            [...own, 'codex-canary', `ws://127.0.0.1:${CLI_EXEC_PORT}`, deps.codexPath ?? 'codex'],
            {
              cwd: '/tmp',
              env: {
                PATH: base.PATH ?? '/usr/local/bin:/usr/bin:/bin',
                // The test's stand-in for Codex reads its own; the real one has none.
                ...Object.fromEntries(
                  Object.entries(base).filter(([name]) => name.startsWith('CODEX_FAKE_')),
                ),
              },
            },
          );
          let said = '';
          canary.stderr?.on(
            'data',
            (chunk: Buffer) => (said = (said + chunk.toString()).slice(-2000)),
          );
          const passed = await new Promise<boolean>((resolve) => {
            canary.once('close', (code) => resolve(code === 0));
            canary.once('error', () => resolve(false));
          });
          if (!passed) {
            throw new CanaryRefused(
              `Codex's check before the run failed: ${said.trim() || 'it did not run'}. The run did not start; Codex in this place may be a version the platform has not checked.`,
            );
          }
        }
        engineDeps = {
          ...deps,
          spawn: remoteSpawn(at.cli, sandbox, tunnel) as unknown as typeof spawn,
          split: { runId: id, cliToken: at.cliToken },
          ...(tunnel && {
            execServer: `ws://127.0.0.1:${tunnel.port}`,
            commandEnv: sandbox.env,
          }),
        };
      }
      outcome = await engine(
        launch,
        launch.task,
        workspace,
        left(),
        sink,
        signal,
        engineDeps,
        waited,
      );
    }
  } catch (error) {
    if (signal.aborted) outcome = end(RUN_CANCELLED_CODE, 'The run was cancelled.');
    else if (error instanceof CanaryRefused) outcome = end('sandbox_unavailable', error.message);
    else outcome = end(workspace ? 'worker_error' : 'workspace_failed', describe(error));
  }
  clearInterval(ticker);
  // Whatever the run left running goes with its container, before its commits are read.
  if (container) {
    await client
      .endContainer(id)
      .catch((error: unknown) =>
        log('warn', `run ${id}: its container could not be deleted (${describe(error)})`),
      );
    // What the run wrote into the sign-in folders goes before anything reads them again: the
    // place's check of the sign-in, the person's CLI in its terminal, the next run.
    if (deps.signInHome) {
      try {
        readySignIn(deps.signInHome, (text) => log('info', `run ${id}: after it, ${text}`));
      } catch (error) {
        log('warn', `run ${id}: the sign-in folders could not be cleared (${describe(error)})`);
      }
    }
  }

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
  const env = egressOf(
    deps.env ?? process.env,
    launch.run.token,
    launch.workspace.services,
    deps.split,
  );
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
  return runClaude(
    { ...run, cliPath: deps.cliPath, ...(deps.spawn && { spawn: deps.spawn }) },
    sink,
    signal,
  );
}

/** A run in a place in two containers: its CLI container's way out. */
export type Split = { runId: string; cliToken: string };

/**
 * In a person's place, the run's calls out go through the egress proxy; the place's token, for
 * sign-in, stays out of it. In two containers the CLI goes out under its CLI container's token, which
 * opens the model's vendor, and its commands, in the sandbox, under the run's (sandboxEnvOf), which
 * opens what its task's project allows. The project's services are reached directly.
 */
export function egressOf(
  env: NodeJS.ProcessEnv,
  token: string,
  services: string[] = [],
  split?: Split,
) {
  const proxy = env.AGENTOME_PLACE_EGRESS;
  if (!proxy) return env;
  if (split) {
    // The CLI container reaches the server by its public name, through the proxy, and its own
    // loopback for the executor; never the server's inner name. Codex's client and curl read a
    // NO_PROXY entry as a domain's tail, so `app` there also sent a server at `<name>.app`, and
    // every other name in `.app`, around the proxy, where nothing answers: Codex then dropped the
    // gateway's MCP server without a word.
    return { ...env, ...proxied(via(proxy, `cli-${split.runId}`, split.cliToken), LOOPBACK) };
  }
  return { ...env, ...proxied(via(proxy, 'run', token), [env.NO_PROXY, ...services]) };
}

/**
 * A command's environment in a run's sandbox: the toolchains, the run's way out, and the run's own
 * Docker when it has one, as `docker`, for the docker CLI and testcontainers (which also reach
 * a container's ports there).
 */
export function sandboxEnvOf(
  env: NodeJS.ProcessEnv,
  token: string,
  services: string[] = [],
  docker = false,
) {
  const proxy = env.AGENTOME_PLACE_EGRESS ?? '';
  const own = docker ? ['docker'] : [];
  return {
    ...(docker && { DOCKER_HOST: 'tcp://docker:2375', TESTCONTAINERS_HOST_OVERRIDE: 'docker' }),
    PATH: env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: '/home/node',
    ...(env.NODE_USE_ENV_PROXY && { NODE_USE_ENV_PROXY: env.NODE_USE_ENV_PROXY }),
    ...(env.DOTNET_ROOT && { DOTNET_ROOT: env.DOTNET_ROOT }),
    ...proxied(via(proxy, 'run', token), [env.NO_PROXY, ...services, ...own]),
  };
}

const LOOPBACK = ['localhost', '127.0.0.1'];

const via = (proxy: string, user: string, secret: string) =>
  `http://${user}:${encodeURIComponent(secret)}@${proxy}`;

function proxied(url: string, direct: (string | undefined)[]) {
  const none = direct.filter(Boolean).join(',');
  return {
    HTTPS_PROXY: url,
    HTTP_PROXY: url,
    https_proxy: url,
    http_proxy: url,
    NO_PROXY: none,
    no_proxy: none,
  };
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
  const env = egressOf(
    deps.env ?? process.env,
    launch.run.token,
    launch.workspace.services,
    deps.split,
  );
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
      ...(deps.execServer && { execServer: deps.execServer, commandEnv: deps.commandEnv }),
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
      ...(deps.spawn && { spawn: deps.spawn }),
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
