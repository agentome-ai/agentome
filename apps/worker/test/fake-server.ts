import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { FinishBody, LaunchPackage, WireEvent } from '../src/client.js';

// The server half of the seat protocol as the server speaks it, on `node:http`: enough to
// drive the worker through pairing, claims, events, heartbeats, finish and every 401, and to
// look at what it sent. Not the real server: that one has its own tests against PostgreSQL.

export interface FakeRun {
  readonly launch: LaunchPackage;
  /** The transcript as stored: one event per `seq`, the first one sent wins. */
  readonly events: Map<number, WireEvent>;
  readonly batches: WireEvent[][];
  heartbeats: number;
  /** The `content-type` of each heartbeat; the server answers 400 to an empty JSON body. */
  readonly heartbeatTypes: (string | undefined)[];
  finish?: FinishBody;
  /** Running: the run token opens the run. */
  open: boolean;
  cancelRequested: boolean;
  /** Answer the next batches 500, after storing them, as if the answer were lost on the way. */
  failEvents: number;
  /** Refuse the next batches with 400, without storing them. */
  refuseEvents: number;
}

export interface FakeServer {
  readonly url: string;
  readonly code: string;
  readonly seatToken: string;
  readonly pairings: unknown[];
  /** The worker's log lines it sent. */
  readonly logLines: { level: string; message: string; runId?: string }[];
  readonly runs: Map<string, FakeRun>;
  /** Claims the server has answered. */
  claims: number;
  /** The query of the last claim, as the worker sent it. */
  claimQuery?: URLSearchParams;
  /** The idle time the owner set on the platform, sent with every claim answer; unset: none. */
  idleMinutes?: number;
  /** A revoked seat: every claim is refused with 401. */
  revoked: boolean;
  /** Puts a run in the queue; a claim waiting in its long poll gets it at once. */
  enqueue(launch: LaunchPackage): FakeRun;
  close(): Promise<void>;
}

export function launchPackage(
  overrides: { repository?: string | null; maxMinutes?: number } = {},
): LaunchPackage {
  return {
    run: {
      id: randomUUID(),
      token: `run-${randomUUID()}`,
      limits: { maxMinutes: overrides.maxMinutes ?? 5, maxTurns: 20, maxTokens: 1_000_000 },
    },
    agent: { id: randomUUID(), name: 'Backend developer', modelPref: null },
    task: {
      id: randomUUID(),
      title: 'Add a README',
      body: 'Describe the project.',
      repository: overrides.repository ?? null,
    },
    workspace: {
      profile: {
        claudeMd: '# Backend developer\n\nYou are Backend developer.\n',
        settings: {
          permissionMode: 'acceptEdits',
          allowedTools: ['Bash', 'Glob', 'Grep', 'Read', 'TodoWrite'],
          sandbox: {
            enabled: true,
            network: { allowedDomains: ['agentome.test'], strictAllowlist: true },
          },
        },
      },
    },
  };
}

export async function startFakeServer(options: { holdMs?: number } = {}): Promise<FakeServer> {
  const queue: FakeRun[] = [];
  const waiting = new Set<() => void>();
  const byToken = new Map<string, FakeRun>();

  const send = (response: ServerResponse, status: number, body?: unknown) => {
    response.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json' });
    response.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const refuse = (response: ServerResponse, status: number, code: string, message: string) =>
    send(response, status, { error: { code, message } });
  const bearer = (request: IncomingMessage) =>
    /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1];

  async function handle(request: IncomingMessage, response: ServerResponse) {
    let text = '';
    for await (const chunk of request) text += String(chunk);
    const body: unknown = text === '' ? undefined : JSON.parse(text);
    const url = new URL(request.url ?? '/', 'http://fake');

    if (request.method === 'POST' && url.pathname === '/api/seats/pair') {
      server.pairings.push(body);
      const { code } = body as { code: string };
      if (code.toUpperCase().replace(/[^A-Z0-9]/g, '') !== server.code.replace('-', '')) {
        return refuse(
          response,
          400,
          'pairing_code_invalid',
          'This code is not valid. Check it, or create a new one in Admin, Computers.',
        );
      }
      return send(response, 201, { seatId: randomUUID(), token: server.seatToken });
    }

    if (request.method === 'POST' && url.pathname === '/api/seats/logs') {
      if (bearer(request) !== server.seatToken) {
        return refuse(response, 401, 'unauthorized', 'This computer is not connected.');
      }
      server.logLines.push(...(body as { lines: FakeServer['logLines'] }).lines);
      return send(response, 204);
    }

    if (request.method === 'GET' && url.pathname === '/api/seats/claim') {
      if (server.revoked || bearer(request) !== server.seatToken) {
        return refuse(
          response,
          401,
          'unauthorized',
          'This computer is not connected. Connect it again with a new code.',
        );
      }
      server.claimQuery = url.searchParams;
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            waiting.delete(done);
            resolve();
          };
          const timer = setTimeout(done, options.holdMs ?? 50);
          waiting.add(done);
          response.once('close', done);
        });
      }
      if (response.destroyed) return;
      server.claims++;
      const run = queue.shift();
      if (server.idleMinutes !== undefined) {
        response.setHeader('x-agentome-idle-minutes', String(server.idleMinutes));
      }
      if (run === undefined) return send(response, 204);
      run.open = true;
      return send(response, 200, run.launch);
    }

    const route = /^\/api\/runs\/([^/]+)\/(events|heartbeat|finish)$/.exec(url.pathname);
    const run = byToken.get(bearer(request) ?? '');
    if (request.method !== 'POST' || route === null)
      return refuse(response, 404, 'not_found', 'Not found');
    if (run === undefined || !run.open || run.launch.run.id !== route[1]) {
      return refuse(
        response,
        401,
        'unauthorized',
        'This run token is not valid any more: the run has ended.',
      );
    }
    if (route[2] === 'events') {
      const batch = body as WireEvent[];
      run.batches.push(batch);
      if (run.refuseEvents > 0) {
        run.refuseEvents--;
        return refuse(response, 400, 'validation_failed', 'The request is not valid');
      }
      let accepted = 0;
      for (const event of batch) {
        if (run.events.has(event.seq)) continue;
        run.events.set(event.seq, event);
        accepted++;
      }
      if (run.failEvents > 0) {
        run.failEvents--;
        return refuse(response, 500, 'internal', 'Internal server error');
      }
      return send(response, 200, { accepted, cancelRequested: run.cancelRequested });
    }
    if (route[2] === 'heartbeat') {
      run.heartbeats++;
      run.heartbeatTypes.push(request.headers['content-type']);
      return send(response, 200, { cancelRequested: run.cancelRequested, waitedMs: 0 });
    }
    run.finish = body as FinishBody;
    run.open = false;
    return send(response, 200, { status: run.finish.status });
  }

  const http = createServer((request, response) => {
    handle(request, response).catch((error: unknown) =>
      refuse(response, 500, 'internal', String(error)),
    );
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;

  const server: FakeServer = {
    url: `http://127.0.0.1:${port}`,
    code: 'K7QX-M2PH',
    seatToken: `seat-${randomUUID()}`,
    pairings: [],
    logLines: [],
    runs: new Map(),
    claims: 0,
    revoked: false,
    enqueue(launch) {
      const run: FakeRun = {
        launch,
        events: new Map(),
        batches: [],
        heartbeats: 0,
        heartbeatTypes: [],
        open: false,
        cancelRequested: false,
        failEvents: 0,
        refuseEvents: 0,
      };
      server.runs.set(launch.run.id, run);
      byToken.set(launch.run.token, run);
      queue.push(run);
      for (const wake of waiting) wake();
      return run;
    },
    close: () =>
      new Promise((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
  return server;
}
