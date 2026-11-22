import { createServer, request, type Server } from 'node:http';
import { connect, createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  addressAllowed,
  type EgressEvent,
  egressProxy,
  type HostsOf,
  serverNameOf,
} from './egress-proxy.js';
import { hostAllowed, ownHost, withinBudget } from './egress.js';

// The egress proxy between a place and the world, against targets on this machine. Names stand
// for hosts: `opened.test` is one a run's project opens, `closed.test` one it does not; both
// resolve to 127.0.0.1, which the proxy is told it may reach here (its own check refuses it).

let httpPort = 0;
let tcpPort = 0;
const hostsOf: HostsOf = async (kind, id, token) => {
  if (kind === 'run' && token === 'the run token') {
    return { who: 'run r1', hosts: [`opened.test:${httpPort}`, `opened.test:${tcpPort}`] };
  }
  if (kind === 'seat' && id === undefined && token === 'the seat token') {
    return { who: 'seat s1', hosts: [`opened.test:${tcpPort}`] };
  }
  if (kind === 'place' && id === 'p1' && token === 'the place token') {
    return { who: 'place p1', hosts: ['*.example.com'] };
  }
  return undefined;
};
const lookup = async (host: string) =>
  host.endsWith('.test') ? [{ address: '127.0.0.1' }] : Promise.reject(new Error('no such host'));

const logged: string[] = [];
let proxy: Server;
let target: Server;
let raw: ReturnType<typeof createTcpServer>;
/** What the raw target heard on each connection. */
const heard: Buffer[] = [];
let proxyPort = 0;

function listen(server: { listen: (port: number, host: string, done: () => void) => unknown }) {
  return new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
}

beforeAll(async () => {
  target = createServer((req, res) => {
    res.end(
      `target heard ${req.method} ${req.url} ${req.headers.host} ${req.headers['proxy-authorization'] ?? 'no proxy auth'}`,
    );
  });
  raw = createTcpServer((socket) => {
    socket.once('data', (chunk) => {
      heard.push(chunk);
      socket.end('hello from the server');
    });
  });
  proxy = egressProxy({
    hostsOf,
    report: async () => {},
    log: (line) => logged.push(line),
    lookup,
    reachable: () => true,
  });
  await Promise.all([listen(target), listen(raw), listen(proxy)]);
  httpPort = (target.address() as AddressInfo).port;
  tcpPort = (raw.address() as AddressInfo).port;
  proxyPort = (proxy.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((resolve) => proxy.close(resolve));
  await new Promise((resolve) => target.close(resolve));
  await new Promise((resolve) => raw.close(resolve));
});

const basic = (user: string, token: string) =>
  `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`;

/** A CONNECT as a CLI sends it; the proxy's status line. */
function tunnel(authority: string, auth?: string, port = proxyPort) {
  return new Promise<{ status: string; socket: Socket }>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n`,
      );
    });
    socket.once('data', (chunk: Buffer) =>
      resolve({ status: chunk.toString().split('\r\n')[0] ?? '', socket }),
    );
    socket.once('error', reject);
  });
}

/** The ClientHello Node's TLS sends for a server name, as a CLI's would be. */
async function helloFor(servername: string): Promise<Buffer> {
  const catcher = createTcpServer();
  await listen(catcher);
  const port = (catcher.address() as AddressInfo).port;
  const caught = new Promise<Buffer>((resolve) =>
    catcher.once('connection', (socket) =>
      socket.once('data', (chunk: Buffer) => {
        resolve(chunk);
        socket.destroy();
      }),
    ),
  );
  const client = tlsConnect({ host: '127.0.0.1', port, servername, rejectUnauthorized: false });
  client.on('error', () => {});
  const hello = await caught;
  client.destroy();
  await new Promise((resolve) => catcher.close(resolve));
  return hello;
}

describe('the egress rules', () => {
  it('match a host exactly or under a *. pattern, on its port, 443 by default', () => {
    expect(hostAllowed('api.anthropic.com', 443, ['*.anthropic.com'])).toEqual({
      pattern: '*.anthropic.com',
      exact: false,
    });
    expect(hostAllowed('API.Anthropic.com.', 443, ['*.anthropic.com'])).toBeDefined();
    expect(hostAllowed('anthropic.com', 443, ['*.anthropic.com'])).toBeUndefined();
    expect(hostAllowed('evilanthropic.com', 443, ['*.anthropic.com'])).toBeUndefined();
    expect(hostAllowed('api.anthropic.com.evil.io', 443, ['*.anthropic.com'])).toBeUndefined();
    expect(hostAllowed('claude.ai', 443, ['claude.ai'])).toEqual({
      pattern: 'claude.ai',
      exact: true,
    });
    expect(hostAllowed('x.claude.ai', 443, ['claude.ai'])).toBeUndefined();
    // Another port only when the pattern names it.
    expect(hostAllowed('claude.ai', 22, ['claude.ai'])).toBeUndefined();
    expect(hostAllowed('git.corp', 8443, ['git.corp:8443'])).toBeDefined();
    expect(hostAllowed('git.corp', 443, ['git.corp:8443'])).toBeUndefined();
    // Allowed from the refusals: that host only, and public addresses only.
    expect(hostAllowed('cdn.example.io', 8080, ['public:cdn.example.io:8080'])).toEqual({
      pattern: 'public:cdn.example.io:8080',
      exact: false,
    });
    expect(hostAllowed('x.cdn.example.io', 443, ['public:cdn.example.io'])).toBeUndefined();
    expect(ownHost('https://agentome.example.com')).toBe('agentome.example.com:443');
    expect(ownHost('http://localhost:4440')).toBe('localhost:4440');
  });

  it("reach no loopback, link-local or metadata address, and a company's only for an exact host", () => {
    const exact = { pattern: 'jira.corp', exact: true };
    const wild = { pattern: '*.corp', exact: false };
    for (const address of [
      '127.0.0.1',
      '::1',
      '169.254.169.254',
      '0.0.0.0',
      'fe80::1',
      '::ffff:127.0.0.1',
      // The clouds' metadata, by whatever name, and inside NAT64's prefix.
      'fd00:ec2::254',
      'fd00:ec2::23',
      'fd20:ce::254',
      '100.100.100.200',
      '168.63.129.16',
      '64:ff9b::a9fe:a9fe',
      '64:ff9b::7f00:1',
    ]) {
      expect(addressAllowed(address, exact)).toBe(false);
    }
    // A public address behind NAT64 is the public one.
    expect(addressAllowed('64:ff9b::6812:202f', wild)).toBe(true);
    for (const address of [
      '10.1.2.3',
      '192.168.10.20',
      '172.20.0.5',
      'fd00::5',
      '::ffff:10.0.0.1',
    ]) {
      expect(addressAllowed(address, exact)).toBe(true);
      expect(addressAllowed(address, wild)).toBe(false);
    }
    expect(addressAllowed('104.18.32.47', wild)).toBe(true);
  });

  it("keep a run's lines of the log to 600 a minute, so a run that holds its token cannot flood it", () => {
    const at = Date.UTC(2026, 10, 13, 12, 0, 0);
    const said: string[] = [];
    for (let n = 0; n < 700; n++) said.push(withinBudget('run flood', at + n));
    expect(said.filter((fits) => fits === 'yes')).toHaveLength(600);
    // The first line past the budget is told of once.
    expect(said.filter((fits) => fits === 'first-no')).toHaveLength(1);
    // Another run, and the next minute, have their own.
    expect(withinBudget('run quiet', at)).toBe('yes');
    expect(withinBudget('run flood', at + 60_000)).toBe('yes');
  });

  it('read the server name of a ClientHello, and nothing from what is not one', async () => {
    const hello = await helloFor('api.anthropic.com');
    expect(serverNameOf(hello)).toBe('api.anthropic.com');
    // Cut short, it waits for more; not TLS at all, it is no name.
    expect(serverNameOf(hello.subarray(0, 20))).toBeUndefined();
    expect(serverNameOf(Buffer.from('GET / HTTP/1.1\r\n\r\n'))).toBeNull();
    expect(serverNameOf(Buffer.from('SSH-2.0-OpenSSH_9.6\r\n'))).toBeNull();
  });
});

describe('the egress proxy', () => {
  it('passes TLS to the name it was asked for, the ClientHello first, then both ways', async () => {
    const { status, socket } = await tunnel(
      `opened.test:${tcpPort}`,
      basic('run', 'the run token'),
    );
    expect(status).toBe('HTTP/1.1 200 Connection established');
    const hello = await helloFor('opened.test');
    const answer = new Promise<string>((resolve) =>
      socket.once('data', (chunk) => resolve(chunk.toString())),
    );
    socket.write(hello);
    expect(await answer).toBe('hello from the server');
    expect(heard.at(-1)?.equals(hello)).toBe(true);
    socket.destroy();
  });

  it('closes a tunnel whose TLS names another server, or that is not TLS', async () => {
    for (const first of [await helloFor('evil.example.net'), Buffer.from('SSH-2.0-x\r\n')]) {
      const before = heard.length;
      const { status, socket } = await tunnel(
        `opened.test:${tcpPort}`,
        basic('run', 'the run token'),
      );
      expect(status).toBe('HTTP/1.1 200 Connection established');
      const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
      socket.write(first);
      await closed;
      expect(heard.length).toBe(before);
    }
    expect(logged).toContain(
      `run r1: refused opened.test:${tcpPort}, it said hello to evil.example.net`,
    );
    expect(logged).toContain(`run r1: refused opened.test:${tcpPort}, not TLS to a named server`);
  });

  it('refuses a host the token does not open, or on another port, without the token in its log', async () => {
    for (const authority of [`closed.test:${tcpPort}`, 'opened.test:22']) {
      const { status, socket } = await tunnel(authority, basic('run', 'the run token'));
      socket.destroy();
      expect(status).toBe('HTTP/1.1 403 Forbidden');
    }
    expect(logged).toContain(`run r1: refused closed.test:${tcpPort}`);
    expect(logged.join('\n')).not.toContain('the run token');
  });

  it("refuses a host whose address is not one a place may reach, with the proxy's own check", async () => {
    const strict = egressProxy({ hostsOf, report: async () => {}, log: () => {}, lookup });
    await listen(strict);
    const port = (strict.address() as AddressInfo).port;
    const { status, socket } = await tunnel(
      `opened.test:${tcpPort}`,
      basic('run', 'the run token'),
      port,
    );
    socket.destroy();
    expect(status).toBe('HTTP/1.1 403 Forbidden');
    await new Promise((resolve) => strict.close(resolve));
  });

  it("takes a server seat's own token as the user seat", async () => {
    const { status, socket } = await tunnel(
      `opened.test:${tcpPort}`,
      basic('seat', 'the seat token'),
    );
    socket.destroy();
    expect(status).toBe('HTTP/1.1 200 Connection established');
  });

  it('asks for credentials without them, or with a token the app refuses', async () => {
    for (const auth of [
      undefined,
      basic('run', 'forged'),
      basic('seat', 'forged'),
      basic('p2', 'the place token'),
      basic('run', '%E0%A4%A'),
      'Bearer x',
    ]) {
      const { status, socket } = await tunnel(`opened.test:${tcpPort}`, auth);
      socket.destroy();
      expect(status).toBe('HTTP/1.1 407 Proxy Authentication Required');
    }
  });

  it('refuses an IPv6 literal or an address without a port', async () => {
    for (const authority of [`[::1]:${tcpPort}`, 'opened.test']) {
      const { status, socket } = await tunnel(authority, basic('run', 'the run token'));
      socket.destroy();
      expect(status).toBe('HTTP/1.1 400 Bad Request');
    }
  });

  it("keeps a token's last answer while the app does not answer, and asks little of random tokens", async () => {
    let clock = 0;
    let asks = 0;
    let down = false;
    const steady = egressProxy({
      hostsOf: async (kind, id, token) => {
        asks += 1;
        if (down) throw new Error('the app answered 429');
        return hostsOf(kind, id, token);
      },
      report: async () => {},
      log: () => {},
      now: () => clock,
      lookup,
      reachable: () => true,
    });
    await listen(steady);
    const port = (steady.address() as AddressInfo).port;
    const status = async (token: string) => {
      const { socket, status: line } = await tunnel(
        `opened.test:${tcpPort}`,
        basic('run', token),
        port,
      );
      socket.destroy();
      return line.split(' ')[1];
    };
    expect(await status('the run token')).toBe('200');
    // The app stops answering: the run that was let out a moment ago still is.
    down = true;
    clock += 16_000;
    expect(await status('the run token')).toBe('200');
    // Random tokens from one address: the app is asked of 30 new ones a minute, then not at all.
    down = false;
    asks = 0;
    for (let i = 0; i < 40; i += 1) await status(`random ${i}`);
    // 30 new tokens a minute from this address, the run's own the first of them.
    expect(asks).toBe(29);
    // A refused token asked again counts as a new one: in a fresh minute, 30 in all.
    clock = 120_000;
    asks = 0;
    for (let i = 0; i < 30; i += 1) await status(`random ${i}`);
    expect(asks).toBe(30);
    clock += 10_001;
    await status('random 0');
    expect(asks).toBe(30);
    steady.closeAllConnections();
    await new Promise((resolve) => steady.close(resolve));
  }, 20_000);

  it('keeps an answer of the app 15 seconds, so a run does not ask it on every call', async () => {
    let clock = 0;
    let asks = 0;
    const counted = egressProxy({
      hostsOf: async (kind, id, token) => {
        asks += 1;
        return hostsOf(kind, id, token);
      },
      report: async () => {},
      log: () => {},
      now: () => clock,
      lookup,
      reachable: () => true,
    });
    await listen(counted);
    const port = (counted.address() as AddressInfo).port;
    const call = async () =>
      (
        await tunnel(`closed.test:${tcpPort}`, basic('run', 'the run token'), port)
      ).socket.destroy();
    await call();
    await call();
    expect(asks).toBe(1);
    clock += 16_000;
    await call();
    expect(asks).toBe(2);
    await new Promise((resolve) => counted.close(resolve));
  });

  it('forwards plain HTTP to an opened host and port without the credentials, and refuses another', async () => {
    const send = (url: string, auth: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request(
          {
            host: '127.0.0.1',
            port: proxyPort,
            path: url,
            headers: { 'proxy-authorization': auth },
          },
          (res) => {
            let body = '';
            res.on('data', (chunk: Buffer) => (body += chunk.toString()));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
          },
        );
        req.on('error', reject);
        req.end();
      });
    const opened = await send(
      `http://opened.test:${httpPort}/plain?x=1`,
      basic('run', 'the run token'),
    );
    // Sent to the address checked, with the host's own name.
    expect(opened).toEqual({
      status: 200,
      body: `target heard GET /plain?x=1 opened.test:${httpPort} no proxy auth`,
    });
    expect(
      (await send(`http://closed.test:${httpPort}/`, basic('run', 'the run token'))).status,
    ).toBe(403);
    expect(
      (await send(`http://opened.test:${httpPort}/`, basic('p1', 'the place token'))).status,
    ).toBe(403);
    // A name no CONNECT could carry, which the app would not read in the log: refused first.
    expect((await send(`http://a_b.test:${httpPort}/`, basic('run', 'the run token'))).status).toBe(
      400,
    );
  });

  it('tells the app of each connection it let out, with its rule and bytes, and of each refusal', async () => {
    const told: EgressEvent[] = [];
    let clock = 1_000;
    const own = egressProxy({
      hostsOf,
      report: async (events) => void told.push(...events),
      log: () => {},
      now: () => clock,
      lookup,
      reachable: () => true,
    });
    await listen(own);
    const port = (own.address() as AddressInfo).port;
    const token = basic('run', 'the run token');
    const hello = await helloFor('opened.test');
    // Two tunnels that speak TLS to their name: each its own line, as it ends.
    for (let n = 0; n < 2; n++) {
      const { socket } = await tunnel(`opened.test:${tcpPort}`, token, port);
      const ended = new Promise<void>((resolve) => socket.once('close', () => resolve()));
      socket.write(hello);
      clock += 250;
      await ended;
    }
    // One that says hello to another name, and two to a host the list does not have.
    const wrong = await tunnel(`opened.test:${tcpPort}`, token, port);
    wrong.socket.write(await helloFor('evil.example.net'));
    for (let n = 0; n < 2; n++)
      (await tunnel(`closed.test:${tcpPort}`, token, port)).socket.destroy();
    // Plain HTTP: the method, the path without its query, the answer's status.
    await new Promise<void>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path: `http://opened.test:${httpPort}/plain?secret=1`,
          method: 'GET',
          headers: { 'proxy-authorization': token },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve());
        },
      );
      req.on('error', reject);
      req.end();
    });
    await vi.waitFor(() => expect(told.length).toBe(5), { timeout: 8000 });
    const run = { kind: 'run', token: 'the run token' };
    const tunnels = told.filter((event) => event.allowed && event.method === undefined);
    expect(tunnels).toHaveLength(2);
    for (const event of tunnels) {
      expect(event).toMatchObject({
        ...run,
        host: 'opened.test',
        port: tcpPort,
        count: 1,
        rule: `opened.test:${tcpPort}`,
        sent: hello.length,
        received: 'hello from the server'.length,
        ms: 250,
      });
    }
    expect(told).toContainEqual(
      expect.objectContaining({
        ...run,
        host: 'opened.test',
        port: httpPort,
        allowed: true,
        rule: `opened.test:${httpPort}`,
        method: 'GET',
        path: '/plain',
        status: 200,
      }),
    );
    expect(told).toContainEqual({
      ...run,
      host: 'opened.test',
      port: tcpPort,
      allowed: false,
      count: 1,
      reason: 'hello',
    });
    expect(told).toContainEqual({
      ...run,
      host: 'closed.test',
      port: tcpPort,
      allowed: false,
      count: 2,
      reason: 'not-listed',
    });
    await new Promise((resolve) => own.close(resolve));
  }, 20_000);
});
