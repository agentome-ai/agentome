import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dockerAttachAt } from './docker.js';
import { dockerGuard } from './docker-guard.js';

// The guard as a launcher reaches it, on its socket, with a Docker of its own behind it: what
// Docker is sent, and what never reaches it.

let dir: string;
let docker: Server;
let guard: Server;
const got: { method: string; path: string; body: string }[] = [];
const labels: Record<string, Record<string, string>> = {
  'agentome-place-0a1b2c3d': { 'ai.agentome.place': '0a1b2c3d' },
  // The installation's egress proxy: a name like a place's, compose's labels.
  'agentome-place-egress-1': {
    'com.docker.compose.project': 'agentome',
    'com.docker.compose.service': 'place-egress',
  },
};

const listen = (server: Server, path: string) =>
  new Promise<void>((resolve) => server.listen(path, resolve));

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentome-guard-'));
  docker = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      const path = (incoming.url ?? '').replace(/^\/v\d+\.\d+/, '');
      got.push({ method: incoming.method ?? '', path, body: Buffer.concat(chunks).toString() });
      const inspected = /^\/containers\/([^/?]+)\/json$/.exec(path);
      if (inspected) {
        const found = labels[decodeURIComponent(inspected[1] ?? '')];
        outgoing.writeHead(found ? 200 : 404, { 'content-type': 'application/json' });
        outgoing.end(JSON.stringify(found ? { Id: 'abc', Config: { Labels: found } } : {}));
        return;
      }
      outgoing.writeHead(201, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify({ Id: 'e1' }));
    });
  });
  // A terminal, as Docker starts one: the start's options read first, then 101 and the shell.
  docker.on('upgrade', (incoming, socket, head: Buffer) => {
    const length = Number(incoming.headers['content-length'] ?? 0);
    let read = head;
    const answer = () => {
      const path = (incoming.url ?? '').replace(/^\/v\d+\.\d+/, '');
      got.push({ method: incoming.method ?? '', path, body: read.subarray(0, length).toString() });
      socket.write('HTTP/1.1 101 UPGRADED\r\nconnection: Upgrade\r\nupgrade: tcp\r\n\r\n');
      socket.on('data', (chunk: Buffer) => socket.write(`typed ${chunk.toString()}`));
      socket.write('hello from the place\n');
    };
    if (read.length >= length) return answer();
    const more = (chunk: Buffer) => {
      read = Buffer.concat([read, chunk]);
      if (read.length < length) return;
      socket.off('data', more);
      answer();
    };
    socket.on('data', more);
  });
  await listen(docker, join(dir, 'docker.sock'));
  guard = dockerGuard(
    join(dir, 'docker.sock'),
    { runtimes: ['runsc'], peers: ['app', 'place-egress'] },
    () => undefined,
  );
  await listen(guard, join(dir, 'guard.sock'));
});

afterAll(() => {
  guard?.close();
  docker?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function call(method: string, path: string, body?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const sent = request(
      {
        socketPath: join(dir, 'guard.sock'),
        method,
        path,
        headers: body ? { 'content-type': 'application/json' } : {},
      },
      (answer) => {
        answer.resume();
        answer.on('end', () => resolve(answer.statusCode ?? 0));
      },
    );
    sent.on('error', reject);
    sent.end(body);
  });
}

describe('the docker guard on its socket', () => {
  it('sends Docker its own writing of a body it checked, never the bytes it was given', async () => {
    got.length = 0;
    const body = `{
      "Labels": {"ai.agentome.place": "0a1b2c3d"},
      "HostConfig": {"NetworkMode": "agentome-place-0a1b2c3d"}
    }`;
    expect(
      await call('POST', '/v1.45/containers/create?name=agentome-place-0a1b2c3d-x', body),
    ).toBe(201);
    expect(got.at(-1)?.body).toBe(JSON.stringify(JSON.parse(body)));
    // The same with a field Docker reads in any case: refused, Docker never asked.
    got.length = 0;
    const sneaky = body.replace('"HostConfig": {', '"HostConfig": {"privileged": true, ');
    expect(
      await call('POST', '/v1.45/containers/create?name=agentome-place-0a1b2c3d-x', sneaky),
    ).toBe(403);
    expect(got).toEqual([]);
  });

  it("acts on a launcher's container by its labels, and not on the installation's", async () => {
    const exec = JSON.stringify({ User: '1000:1000', Cmd: ['bash'] });
    expect(await call('POST', '/v1.45/containers/agentome-place-0a1b2c3d/exec', exec)).toBe(201);
    got.length = 0;
    expect(await call('POST', '/v1.45/containers/agentome-place-egress-1/exec', exec)).toBe(403);
    expect(await call('DELETE', '/v1.45/containers/agentome-place-egress-1?force=true')).toBe(403);
    // Docker was only asked who they are.
    expect(got.every((call) => call.method === 'GET' && call.path.endsWith('/json'))).toBe(true);
  });

  it('opens a terminal: the start reaches Docker with its options, then bytes go both ways', async () => {
    got.length = 0;
    const exec = JSON.stringify({ AttachStdin: true, Tty: true, User: '1000:1000', Cmd: ['bash'] });
    expect(await call('POST', '/v1.45/containers/agentome-place-0a1b2c3d/exec', exec)).toBe(201);
    const shell = await dockerAttachAt(join(dir, 'guard.sock'))('e1');
    const said: string[] = [];
    shell.on('data', (chunk: Buffer) => said.push(chunk.toString()));
    shell.write('ls');
    await expect.poll(() => said.join('')).toBe('hello from the place\ntyped ls');
    shell.destroy();
    expect(got.at(-1)).toEqual({
      method: 'POST',
      path: '/exec/e1/start',
      body: '{"Detach":false,"Tty":true}',
    });
  });

  it('waits for options that come after the headers, and refuses an exec it did not see made', async () => {
    const exec = JSON.stringify({ Tty: true, User: '1000:1000', Cmd: ['bash'] });
    expect(await call('POST', '/v1.45/containers/agentome-place-0a1b2c3d/exec', exec)).toBe(201);
    const talk = (path: string, late: boolean) =>
      new Promise<string>((resolve) => {
        const body = '{"Detach":false,"Tty":true}';
        const socket = connect(join(dir, 'guard.sock'));
        let text = '';
        socket.on('data', (chunk: Buffer) => {
          text += chunk.toString();
          if (text.includes('hello') || text.startsWith('HTTP/1.1 403')) socket.destroy();
        });
        socket.on('close', () => resolve(text));
        socket.write(
          `POST ${path} HTTP/1.1\r\nhost: docker\r\ncontent-type: application/json\r\n` +
            `content-length: ${String(body.length)}\r\nconnection: Upgrade\r\nupgrade: tcp\r\n\r\n`,
        );
        if (late) setTimeout(() => socket.write(body), 50);
        else socket.write(body);
      });
    expect(await talk('/v1.45/exec/e1/start', true)).toMatch(
      /^HTTP\/1\.1 101[\s\S]*hello from the place/,
    );
    // Each exec opens once.
    expect(await talk('/v1.45/exec/e1/start', false)).toMatch(/^HTTP\/1\.1 403/);
  });
});
