import { backoff, seatClient, sleep, Unauthorized } from './client.js';
import type { LaunchPackage } from './client.js';
import { alive, describe, readState, writeState } from './config.js';
import type { Connection, Log, Settings, WorkerState } from './config.js';
import { claudeSignedOut, probe } from './claude/launcher.js';
import { codexSignedOut, probeCodex } from './codex/launcher.js';
import { idleMs } from './presence.js';
import { executeRun } from './run.js';
import type { RunDeps } from './run.js';
import { shippingLog } from './shipping.js';
import { removeRuns } from './workspace.js';

// The seat: ask the server for a run, execute it, ask again — one run at a time, and only while
// somebody is at the computer. An outage is waited out; a refused seat token ends the
// loop, because no amount of waiting brings a revoked seat back.

/** The engines as people call them, and what signs each in. */
export const ENGINES: Record<string, { name: string; signIn: string }> = {
  'claude-code': { name: 'Claude Code', signIn: 'claude' },
  codex: { name: 'Codex', signIn: 'codex login' },
};

export const WAITS_FOR_SANDBOX =
  "Windows has no sandbox for the agent's commands: this computer takes runs once an admin allows it to run them without one, in Admin, Computers.";

export const WAITS_FOR_OWNER =
  "its owner is not at work in Agentome: this place takes their agents' runs while a tab of Agentome is open and in use.";

export const DISCONNECTED =
  'This computer was disconnected; connect it again with a new code from Admin, Computers: agentome-worker connect <code> --server <url>';

export interface WorkerOptions {
  readonly connection: Connection;
  readonly settings: Settings;
  /** Stops the loop; a run in progress is cancelled and finished first. */
  readonly signal: AbortSignal;
  readonly log: Log;
  /** Milliseconds since the last keyboard or mouse input; this computer's by default. */
  readonly idle?: () => Promise<number>;
  /** How long to wait before looking for somebody again. */
  readonly awayPauseMs?: number;
  /** How often the engines are asked whether they are signed in. */
  readonly signInEveryMs?: number;
  readonly backoff?: (attempt: number) => number;
  /** The SHA-256 of this worker's file, as the server names the bundle it hands out. */
  readonly build?: string;
  readonly run?: Pick<RunDeps, 'cliPath' | 'codexPath' | 'env' | 'timing'>;
}

export async function runWorker(options: WorkerOptions): Promise<'stopped' | 'disconnected'> {
  const client = seatClient(options.connection);
  // Every line goes to the file and, a batch at a time, to the server.
  const shipping = shippingLog(options.log, (lines) => client.logs(lines));
  try {
    return await work({ ...options, log: shipping.log }, client);
  } finally {
    await shipping.stop();
  }
}

async function work(
  options: WorkerOptions,
  client: ReturnType<typeof seatClient>,
): Promise<'stopped' | 'disconnected'> {
  const { connection, settings, signal, log } = options;
  const { home, keepWorkspaces: keepWorkspace } = settings;
  // A server seat has no keyboard to wait for: it is always there. A person's place has none
  // either: the server gives it a run only while its owner is at work, by the web app.
  const idle =
    settings.server || settings.place ? async () => 0 : (options.idle ?? (() => idleMs()));
  const delay = options.backoff ?? backoff;
  // A worker that was killed leaves its run's folder behind; one still alive needs its.
  const previous = readState(home)?.pid;
  if (!keepWorkspace && (previous === undefined || !alive(previous))) {
    try {
      removeRuns(home, options.run?.env ?? process.env);
    } catch (error) {
      log('error', `the folders of earlier runs could not be removed (${describe(error)})`);
    }
  }
  let state: WorkerState = { pid: process.pid };
  const save = (change: Partial<WorkerState>) => {
    state = { ...state, ...change };
    writeState(home, state);
  };
  save({});
  log('info', `worker started for ${connection.serverUrl}, seat ${connection.seatId}`);

  // Claude Code is the worker's own engine; Codex counts when it is on this computer. A computer
  // with Codex alone, as a person with a ChatGPT subscription has it, takes Codex runs only.
  const codex = await probeCodex({ cliPath: options.run?.codexPath, env: options.run?.env });
  const claude = await probe({ cliPath: options.run?.cliPath, env: options.run?.env });
  const engines =
    codex.installed && !claude.installed
      ? ['codex']
      : codex.installed
        ? ['claude-code', 'codex']
        : ['claude-code'];
  // Said once, for whoever wonders why Codex agents do not run here: the Codex inside the
  // ChatGPT app is not on the PATH.
  if (!codex.installed)
    log('info', 'no `codex` on the PATH of this worker; taking Claude Code runs only');
  // A run of an engine that is signed out fails at its first request, and the next one after
  // it: the engines are asked first, and the server keeps their runs in the queue. A
  // server seat is not asked: it works with a model connection's key.
  let signedOut: string[] = [];
  let askedAt = 0;
  const askSignIn = async () => {
    if (settings.server || Date.now() - askedAt < (options.signInEveryMs ?? 60_000)) return;
    askedAt = Date.now();
    const cli = { env: options.run?.env };
    const out: string[] = [];
    const claudeHere = engines.includes('claude-code');
    if (claudeHere && (await claudeSignedOut({ ...cli, cliPath: options.run?.cliPath }))) {
      out.push('claude-code');
    }
    if (codex.installed && (await codexSignedOut({ ...cli, cliPath: options.run?.codexPath }))) {
      out.push('codex');
    }
    for (const engine of out.filter((name) => !signedOut.includes(name))) {
      const { name, signIn } = ENGINES[engine] ?? { name: engine, signIn: engine };
      log(
        'warn',
        `${name} is not signed in on this computer; taking no runs for it. Run \`${signIn}\` and sign in.`,
      );
    }
    for (const engine of signedOut.filter((name) => !out.includes(name))) {
      log('info', `${ENGINES[engine]?.name ?? engine} is signed in again; taking its runs`);
    }
    if (out.join() !== signedOut.join()) save({ signedOut: out.length ? out : undefined });
    signedOut = out;
  };
  // The environment's value until the server names the owner's (with every claim answer).
  let idleMinutes = settings.idleMinutes;
  let waitingForOwner = false;
  let waitingForServices = false;
  let failures = 0;
  while (!signal.aborted) {
    // An idle time that cannot be read counts as somebody being there (presence.ts).
    const idleFor = await idle().catch(() => 0);
    if (idleFor > idleMinutes * 60_000) {
      if (state.awaySince === undefined) {
        log('info', `nobody at the computer for ${idleMinutes} min; taking no runs`);
        save({ awaySince: new Date().toISOString() });
      }
      await sleep(options.awayPauseMs ?? 60_000, signal);
      continue;
    }
    if (state.awaySince !== undefined) {
      log('info', 'somebody is at the computer again; taking runs');
      save({ awaySince: undefined });
    }

    let launch: LaunchPackage | undefined;
    try {
      await askSignIn();
      const answer = await client.claim(signal, engines, options.build, signedOut);
      launch = answer.launch;
      if ((answer.waitsForOwner === true) !== waitingForOwner) {
        waitingForOwner = answer.waitsForOwner === true;
        if (waitingForOwner) log('info', WAITS_FOR_OWNER);
        else log('info', 'its owner is at work again; taking runs');
      }
      if ((answer.waitsForServices === true) !== waitingForServices) {
        waitingForServices = answer.waitsForServices === true;
        if (waitingForServices) log('info', "the next run's services are starting beside it");
      }
      if ((answer.waitsForSandbox === true) !== (state.waitsForSandbox === true)) {
        if (answer.waitsForSandbox) log('warn', WAITS_FOR_SANDBOX);
        save({ waitsForSandbox: answer.waitsForSandbox });
      }
      if (answer.idleMinutes !== undefined && answer.idleMinutes !== idleMinutes) {
        log('info', `idle time is now ${answer.idleMinutes} min, as set on the platform`);
        idleMinutes = answer.idleMinutes;
      }
      failures = 0;
      save({ lastClaimAt: new Date().toISOString() });
    } catch (error) {
      if (signal.aborted) break;
      if (error instanceof Unauthorized) {
        log('error', DISCONNECTED);
        save({ pid: undefined });
        return 'disconnected';
      }
      log('warn', `the claim failed (${describe(error)}); trying again`);
      await sleep(delay(failures++), signal);
      continue;
    }
    if (launch === undefined) continue;

    const { run, agent, task } = launch;
    log('info', `run ${run.id} claimed: ${agent.name}${task ? `, "${task.title}"` : ''}`);
    const startedAt = new Date().toISOString();
    save({ activeRun: { id: run.id, agent: agent.name, task: task?.title, startedAt } });
    const deps = {
      client,
      log,
      signal,
      home,
      keepWorkspace,
      server: settings.server,
      place: settings.place,
      ...options.run,
    };
    const status = await executeRun(launch, deps);
    save({ activeRun: undefined });
    log('info', `run ${run.id} finished: ${status}`);
    // A sign-in that ended during the run: asked before the next run is taken.
    if (status === 'failed') askedAt = 0;
    // A server seat runs one run per container: its compose service starts it again clean, so
    // nothing of this run, which may be another person's, is left for the next.
    if (settings.server) break;
  }
  save({ pid: undefined });
  log('info', 'worker stopped');
  return 'stopped';
}
