import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { z } from 'zod';
import { MAX_SERVICES, ServiceSpec } from '../projects/devcontainer.js';
import {
  orderIsSigned,
  PLACE_ID,
  type PlaceState,
  SIGNATURE_HEADER,
  TIME_HEADER,
} from './protocol.js';

// The place launcher: the only part of Agentome that may make containers. It takes a few orders
// from the server, signed, and makes a person's place only from the seat image, with fixed
// settings and nothing the order could change: the order names a person and, to create, a
// one-time code. Whoever gets past the signature still gets no other container, mount or
// privilege. Where the places run is a backend: Docker's socket (docker-places.ts) or the
// Kubernetes namespace the launcher runs in (kube-places.ts).

/** A shell in a place: its bytes both ways, and its size. */
export interface Shell {
  stream: Duplex;
  resize: (cols: number, rows: number) => Promise<void>;
}

/** Where places run. Every method takes a person's id, checked against PLACE_ID before. */
export interface Places {
  status: (id: string) => Promise<{ state: PlaceState; startedAt?: string }>;
  /** Pairs the place with the server by the one-time code, then starts it. */
  create: (id: string, code: string) => Promise<void>;
  wake: (id: string) => Promise<void>;
  /** Stops the place and keeps its volumes; a run in it ends as cancelled. */
  sleep: (id: string) => Promise<void>;
  /** The place and its volumes. */
  remove: (id: string) => Promise<void>;
  /** An agent's working folders, whether the place is awake or asleep. */
  removeFolders: (id: string, agent: string) => Promise<void>;
  /** An interactive shell as the place's user, its CLIs on the path; the place is awake. */
  shell: (id: string) => Promise<Shell>;
  /**
   * Runs a project's services beside the agent, reachable by their names, and stops any other
   * project's: between runs, never while one runs. The place is awake.
   */
  services: (id: string, shape: Shape) => Promise<void>;
}

/** What a place is made ready for: a project's approved services. */
export const Shape = z.object({
  project: z.string().regex(PLACE_ID),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  services: z.array(ServiceSpec).max(MAX_SERVICES),
});
export type Shape = z.infer<typeof Shape>;

export interface LauncherSettings {
  /** Shared with the server: derived from the installation's secret. */
  key: string;
  places: Places;
}

/** How a place calls out and reaches the app: what both backends give a place's environment. */
export interface PlaceNetwork {
  /** How a place reaches the app, directly. */
  serverUrl: string;
  /**
   * The places' only way out (`agentome place-egress`), as `host:port`, and the token a person's
   * place gives it for its worker and the sign-in in its terminal. A run gives its own instead.
   */
  egress: { proxy: string; tokenOf: (id: string) => string };
}

/** The place's environment: a person's place, calling out through the egress proxy. */
export function placeEnv(network: PlaceNetwork, id: string): [string, string][] {
  const proxy = `http://${id}:${network.egress.tokenOf(id)}@${network.egress.proxy}`;
  const direct = `${new URL(network.serverUrl).hostname},localhost,127.0.0.1`;
  return [
    // The image is a server seat's; a place is its person's, under their subscription.
    ['AGENTOME_WORKER_SERVER', ''],
    ['AGENTOME_WORKER_PLACE', '1'],
    ['AGENTOME_PLACE_EGRESS', network.egress.proxy],
    ...['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'].map((name): [string, string] => [
      name,
      proxy,
    ]),
    ['NO_PROXY', direct],
    ['no_proxy', direct],
    // Node's own fetch ignores the variables above without it, and an agent's checks often use it.
    ['NODE_USE_ENV_PROXY', '1'],
  ];
}

/**
 * The shell a terminal runs: the CLI the place installed on its volume first, as the worker has
 * it; not a login shell, whose profile would set the PATH back.
 */
export const SHELL = [
  'env',
  'TERM=xterm-256color',
  'PATH=/seat/cli/node_modules/.bin:/usr/local/bin:/usr/bin:/bin',
  'bash',
  '-i',
];

/** The terminals open in each place: a place with one open does not sleep. */
const terminals = new Map<string, Set<Shell>>();

/** An order the launcher turns down, with its status. */
export class Refusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const readBody = (request: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
      // A list of services with their environment is the longest order.
      if (body.length > 256 * 1024) request.destroy(new Error('An order is short'));
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });

const answer = (response: ServerResponse, status: number, body?: unknown) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(body === undefined ? undefined : JSON.stringify(body));
};

const failed = (error: unknown) =>
  error instanceof Refusal
    ? { status: error.status, body: { error: error.message } }
    : { status: 502, body: { error: error instanceof Error ? error.message : String(error) } };

/** Carries out one order; the path is /places/<person>[/wake|/sleep|/resize|/services|/folders/<agent>]. */
export async function handleOrder(
  settings: LauncherSettings,
  order: { method: string; path: string; time?: string; signature?: string; body: string },
): Promise<{ status: number; body?: unknown }> {
  if (!orderIsSigned(settings.key, order))
    return { status: 401, body: { error: 'Not the server’s order' } };
  const { places } = settings;
  const fresh = /^\/places\/([^/]+)\/folders\/([^/]+)$/.exec(order.path);
  if (fresh && order.method === 'DELETE') {
    const [, person, agent] = fresh;
    if (!person || !agent || !PLACE_ID.test(person) || !PLACE_ID.test(agent)) {
      return { status: 404, body: { error: 'No such order' } };
    }
    try {
      if ((await places.status(person)).state === 'none') {
        throw new Refusal(404, 'This person has no place');
      }
      await places.removeFolders(person, agent);
      return { status: 204 };
    } catch (error) {
      return failed(error);
    }
  }
  const match = /^\/places\/([^/]+)(?:\/(wake|sleep|resize|services))?$/.exec(order.path);
  const id = match?.[1];
  if (!match || !id || !PLACE_ID.test(id)) return { status: 404, body: { error: 'No such order' } };
  const action = `${order.method} ${match[2] ?? ''}`;
  try {
    switch (action) {
      case 'GET ': {
        const status = await places.status(id);
        return {
          status: 200,
          body:
            status.state === 'awake'
              ? { ...status, terminals: terminals.get(id)?.size ?? 0 }
              : { state: status.state },
        };
      }
      case 'POST ': {
        const { code } = JSON.parse(order.body || '{}') as { code?: unknown };
        if (typeof code !== 'string' || !/^[A-Z0-9-]{4,20}$/.test(code)) {
          return { status: 400, body: { error: 'A place is made with a pairing code' } };
        }
        if ((await places.status(id)).state !== 'none') {
          throw new Refusal(409, 'This person has a place already');
        }
        await places.create(id, code);
        return { status: 201, body: { state: 'awake' } };
      }
      case 'POST wake':
        await places.wake(id);
        return { status: 200, body: { state: 'awake' } };
      case 'POST sleep':
        await places.sleep(id);
        return { status: 200, body: { state: 'asleep' } };
      case 'POST resize': {
        const { cols, rows } = JSON.parse(order.body || '{}') as { cols?: unknown; rows?: unknown };
        const size = (value: unknown) =>
          Number.isInteger(value) && Number(value) > 0 && Number(value) <= 1000;
        if (!size(cols) || !size(rows))
          return { status: 400, body: { error: 'A size is columns and rows' } };
        for (const shell of terminals.get(id) ?? []) await shell.resize(Number(cols), Number(rows));
        return { status: 204 };
      }
      case 'DELETE ':
        await places.remove(id);
        return { status: 204 };
      case 'PUT services': {
        const shape = Shape.safeParse(JSON.parse(order.body || '{}'));
        if (!shape.success) return { status: 400, body: { error: 'Not a list of services' } };
        if ((await places.status(id)).state === 'none') {
          throw new Refusal(404, 'This person has no place');
        }
        await places.services(id, shape.data);
        return { status: 204 };
      }
      default:
        return { status: 404, body: { error: 'No such order' } };
    }
  } catch (error) {
    return failed(error);
  }
}

/**
 * Opens a terminal in a person's place, woken first if it sleeps. What goes through it is the
 * person's and is never kept.
 */
export async function openTerminal(
  settings: LauncherSettings,
  id: string,
): Promise<{ stream: Duplex; done: () => void }> {
  const { places } = settings;
  if ((await places.status(id)).state === 'none')
    throw new Refusal(404, 'This person has no place');
  await places.wake(id);
  const shell = await places.shell(id);
  const open = terminals.get(id) ?? new Set<Shell>();
  open.add(shell);
  terminals.set(id, open);
  let closed = false;
  const done = () => {
    if (closed) return;
    closed = true;
    open.delete(shell);
    if (open.size === 0) terminals.delete(id);
    shell.stream.destroy();
  };
  shell.stream.once('close', done);
  return { stream: shell.stream, done };
}

/** The launcher's HTTP side, on the internal network only. */
export function launcherServer(settings: LauncherSettings, log: (line: string) => void) {
  const server = createServer((request, response) => {
    readBody(request)
      .then(async (body) => {
        const path = (request.url ?? '').split('?', 1)[0] ?? '';
        const header = (name: string) => {
          const value = request.headers[name];
          return typeof value === 'string' ? value : undefined;
        };
        const done = await handleOrder(settings, {
          method: request.method ?? '',
          path,
          time: header(TIME_HEADER),
          signature: header(SIGNATURE_HEADER),
          body,
        });
        log(`${request.method} ${path} ${done.status}`);
        answer(response, done.status, done.body);
      })
      .catch((error: unknown) => answer(response, 400, { error: String(error) }));
  });
  // A terminal: the server's signed request, upgraded; then the shell's bytes both ways.
  server.on('upgrade', (request, socket) => {
    const path = (request.url ?? '').split('?', 1)[0] ?? '';
    const header = (name: string) => {
      const value = request.headers[name];
      return typeof value === 'string' ? value : undefined;
    };
    const id = /^\/places\/([^/]+)\/terminal$/.exec(path)?.[1];
    const signed = orderIsSigned(settings.key, {
      method: request.method ?? '',
      path,
      time: header(TIME_HEADER),
      signature: header(SIGNATURE_HEADER),
      body: '',
    });
    const refuse = (status: number, why: string) => {
      log(`terminal ${path} ${status}`);
      socket.end(`HTTP/1.1 ${status} ${why}\r\nconnection: close\r\n\r\n`);
    };
    if (!signed) return refuse(401, 'Unauthorized');
    if (!id || !PLACE_ID.test(id)) return refuse(404, 'Not Found');
    openTerminal(settings, id)
      .then(({ stream, done }) => {
        log(`terminal opened in ${id}`);
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\nconnection: Upgrade\r\nupgrade: tcp\r\n\r\n',
        );
        stream.pipe(socket);
        socket.pipe(stream);
        const close = () => {
          done();
          socket.destroy();
        };
        stream.once('close', () => {
          log(`terminal closed in ${id}`);
          socket.destroy();
        });
        socket.once('close', close);
        socket.once('error', close);
        stream.once('error', close);
      })
      .catch((error: unknown) =>
        refuse(
          error instanceof Refusal ? error.status : 502,
          error instanceof Error ? error.message.replace(/[\r\n]/g, ' ') : 'Bad Gateway',
        ),
      );
  });
  return server;
}
