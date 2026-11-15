import type { ChildProcess } from 'node:child_process';
import { closeSync, constants, existsSync, openSync, readFileSync, writeSync } from 'node:fs';
import { CWD_FILE, SANDBOX_FILE, type Sandbox, remoteSpawn } from './remote.js';

// The CLI container's bash and git. In a run's CLI container the CLI holds the person's sign-in, so
// no command runs there: the image's bash and git (deploy/sandbox-shim.sh) come here in a CLI container,
// and the command runs in the run's sandbox container instead, with the same arguments and
// working folder, its streams and its exit passed back as the program's own. git too: the
// CLIs run it for themselves, on the agent's repository, whose config the sandbox may write
// (an fsmonitor or a filter would run a command beside the sign-in).

/** The programs that pass to the sandbox, by their paths there. */
const PROGRAMS: Record<string, string> = { bash: '/bin/bash', git: '/usr/bin/git' };

/** What a command takes of the CLI's environment: how to show itself, nothing of the CLI container's. */
const PASSED = new Set([
  ...['TERM', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'COLUMNS', 'LINES', 'TZ'],
  ...['NO_COLOR', 'FORCE_COLOR', 'CI', 'PAGER', 'GIT_PAGER', 'GIT_EDITOR', 'EDITOR'],
  // How tools know they run under an agent; Claude Code and Codex set them for their commands.
  ...['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CODEX_THREAD_ID'],
]);

const SIGNALS: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT'];

/** Where the sandbox is, as the CLI container's server wrote it, with a command's environment there; undefined without. */
export function sandboxOf(
  env: NodeJS.ProcessEnv,
  file = SANDBOX_FILE,
): { sandbox: Sandbox; env: Record<string, string> } | undefined {
  if (!existsSync(file)) return undefined;
  const sandbox = JSON.parse(readFileSync(file, 'utf8')) as Sandbox;
  const passed = Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => PASSED.has(entry[0]) && entry[1] !== undefined,
    ),
  );
  return { sandbox, env: { ...passed, ...sandbox.env } };
}

type Io = {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
};

/**
 * Runs `program args` in the sandbox and answers its exit code; 126, and nothing run, when the
 * CLI container has no sandbox to run it in.
 */
export function sandboxMain(
  [program, ...args]: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  io: Io = process,
  cwd: string = process.cwd(),
  file = SANDBOX_FILE,
): Promise<number> {
  const path = program === undefined ? undefined : PROGRAMS[program];
  const found = sandboxOf(env, file);
  if (!path || !found) {
    io.stderr.write(`${program ?? 'bash'}: this run has no sandbox to run the command in\n`);
    return Promise.resolve(126);
  }
  // Claude Code reads where a command left its shell from a file in its own /tmp, which the
  // sandbox does not share: their shell writes it there, and the exit brings it back.
  const cwdFile =
    program === 'bash'
      ? args
          .map((arg) => /pwd -P >\| (\/tmp\/claude-[0-9a-f]{1,32}-cwd)\s*$/.exec(arg)?.[1])
          .find((name) => name !== undefined && CWD_FILE.test(name))
      : undefined;
  const child = remoteSpawn(found.sandbox.server)(path, args, {
    cwd,
    env: found.env,
    ...(cwdFile !== undefined && { cwdFile }),
  }) as ChildProcess & { stop: (signal: NodeJS.Signals) => void; cwd?: string };
  return new Promise((resolve) => {
    const onSignal = (signal: NodeJS.Signals) => child.stop(signal);
    for (const signal of SIGNALS) process.on(signal, onSignal);
    io.stdin.pipe(child.stdin as NodeJS.WritableStream);
    child.stdout?.pipe(io.stdout, { end: false });
    child.stderr?.pipe(io.stderr, { end: false });
    child.once('error', (error: Error) => {
      io.stderr.write(`${program}: the command could not be run: ${error.message}\n`);
      resolve(126);
    });
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      for (const each of SIGNALS) process.off(each, onSignal);
      if (cwdFile !== undefined && child.cwd !== undefined) writeCwd(cwdFile, child.cwd);
      io.stdin.unpipe(child.stdin as NodeJS.WritableStream);
      resolve(code ?? 128 + signalNumber(signal));
    });
  });
}

/** A signal's number, for a shell's 128 + n. */
function signalNumber(signal: NodeJS.Signals | null): number {
  const numbers: Partial<Record<NodeJS.Signals, number>> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGKILL: 9,
    SIGTERM: 15,
  };
  return (signal && numbers[signal]) ?? 9;
}

/** Writes the working folder where the CLI reads it, as the shell would; never through a link. */
function writeCwd(path: string, cwd: string): void {
  const { O_WRONLY, O_CREAT, O_TRUNC, O_NOFOLLOW } = constants;
  try {
    const fd = openSync(path, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0o600);
    try {
      writeSync(fd, cwd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Not written: the CLI keeps the folder it had, as after a failed command.
  }
}
