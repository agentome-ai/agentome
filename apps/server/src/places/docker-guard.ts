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

type Body = Record<string, unknown> | undefined;
type HostConfig = Record<string, unknown>;

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
  const host = (body?.HostConfig ?? {}) as HostConfig;
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
  if (runtime !== undefined && !settings.runtimes.includes(String(runtime))) {
    return no(`a container on the runtime ${String(runtime)}`);
  }
  // Capabilities and unconfined profiles are a run's own Docker's, which needs them inside
  // gVisor's kernel; nowhere else.
  const sandboxed = settings.sandboxRuntime !== undefined && runtime === settings.sandboxRuntime;
  if (!empty(host.CapAdd) && !sandboxed) return no('a container that adds capabilities');
  const opts = (host.SecurityOpt ?? []) as string[];
  if (!sandboxed && opts.some((opt) => /unconfined|label[=:]disable/.test(opt))) {
    return no('a container without its security profile');
  }
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
  if (method === 'POST' && route === '/images/create') return OK;
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
      if (body?.Privileged === true) return no('a privileged exec');
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
      let body: Body;
      try {
        body = raw.length ? (JSON.parse(raw.toString('utf8')) as Body) : undefined;
      } catch {
        body = undefined;
      }
      const send = (status: number, text: string) => {
        outgoing.writeHead(status, { 'content-type': 'application/json' });
        outgoing.end(text);
      };
      const verdict = callAllowed(method, path, body, settings);
      if (!verdict.ok) return refuse(send, verdict.why);
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
            ...(raw.length > 0 && {
              'content-type': 'application/json',
              'content-length': raw.length,
            }),
          },
        },
        (answer) => {
          const inspected = /^\/containers\/([^/?]+)\/json$/.exec(path.split('?')[0] ?? '');
          const exec = method === 'POST' && /^\/containers\/[^/]+\/exec$/.test(path);
          if (!inspected && !exec) {
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
                : said;
            send(answer.statusCode ?? 502, out === undefined ? '' : JSON.stringify(out));
          });
        },
      );
      upstream.on('error', (error) => send(502, JSON.stringify({ message: error.message })));
      upstream.end(raw.length ? raw : undefined);
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
      if (head.length > 0) upstreamSocket.write(head);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    });
    upstream.on('response', (answer) => {
      socket.end(`HTTP/1.1 ${String(answer.statusCode)} ${answer.statusMessage ?? ''}\r\n\r\n`);
    });
    upstream.on('error', () => socket.destroy());
    incoming.pipe(upstream);
  });
  return server;
}
