#!/usr/bin/env node
// A stand-in for the `claude` binary, for the launcher tests. The launcher is a process
// supervisor, so what it does can only be tested against a process: a prompt on stdin, the
// order of events, SIGTERM followed by SIGKILL, an exit code without a result line. Mocking
// `child_process` would test the mock. It is not a model simulator: it replays a stream-json
// fixture.
//
// Every variable starts with `CLAUDE_FAKE_`, so the launcher's environment filter passes it
// through to the child exactly like the real CLI's own `CLAUDE_*` settings.
//
//   CLAUDE_FAKE_VERSION          output of `--version` (default "2.1.90 (Claude Code)")
//   CLAUDE_FAKE_LOGGED_OUT       a file: while it exists, `auth status` says signed out
//   CLAUDE_FAKE_FIXTURE          jsonl replayed to stdout
//   CLAUDE_FAKE_RESUME_FIXTURE   jsonl replayed instead when `--resume` was passed
//   CLAUDE_FAKE_RESUME_UNKNOWN   refuse `--resume` the way the CLI refuses a session it lacks
//   CLAUDE_FAKE_RECORD           file each invocation is appended to, one JSON per line
//   CLAUDE_FAKE_LINE_DELAY_MS    pause between replayed lines (default 0)
//   CLAUDE_FAKE_STDERR           text written to stderr
//   CLAUDE_FAKE_EXIT             exit code (default 0)
//   CLAUDE_FAKE_HANG             stay alive after the replay until a signal arrives
//   CLAUDE_FAKE_IGNORE_SIGTERM   ignore SIGTERM, so that the caller has to escalate to SIGKILL
//   CLAUDE_FAKE_SPAWN_CHILD      start a grandchild in the same process group
//   CLAUDE_FAKE_COMMIT           commit a file of this name in the working directory, as an agent
//                                would
//
// It ends by setting `process.exitCode` rather than calling `process.exit`, so that stdout is
// flushed into the pipe before the process goes.
/* global process, setTimeout, setInterval */
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const env = process.env;

process.on('SIGTERM', () => {
  if (env.CLAUDE_FAKE_IGNORE_SIGTERM !== '1') process.exit(143);
});

async function main() {
  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(`${env.CLAUDE_FAKE_VERSION ?? '2.1.90 (Claude Code)'}\n`);
    return 0;
  }
  // As Claude Code 2.1.280 answers it: JSON either way, and exit 1 when signed out.
  if (args[0] === 'auth' && args[1] === 'status') {
    const out = env.CLAUDE_FAKE_LOGGED_OUT !== undefined && existsSync(env.CLAUDE_FAKE_LOGGED_OUT);
    process.stdout.write(`{\n  "loggedIn": ${!out},\n  "authMethod": "claude.ai"\n}\n`);
    return out ? 1 : 0;
  }

  let stdin = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    stdin += chunk;
  });
  await new Promise((resolve) => {
    process.stdin.on('end', resolve);
    process.stdin.on('error', resolve);
  });

  // A tool or an MCP server the CLI started: a stopped run must not leave it behind.
  const grandchild =
    env.CLAUDE_FAKE_SPAWN_CHILD === '1'
      ? spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      : undefined;
  grandchild?.unref();

  if (env.CLAUDE_FAKE_RECORD !== undefined) {
    const prefixes = ['ANTHROPIC_', 'CLAUDE_', 'AGENTOME_', 'MCP_'];
    const record = {
      args,
      cwd: process.cwd(),
      stdin,
      // The prefixes a test asserts about — including the ones the child must *not* get.
      env: Object.fromEntries(
        Object.entries(env).filter(([name]) => prefixes.some((prefix) => name.startsWith(prefix))),
      ),
      pid: process.pid,
      childPid: grandchild?.pid ?? null,
    };
    appendFileSync(env.CLAUDE_FAKE_RECORD, `${JSON.stringify(record)}\n`);
  }

  if (env.CLAUDE_FAKE_COMMIT !== undefined) {
    // With the identity the repository gives the agent, as the real CLI's git would.
    writeFileSync(env.CLAUDE_FAKE_COMMIT, 'Written by fake-claude\n');
    execFileSync('git', ['add', '--', env.CLAUDE_FAKE_COMMIT]);
    const message = `Add ${env.CLAUDE_FAKE_COMMIT}`;
    execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', message]);
  }

  const resume = args.indexOf('--resume');
  if (resume !== -1 && env.CLAUDE_FAKE_RESUME_UNKNOWN === '1') {
    // How the real CLI refuses a session it does not have: on stderr, with no result line.
    process.stderr.write(`No conversation found with session ID: ${args[resume + 1] ?? ''}\n`);
    return 1;
  }

  const fixture =
    resume !== -1 && env.CLAUDE_FAKE_RESUME_FIXTURE !== undefined
      ? env.CLAUDE_FAKE_RESUME_FIXTURE
      : env.CLAUDE_FAKE_FIXTURE;
  const delay = Number(env.CLAUDE_FAKE_LINE_DELAY_MS ?? '0');
  for (const line of fixture === undefined ? [] : readFileSync(fixture, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    process.stdout.write(`${line}\n`);
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  }

  if (env.CLAUDE_FAKE_STDERR !== undefined) process.stderr.write(`${env.CLAUDE_FAKE_STDERR}\n`);

  if (env.CLAUDE_FAKE_HANG === '1') {
    // Alive until the caller stops it; the test measures how.
    setInterval(() => undefined, 1000);
  }
  return Number(env.CLAUDE_FAKE_EXIT ?? '0');
}

process.exitCode = await main();
