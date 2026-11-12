import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// What the worker keeps on this computer: where the server is and which seat this is
// (`config.json`), what it is doing, for `status` (`state.json`), its log, and the folder of the
// run in progress. Nothing of an agent stays here between runs.

/** A problem the person can fix, said so that they can: printed without a stack. */
export class UserError extends Error {
  override name = 'UserError';
}

export interface Settings {
  /** `AGENTOME_WORKER_HOME`, or `~/.agentome`; absolute, for the service file and deny rules. */
  home: string;
  /** Minutes without keyboard or mouse after which nobody counts as present. */
  idleMinutes: number;
  /** Keeps the folders of finished runs, to look into one. */
  keepWorkspaces: boolean;
  /**
   * `AGENTOME_WORKER_SERVER=1`: a server seat, in its container next to the server. It
   * pairs as one, takes runs with nobody at a keyboard, never uses a subscription, and exits after
   * each run, so that its container starts the next one clean.
   */
  server: boolean;
  /**
   * `AGENTOME_WORKER_PLACE=1`: a person's own place on the company's server, in the container the
   * platform made for them. It pairs as one and runs its owner's agents under their subscription;
   * whether the owner is at work is the server's to say, from the web app, as there is no keyboard
   * here to measure.
   */
  place: boolean;
}

export function readSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const idle = env.AGENTOME_WORKER_IDLE_MINUTES?.trim() || '15';
  const idleMinutes = Number(idle);
  if (!Number.isInteger(idleMinutes) || idleMinutes < 1) {
    throw new UserError(
      `AGENTOME_WORKER_IDLE_MINUTES must be a whole number of minutes, 1 or more, not "${idle}".`,
    );
  }
  const home = env.AGENTOME_WORKER_HOME?.trim();
  return {
    home: home ? resolve(home) : join(homedir(), '.agentome'),
    idleMinutes,
    keepWorkspaces: env.AGENTOME_WORKER_KEEP_WORKSPACES?.trim() === '1',
    server: env.AGENTOME_WORKER_SERVER?.trim() === '1',
    place: env.AGENTOME_WORKER_PLACE?.trim() === '1',
  };
}

export interface Connection {
  serverUrl: string;
  seatId: string;
  /** The seat token: it claims the runs of every agent of this person. */
  token: string;
}

export const connectionFile = (home: string) => join(home, 'config.json');

/** The connection `connect` saved, or nothing on a computer that was never connected. */
export function readConnection(home: string): Connection | undefined {
  const text = readIfExists(connectionFile(home));
  if (text === undefined) return undefined;
  const { serverUrl, seatId, token } = (parseJson(text) ?? {}) as Record<string, unknown>;
  if (typeof serverUrl === 'string' && typeof seatId === 'string' && typeof token === 'string') {
    return { serverUrl, seatId, token };
  }
  throw new UserError(
    `${connectionFile(home)} is not a connection this worker wrote. Connect this computer again.`,
  );
}

/**
 * A folder that existed before is the owner's alone from now on, too. A volume's root on
 * Kubernetes is root's and cannot be changed by the place's user, the only one in its container:
 * it is taken as it is. The connection file is the owner's alone either way.
 */
export function privateFolder(folder: string, uid = process.getuid?.()): void {
  if (uid === undefined || statSync(folder).uid === uid) chmodSync(folder, 0o700);
}

export function writeConnection(home: string, connection: Connection): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  privateFolder(home);
  writePrivate(connectionFile(home), `${JSON.stringify(connection, null, 2)}\n`);
}

export interface WorkerState {
  /** The worker process; absent once it has stopped. */
  pid?: number;
  /** When the server last answered a claim. */
  lastClaimAt?: string;
  /** Since when nobody has been at the computer, while the worker waits for somebody. */
  awaySince?: string;
  /** The engines that say they are not signed in on this computer; absent when none does. */
  signedOut?: string[];
  activeRun?: { id: string; agent: string; task?: string; startedAt: string };
  /** A Windows computer that no admin has allowed yet to run without a sandbox. */
  waitsForSandbox?: boolean;
}

const stateFile = (home: string) => join(home, 'state.json');

export function readState(home: string): WorkerState | undefined {
  const text = readIfExists(stateFile(home));
  return text === undefined ? undefined : (parseJson(text) as WorkerState | undefined);
}

export function writeState(home: string, state: WorkerState): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writePrivate(stateFile(home), `${JSON.stringify(state)}\n`);
}

/** Readable by its owner only from the first byte, and replaced whole: never half a token. */
function writePrivate(path: string, content: string): void {
  const temporary = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function readIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** The value, or nothing for text that is not JSON: a proxy's error page, a truncated file. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Whether a process of this number runs: gone, or another user's, is not. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export type Log = (level: 'info' | 'warn' | 'error', message: string) => void;

/** One line per event on stderr, which the service appends to `logs/worker.log`. */
export const stderrLog: Log = (level, message) => {
  process.stderr.write(`${new Date().toISOString()} ${level} ${message}\n`);
};

/** The message of an error, with its cause: `fetch failed` says nothing, `ECONNREFUSED` does. */
export function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const { code, message } = (error.cause ?? {}) as { code?: unknown; message?: unknown };
  const why = typeof code === 'string' ? code : typeof message === 'string' ? message : '';
  return why ? `${error.message}: ${why}` : error.message;
}
