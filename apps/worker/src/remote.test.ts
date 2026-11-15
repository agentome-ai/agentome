import { afterAll, describe, expect, it } from 'vitest';
import { connect, createServer } from 'node:net';
import { knockOnPlace, remoteSpawn, runServer, serverReady } from './remote.js';
import { stopTree } from './platform.js';
import { sandboxMain } from './sandbox.js';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A run's container's server and the two who call it, the place's worker and the CLI container's
// `bash`, all ends here.

const KEY = 'k'.repeat(43);

async function started() {
  const { port, close } = await runServer(KEY, () => {}, 0);
  const server = { host: '127.0.0.1', port, key: KEY };
  await serverReady(server);
  return { server, close };
}

const ended = (child: { once: (event: 'close', fn: (...args: unknown[]) => void) => unknown }) =>
  new Promise<[unknown, unknown]>((resolve) =>
    child.once('close', (code, signal) => resolve([code, signal])),
  );

describe("a run's container's server", () => {
  it('starts what it is asked to, passes its input and output, and says how it ended', async () => {
    const { server, close } = await started();
    const child = remoteSpawn(server)(
      process.execPath,
      [
        '-e',
        'process.stdin.on("data", (d) => process.stdout.write(`heard ${d}`)); process.stdin.on("end", () => { console.error("bye"); process.exit(3); })',
      ],
      { env: { PATH: process.env.PATH ?? '' } },
    );
    let out = '';
    let err = '';
    child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (err += chunk.toString()));
    const closed = ended(child);
    child.stdin?.end('the task');
    expect(await closed).toEqual([3, null]);
    expect(out).toBe('heard the task');
    expect(err).toBe('bye\n');
    close();
  });

  it('stops the CLI and what it started, by its group', async () => {
    const { server, close } = await started();
    const child = remoteSpawn(server)(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      env: { PATH: process.env.PATH ?? '' },
    });
    const closed = ended(child);
    await new Promise((resolve) => setTimeout(resolve, 300));
    stopTree(child, 'SIGTERM');
    expect(await closed).toEqual([null, 'SIGTERM']);
    close();
  });

  it('takes a long environment with the spawn, but not a long first line', async () => {
    const { server, close } = await started();
    const big = { PATH: process.env.PATH ?? '', BIG: 'x'.repeat(64 * 1024) };
    const child = remoteSpawn(server)(
      process.execPath,
      ['-e', 'process.exit(process.env.BIG.length > 0 ? 0 : 1)'],
      {
        env: big,
      },
    );
    expect(await ended(child)).toEqual([0, null]);
    const long = connect(server.port, server.host);
    long.write('x'.repeat(8 * 1024));
    await new Promise((resolve) => long.once('close', resolve));
    close();
  });

  it('starts nothing for a connection without its key', async () => {
    const { server, close } = await started();
    const wrong = remoteSpawn({ ...server, key: 'x'.repeat(43) })(process.execPath, ['-e', ''], {
      env: {},
    });
    expect(await ended(wrong)).toEqual([null, 'SIGKILL']);
    // Nor for one that sends nothing but a spawn.
    const bare = connect(server.port, server.host);
    bare.write(
      `${JSON.stringify({ t: 'spawn', file: process.execPath, args: ['-e', ''], env: {} })}\n`,
    );
    let heard = '';
    bare.on('data', (chunk: Buffer) => (heard += chunk.toString()));
    await new Promise((resolve) => bare.once('close', resolve));
    expect(heard).toBe('');
    close();
  });
});

describe("a run's container, as it starts", () => {
  it('knocks once on the place, so that it learns the new container, and on nothing it cannot find', async () => {
    const knocked = new Promise<void>((resolve) => {
      const place = createServer((socket) => {
        socket.destroy();
        place.close();
        resolve();
      });
      place.listen(0, () => {
        const at = place.address();
        knockOnPlace('localhost', typeof at === 'object' && at ? at.port : 0);
      });
    });
    await knocked;
    // No place in /etc/hosts, as on Kubernetes: nothing happens, nothing throws.
    expect(() => knockOnPlace('no-such-place.invalid')).not.toThrow();
  });
});

describe("the CLI container's bash and git", () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentome-sandbox-'));
  const file = join(dir, 'sandbox.json');
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('runs the command in the sandbox, with their environment, and exits as it did', async () => {
    const { server, close } = await started();
    writeFileSync(
      file,
      JSON.stringify({ server, env: { PATH: process.env.PATH, HTTPS_PROXY: 'http://run' } }),
    );
    const stdout = new PassThrough();
    let out = '';
    stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    const stdin = new PassThrough();
    stdin.end();
    const code = await sandboxMain(
      ['bash', '-c', 'echo "proxy=$HTTPS_PROXY cli=${CLI_SECRET:-none} term=$TERM"; exit 7'],
      { CLI_SECRET: 'the sign-in', HTTPS_PROXY: 'http://cli', TERM: 'xterm' },
      { stdin, stdout, stderr: new PassThrough() },
      dir,
      file,
    );
    expect(code).toBe(7);
    expect(out.trim()).toBe('proxy=http://run cli=none term=xterm');
    close();
  });

  it('brings back where the shell was left, into a file of the CLI container, never through a link', async () => {
    const { server, close } = await started();
    writeFileSync(file, JSON.stringify({ server, env: { PATH: process.env.PATH } }));
    const named = `/tmp/claude-${process.pid.toString(16)}a-cwd`;
    rmSync(named, { force: true });
    const code = await sandboxMain(
      ['bash', '-c', `cd / && pwd -P >| ${named}`],
      {},
      { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() },
      dir,
      file,
    );
    expect(code).toBe(0);
    expect(readFileSync(named, 'utf8').trim()).toBe('/');
    rmSync(named, { force: true });
    close();
  });

  it('runs nothing in a CLI container without its sandbox, and nothing but bash and git', async () => {
    const stderr = new PassThrough();
    let err = '';
    stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    const none = { stdin: new PassThrough(), stdout: new PassThrough(), stderr };
    expect(await sandboxMain(['bash', '-c', 'true'], {}, none, dir, join(dir, 'none.json'))).toBe(
      126,
    );
    expect(err).toMatch(/no sandbox/);
    expect(await sandboxMain(['sh', '-c', 'true'], {}, none, dir, file)).toBe(126);
  });
});
