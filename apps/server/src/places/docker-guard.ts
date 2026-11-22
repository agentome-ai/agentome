import { createServer, type IncomingMessage, request, type Server } from 'node:http';
import type { Duplex } from 'node:stream';

// The only process with Docker's socket on a host with places (review N7). The place launcher
// talks to Docker through this instead, and this passes only the calls a launcher makes, with
// the bodies a launcher sends: containers, networks and volumes of places and runs by their
// names, never privileged, never a folder or a port of the host, never the host's namespaces;
// a capability or an unconfined profile only for a run's own Docker, on a gVisor runtime. So a
// launcher broken into reaches Docker as a launcher, not as the host's root.

/** What the guard knows of its installation. */
export interface GuardSettings {
  /** Runtimes a container may ask for: the places' and a run's Docker's. */
  runtimes: string[];
  /** The runtime under which a container may have capabilities: a run's own Docker's. */
  sandboxRuntime?: string;
  /** The compose services a place's network may join besides places and runs. */
  peers: string[];
}

export type Verdict = { ok: true } | { ok: false; why: string };
const no = (why: string): Verdict => ({ ok: false, why });
const OK: Verdict = { ok: true };

/** Names of what a launcher makes: places, their services, runs, and their volumes and networks. */
const OURS = /^agentome-(place|run)-[a-z0-9_-]{1,200}$/;
/** A container named in a path: by name, as a launcher calls them. */
const NAMED = /^\/containers\/([^/?]+)(\/[a-z]+)?$/;
/** An exec start's options, `{"Detach":false,"Tty":true}`, with room to spare. */
const MAX_START_BODY = 4096;

type Body = Record<string, unknown> | undefined;
type HostConfig = Record<string, unknown>;

/**
 * The fields a body may have, as a launcher sends them, by their exact names: Docker reads a
 * field's name in any case (`privileged`), so a check by name alone would let another case through.
 * A body with any other field is refused, and what goes to Docker is the guard's own writing of it.
 */
type Shape = 'string' | 'number' | 'boolean' | readonly [Shape] | { map: Shape } | Fields;
interface Fields {
  readonly [field: string]: Shape;
}
const strings = ['string'] as const;
const labels = { map: 'string' } as const;
const MOUNT: Fields = {
  Type: 'string',
  Source: 'string',
  Target: 'string',
  ReadOnly: 'boolean',
  VolumeOptions: { Subpath: 'string' },
};
const CONTAINER: Fields = {
  Image: 'string',
  Cmd: strings,
  Entrypoint: strings,
  Env: strings,
  User: 'string',
  Labels: labels,
  Tty: 'boolean',
  HostConfig: {
    Init: 'boolean',
    CapDrop: strings,
    CapAdd: strings,
    SecurityOpt: strings,
    ReadonlyRootfs: 'boolean',
    Tmpfs: labels,
    Mounts: [MOUNT],
    Memory: 'number',
    PidsLimit: 'number',
    NanoCpus: 'number',
    NetworkMode: 'string',
    ExtraHosts: strings,
    Dns: strings,
    Runtime: 'string',
    RestartPolicy: { Name: 'string', MaximumRetryCount: 'number' },
  },
  NetworkingConfig: { EndpointsConfig: { map: { Aliases: strings } } },
};
const VOLUME: Fields = { Name: 'string', Labels: labels };
const NETWORK: Fields = { Name: 'string', Internal: 'boolean', Labels: labels };
const EXEC: Fields = {
  AttachStdin: 'boolean',
  AttachStdout: 'boolean',
  AttachStderr: 'boolean',
  Tty: 'boolean',
  User: 'string',
  Cmd: strings,
};
const JOIN: Fields = {
  Container: 'string',
  EndpointConfig: { Aliases: strings },
  Force: 'boolean',
};

/** Whether a value has the shape, every field by its exact name; why not, when it has not. */
export function fits(value: unknown, shape: Shape, at = 'the body'): Verdict {
  if (typeof shape === 'string') {
    return typeof value === shape ? OK : no(`${at} as ${typeof value}`);
  }
  if (Array.isArray(shape)) {
    if (!Array.isArray(value)) return no(`${at} that is not a list`);
    for (const [i, item] of value.entries()) {
      const verdict = fits(item, shape[0] as Shape, `${at}[${i}]`);
      if (!verdict.ok) return verdict;
    }
    return OK;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return no(`${at} that is not an object`);
  }
  const entries = Object.entries(value);
  if ('map' in shape && Object.keys(shape).length === 1) {
    for (const [key, item] of entries) {
      const verdict = fits(item, (shape as { map: Shape }).map, `${at}.${key}`);
      if (!verdict.ok) return verdict;
    }
    return OK;
  }
  const fields = shape as Fields;
  for (const [key, item] of entries) {
    const field = Object.hasOwn(fields, key) ? fields[key] : undefined;
    if (field === undefined) return no(`${at} with the field ${key}`);
    const verdict = fits(item, field, `${at}.${key}`);
    if (!verdict.ok) return verdict;
  }
  return OK;
}

/** Labels no container of a launcher's may carry: compose's, which make the installation's own. */
const COMPOSE = /^com\.docker\.compose\./;
/** The label every container of a launcher's carries: the place it belongs to. */
const PLACE_LABEL = 'ai.agentome.place';

/**
 * Whether a container a launcher acts on is one it made, by its labels: its place's, and none of
 * compose's. Its name alone is not enough: the installation's own `agentome-place-egress-1` has a
 * name like a place's.
 */
export function madeByLauncher(labels: Record<string, string> | undefined): boolean {
  if (!labels || !(PLACE_LABEL in labels)) return false;
  return !Object.keys(labels).some((label) => COMPOSE.test(label));
}

/** Security options as a launcher sets them; a run's own Docker's also unconfined. */
const OPTS = ['no-new-privileges:true'];
const SANDBOXED_OPTS = [...OPTS, 'seccomp=unconfined'];

/** What an image pull may say: which image, nothing to import from an address or to name it. */
const PULL = new Set(['fromImage', 'tag']);

const empty = (value: unknown) =>
  value === undefined ||
  value === null ||
  value === false ||
  (Array.isArray(value) && value.length === 0) ||
  (typeof value === 'object' && Object.keys(value as object).length === 0) ||
  value === '';

/** Whether a container a launcher creates is one: its body checked field by field. */
export function containerAllowed(name: string, body: Body, settings: GuardSettings): Verdict {
  if (!OURS.test(name)) return no(`a container named ${name}`);
  const shaped = fits(body ?? {}, CONTAINER);
  if (!shaped.ok) return shaped;
  const given = (body?.Labels ?? {}) as Record<string, string>;
  if (!(PLACE_LABEL in given)) return no('a container without its place');
  if (Object.keys(given).some((label) => COMPOSE.test(label))) {
    return no("a container with compose's labels");
  }
  const host = (body?.HostConfig ?? {}) as HostConfig;
  const endpoints = Object.keys(
    ((body?.NetworkingConfig as { EndpointsConfig?: object } | undefined)?.EndpointsConfig ??
      {}) as object,
  );
  if (endpoints.some((network) => network !== host.NetworkMode)) {
    return no('a container on a network besides its own');
  }
  if (host.Privileged === true) return no('a privileged container');
  for (const field of ['Binds', 'Devices', 'DeviceRequests', 'DeviceCgroupRules', 'VolumesFrom']) {
    if (!empty(host[field])) return no(`a container with ${field}`);
  }
  if (!empty(host.PortBindings) || host.PublishAllPorts === true) {
    return no('a container on a port of the host');
  }
  for (const field of ['PidMode', 'IpcMode', 'UTSMode', 'UsernsMode', 'CgroupnsMode']) {
    if (typeof host[field] === 'string' && (host[field] as string).startsWith('host')) {
      return no(`a container in the host's ${field}`);
    }
  }
  if (!empty(host.Sysctls)) return no('a container with sysctls');
  const network = host.NetworkMode;
  if (typeof network !== 'string' || !OURS.test(network)) {
    return no(`a container on the network ${String(network)}`);
  }
  const mounts = (host.Mounts ?? []) as { Type?: string; Source?: string }[];
  for (const mount of mounts) {
    if (mount.Type !== 'volume' || !OURS.test(mount.Source ?? '')) {
      return no(`a container that mounts ${String(mount.Type)} ${String(mount.Source)}`);
    }
  }
  const runtime = host.Runtime;
  // Docker's default is the host's kernel: only where the installation chose it by name.
  if (runtime === undefined && !settings.runtimes.includes('runc')) {
    return no("a container without the places' runtime");
  }
  if (runtime !== undefined && !settings.runtimes.includes(String(runtime))) {
    return no(`a container on the runtime ${String(runtime)}`);
  }
  if (body?.User !== undefined && body.User !== '1000:1000') {
    return no(`a container as the user ${String(body.User)}`);
  }
  // Capabilities and an unconfined profile are a run's own Docker's, which needs them inside
  // gVisor's kernel; nowhere else. No other option, such as a profile of the caller's own.
  const sandboxed = settings.sandboxRuntime !== undefined && runtime === settings.sandboxRuntime;
  if (!empty(host.CapAdd) && !sandboxed) return no('a container that adds capabilities');
  const opts = (host.SecurityOpt ?? []) as string[];
  const allowed = sandboxed ? SANDBOXED_OPTS : OPTS;
  const odd = opts.find((opt) => !allowed.includes(opt));
  if (odd !== undefined) return no(`a container with the security option ${odd}`);
  if (!opts.includes('no-new-privileges:true')) return no('a container that may gain privileges');
  return OK;
}

/**
 * Whether a call may pass, before any body that needs Docker's own answer (a network's
 * container) is checked by the server. Paths without the API version.
 */
export function callAllowed(
  method: string,
  path: string,
  body: Body,
  settings: GuardSettings,
): Verdict {
  const [route = '', query = ''] = path.split('?');
  const params = new URLSearchParams(query);
  if ((method === 'GET' || method === 'HEAD') && (route === '/_ping' || route === '/version')) {
    return OK;
  }
  if (method === 'GET' && route === '/system/df') return OK;
  // Which runtimes Docker has, to check the places' is gVisor's: answered with those alone.
  if (method === 'GET' && route === '/info') return OK;
  // Lists only by a place's labels: not the host's other containers.
  if (
    method === 'GET' &&
    (route === '/containers/json' || route === '/networks' || route === '/volumes')
  ) {
    // A place's, or the launcher's own compose project's, to find the app and the proxy.
    return /ai\.agentome\.place|com\.docker\.compose\.project/.test(params.get('filters') ?? '')
      ? OK
      : no('a list without a place');
  }
  if (method === 'POST' && route === '/containers/create') {
    return containerAllowed(params.get('name') ?? '', body, settings);
  }
  // No other call carries a body but these, each by its own fields.
  const shapes: [boolean, Fields][] = [
    [method === 'POST' && route === '/volumes/create', VOLUME],
    [method === 'POST' && route === '/networks/create', NETWORK],
    [method === 'POST' && /^\/containers\/[^/]+\/exec$/.test(route), EXEC],
    [method === 'POST' && /^\/networks\/[^/]+\/(connect|disconnect)$/.test(route), JOIN],
  ];
  const shape = shapes.find(([applies]) => applies)?.[1];
  if (body !== undefined) {
    if (!shape) return no(`a body with ${method} ${route}`);
    const shaped = fits(body, shape);
    if (!shaped.ok) return shaped;
  }
  if (method === 'POST' && route === '/images/create') {
    const odd = [...params.keys()].find((key) => !PULL.has(key));
    if (odd !== undefined) return no(`an image pull with ${odd}`);
    return params.get('fromImage') ? OK : no('an image pull without its image');
  }
  if (method === 'GET' && /^\/images\/[^/]+\/json$/.test(route)) return OK;
  const container = NAMED.exec(route);
  if (container) {
    const [, name = '', action = ''] = container;
    // Inspecting anything: the answer of one not ours is cut to its name and labels.
    if (method === 'GET' && action === '/json') return OK;
    if (!OURS.test(name)) return no(`the container ${name}`);
    if (method === 'DELETE' && action === '') return OK;
    if (method === 'POST' && ['/start', '/stop', '/wait', '/kill'].includes(action)) return OK;
    if (method === 'POST' && action === '/exec') {
      if (body?.User !== '1000:1000') return no('an exec as another user');
      return OK;
    }
    return no(`${method} ${route}`);
  }
  if (method === 'POST' && /^\/exec\/[a-f0-9]+\/resize$/.test(route)) return OK;
  if (method === 'POST' && route === '/networks/create') {
    const name = String(body?.Name ?? '');
    if (!OURS.test(name)) return no(`a network named ${name}`);
    return body?.Internal === true ? OK : no('a network with a way out');
  }
  const network = /^\/networks\/([^/?]+)(\/connect|\/disconnect)?$/.exec(route);
  if (network) {
    const [, name = '', action] = network;
    if (method === 'GET' && action === undefined)
      return OURS.test(name) ? OK : no(`the network ${name}`);
    if (!OURS.test(name)) return no(`the network ${name}`);
    if (method === 'DELETE' && action === undefined) return OK;
    // Which container joins is checked against Docker's answer (joinAllowed).
    if (method === 'POST' && action !== undefined) return OK;
    return no(`${method} ${route}`);
  }
  if (method === 'POST' && route === '/volumes/create') {
    const name = String(body?.Name ?? '');
    return OURS.test(name) ? OK : no(`a volume named ${name}`);
  }
  const volume = /^\/volumes\/([^/?]+)$/.exec(route);
  if (volume && method === 'DELETE') {
    return OURS.test(volume[1] ?? '') ? OK : no(`the volume ${volume[1] ?? ''}`);
  }
  return no(`${method} ${route}`);
}

/** Who may join a place's network: places and runs, or the installation's app and proxy. */
export function joinAllowed(
  container: string,
  labels: Record<string, string> | undefined,
  settings: GuardSettings,
): boolean {
  if (OURS.test(container)) return true;
  return settings.peers.includes(labels?.['com.docker.compose.service'] ?? '');
}

/** Docker's info, as the launcher may read it: its runtimes' names and programs, nothing of the host. */
export function cutInfo(body: unknown): unknown {
  const runtimes = (body as { Runtimes?: Record<string, { path?: unknown }> } | undefined)
    ?.Runtimes;
  return {
    Runtimes: Object.fromEntries(
      Object.entries(runtimes ?? {}).map(([name, runtime]) => [
        name,
        { path: String(runtime.path ?? '') },
      ]),
    ),
  };
}

/** An inspected container not ours: its name, id and labels, not its environment or mounts. */
export function cutInspect(name: string, body: unknown): unknown {
  if (OURS.test(name)) return body;
  const found = body as { Id?: string; Name?: string; Config?: { Labels?: unknown } } | undefined;
  return { Id: found?.Id, Name: found?.Name, Config: { Labels: found?.Config?.Labels ?? {} } };
}

const strip = (url: string) => url.replace(/^\/v\d+\.\d+(?=\/)/, '');

/** Reads a request's JSON body, at most a megabyte. */
function readBody(incoming: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    incoming.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 ** 2) {
        reject(new Error('too large'));
        incoming.destroy();
        return;
      }
      chunks.push(chunk);
    });
    incoming.on('end', () => resolve(Buffer.concat(chunks)));
    incoming.on('error', reject);
  });
}

/** Asks Docker on its socket, for the guard's own checks. */
function ask(socketPath: string, path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const call = request({ socketPath, method: 'GET', path: `/v1.45${path}` }, (answer) => {
      const chunks: Buffer[] = [];
      answer.on('data', (chunk: Buffer) => chunks.push(chunk));
      answer.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          resolve(undefined);
        }
      });
    });
    call.on('error', reject);
    call.end();
  });
}

/** The guard: a server on its own socket, Docker's socket behind it. */
export function dockerGuard(
  dockerSocket: string,
  settings: GuardSettings,
  log: (line: string) => void,
): Server {
  // Execs the guard let a launcher make: only those start.
  const execs = new Set<string>();
  const refuse = (send: (status: number, text: string) => void, why: string) => {
    log(`docker-guard: refused ${why}`);
    send(403, JSON.stringify({ message: `The docker guard refuses ${why}` }));
  };

  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const method = incoming.method ?? 'GET';
      const path = strip(incoming.url ?? '/');
      const raw = await readBody(incoming);
      const send = (status: number, text: string) => {
        outgoing.writeHead(status, { 'content-type': 'application/json' });
        outgoing.end(text);
      };
      let body: Body;
      try {
        body = raw.length ? (JSON.parse(raw.toString('utf8')) as Body) : undefined;
      } catch {
        return refuse(send, 'a body that is not JSON');
      }
      const verdict = callAllowed(method, path, body, settings);
      if (!verdict.ok) return refuse(send, verdict.why);
      // What goes to Docker is the guard's writing of what it checked, not the bytes it was sent.
      const sent = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
      // A container acted on is one a launcher made, by its labels, not only by a name like one.
      const acted = /^\/containers\/([^/?]+)(\/[a-z]+)?$/.exec(path.split('?')[0] ?? '');
      if (acted && !(method === 'GET' && acted[2] === '/json')) {
        const target = decodeURIComponent(acted[1] ?? '');
        const found = (await ask(
          dockerSocket,
          `/containers/${encodeURIComponent(target)}/json`,
        )) as { Id?: string; Config?: { Labels?: Record<string, string> } } | undefined;
        if (found?.Id !== undefined && !madeByLauncher(found.Config?.Labels)) {
          return refuse(send, `the container ${target}, which no launcher made`);
        }
      }
      const joining = /^\/networks\/[^/]+\/connect$/.exec(path.split('?')[0] ?? '');
      if (joining) {
        const who = String(body?.Container ?? '');
        const found = (await ask(dockerSocket, `/containers/${encodeURIComponent(who)}/json`)) as
          { Name?: string; Config?: { Labels?: Record<string, string> } } | undefined;
        const name = (found?.Name ?? who).replace(/^\//, '');
        if (!joinAllowed(name, found?.Config?.Labels, settings)) {
          return refuse(send, `${name} on a place's network`);
        }
      }
      const upstream = request(
        {
          socketPath: dockerSocket,
          method,
          path: incoming.url,
          headers: {
            ...(sent.length > 0 && {
              'content-type': 'application/json',
              'content-length': sent.length,
            }),
          },
        },
        (answer) => {
          const inspected = /^\/containers\/([^/?]+)\/json$/.exec(path.split('?')[0] ?? '');
          const exec = method === 'POST' && /^\/containers\/[^/]+\/exec$/.test(path);
          const info = method === 'GET' && path.split('?')[0] === '/info';
          if (!inspected && !exec && !info) {
            outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
            answer.pipe(outgoing);
            return;
          }
          const chunks: Buffer[] = [];
          answer.on('data', (chunk: Buffer) => chunks.push(chunk));
          answer.on('end', () => {
            let said: unknown;
            try {
              said = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
              said = undefined;
            }
            if (exec && answer.statusCode === 201) {
              const id = (said as { Id?: string } | undefined)?.Id;
              if (id) execs.add(id);
            }
            const out =
              inspected && said !== undefined
                ? cutInspect(decodeURIComponent(inspected[1] ?? ''), said)
                : info
                  ? cutInfo(said)
                  : said;
            send(answer.statusCode ?? 502, out === undefined ? '' : JSON.stringify(out));
          });
        },
      );
      upstream.on('error', (error) => send(502, JSON.stringify({ message: error.message })));
      upstream.end(sent.length ? sent : undefined);
    })().catch((error: unknown) => {
      outgoing.writeHead(400, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify({ message: String(error) }));
    });
  });

  // A terminal: an exec the guard saw made, its stream passed both ways.
  server.on('upgrade', (incoming: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = strip(incoming.url ?? '/');
    const id = /^\/exec\/([a-f0-9]+)\/start$/.exec(path)?.[1];
    if (!id || !execs.has(id)) {
      log(`docker-guard: refused an exec it did not see made`);
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    execs.delete(id);
    // The start's options are its body, which Docker reads before it answers: with an upgrade
    // they come in `head` and on the socket, never through `incoming`, so they are sent here.
    const length = Number(incoming.headers['content-length'] ?? 0);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_START_BODY) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    let read = head;
    const start = () => {
      const upstream = request({
        socketPath: dockerSocket,
        method: incoming.method,
        path: incoming.url,
        headers: incoming.headers,
      });
      upstream.on('upgrade', (answer, upstreamSocket, upstreamHead) => {
        const lines = [`HTTP/1.1 ${String(answer.statusCode)} ${answer.statusMessage ?? ''}`];
        for (const [key, value] of Object.entries(answer.headers))
          lines.push(`${key}: ${String(value)}`);
        socket.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (upstreamHead.length > 0) socket.write(upstreamHead);
        // What came past the body is already the terminal's.
        if (read.length > length) upstreamSocket.write(read.subarray(length));
        upstreamSocket.pipe(socket);
        socket.pipe(upstreamSocket);
      });
      upstream.on('response', (answer) => {
        socket.end(`HTTP/1.1 ${String(answer.statusCode)} ${answer.statusMessage ?? ''}\r\n\r\n`);
      });
      upstream.on('error', () => socket.destroy());
      upstream.end(read.subarray(0, length));
    };
    if (read.length >= length) {
      start();
      return;
    }
    const more = (chunk: Buffer) => {
      read = Buffer.concat([read, chunk]);
      if (read.length < length) return;
      socket.off('data', more);
      socket.pause();
      start();
    };
    socket.on('data', more);
  });
  return server;
}
