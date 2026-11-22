import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage, type Server, createServer } from 'node:http';
import { BlockList, connect, isIP } from 'node:net';
import type { Duplex } from 'node:stream';
import { type HostMatch, hostAllowed } from './egress.js';

// The only way out of the places' network, and of the server seat's. A place sends every call
// out through here with a token in the proxy URL: a run's own while it runs, the person's place
// token in its terminal; the server seat its own, to install its CLI.
// The proxy asks the app which hosts that token opens, keeps the answer 15 seconds, and connects
// only to those, on their port, at an address it checked. Through CONNECT only TLS passes, to
// the server name that was asked for: the proxy reads the ClientHello for it, and nothing else.

/** Whom the hosts are for, and the hosts; undefined when the app refuses the token. */
export type Opened = { who: string; hosts: string[] };
export type HostsOf = (
  kind: 'run' | 'cli' | 'docker' | 'place' | 'seat',
  id: string | undefined,
  token: string,
) => Promise<Opened | undefined>;

// A run that ends, a host taken off a project's list: closed within this long.
const KEEP_MS = 15_000;
const KEEP_REFUSED_MS = 10_000;
const MAX_KEPT = 2_000;
/** New tokens the app does not know, from one address in a minute, before the app is asked no more. */
const UNKNOWN_A_MINUTE = 30;

/** Drops a map's oldest entries until it has room: the newest are the ones in use. */
function makeRoom<K, V>(map: Map<K, V>, max: number) {
  for (const key of map.keys()) {
    if (map.size < max) return;
    map.delete(key);
  }
}
/** What the proxy did goes to the app this often; a host it lets out, once a minute a token. */
const REPORT_MS = 5_000;
const REPORT_ALLOWED_MS = 60_000;

/** A host the proxy let out or refused for one token, and how many times since the last report. */
export type EgressEvent = {
  kind: 'run' | 'cli' | 'docker' | 'place' | 'seat';
  id?: string;
  token: string;
  host: string;
  port: number;
  allowed: boolean;
  count: number;
};
export type Report = (events: EgressEvent[]) => Promise<void>;

/** Tells the app, which writes it to the platform's log under the run or the place. */
/** The header the proxy shows its key to the app in (egress.ts). */
const KEY_HEADER = 'x-agentome-egress';

export function reportToServer(
  serverUrl: string,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Report {
  const url = `${serverUrl.replace(/\/+$/, '')}/api/egress/events`;
  return async (events) => {
    const answer = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [KEY_HEADER]: key },
      body: JSON.stringify({ events }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!answer.ok) throw new Error(`the app answered ${answer.status}`);
  };
}

/** Asks the app, as the proxy does in compose. */
export function hostsFromServer(
  serverUrl: string,
  key: string,
  fetchImpl: typeof fetch = fetch,
): HostsOf {
  const url = `${serverUrl.replace(/\/+$/, '')}/api/egress/hosts`;
  return async (kind, id, token) => {
    const answer = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [KEY_HEADER]: key },
      body: JSON.stringify({ kind, ...(id !== undefined && { id }), token }),
      signal: AbortSignal.timeout(10_000),
    });
    if (answer.status === 401 || answer.status === 400) return undefined;
    if (!answer.ok) throw new Error(`the app answered ${answer.status}`);
    return (await answer.json()) as Opened;
  };
}

/** `Proxy-Authorization: Basic run:<token>` or `<person id>:<place token>`. */
function credentialsOf(header: string | undefined) {
  const encoded = /^Basic\s+(\S+)$/i.exec(header ?? '')?.[1];
  if (!encoded) return undefined;
  const text = Buffer.from(encoded, 'base64').toString('utf8');
  const colon = text.indexOf(':');
  if (colon <= 0) return undefined;
  let user: string;
  let token: string;
  try {
    user = decodeURIComponent(text.slice(0, colon));
    token = decodeURIComponent(text.slice(colon + 1));
  } catch {
    // Not percent-encoding: not credentials of ours.
    return undefined;
  }
  if (!token) return undefined;
  if (user === 'run' || user === 'seat') {
    return { kind: user === 'run' ? ('run' as const) : ('seat' as const), id: undefined, token };
  }
  // A run's CLI container: `cli-<run id>`.
  if (user.startsWith('cli-')) return { kind: 'cli' as const, id: user.slice(4), token };
  // A run's own Docker: `docker-<run id>`.
  if (user.startsWith('docker-')) return { kind: 'docker' as const, id: user.slice(7), token };
  return { kind: 'place' as const, id: user, token };
}

/** `host:port` of a CONNECT; an IPv6 literal is not a host anybody allows. */
function targetOf(authority: string | undefined) {
  const match = /^([a-z0-9.-]+):(\d{1,5})$/i.exec(authority ?? '');
  const port = Number(match?.[2]);
  if (!match?.[1] || !(port > 0 && port < 65_536)) return undefined;
  return { host: match[1].toLowerCase(), port };
}

/** Addresses nothing may reach: the proxy's own machine, link-local (cloud metadata), multicast. */
const NEVER = new BlockList();
NEVER.addSubnet('0.0.0.0', 8);
NEVER.addSubnet('127.0.0.0', 8);
NEVER.addSubnet('169.254.0.0', 16);
NEVER.addSubnet('224.0.0.0', 4);
NEVER.addSubnet('240.0.0.0', 4);
NEVER.addAddress('::', 'ipv6');
NEVER.addAddress('::1', 'ipv6');
NEVER.addSubnet('fe80::', 10, 'ipv6');
NEVER.addSubnet('ff00::', 8, 'ipv6');
// The clouds' own metadata services, wherever they are: AWS's over IPv6, Alibaba's, Azure's wire
// server. Whatever name resolves to them, never (review P9).
NEVER.addAddress('fd00:ec2::254', 'ipv6');
NEVER.addAddress('100.100.100.200');
NEVER.addAddress('168.63.129.16');
/** The company's own networks: reached only for a host listed exactly, never through a `*.`. */
const PRIVATE = new BlockList();
PRIVATE.addSubnet('10.0.0.0', 8);
PRIVATE.addSubnet('172.16.0.0', 12);
PRIVATE.addSubnet('192.168.0.0', 16);
PRIVATE.addSubnet('100.64.0.0', 10);
PRIVATE.addSubnet('fc00::', 7, 'ipv6');

/** Whether a host's address may be reached, given how the host was allowed. */
export function addressAllowed(address: string, match: HostMatch): boolean {
  // An IPv4 address written as IPv6 (::ffff:10.0.0.1) is judged as the IPv4 one.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  // So is one inside NAT64's prefix (64:ff9b::a9fe:a9fe is 169.254.169.254), wherever it leads.
  const nat64 = /^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  const translated = nat64
    ? [parseInt(nat64[1] ?? '0', 16), parseInt(nat64[2] ?? '0', 16)]
        .flatMap((word) => [word >> 8, word & 0xff])
        .join('.')
    : undefined;
  const ip = mapped ?? translated ?? address;
  const family = isIP(ip) === 6 ? 'ipv6' : 'ipv4';
  if (isIP(ip) === 0 || NEVER.check(ip, family)) return false;
  return match.exact || !PRIVATE.check(ip, family);
}

export type Lookup = (host: string) => Promise<{ address: string }[]>;
const systemLookup: Lookup = (host) => dnsLookup(host, { all: true, verbatim: true });

/** How long a client has to send its ClientHello, and how much of it the proxy reads. */
const HELLO_MS = 10_000;
const MAX_HELLO = 64 * 1024;

/**
 * The server name of a TLS ClientHello, once `bytes` hold all of it: a string, `null` when it
 * names none or is not TLS, `undefined` while more is needed.
 */
export function serverNameOf(bytes: Buffer): string | null | undefined {
  // The handshake message may span records: put their payloads together.
  const handshake: Buffer[] = [];
  let at = 0;
  let length = 0;
  while (at + 5 <= bytes.length) {
    if (bytes[at] !== 0x16) return null;
    const size = bytes.readUInt16BE(at + 3);
    if (at + 5 + size > bytes.length) break;
    handshake.push(bytes.subarray(at + 5, at + 5 + size));
    length += size;
    at += 5 + size;
  }
  if (at === 0 && bytes.length >= 1 && bytes[0] !== 0x16) return null;
  const message = Buffer.concat(handshake, length);
  if (message.length < 4) return undefined;
  if (message[0] !== 0x01) return null;
  const end = 4 + message.readUIntBE(1, 3);
  if (message.length < end) return undefined;
  try {
    // version 2, random 32, then the session id, the ciphers and the compressions by their lengths.
    let i = 4 + 2 + 32;
    i += 1 + message.readUInt8(i);
    i += 2 + message.readUInt16BE(i);
    i += 1 + message.readUInt8(i);
    if (i + 2 > end) return null;
    const extensionsEnd = i + 2 + message.readUInt16BE(i);
    i += 2;
    while (i + 4 <= extensionsEnd && extensionsEnd <= end) {
      const type = message.readUInt16BE(i);
      const size = message.readUInt16BE(i + 2);
      if (type === 0) {
        // server_name: a list of (type 0, length, name); the first host name is the one.
        let j = i + 4 + 2;
        while (j + 3 <= i + 4 + size) {
          const nameLength = message.readUInt16BE(j + 1);
          if (message[j] === 0) {
            return message.toString('ascii', j + 3, j + 3 + nameLength).toLowerCase();
          }
          j += 3 + nameLength;
        }
        return null;
      }
      i += 4 + size;
    }
  } catch {
    // A length that points past the message: not a ClientHello anyone sends.
    return null;
  }
  return null;
}

/** Reads the client's ClientHello after the tunnel is open; what it read goes on to the server. */
function helloOf(client: Duplex, head: Buffer): Promise<{ bytes: Buffer; name: string | null }> {
  return new Promise((resolve) => {
    let bytes = head;
    const done = (name: string | null) => {
      clearTimeout(timer);
      client.off('data', onData);
      client.off('close', onClose);
      client.pause();
      resolve({ bytes, name });
    };
    const check = () => {
      const name = serverNameOf(bytes);
      if (name !== undefined) done(name);
      else if (bytes.length > MAX_HELLO) done(null);
    };
    const onData = (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      check();
    };
    const onClose = () => done(null);
    const timer = setTimeout(() => done(null), HELLO_MS);
    client.on('data', onData);
    client.on('close', onClose);
    if (bytes.length > 0) check();
  });
}

export function egressProxy(options: {
  hostsOf: HostsOf;
  report: Report;
  log: (line: string) => void;
  now?: () => number;
  lookup?: Lookup;
  /** Whether an address may be reached; tests on this machine let loopback through. */
  reachable?: typeof addressAllowed;
}): Server {
  const { hostsOf, report, log } = options;
  const now = options.now ?? Date.now;
  const lookup = options.lookup ?? systemLookup;
  const reachable = options.reachable ?? addressAllowed;
  const kept = new Map<string, { opened: Opened | undefined; until: number }>();
  // Unknown tokens per address and minute: random tokens from one run cost the app nothing.
  const unknownFrom = new Map<string, { minute: number; count: number }>();
  const pending = new Map<string, EgressEvent>();
  const reported = new Map<string, number>();

  type Credentials = NonNullable<ReturnType<typeof credentialsOf>>;
  async function openedFor(credentials: Credentials, from: string): Promise<Opened | undefined> {
    const key = `${credentials.kind}\n${credentials.id ?? ''}\n${credentials.token}`;
    const known = kept.get(key);
    if (known && known.until > now()) return known.opened;
    // A token the proxy has not seen: one more from this address this minute, or no question.
    if (!known) {
      const minute = Math.floor(now() / 60_000);
      const tried = unknownFrom.get(from);
      const count = tried?.minute === minute ? tried.count + 1 : 1;
      unknownFrom.delete(from);
      makeRoom(unknownFrom, MAX_KEPT);
      unknownFrom.set(from, { minute, count });
      if (count > UNKNOWN_A_MINUTE) return undefined;
    }
    let opened: Opened | undefined;
    try {
      opened = await hostsOf(credentials.kind, credentials.id, credentials.token);
    } catch (error) {
      // The app did not answer: a token it opened a moment ago keeps what it opened, rather than
      // every place losing its way out together.
      if (known?.opened) return known.opened;
      throw error;
    }
    kept.delete(key);
    makeRoom(kept, MAX_KEPT);
    kept.set(key, { opened, until: now() + (opened ? KEEP_MS : KEEP_REFUSED_MS) });
    return opened;
  }

  /** Notes a host let out or refused, for the next report: a host let out, once a minute. */
  function account(credentials: Credentials, host: string, port: number, allowed: boolean) {
    const key = `${credentials.kind}\n${credentials.id ?? ''}\n${credentials.token}\n${host}:${port}\n${allowed}`;
    const waiting = pending.get(key);
    if (waiting) {
      waiting.count += 1;
      return;
    }
    if (allowed && now() - (reported.get(key) ?? -Infinity) < REPORT_ALLOWED_MS) return;
    if (reported.size >= MAX_KEPT) {
      for (const [old, at] of reported) if (now() - at >= REPORT_ALLOWED_MS) reported.delete(old);
      makeRoom(reported, MAX_KEPT);
    }
    reported.set(key, now());
    pending.set(key, {
      kind: credentials.kind,
      ...(credentials.id !== undefined && { id: credentials.id }),
      token: credentials.token,
      host,
      port,
      allowed,
      count: 1,
    });
  }

  const reporting = setInterval(() => {
    if (pending.size === 0) return;
    const events = [...pending.values()].slice(0, 500);
    pending.clear();
    report(events).catch((error: unknown) =>
      log(`cannot tell the app: ${error instanceof Error ? error.message : String(error)}`),
    );
  }, REPORT_MS);
  reporting.unref();

  /** Who may go where, and at which address; the answer to give when not. */
  async function decide(request: IncomingMessage, host: string, port: number) {
    const credentials = credentialsOf(request.headers['proxy-authorization']);
    if (!credentials) return { status: 407 as const };
    let opened: Opened | undefined;
    try {
      opened = await openedFor(credentials, request.socket.remoteAddress ?? '');
    } catch (error) {
      log(`cannot ask the app: ${error instanceof Error ? error.message : String(error)}`);
      return { status: 503 as const };
    }
    if (!opened) return { status: 407 as const };
    const match = hostAllowed(host, port, opened.hosts);
    let address: string | undefined;
    if (match) {
      try {
        const found = isIP(host) ? [{ address: host }] : await lookup(host);
        address = found.find((entry) => reachable(entry.address, match))?.address;
      } catch {
        // A name that does not resolve has no address to allow.
      }
    }
    account(credentials, host, port, address !== undefined);
    if (!match) {
      log(`${opened.who}: refused ${host}:${port}`);
      return { status: 403 as const, who: opened.who };
    }
    if (!address) {
      log(`${opened.who}: refused ${host}:${port}, its address is not one a place may reach`);
      return { status: 403 as const, who: opened.who };
    }
    return { status: 200 as const, who: opened.who, address };
  }

  const server = createServer((request, response) => {
    // Plain HTTP, sent whole: GET http://host/path.
    void (async () => {
      let url: URL;
      try {
        url = new URL(request.url ?? '');
      } catch {
        response.writeHead(400).end();
        return;
      }
      if (url.protocol !== 'http:') {
        response.writeHead(400).end();
        return;
      }
      const verdict = await decide(request, url.hostname.toLowerCase(), Number(url.port || 80));
      if (verdict.status !== 200) {
        response.writeHead(verdict.status, proxyHeaders(verdict.status)).end();
        return;
      }
      const headers = { ...request.headers };
      delete headers['proxy-authorization'];
      delete headers['proxy-connection'];
      // The host asked for, whatever the client put in Host: the address is the one checked.
      headers.host = url.host;
      // The address checked, with the host's name kept in the Host header it came with.
      const upstream = httpRequest(
        {
          host: verdict.address,
          port: url.port || 80,
          path: `${url.pathname}${url.search}`,
          method: request.method,
          headers,
        },
        (answer) => {
          response.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(response);
        },
      );
      upstream.on('error', () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      request.pipe(upstream);
    })();
  });

  server.on('connect', (request: IncomingMessage, client: Duplex, head: Buffer) => {
    client.on('error', () => client.destroy());
    void (async () => {
      const target = targetOf(request.url);
      if (!target) return refuse(client, 400);
      const verdict = await decide(request, target.host, target.port);
      if (verdict.status !== 200) return refuse(client, verdict.status);
      // The tunnel opens, the client says hello, and only TLS to the name it asked for goes on.
      client.write('HTTP/1.1 200 Connection established\r\n\r\n');
      const hello = await helloOf(client, head);
      if (hello.name !== target.host) {
        log(
          `${verdict.who}: refused ${target.host}:${target.port}, ` +
            (hello.name ? `it said hello to ${hello.name}` : 'not TLS to a named server'),
        );
        client.destroy();
        return;
      }
      const upstream = connect(target.port, verdict.address);
      upstream.once('connect', () => {
        upstream.write(hello.bytes);
        upstream.pipe(client);
        client.pipe(upstream);
        client.resume();
      });
      upstream.on('error', () => client.destroy());
      client.on('close', () => upstream.destroy());
    })();
  });
  server.on('close', () => clearInterval(reporting));
  return server;
}

function proxyHeaders(status: number): Record<string, string> {
  return status === 407 ? { 'proxy-authenticate': 'Basic realm="agentome"' } : {};
}

function refuse(client: Duplex, status: 400 | 403 | 407 | 502 | 503) {
  const reason = {
    400: 'Bad Request',
    403: 'Forbidden',
    407: 'Proxy Authentication Required',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
  }[status];
  const extra = status === 407 ? 'Proxy-Authenticate: Basic realm="agentome"\r\n' : '';
  client.end(`HTTP/1.1 ${status} ${reason}\r\n${extra}Content-Length: 0\r\n\r\n`);
}
