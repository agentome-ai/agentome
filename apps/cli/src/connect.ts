import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { Exec } from './system.js';
import { Refusal } from './system.js';

// `agentome connect <code> <server>`: this computer takes the runs of its person's agents. As the
// server's own connect scripts do, on macOS, Linux and Windows alike: the worker from the server,
// checked against its checksum, into ~/.agentome/bin, connected with the one-time code, and started
// as a service of the person's session. `agentome connect update` replaces the worker of a computer
// that is connected already.

export interface ConnectDeps {
  exec: Exec;
  fetch: typeof fetch;
  say: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/** The server's address as people type it: with or without https://, with a slash or not. */
export function serverUrl(typed: string): string {
  const withScheme = /^https?:\/\//i.test(typed) ? typed : `https://${typed}`;
  const url = new URL(withScheme);
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

/** A program on PATH, as the shell would find it; Windows's extensions too. */
export function onPath(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  const extensions = platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  return (env.PATH ?? env.Path ?? '')
    .split(platform === 'win32' ? ';' : delimiter)
    .filter(Boolean)
    .some((dir) =>
      extensions.some(
        (ext) =>
          existsSync(join(dir, `${name}${ext.toLowerCase()}`)) ||
          existsSync(join(dir, `${name}${ext}`)),
      ),
    );
}

const binOf = (env: NodeJS.ProcessEnv) =>
  join(env.AGENTOME_WORKER_HOME ?? join(homedir(), '.agentome'), 'bin');

/** The worker of this server, checked against the checksum the server gives for it. */
async function downloadWorker(
  server: string,
  bin: string,
  deps: ConnectDeps,
  platform: NodeJS.Platform,
) {
  const said = await deps.fetch(`${server}/connect/worker.json`).catch(() => undefined);
  if (!said?.ok) {
    throw new Refusal(
      `${server} does not hand out a worker: check the address, and that the server is Agentome 0.2.0 or later`,
    );
  }
  const { sha256 } = (await said.json()) as { sha256?: string };
  const body = await deps.fetch(`${server}/connect/agentome-worker.mjs`).catch(() => undefined);
  if (!body?.ok || !sha256) throw new Refusal(`cannot download the worker from ${server}`);
  const bytes = Buffer.from(await body.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) {
    throw new Refusal(
      'The downloaded worker does not match its checksum, so nothing was installed. Try again.',
    );
  }
  // The person's alone, as the worker makes its own folders.
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  const worker = join(bin, 'agentome-worker.mjs');
  writeFileSync(`${worker}.download`, bytes, { mode: 0o755 });
  renameSync(`${worker}.download`, worker);
  if (platform !== 'win32') {
    rmSync(join(bin, 'agentome-worker'), { force: true });
    symlinkSync('agentome-worker.mjs', join(bin, 'agentome-worker'));
    chmodSync(worker, 0o755);
  }
  return worker;
}

export async function connect(code: string, typedServer: string, deps: ConnectDeps) {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const server = serverUrl(typedServer);
  // The worker takes plain HTTP only to this machine: across a network, whoever sits on it could
  // change the worker on its way here, read its token and hand it runs of their own.
  if (
    server.startsWith('http://') &&
    !/^http:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:|\/|$)/.test(server)
  ) {
    throw new Refusal(
      `${server} is plain HTTP across a network: connect to the server's https:// address.`,
    );
  }
  if (!onPath('claude', env, platform) && !onPath('codex', env, platform)) {
    throw new Refusal(
      'Claude Code or Codex is needed: install one, run claude (or codex login) and sign in with your subscription.',
    );
  }
  const bin = binOf(env);
  const worker = await downloadWorker(server, bin, deps, platform);
  const node = process.execPath;
  if ((await deps.exec(node, [worker, 'connect', code, '--server', server])).code !== 0) {
    throw new Refusal('This computer did not connect: see the worker’s words above.');
  }
  // Connected by now: without a service the worker still runs, in a terminal.
  if ((await deps.exec(node, [worker, 'install-service'])).code !== 0) {
    throw new Refusal(
      `This computer is connected, but its background service could not be installed. Take runs in a terminal instead: node ${worker} run`,
    );
  }
  deps.say('');
  deps.say(`Connected. Check it any time: agentome connect status`);
}

/** `agentome connect update`: the newest worker of the server this computer is connected to. */
export async function updateWorker(server: string | undefined, deps: ConnectDeps) {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const bin = binOf(env);
  const worker = join(bin, 'agentome-worker.mjs');
  if (!existsSync(worker)) {
    throw new Refusal('This computer is not connected yet: agentome connect <code> <server>');
  }
  const status = await deps.exec(process.execPath, [worker, 'status'], { capture: true });
  if (/^Current run: [0-9a-f]{8}-/m.test(status.stdout)) {
    throw new Refusal(
      'A run is in progress on this computer. Update the worker when it has finished.',
    );
  }
  const connected = server ?? /Connected to (\S+) as/.exec(status.stdout)?.[1];
  if (!connected) throw new Refusal('Name the server: agentome connect update <server>');
  await downloadWorker(serverUrl(connected), bin, deps, platform);
  // The service as the worker installed it, started again: Windows's by installing it anew.
  const restart =
    platform === 'darwin'
      ? await deps.exec(
          'launchctl',
          ['kickstart', '-k', `gui/${process.getuid?.() ?? ''}/ai.agentome.worker`],
          { capture: true },
        )
      : platform === 'win32'
        ? await deps.exec(process.execPath, [worker, 'install-service'])
        : await deps.exec('systemctl', ['--user', 'restart', 'agentome-worker.service'], {
            capture: true,
          });
  if (restart.code !== 0) {
    throw new Refusal(
      `The worker is updated, but its service did not start again. Start it by hand: node ${worker} run`,
    );
  }
  deps.say('The worker is updated and running again.');
}

/** `agentome connect status`: the worker's own account of itself. */
export async function workerStatus(deps: ConnectDeps) {
  const worker = join(binOf(deps.env ?? process.env), 'agentome-worker.mjs');
  if (!existsSync(worker))
    throw new Refusal('This computer is not connected: agentome connect <code> <server>');
  await deps.exec(process.execPath, [worker, 'status']);
}
