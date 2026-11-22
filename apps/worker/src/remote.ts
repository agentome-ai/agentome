import { type ChildProcess, spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { lookup } from 'node:dns';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { PassThrough, Writable } from 'node:stream';

// A run in a person's place runs in two containers of its own: the CLI container holds the CLI
// and the person's sign-in, the sandbox every command the agent runs. In each `run-server`
// listens on the place's network; the place's worker has the CLI container's server start the
// CLI, and the CLI container's `bash` has the sandbox's server start each command, as `spawn`
// would, their input and output
// passing over the connection, one JSON message a line. TCP, not a socket in a shared folder:
// one does not cross gVisor sandboxes, and on Kubernetes the ends may be other pods. Each
// container's server takes only a connection that opens with its own key, made for the run.

/** The port a run's container serves on. */
export const RUN_PORT = 7419;

/** Where a run's container serves, and its key. */
export type RunServer = { host: string; port: number; key: string };

/**
 * Where a Codex run's executor listens in its sandbox, on the sandbox's own loopback: Codex's
 * `codex exec-server`, which runs the commands and edits of Codex in the CLI container. Only this
 * port is tunnelled to.
 */
export const EXEC_PORT = 7421;
/** Where a Codex run's CLI container finds its executor, on its own loopback, tunnelled to the sandbox. */
export const CLI_EXEC_PORT = 7422;

/** In a CLI container: a port on its loopback whose connections are tunnelled to the sandbox's executor. */
export type Tunnel = { port: number; to: RunServer; exec?: number };

/** A run's sandbox, as its CLI container knows it: where, and the environment a command gets there. */
export type Sandbox = { server: RunServer; env: Record<string, string> };

/**
 * Where a CLI container's server writes where its sandbox is, read by sandbox.ts: in its own /tmp,
 * which the CLI's file tools may not touch (workspace.ts).
 */
export const RUN_DIR = '/tmp/agentome';
export const SANDBOX_FILE = `${RUN_DIR}/sandbox.json`;

type Request =
  | { t: 'hello'; key: string }
  | {
      t: 'spawn';
      file: string;
      args: string[];
      cwd?: string;
      env: Record<string, string>;
      /** Where the command's shell leaves its working folder, for the exit to carry back. */
      cwdFile?: string;
      /** For a run's CLI container: where its sandbox is, which its bash and git pass commands to. */
      sandbox?: Sandbox;
      /** For a Codex run's CLI container: its loopback port to the sandbox's executor, while the CLI runs. */
      tunnel?: Tunnel;
    }
  | { t: 'tunnel'; port: number }
  | { t: 'in'; d: string }
  | { t: 'end' }
  | { t: 'kill'; signal: NodeJS.Signals };
type Answer =
  | { t: 'ok' }
  | { t: 'out' | 'err'; d: string }
  | { t: 'exit'; code: number | null; signal: NodeJS.Signals | null; cwd?: string }
  | { t: 'error'; message: string };

const line = (message: Request | Answer) => `${JSON.stringify(message)}\n`;

/**
 * A run's container's side: starts what it is asked for, a process group each, and passes its
 * streams. What it starts is the container's: the worker deletes the container when the run ends.
 */
export function runServer(
  key: string,
  log: (text: string) => void,
  port = RUN_PORT,
  cli = false,
  execPort = EXEC_PORT,
  // Every address in a run's container; the tests' own, where another program may hold the port
  // on 127.0.0.1 that the system gives the wildcard.
  host?: string,
): Promise<{ close: () => void; port: number }> {
  if (cli) mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => serve(socket, key, log, cli, execPort));
    server.once('error', reject);
    server.listen(port, host, () => {
      const bound = server.address();
      const at = typeof bound === 'object' && bound ? bound.port : port;
      log(`run-server: listening on port ${String(at)}`);
      resolve({ close: () => server.close(), port: at });
    });
  });
}

/**
 * Knocks once on the place, `place` in this container's /etc/hosts, as the run's container starts.
 * Docker gives a run's new containers the addresses of the last run's; under gVisor the place
 * still knows each address by the old container's hardware address and loses every packet to the
 * new one for up to a minute. A packet from here makes the place learn the new one at once. The
 * port is closed: the answer, a refusal, is all the knock needs.
 */
export function knockOnPlace(host = 'place', port = 9): void {
  lookup(host, (error, address) => {
    if (error) return; // No place to knock on: on Kubernetes the run is the place's neighbour.
    const knock = connect(port, address);
    knock.setTimeout(1_000, () => knock.destroy());
    knock.once('connect', () => knock.destroy());
    // Refused, as it should be: the place has learnt this container's hardware address.
    knock.once('error', () => knock.destroy());
  });
}

const HELLO_MS = 10_000;
const HELLO_BYTES = 4096;

/** Where Claude Code's shell leaves a command's working folder: `/tmp/claude-<hex>-cwd`. */
export const CWD_FILE = /^\/tmp\/claude-[0-9a-f]{1,32}-cwd$/;

/**
 * The working folder a command's shell left in `path`, which then goes: a short file of the
 * shell's own in this container's /tmp, never a link, so a command cannot hand back another file.
 */
function leftCwd(path: string): string | undefined {
  if (!CWD_FILE.test(path)) return undefined;
  try {
    const found = lstatSync(path);
    if (!found.isFile() || found.size > 4096) return undefined;
    return readFileSync(path, 'utf8');
  } catch {
    // The command left none: it failed before its `pwd`, or was stopped.
    return undefined;
  } finally {
    rmSync(path, { force: true });
  }
}

/** Whether `given` is the key, in constant time. */
function sameKey(given: unknown, key: string): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

function serve(
  socket: Socket,
  key: string,
  log: (text: string) => void,
  cli: boolean,
  execPort: number,
) {
  let child: ChildProcess | undefined;
  let listening: Server | undefined;
  let heard = false;
  // A connection that does not open with its key soon, and short, goes.
  const hello = setTimeout(() => socket.destroy(), HELLO_MS);
  // Only the first line is held to it: the key's, short. What follows it in the same chunk, a
  // spawn with its environment, may be long.
  let before = 0;
  let firstLine = true;
  socket.on('data', (chunk: Buffer) => {
    if (!firstLine) return;
    const end = chunk.indexOf(10);
    before += end < 0 ? chunk.length : end;
    if (end >= 0) firstLine = false;
    if (before > HELLO_BYTES) socket.destroy();
  });
  socket.once('close', () => clearTimeout(hello));
  const send = (answer: Answer) => {
    if (!socket.destroyed) socket.write(line(answer));
  };
  // The other end went (the CLI container's `bash` was killed, or the worker's connection broke): what
  // it started goes too, its whole group, rather than run on unwatched.
  const orphan = () => {
    if (child?.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Gone already.
    }
  };
  socket.on('error', orphan);
  socket.on('close', orphan);
  const lines = createInterface({ input: socket, crlfDelay: Infinity });
  lines.on('line', (text) => {
    let request: Request;
    try {
      request = JSON.parse(text) as Request;
    } catch {
      if (!heard) socket.destroy();
      return;
    }
    // The first line is the key, or the connection goes.
    if (!heard) {
      if (request.t !== 'hello' || !sameKey(request.key, key)) {
        socket.destroy();
        return;
      }
      heard = true;
      clearTimeout(hello);
      return;
    }
    // A sandbox's connection to its executor, for the CLI container's Codex: from here on the
    // connection carries the executor's bytes both ways, nothing else.
    if (request.t === 'tunnel' && !cli && !child) {
      if (request.port !== execPort) {
        socket.destroy();
        return;
      }
      const target = connect(request.port, '127.0.0.1');
      target.once('error', (error) => {
        send({ t: 'error', message: error.message });
        socket.end();
      });
      target.once('connect', () => {
        lines.close();
        socket.removeAllListeners('data');
        send({ t: 'ok' });
        socket.pipe(target);
        target.pipe(socket);
        socket.once('close', () => target.destroy());
        target.once('close', () => socket.destroy());
      });
      return;
    }
    if (request.t === 'spawn' && !child) {
      try {
        // A CLI container's CLI: where its commands go, for its bash and git, before it starts.
        if (cli && request.sandbox) {
          writeFileSync(SANDBOX_FILE, JSON.stringify(request.sandbox), { mode: 0o600 });
        }
        // A Codex CLI's executor, in the sandbox, at a port of this container's loopback.
        if (request.tunnel) listening = tunnelFrom(request.tunnel, log);
        child = spawn(request.file, request.args, {
          cwd: request.cwd,
          env: request.env,
          stdio: 'pipe',
          detached: true,
        });
      } catch (error) {
        send({ t: 'error', message: error instanceof Error ? error.message : String(error) });
        return;
      }
      const started = child;
      started.stdout?.on('data', (chunk: Buffer) =>
        send({ t: 'out', d: chunk.toString('base64') }),
      );
      started.stderr?.on('data', (chunk: Buffer) =>
        send({ t: 'err', d: chunk.toString('base64') }),
      );
      started.stdin?.on('error', () => undefined);
      started.on('error', (error) => send({ t: 'error', message: error.message }));
      const { cwdFile } = request;
      started.once('close', (code, signal) => {
        listening?.close();
        const cwd = cwdFile === undefined ? undefined : leftCwd(cwdFile);
        send({ t: 'exit', code, signal, ...(cwd !== undefined && { cwd }) });
        socket.end();
      });
      log(`run-server: started ${request.file}`);
    } else if (request.t === 'in') {
      child?.stdin?.write(Buffer.from(request.d, 'base64'));
    } else if (request.t === 'end') {
      child?.stdin?.end();
    } else if (request.t === 'kill' && child?.pid !== undefined) {
      try {
        // The CLI's group: what it started goes with it.
        process.kill(-child.pid, request.signal);
      } catch {
        // Gone already.
      }
    }
  });
}

/**
 * Opens a connection to the sandbox's executor through its run server: the key, then the tunnel,
 * then, once the server says it reached the executor, the executor's bytes both ways. Rejects when
 * the executor is not listening.
 */
export function openTunnel(to: RunServer, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(to.port, to.host);
    socket.write(line({ t: 'hello', key: to.key }));
    socket.write(line({ t: 'tunnel', port }));
    let heard = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      heard = Buffer.concat([heard, chunk]);
      const end = heard.indexOf(10);
      if (end < 0) {
        if (heard.length > HELLO_BYTES) socket.destroy(new Error('the sandbox answered at length'));
        return;
      }
      socket.off('data', onData);
      let answer: Answer | undefined;
      try {
        answer = JSON.parse(heard.subarray(0, end).toString('utf8')) as Answer;
      } catch {
        answer = undefined;
      }
      if (answer?.t !== 'ok') {
        socket.destroy();
        reject(
          new Error(answer?.t === 'error' ? answer.message : 'the sandbox refused the tunnel'),
        );
        return;
      }
      const rest = heard.subarray(end + 1);
      if (rest.length > 0) socket.unshift(rest);
      resolve(socket);
    };
    socket.on('data', onData);
    socket.once('error', reject);
    socket.once('close', () => reject(new Error('the sandbox closed the tunnel')));
  });
}

/** Waits until the sandbox's executor takes connections, or its time is up. */
export async function tunnelReady(to: RunServer, port: number, timeoutMs = 30_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      (await openTunnel(to, port)).destroy();
      return;
    } catch (error) {
      if (Date.now() > until) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

/**
 * In a Codex run's CLI container: listens on the loopback, where its Codex finds its executor
 * (CODEX_EXEC_SERVER_URL), and passes each connection to the executor in the sandbox. Codex sends
 * nothing secret there: the bytes are the commands and edits it asks for and their output.
 */
function tunnelFrom(tunnel: Tunnel, log: (text: string) => void): Server {
  const server = createServer((local) => {
    local.pause();
    openTunnel(tunnel.to, tunnel.exec ?? EXEC_PORT).then(
      (remote) => {
        local.pipe(remote);
        remote.pipe(local);
        local.resume();
        local.once('close', () => remote.destroy());
        remote.once('close', () => local.destroy());
        local.on('error', () => remote.destroy());
        remote.on('error', () => local.destroy());
      },
      (error: unknown) => {
        log(
          `run-server: no tunnel to the executor (${error instanceof Error ? error.message : String(error)})`,
        );
        local.destroy();
      },
    );
  });
  server.listen(tunnel.port, '127.0.0.1');
  return server;
}

/**
 * A process in the run's container, as `spawn` gives one: its streams, `close` and `exit` with
 * its code, `error` when it could not start. It has no pid here; `stop` signals its group there.
 */
export class RemoteChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  readonly pid = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  /** The working folder the command's shell left, when it was asked for. */
  cwd: string | undefined;
  readonly #socket: Socket;

  constructor(socket: Socket) {
    super();
    this.#socket = socket;
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, done) => {
        this.#send({ t: 'in', d: Buffer.from(chunk).toString('base64') });
        done();
      },
      final: (done) => {
        this.#send({ t: 'end' });
        done();
      },
    });
  }

  #send(request: Request) {
    if (!this.#socket.destroyed) this.#socket.write(line(request));
  }

  /** Signals the CLI's process group in the run's container. */
  stop(signal: NodeJS.Signals) {
    this.#send({ t: 'kill', signal });
  }

  kill(signal: NodeJS.Signals = 'SIGTERM') {
    this.stop(signal);
    return true;
  }
}

/** A `spawn` that starts the program in a run's container, over its connection. */
export function remoteSpawn(server: RunServer, sandbox?: Sandbox, tunnel?: Tunnel) {
  return (
    file: string,
    args: readonly string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv; cwdFile?: string },
  ): ChildProcess => {
    const socket = connect(server.port, server.host);
    const child = new RemoteChild(socket);
    socket.write(line({ t: 'hello', key: server.key }));
    const env = Object.fromEntries(
      Object.entries(options.env ?? {}).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    const { cwdFile } = options;
    socket.write(
      line({
        t: 'spawn',
        file,
        args: [...args],
        cwd: options.cwd,
        env,
        ...(cwdFile !== undefined && { cwdFile }),
        ...(sandbox && { sandbox }),
        ...(tunnel && { tunnel }),
      }),
    );
    let ended = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (ended) return;
      ended = true;
      child.exitCode = code;
      child.signalCode = signal;
      child.emit('exit', code, signal);
      child.stdout.end();
      child.stderr.end();
      child.emit('close', code, signal);
    };
    createInterface({ input: socket, crlfDelay: Infinity }).on('line', (text) => {
      let answer: Answer;
      try {
        answer = JSON.parse(text) as Answer;
      } catch {
        return;
      }
      if (answer.t === 'out') child.stdout.write(Buffer.from(answer.d, 'base64'));
      else if (answer.t === 'err') child.stderr.write(Buffer.from(answer.d, 'base64'));
      else if (answer.t === 'exit') {
        child.cwd = answer.cwd;
        finish(answer.code, answer.signal);
      } else if (answer.t === 'error') child.emit('error', new Error(answer.message));
    });
    socket.on('error', (error) => child.emit('error', error));
    // The container went (deleted at the end, or it died): the CLI went with it.
    socket.on('close', () => finish(null, 'SIGKILL'));
    return child as unknown as ChildProcess;
  };
}

/**
 * Waits for a run's container to listen, as it starts. Each try waits a second at most: under
 * gVisor a place that ran a run before may still know the new container's address by the old
 * one's hardware address, and its first connection's SYN is lost until it learns again; left to
 * TCP, the connection would wait out its retries, 31 or 63 seconds, before the run started.
 */
export async function serverReady(server: RunServer, timeoutMs = 60_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const ok = await new Promise<boolean>((resolve) => {
      const probe = connect(server.port, server.host);
      probe.setTimeout(1_000, () => {
        probe.destroy();
        resolve(false);
      });
      probe.once('connect', () => {
        probe.destroy();
        resolve(true);
      });
      probe.once('error', () => resolve(false));
    });
    if (ok) return;
    if (Date.now() > until) throw new Error("The run's container did not start in time");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
