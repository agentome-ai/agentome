import type { ShippedLine } from './shipping.js';
import type { UsageRow } from '@agentome/costs';
import type { ArtifactKind } from '@agentome/shared';

import type { ClaudePermissionMode } from './claude/launcher.js';
import type { Connection } from './config.js';
import { parseJson } from './config.js';

// The seat's half of the seat protocol. Every request has a timeout: a computer sleeps
// and changes networks, and a request that never ends would stop the worker with it.

const TIMEOUT_MS = 15_000;
/** The server holds a claim up to 25 s; a client that gives up first can lose a run handed out. */
const CLAIM_TIMEOUT_MS = 40_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a claim hands over: the fields this worker reads. */
export interface LaunchPackage {
  run: {
    id: string;
    token: string;
    limits: Record<'maxMinutes' | 'maxTurns' | 'maxTokens', number>;
  };
  agent: {
    id: string;
    name: string;
    /** Which CLI runs it. Absent from an older server: Claude Code. */
    engine?: 'claude-code' | 'codex';
    modelPref: string | null;
    /** The agent's skills at their pinned versions. Absent from an older server. */
    skills?: { name: string; version: number; content: string }[];
    /** The agent's memory at claim. Absent from an older server. */
    memoryDocuments?: { path: string; version: number; content: string }[];
  };
  /** A team run: the members as subagents, each with its own gateway token. */
  team?: {
    mode: 'auto' | 'manual';
    members: {
      key: string;
      description: string;
      prompt: string;
      modelPref: string | null;
      token: string;
      skills: { name: string; content: string }[];
      memoryDocuments: { path: string; content: string }[];
    }[];
    steps: { members: string[]; note: string }[];
  };
  /** A server seat's model connection, its key included; never sent to a computer. */
  model?: { kind: 'anthropic' | 'openai' | 'gateway'; baseUrl: string; key: string };
  /** `repository`: a URL or a path on this computer to clone; null for a new, empty repository. */
  task: { id: string; title: string; body: string; repository: string | null } | null;
  workspace: {
    /** The agent's tools on the server; the run's token opens them. Absent from an older server. */
    mcp?: { url: string };
    /** The git proxy, when the task's repository is connected; the password opens it only. */
    git?: { url: string; username: string; password: string };
    /** In a person's place, the project's services beside the agent, by name. */
    services?: string[];
    profile: {
      claudeMd: string;
      /** The task's project. Absent when it has none, or from an older server. */
      projectMd?: string;
      settings: {
        permissionMode: ClaudePermissionMode;
        allowedTools: string[];
        /** Claude Code's `sandbox` settings, as they go into the `--settings` file. */
        sandbox: Record<string, unknown> & {
          filesystem?: Partial<Record<'denyRead' | 'denyWrite', string[]>>;
        };
      };
    };
  };
}

/** A run event on the wire: `seq`, `type` and `at` on their own, the rest in `payload`. */
export type WireEvent = { seq: number; type: string; at: string; payload: Record<string, unknown> };
export type Artifact = { kind: ArtifactKind; ref: string; meta: Record<string, unknown> };

export interface FinishBody {
  status: 'done' | 'failed' | 'cancelled';
  summary?: string;
  errorCode?: string;
  artifacts: Artifact[];
  usage: UsageRow[];
}

/** The server refused the request; `code` is the code of its error body. */
export class ServerError extends Error {
  override name = 'ServerError';

  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

/** 401: the seat was revoked, or the run is over on the server; either way, stop. */
export class Unauthorized extends ServerError {
  override name = 'Unauthorized';
}

/** Worth asking again: the network, a timeout, a server that is busy or restarting. */
export function isRetryable(error: unknown): boolean {
  if (!(error instanceof ServerError)) return true;
  return error.status === 408 || error.status === 429 || error.status >= 500;
}

/** 1 s doubling to 30 s, less up to a fifth: the computers of one server must not return at once. */
export function backoff(attempt: number): number {
  return Math.round(Math.min(30_000, 1000 * 2 ** attempt) * (1 - 0.2 * Math.random()));
}

/** Waits unless `signal` fires first; false when it did. */
export function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = (slept: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      resolve(slept);
    };
    const aborted = () => done(false);
    const timer = setTimeout(() => done(true), ms);
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

type Call = { token?: string; body?: unknown; timeoutMs?: number; signal?: AbortSignal };

async function call(url: string, method: 'GET' | 'POST', options: Call) {
  const { token, body, timeoutMs = TIMEOUT_MS, signal } = options;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  // No body, no content type: Fastify answers 400 to an empty JSON body.
  if (body !== undefined) headers['content-type'] = 'application/json';
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    // A redirect would carry a token or a pairing code to wherever it points.
    redirect: 'error',
  });
  const answer = parseJson(await response.text());
  if (response.ok) return { status: response.status, body: answer, headers: response.headers };
  const error = (answer as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
  const code = typeof error?.code === 'string' ? error.code : undefined;
  const message =
    typeof error?.message === 'string' ? error.message : `The server answered ${response.status}.`;
  throw new (response.status === 401 ? Unauthorized : ServerError)(response.status, code, message);
}

/**
 * What this worker is: a computer with Claude Code under its owner's subscription, or a
 * server seat with model connections' keys, which only an admin's code connects.
 */
const seat = (where: Where) => ({
  kind:
    where === 'server'
      ? 'api-server'
      : where === 'place'
        ? 'subscription-server'
        : 'subscription-laptop',
  engines: ['claude-code'],
  capabilities: {},
});

/** Trades a pairing code for the seat of this computer. */
/** Where a worker runs: a person's computer, a server seat, or a person's place on the server. */
export type Where = 'computer' | 'server' | 'place';

export async function pair(
  serverUrl: string,
  code: string,
  name: string,
  where: Where = 'computer',
) {
  const body = { code, name, ...seat(where) };
  const answer = await call(`${serverUrl}/api/seats/pair`, 'POST', { body });
  const { seatId, token } = (answer.body ?? {}) as { seatId?: unknown; token?: unknown };
  if (typeof seatId !== 'string' || typeof token !== 'string') {
    throw new ServerError(200, undefined, `${serverUrl} did not answer like an Agentome server.`);
  }
  return { seatId, token };
}

/** The calls of a connected seat and of the runs it claims. */
export function seatClient({ serverUrl, token }: Pick<Connection, 'serverUrl' | 'token'>) {
  const run = (id: string, what: string, request: Call) =>
    call(`${serverUrl}/api/runs/${encodeURIComponent(id)}/${what}`, 'POST', request);
  const cancelRequested = ({ body }: { body: unknown }) =>
    (body as { cancelRequested?: unknown } | undefined)?.cancelRequested === true;
  return {
    /**
     * A run to execute, or nothing once the long poll is over; with either, the seat's idle
     * time as its owner set it on the platform, when the server names one.
     */
    async claim(
      signal: AbortSignal,
      engines?: readonly string[],
      build?: string,
      signedOut: readonly string[] = [],
    ): Promise<{
      launch?: LaunchPackage;
      idleMinutes?: number;
      waitsForSandbox?: boolean;
      waitsForOwner?: boolean;
      waitsForServices?: boolean;
    }> {
      // The engines on this computer now: Codex installed after pairing counts from the next claim.
      const also = engines ? `&engines=${encodeURIComponent(engines.join(','))}` : '';
      // Which worker this is, so that Admin, Computers can say when it is older than the server's.
      const worker = build ? `&worker=${build}` : '';
      // The engines that are here but not signed in: the server hands out no run of theirs.
      const out = signedOut.length ? `&signedOut=${encodeURIComponent(signedOut.join(','))}` : '';
      // Which system this is: a Windows computer gets runs only once an admin allows it to run
      // the agent's commands without a sandbox.
      const platform = `&platform=${encodeURIComponent(process.platform)}`;
      const url = `${serverUrl}/api/seats/claim?wait=25${also}${worker}${out}${platform}`;
      const answer = await call(url, 'GET', { token, signal, timeoutMs: CLAIM_TIMEOUT_MS });
      const idle = Number(answer.headers.get('x-agentome-idle-minutes'));
      const idleMinutes = Number.isInteger(idle) && idle >= 1 ? idle : undefined;
      if (answer.status === 204) {
        const waiting = answer.headers.get('x-agentome-waiting');
        const waitsForSandbox = waiting === 'sandbox';
        const waitsForOwner = waiting === 'presence';
        const waitsForServices = waiting === 'services';
        return {
          idleMinutes,
          ...(waitsForSandbox && { waitsForSandbox }),
          ...(waitsForOwner && { waitsForOwner }),
          ...(waitsForServices && { waitsForServices }),
        };
      }
      const launch = answer.body as LaunchPackage | undefined;
      // The run id names a folder that is removed after the run: it must be nothing but an id.
      if (!UUID.test(String(launch?.run?.id)) || typeof launch?.run.token !== 'string') {
        throw new ServerError(200, undefined, 'This worker cannot read the launch package.');
      }
      return { launch, idleMinutes };
    },
    async events(id: string, runToken: string, events: WireEvent[], signal?: AbortSignal) {
      const answer = await run(id, 'events', { token: runToken, body: events, signal });
      return { cancelRequested: cancelRequested(answer) };
    },
    async heartbeat(id: string, runToken: string) {
      const answer = await run(id, 'heartbeat', { token: runToken });
      // How long the run stood waiting for its owner; an older server says nothing of it.
      const waited = (answer.body as { waitedMs?: unknown } | undefined)?.waitedMs;
      return {
        cancelRequested: cancelRequested(answer),
        waitedMs: typeof waited === 'number' && waited > 0 ? waited : 0,
      };
    },
    async finish(id: string, runToken: string, body: FinishBody, signal?: AbortSignal) {
      await run(id, 'finish', { token: runToken, body, signal });
    },
    /** The worker's own log lines, for Admin → Logs. */
    async logs(lines: ShippedLine[]) {
      await call(`${serverUrl}/api/seats/logs`, 'POST', { token, body: { lines } });
    },
  };
}

export type SeatClient = ReturnType<typeof seatClient>;
