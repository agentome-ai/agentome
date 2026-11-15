import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connect, serverUrl } from './connect.js';
import { parse } from './cli.js';
import { markLines } from './banner.js';
import type { Exec } from './system.js';

// `agentome connect` against a server of the test's own, which hands out a worker and its checksum.

let root: string;
let env: NodeJS.ProcessEnv;
const WORKER = 'console.log("the worker")\n';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentome-connect-'));
  mkdirSync(join(root, 'tools'));
  // Claude Code is installed.
  writeFileSync(join(root, 'tools', 'claude'), '', { mode: 0o755 });
  env = { PATH: join(root, 'tools'), AGENTOME_WORKER_HOME: join(root, 'home') };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function server(sha256 = createHash('sha256').update(WORKER).digest('hex')) {
  const asked: string[] = [];
  const fetchImpl = (async (url: string) => {
    asked.push(url);
    if (url.endsWith('/connect/worker.json')) return Response.json({ sha256 });
    if (url.endsWith('/connect/agentome-worker.mjs')) return new Response(WORKER);
    return new Response('', { status: 404 });
  }) as typeof fetch;
  const ran: string[][] = [];
  const exec: Exec = async (_command, args) => {
    ran.push(args);
    return { code: 0, stdout: '' };
  };
  return { fetchImpl, asked, exec, ran };
}

describe('agentome connect', () => {
  it('installs the server’s worker by its checksum, connects with the code and starts the service', async () => {
    const { fetchImpl, asked, exec, ran } = server();
    const said: string[] = [];
    await connect('K7QX-M2PH', 'agentome.corp.example/', {
      exec,
      fetch: fetchImpl,
      say: (line) => said.push(line),
      env,
      platform: 'linux',
    });
    expect(asked).toEqual([
      'https://agentome.corp.example/connect/worker.json',
      'https://agentome.corp.example/connect/agentome-worker.mjs',
    ]);
    const worker = join(root, 'home', 'bin', 'agentome-worker.mjs');
    expect(readFileSync(worker, 'utf8')).toBe(WORKER);
    expect(existsSync(join(root, 'home', 'bin', 'agentome-worker'))).toBe(true);
    expect(ran).toEqual([
      [worker, 'connect', 'K7QX-M2PH', '--server', 'https://agentome.corp.example'],
      [worker, 'install-service'],
    ]);
  });

  it('installs nothing that does not match its checksum', async () => {
    const { fetchImpl, exec, ran } = server('0'.repeat(64));
    await expect(
      connect('K7QX-M2PH', 'https://agentome.corp.example', {
        exec,
        fetch: fetchImpl,
        say: () => {},
        env,
        platform: 'linux',
      }),
    ).rejects.toThrow(/does not match its checksum/);
    expect(existsSync(join(root, 'home', 'bin', 'agentome-worker.mjs'))).toBe(false);
    expect(ran).toEqual([]);
  });

  it('asks for Claude Code or Codex first, and warns of plain HTTP to another machine', async () => {
    const { fetchImpl, exec } = server();
    await expect(
      connect('K7QX-M2PH', 'https://a.example', {
        exec,
        fetch: fetchImpl,
        say: () => {},
        env: { ...env, PATH: root },
        platform: 'linux',
      }),
    ).rejects.toThrow(/Claude Code or Codex is needed/);
    await expect(
      connect('K7QX-M2PH', 'http://10.0.0.5:3000', {
        exec,
        fetch: fetchImpl,
        say: () => {},
        env,
        platform: 'linux',
      }),
    ).rejects.toThrow(/plain HTTP across a network/);
  });

  it('reads an address as people type it', () => {
    expect(serverUrl('agentome.corp.example')).toBe('https://agentome.corp.example');
    expect(serverUrl('http://localhost:3000/')).toBe('http://localhost:3000');
  });
});

describe('the program', () => {
  it('reads flags and words in order', () => {
    const { flags, rest } = parse(['install', '--dir', 'srv', '--places', '--port=3300', '--yes']);
    expect(rest).toEqual(['install']);
    expect(Object.fromEntries(flags)).toEqual({
      dir: 'srv',
      places: true,
      port: '3300',
      yes: true,
    });
  });

  it('draws the mark as twelve lines of two pixel rows each', () => {
    const lines = markLines();
    expect(lines).toHaveLength(12);
    expect(lines[0]).toContain('▀');
  });
});
