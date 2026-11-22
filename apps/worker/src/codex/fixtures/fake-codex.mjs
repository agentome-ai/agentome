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
//   CODEX_FAKE_SANDBOX_MS  how long that check takes, in ms (default 0)
//   CODEX_FAKE_CANARY    `brain`: in the worker's check before a place run, the command says it ran
//                        beside the sign-in, as a Codex that ran it locally would
// With the canary's model (`model_provider="agentome-canary"`) it asks that model as Codex does,
// runs the one command it is given with sh here, and tells the model its output.
// `exec-server --listen ws://127.0.0.1:<port>` says back what it hears on that port, as Codex's
// executor answers its CLI; a run with CODEX_EXEC_SERVER_URL says "ping" there first and records
// the answer as `executor`.
/* global process, setInterval, setTimeout, URL, fetch */
import { spawn } from 'node:child_process';
import { connect, createServer } from 'node:net';
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
    await new Promise((resolve) => setTimeout(resolve, Number(env.CODEX_FAKE_SANDBOX_MS ?? 0)));
    if (env.CODEX_FAKE_SANDBOX_RECORD !== undefined) {
      writeFileSync(env.CODEX_FAKE_SANDBOX_RECORD, JSON.stringify(args));
    }
    return Number(env.CODEX_FAKE_SANDBOX ?? 0);
  }
  if (args.includes('model_provider="agentome-canary"')) {
    const base = /base_url="([^"]+)"/.exec(
      args.find((arg) => arg.includes('base_url=')) ?? '',
    )?.[1];
    const ask = async (input) => {
      const answer = await fetch(`${base}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'agentome-canary', input, stream: true }),
      });
      return answer.text();
    };
    const first = await ask([{ role: 'user', content: 'run it' }]);
    const call = /"arguments":"((?:\\.|[^"\\])*)"/.exec(first)?.[1];
    const cmd = call ? JSON.parse(JSON.parse(`"${call}"`)).cmd : '';
    const output =
      env.CODEX_FAKE_CANARY === 'brain'
        ? 'CANARY-BRAIN\nCANARY-SEALED\n'
        : await new Promise((resolve) => {
            const child = spawn('sh', ['-c', cmd], { stdio: ['ignore', 'pipe', 'ignore'] });
            let out = '';
            child.stdout.on('data', (chunk) => (out += chunk));
            child.on('close', () => resolve(out));
          });
    await ask([{ type: 'function_call_output', call_id: 'call_canary', output }]);
    return 0;
  }
  if (args[0] === 'exec-server') {
    const port = Number(/:(\d+)$/.exec(args[args.indexOf('--listen') + 1] ?? '')?.[1]);
    createServer((socket) => socket.pipe(socket)).listen(port, '127.0.0.1');
    await new Promise(() => undefined);
  }
  let executor;
  if (env.CODEX_EXEC_SERVER_URL !== undefined) {
    const url = new URL(env.CODEX_EXEC_SERVER_URL);
    executor = await new Promise((resolve) => {
      const socket = connect(Number(url.port), url.hostname, () => socket.write('ping'));
      socket.on('data', (data) => {
        resolve(data.toString());
        socket.end();
      });
      socket.on('error', (error) => resolve(`error: ${error.message}`));
    });
  }
  let stdin = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => (stdin += chunk));
  await new Promise((resolve) => process.stdin.on('end', resolve));
  if (env.CODEX_FAKE_RECORD !== undefined) {
    const prefixes = ['AGENTOME_', 'CODEX_HOME', 'OPENAI_', 'ANTHROPIC_'];
    const record = {
      args,
      ...(executor !== undefined && { executor }),
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
