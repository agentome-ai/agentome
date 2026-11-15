import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { z } from 'zod';
import { MAX_SERVICES, ServiceSpec } from '../projects/devcontainer.js';
import {
  NONCE_HEADER,
  onceOnly,
  type Order,
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
  /**
   * Whether the place is awake, since when, and the bytes its volumes hold where the volumes have
   * no size of their own (Docker's; a cluster's claims have one).
   */
  status: (id: string) => Promise<{ state: PlaceState; startedAt?: string; diskBytes?: number }>;
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
  /**
   * Makes a run's two containers and starts them: the CLI container with the CLI, the run's
   * folder, the agent's folder for the repository and the person's sign-in; the sandbox, where
   * the agent's commands run, with the agent's folder and the project's services by their
   * names, and nothing of the sign-in. Answers where each serves, with its key.
   */
  startRun: (id: string, runId: string, run: RunSpec) => Promise<RunAddresses>;
  /** Deletes a run's containers and every process in them. Nothing when they are gone already. */
  endRun: (id: string, runId: string) => Promise<void>;
}

/** Where a run's containers serve their worker and their CLI container (apps/worker/src/remote.ts). */
export const RUN_PORTS = { cli: 7419, sandbox: 7420 } as const;

/** A run container's key, made for the run. */
export const newRunKey = () => randomBytes(32).toString('base64url');

/** Where a run's container serves (apps/worker/src/remote.ts), and the key it takes. */
const RunServer = z.object({
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  key: z.string().min(32).max(128),
});

/** A run's two containers: the place's worker starts the CLI in the CLI container, the CLI container's commands go to the sandbox. */
export const RunAddresses = z.object({
  cli: RunServer,
  sandbox: RunServer,
  /** Whether the run has a Docker of its own, which its sandbox reaches as `docker`. */
  docker: z.boolean().optional(),
});
export type RunAddresses = z.infer<typeof RunAddresses>;

/** An agent's folder for a repository on the seat volume, as the worker names it. */
const FOLDER =
  /^folders\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{16}$/;

/** What a place is made ready for: a project's approved services. */
export const Shape = z.object({
  project: z.string().regex(PLACE_ID),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  services: z.array(ServiceSpec).max(MAX_SERVICES),
});
export type Shape = z.infer<typeof Shape>;

/** What a run's container holds of the place: its agent's folder, and the services it runs with. */
export const RunSpec = z.object({
  folder: z.string().regex(FOLDER).optional(),
  shape: Shape.optional(),
});
export type RunSpec = z.infer<typeof RunSpec>;

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
  egress: {
    proxy: string;
    tokenOf: (id: string) => string;
    /** The token of a run's own Docker, for its pulls. */
    dockerTokenOf?: (runId: string) => string;
  };
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
    // Claude Code's telemetry, error reports and updater call hosts the proxy does not open; the
    // CLI is the place's, updated by the place.
    ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', '1'],
    ['DISABLE_AUTOUPDATER', '1'],
    // Claude Code keeps all of its own, .claude.json too, in one folder: a run's container
    // mounts that folder and nothing else of the home.
    ['CLAUDE_CONFIG_DIR', SIGN_IN.claude],
  ];
}

/** Where the CLIs keep the person's sign-in, in the home volume of the place. */
export const SIGN_IN = { claude: '/home/node/.claude', codex: '/home/node/.codex' };

/**
 * A run's container's environment: the place's, without the place's egress token. The worker
 * gives the CLI the run's own proxy address when it starts it.
 */
export function runEnv(network: PlaceNetwork): [string, string][] {
  const direct = `${new URL(network.serverUrl).hostname},localhost,127.0.0.1`;
  return [
    ['AGENTOME_WORKER_SERVER', ''],
    ['AGENTOME_WORKER_PLACE', '1'],
    ['AGENTOME_PLACE_EGRESS', network.egress.proxy],
    ['NO_PROXY', direct],
    ['no_proxy', direct],
    ['NODE_USE_ENV_PROXY', '1'],
    ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', '1'],
    ['DISABLE_AUTOUPDATER', '1'],
    ['CLAUDE_CONFIG_DIR', SIGN_IN.claude],
    ['HOME', '/home/node'],
  ];
}

/**
 * What a run's sandbox mounts of its folder: the git proxy's password and the agent's profile (its
 * skills and memory, which a command reads), read-only; the working folder of a run without a
 * folder of its agent's, to work in. Not the gateway's config, which holds the run's and a team's
 * tokens, nor the copy of the repository's config the worker's own git reads at the end.
 */
export const sandboxMounts = (runId: string) =>
  [
    { name: 'git', readOnly: true },
    { name: 'profile', readOnly: true },
    { name: 'repo', readOnly: false },
  ].map(({ name, readOnly }) => ({
    subPath: `runs/${runId}/${name}`,
    path: `/seat/runs/${runId}/${name}`,
    readOnly,
  }));

/** The seat volume's paths a run's container mounts, at the same paths as in the place. */
export function runMounts(runId: string, folder: string | undefined) {
  return [
    { subPath: `runs/${runId}`, path: `/seat/runs/${runId}`, readOnly: false },
    ...(folder ? [{ subPath: folder, path: `/seat/${folder}`, readOnly: false }] : []),
    // Claude Code as the place installed and checked it: a run cannot leave it changed.
    { subPath: 'cli', path: '/seat/cli', readOnly: true },
  ];
}

/**
 * What a project's service may not do, on either launcher: send raw packets (on Kubernetes it
 * shares the pod's network with the worker, so it could listen in), make device files, give a
 * file capabilities, write the audit log, change its root.
 */
export const SERVICE_CAP_DROP = ['NET_RAW', 'MKNOD', 'SETFCAP', 'AUDIT_WRITE', 'SYS_CHROOT'];

/**
 * The shell a terminal runs. The home folder and the CLIs' folder are the place's volumes, which
 * an agent's run can write: so no profile or rc file of the home is read (a planted `~/.bashrc`
 * could show the person a false prompt), the environment is set here rather than inherited, and
 * the image's own folders come first on the PATH, the CLIs' last.
 */
export function shellFor(network: PlaceNetwork, id: string): string[] {
  return [
    'env',
    '-i',
    ...placeEnv(network, id).map(([name, value]) => `${name}=${value}`),
    'TERM=xterm-256color',
    'HOME=/home/node',
    'LANG=C.UTF-8',
    'PATH=/usr/local/bin:/usr/bin:/bin:/seat/cli/node_modules/.bin',
    'bash',
    '--noprofile',
    '--norc',
    '-i',
  ];
}

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

/** The launcher's memory of the orders it took, by settings: each order once. */
const takenBy = new WeakMap<LauncherSettings, (nonce: string) => boolean>();
function taken(settings: LauncherSettings, order: Order): boolean {
  let once = takenBy.get(settings);
  if (!once) takenBy.set(settings, (once = onceOnly()));
  return order.nonce !== undefined && once(order.nonce);
}

/**
 * Carries out one order; the path is /places/<person>[/wake|/sleep|/resize|/services|
 * /folders/<agent>|/runs/<run>].
 */
export async function handleOrder(
  settings: LauncherSettings,
  order: Order,
): Promise<{ status: number; body?: unknown }> {
  if (!orderIsSigned(settings.key, order) || !taken(settings, order)) {
    return { status: 401, body: { error: 'Not the server’s order' } };
  }
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
  const runOrder = /^\/places\/([^/]+)\/runs\/([^/]+)$/.exec(order.path);
  if (runOrder) {
    const [, person, runId] = runOrder;
    if (!person || !runId || !PLACE_ID.test(person) || !PLACE_ID.test(runId)) {
      return { status: 404, body: { error: 'No such order' } };
    }
    try {
      if (order.method === 'DELETE') {
        await places.endRun(person, runId);
        return { status: 204 };
      }
      if (order.method !== 'PUT') return { status: 404, body: { error: 'No such order' } };
      const run = RunSpec.safeParse(JSON.parse(order.body || '{}'));
      if (!run.success) return { status: 400, body: { error: 'Not a run of a place' } };
      if ((await places.status(person)).state !== 'awake') {
        throw new Refusal(409, 'The place is not awake');
      }
      return { status: 200, body: await places.startRun(person, runId, run.data) };
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
              : {
                  state: status.state,
                  ...(status.diskBytes !== undefined && { diskBytes: status.diskBytes }),
                },
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
          nonce: header(NONCE_HEADER),
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
    const order = {
      method: request.method ?? '',
      path,
      time: header(TIME_HEADER),
      nonce: header(NONCE_HEADER),
      signature: header(SIGNATURE_HEADER),
      body: '',
    };
    const signed = orderIsSigned(settings.key, order) && taken(settings, order);
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
