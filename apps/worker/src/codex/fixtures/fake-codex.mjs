#!/usr/bin/env node
// A stand-in for the `codex` binary, for the launcher tests, as fake-claude is for `claude`: it
// replays a `codex exec --json` fixture and records how it was called. Every variable starts with
// `CODEX_FAKE_`, which the launcher passes through as it would the real CLI's settings.
//
//   CODEX_FAKE_FIXTURE   jsonl replayed to stdout
//   CODEX_FAKE_RECORD    file each invocation is appended to, one JSON per line
//   CODEX_FAKE_STDERR    text written to stderr
//   CODEX_FAKE_EXIT      exit code (default 0)
//   CODEX_FAKE_HANG      stay alive after the replay until a signal arrives
//   CODEX_FAKE_COMMAND   file that gets the pid of a command started as Codex starts one: in a
//                        process group of its own, which outlives a signal to this one
//   CODEX_FAKE_VERSION   what `--version` prints (default 0.163.0)
//   CODEX_FAKE_LOGGED_OUT  a file: while it exists, `login status` says signed out
//   CODEX_FAKE_SANDBOX   exit code of `codex sandbox`, the computer's check before a run (default 0)
//   CODEX_FAKE_SANDBOX_RECORD  file that gets the arguments of that check, as JSON
/* global process, setInterval */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const env = process.env;
process.on('SIGTERM', () => process.exit(143));

async function main() {
  if (args.includes('--version')) {
    process.stdout.write(`codex-cli ${env.CODEX_FAKE_VERSION ?? '0.163.0'}\n`);
    return 0;
  }
  // As Codex 0.163.0 answers it: one line, and exit 1 when signed out.
  if (args[0] === 'login' && args[1] === 'status') {
    const out = env.CODEX_FAKE_LOGGED_OUT !== undefined && existsSync(env.CODEX_FAKE_LOGGED_OUT);
    process.stdout.write(out ? 'Not logged in\n' : 'Logged in using ChatGPT\n');
    return out ? 1 : 0;
  }
  if (args[0] === 'sandbox') {
    if (env.CODEX_FAKE_SANDBOX_RECORD !== undefined) {
      writeFileSync(env.CODEX_FAKE_SANDBOX_RECORD, JSON.stringify(args));
    }
    return Number(env.CODEX_FAKE_SANDBOX ?? 0);
  }
  let stdin = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => (stdin += chunk));
  await new Promise((resolve) => process.stdin.on('end', resolve));
  if (env.CODEX_FAKE_RECORD !== undefined) {
    const prefixes = ['AGENTOME_', 'CODEX_HOME', 'OPENAI_', 'ANTHROPIC_'];
    const record = {
      args,
      cwd: process.cwd(),
      stdin,
      env: Object.fromEntries(
        Object.entries(env).filter(([name]) => prefixes.some((prefix) => name.startsWith(prefix))),
      ),
    };
    appendFileSync(env.CODEX_FAKE_RECORD, `${JSON.stringify(record)}\n`);
  }
  if (env.CODEX_FAKE_FIXTURE !== undefined) {
    process.stdout.write(readFileSync(env.CODEX_FAKE_FIXTURE, 'utf8'));
  }
  if (env.CODEX_FAKE_STDERR !== undefined) process.stderr.write(env.CODEX_FAKE_STDERR);
  if (env.CODEX_FAKE_COMMAND !== undefined) {
    const command = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    writeFileSync(env.CODEX_FAKE_COMMAND, String(command.pid));
  }
  if (env.CODEX_FAKE_HANG === '1') await new Promise(() => setInterval(() => {}, 1000));
  return Number(env.CODEX_FAKE_EXIT ?? 0);
}

main().then((code) => (process.exitCode = code));
