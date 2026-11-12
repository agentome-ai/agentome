import { createServer, request, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type EgressEvent, egressProxy, type HostsOf } from './egress-proxy.js';
import { hostAllowed } from './egress.js';

// The egress proxy between a place and the world, against a target on this machine: 127.0.0.1
// stands for a host a project opens, `localhost` for one it does not.

const hostsOf: HostsOf = async (kind, id, token) => {
  if (kind === 'run' && token === 'the run token') return { who: 'run r1', hosts: ['127.0.0.1'] };
  if (kind === 'place' && id === 'p1' && token === 'the place token') {
    return { who: 'place p1', hosts: ['*.example.com'] };
  }
  return undefined;
};

const logged: string[] = [];
const reports: EgressEvent[] = [];
let proxy: Server;
let target: Server;
let proxyPort = 0;
let targetPort = 0;

beforeAll(async () => {
  target = createServer((req, res) => {
    res.end(
      `target heard ${req.method} ${req.url} ${req.headers['proxy-authorization'] ?? 'no proxy auth'}`,
    );
  });
  proxy = egressProxy({
    hostsOf,
    report: async (events) => void reports.push(...events),
    log: (line) => logged.push(line),
  });
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  targetPort = (target.address() as AddressInfo).port;
  proxyPort = (proxy.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((resolve) => proxy.close(resolve));
  await new Promise((resolve) => target.close(resolve));
});

const basic = (user: string, token: string) =>
  `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`;

/** A CONNECT as a CLI sends it; the proxy's status line. */
function tunnel(authority: string, auth?: string) {
  return new Promise<{ status: string; socket: import('node:net').Socket }>((resolve, reject) => {
    const socket = connect(proxyPort, '127.0.0.1', () => {
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

describe('the egress proxy', () => {
  it('matches a host exactly or under a *. pattern, and nothing that only ends alike', () => {
    expect(hostAllowed('api.anthropic.com', ['*.anthropic.com'])).toBe(true);
    expect(hostAllowed('API.Anthropic.com.', ['*.anthropic.com'])).toBe(true);
    expect(hostAllowed('anthropic.com', ['*.anthropic.com'])).toBe(false);
    expect(hostAllowed('evilanthropic.com', ['*.anthropic.com'])).toBe(false);
    expect(hostAllowed('api.anthropic.com.evil.io', ['*.anthropic.com'])).toBe(false);
    expect(hostAllowed('claude.ai', ['claude.ai'])).toBe(true);
    expect(hostAllowed('x.claude.ai', ['claude.ai'])).toBe(false);
  });

  it("tunnels a run to a host its project opens, and through the tunnel the target's answer", async () => {
    const { status, socket } = await tunnel(
      `127.0.0.1:${targetPort}`,
      basic('run', 'the run token'),
    );
    expect(status).toBe('HTTP/1.1 200 Connection established');
    const answer = new Promise<string>((resolve) =>
      socket.once('data', (chunk) => resolve(chunk.toString())),
    );
    socket.write(`GET /inside HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    // The proxy's credentials never reach the target.
    expect(await answer).toContain('target heard GET /inside no proxy auth');
    socket.destroy();
  });

  it('refuses a host the token does not open, and says so in its log without the token', async () => {
    const { status, socket } = await tunnel(
      `localhost:${targetPort}`,
      basic('run', 'the run token'),
    );
    socket.destroy();
    expect(status).toBe('HTTP/1.1 403 Forbidden');
    expect(logged).toContain('run r1: refused localhost');
    expect(logged.join('\n')).not.toContain('the run token');
  });

  it('asks for credentials without them, or with a token the app refuses', async () => {
    for (const auth of [
      undefined,
      basic('run', 'forged'),
      basic('p2', 'the place token'),
      basic('run', '%E0%A4%A'),
      'Bearer x',
    ]) {
      const { status, socket } = await tunnel(`127.0.0.1:${targetPort}`, auth);
      socket.destroy();
      expect(status).toBe('HTTP/1.1 407 Proxy Authentication Required');
    }
  });

  it('refuses an IPv6 literal or an address without a port', async () => {
    for (const authority of [`[::1]:${targetPort}`, '127.0.0.1']) {
      const { status, socket } = await tunnel(authority, basic('run', 'the run token'));
      socket.destroy();
      expect(status).toBe('HTTP/1.1 400 Bad Request');
    }
  });

  it('keeps an answer of the app a minute, so a run does not ask it on every call', async () => {
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
    });
    await new Promise<void>((resolve) => counted.listen(0, '127.0.0.1', resolve));
    const port = (counted.address() as AddressInfo).port;
    const call = () =>
      new Promise<void>((resolve) => {
        const socket = connect(port, '127.0.0.1', () =>
          socket.write(
            `CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nProxy-Authorization: ${basic('run', 'the run token')}\r\n\r\n`,
          ),
        );
        socket.once('data', () => {
          socket.destroy();
          resolve();
        });
      });
    await call();
    await call();
    expect(asks).toBe(1);
    clock += 61_000;
    await call();
    expect(asks).toBe(2);
    await new Promise((resolve) => counted.close(resolve));
  });

  it('forwards plain HTTP to an opened host without the credentials, and refuses another', async () => {
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
      `http://127.0.0.1:${targetPort}/plain?x=1`,
      basic('run', 'the run token'),
    );
    expect(opened).toEqual({ status: 200, body: 'target heard GET /plain?x=1 no proxy auth' });
    const closed = await send(`http://localhost:${targetPort}/`, basic('run', 'the run token'));
    expect(closed.status).toBe(403);
    const signIn = await send(`http://127.0.0.1:${targetPort}/`, basic('p1', 'the place token'));
    expect(signIn.status).toBe(403);
  });

  it('tells the app what it let out and refused, by token, a host it let out once a minute', async () => {
    const told: EgressEvent[] = [];
    const own = egressProxy({
      hostsOf,
      report: async (events) => void told.push(...events),
      log: () => {},
    });
    await new Promise<void>((resolve) => own.listen(0, '127.0.0.1', resolve));
    const port = (own.address() as AddressInfo).port;
    const call = (authority: string) =>
      new Promise<void>((resolve) => {
        const socket = connect(port, '127.0.0.1', () =>
          socket.write(
            `CONNECT ${authority} HTTP/1.1\r\nProxy-Authorization: ${basic('run', 'the run token')}\r\n\r\n`,
          ),
        );
        socket.once('data', () => {
          socket.destroy();
          resolve();
        });
      });
    for (let n = 0; n < 3; n++) await call(`127.0.0.1:${targetPort}`);
    for (let n = 0; n < 2; n++) await call(`localhost:${targetPort}`);
    await vi.waitFor(() => expect(told.length).toBeGreaterThan(0), { timeout: 8000 });
    const run = { kind: 'run', token: 'the run token', port: targetPort };
    expect(told).toEqual([
      { ...run, host: '127.0.0.1', allowed: true, count: 3 },
      { ...run, host: 'localhost', allowed: false, count: 2 },
    ]);
    // Let out again within the minute: nothing new to tell; refused again: told again.
    told.length = 0;
    await call(`127.0.0.1:${targetPort}`);
    await call(`localhost:${targetPort}`);
    await vi.waitFor(() => expect(told.length).toBeGreaterThan(0), { timeout: 8000 });
    expect(told).toEqual([{ ...run, host: 'localhost', allowed: false, count: 1 }]);
    await new Promise((resolve) => own.close(resolve));
  }, 20_000);
});
