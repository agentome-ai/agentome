import { request as httpRequest, type IncomingMessage, type Server, createServer } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { hostAllowed } from './egress.js';

// The only way out of the places' network. A place sends every call out through here with a
// token in the proxy URL: a run's own while it runs, the person's place token in its terminal.
// The proxy asks the app which hosts that token opens, keeps the answer a minute, and connects
// only to those. It never reads the traffic: HTTPS passes through CONNECT as it is.

/** Whom the hosts are for, and the hosts; undefined when the app refuses the token. */
export type Opened = { who: string; hosts: string[] };
export type HostsOf = (
  kind: 'run' | 'place',
  id: string | undefined,
  token: string,
) => Promise<Opened | undefined>;

const KEEP_MS = 60_000;
const KEEP_REFUSED_MS = 10_000;
const MAX_KEPT = 2_000;
/** What the proxy did goes to the app this often; a host it lets out, once a minute a token. */
const REPORT_MS = 5_000;
const REPORT_ALLOWED_MS = 60_000;

/** A host the proxy let out or refused for one token, and how many times since the last report. */
export type EgressEvent = {
  kind: 'run' | 'place';
  id?: string;
  token: string;
  host: string;
  port: number;
  allowed: boolean;
  count: number;
};
export type Report = (events: EgressEvent[]) => Promise<void>;

/** Tells the app, which writes it to the platform's log under the run or the place. */
export function reportToServer(serverUrl: string, fetchImpl: typeof fetch = fetch): Report {
  const url = `${serverUrl.replace(/\/+$/, '')}/api/egress/events`;
  return async (events) => {
    const answer = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!answer.ok) throw new Error(`the app answered ${answer.status}`);
  };
}

/** Asks the app, as the proxy does in compose. */
export function hostsFromServer(serverUrl: string, fetchImpl: typeof fetch = fetch): HostsOf {
  const url = `${serverUrl.replace(/\/+$/, '')}/api/egress/hosts`;
  return async (kind, id, token) => {
    const answer = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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
  return user === 'run'
    ? { kind: 'run' as const, id: undefined, token }
    : { kind: 'place' as const, id: user, token };
}

/** `host:port` of a CONNECT; an IPv6 literal is not a host anybody allows. */
function targetOf(authority: string | undefined) {
  const match = /^([a-z0-9.-]+):(\d{1,5})$/i.exec(authority ?? '');
  const port = Number(match?.[2]);
  if (!match?.[1] || !(port > 0 && port < 65_536)) return undefined;
  return { host: match[1].toLowerCase(), port };
}

export function egressProxy(options: {
  hostsOf: HostsOf;
  report: Report;
  log: (line: string) => void;
  now?: () => number;
}): Server {
  const { hostsOf, report, log } = options;
  const now = options.now ?? Date.now;
  const kept = new Map<string, { opened: Opened | undefined; until: number }>();
  const pending = new Map<string, EgressEvent>();
  const reported = new Map<string, number>();

  type Credentials = NonNullable<ReturnType<typeof credentialsOf>>;
  async function openedFor(credentials: Credentials): Promise<Opened | undefined> {
    const key = `${credentials.kind}\n${credentials.id ?? ''}\n${credentials.token}`;
    const known = kept.get(key);
    if (known && known.until > now()) return known.opened;
    const opened = await hostsOf(credentials.kind, credentials.id, credentials.token);
    if (kept.size >= MAX_KEPT) {
      for (const [old, entry] of kept) if (entry.until <= now()) kept.delete(old);
      if (kept.size >= MAX_KEPT) kept.clear();
    }
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
      if (reported.size >= MAX_KEPT) reported.clear();
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

  /** Who may go where; the answer to give when not. */
  async function decide(request: IncomingMessage, host: string, port: number) {
    const credentials = credentialsOf(request.headers['proxy-authorization']);
    if (!credentials) return { status: 407 as const };
    let opened: Opened | undefined;
    try {
      opened = await openedFor(credentials);
    } catch (error) {
      log(`cannot ask the app: ${error instanceof Error ? error.message : String(error)}`);
      return { status: 503 as const };
    }
    if (!opened) return { status: 407 as const };
    const allowed = hostAllowed(host, opened.hosts);
    account(credentials, host, port, allowed);
    if (!allowed) {
      log(`${opened.who}: refused ${host}`);
      return { status: 403 as const, who: opened.who };
    }
    return { status: 200 as const, who: opened.who };
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
      const upstream = httpRequest(
        {
          host: url.hostname,
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
      const upstream = connect(target.port, target.host);
      let established = false;
      upstream.once('connect', () => {
        established = true;
        client.write('HTTP/1.1 200 Connection established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on('error', () => {
        if (!established) refuse(client, 502);
        else client.destroy();
      });
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
