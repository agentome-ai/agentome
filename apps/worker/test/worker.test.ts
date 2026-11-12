import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { foldRunStatus, RunEvent } from '@agentome/shared';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { main } from '../src/cli.js';
import type { Connection, Log } from '../src/config.js';
import { DISCONNECTED, runWorker } from '../src/loop.js';
import type { WorkerOptions } from '../src/loop.js';
import { cliProjectDir } from '../src/workspace.js';
import { launchPackage, startFakeServer } from './fake-server.js';
import type { FakeRun, FakeServer } from './fake-server.js';

// The whole seat against a fake server and the stand-in `claude`: claim, workspace, CLI, events,
// heartbeat, finish, cleanup. The real `claude` never runs here (README: what to check live).

const FAKE = fileURLToPath(new URL('../src/claude/fixtures/fake-claude.mjs', import.meta.url));
const fixture = (name: string) =>
  fileURLToPath(new URL(`../src/claude/fixtures/${name}`, import.meta.url));
const RESULT = 'The build script already runs the linter, so nothing has to change.';

let dir: string;
let home: string;
let origin: string;
let record: string;
let hanging: string;
let fake: FakeServer;
let connection: Connection;

beforeAll(() => chmodSync(FAKE, 0o755));

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentome-worker-'));
  home = join(dir, 'home');
  origin = join(dir, 'origin');
  record = join(dir, 'invocations.jsonl');
  // A CLI that has started and works on, until it is stopped.
  hanging = join(dir, 'init.jsonl');
  writeFileSync(hanging, readFileSync(fixture('success-text.jsonl'), 'utf8').split('\n')[0] ?? '');
  mkdirSync(origin);
  git('init', '--quiet', '--initial-branch=main');
  writeFileSync(join(origin, 'index.js'), 'export {};\n');
  git('add', '.');
  git(
    '-c',
    'user.name=Owner',
    '-c',
    'user.email=owner@agentome.invalid',
    'commit',
    '--quiet',
    '-m',
    'Start',
  );
  fake = await startFakeServer();
  connection = { serverUrl: fake.url, seatId: 'seat', token: fake.seatToken };
});

afterEach(async () => {
  await fake.close();
  rmSync(dir, { recursive: true, force: true });
});

/** git in the origin repository, as its owner. */
function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: origin,
    env: { PATH: process.env.PATH, HOME: dir },
  }).toString();
}

function start(
  env: Record<string, string> = {},
  options: Partial<WorkerOptions> = {},
  endMs = 2_000,
) {
  const logs: string[] = [];
  const log: Log = (level, message) => logs.push(`${level} ${message}`);
  const stop = new AbortController();
  const done = runWorker({
    connection,
    settings: { home, idleMinutes: 15, keepWorkspaces: false, server: false, place: false },
    signal: stop.signal,
    log,
    idle: async () => 0,
    backoff: () => 10,
    run: {
      cliPath: FAKE,
      // No Codex, whatever this computer has: the tests that run one name the fake.
      codexPath: join(dir, 'no-codex-here'),
      // HOME: the CLI's git must not read the git configuration of whoever runs the tests.
      env: { PATH: process.env.PATH, HOME: dir, CLAUDE_FAKE_RECORD: record, ...env },
      timing: { flushMs: 20, heartbeatMs: 50, endMs, backoff: () => 10 },
    },
    ...options,
  });
  return { done, logs, stop: () => stop.abort() };
}

async function waitFor(condition: () => boolean, ms = 10_000): Promise<void> {
  for (const deadline = Date.now() + ms; !condition();) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The transcript as the run page reads it back from the server. */
function transcript(run: FakeRun): RunEvent[] {
  return [...run.events.values()].map(({ payload, ...envelope }) =>
    RunEvent.parse({ ...payload, ...envelope }),
  );
}

describe('the seat', () => {
  it("sends its own log lines to the server, a run's under its id, when it stops at the latest", async () => {
    const run = fake.enqueue(launchPackage({ repository: origin }));
    const worker = start({ CLAUDE_FAKE_FIXTURE: fixture('success-text.jsonl') });
    await waitFor(() => run.finish !== undefined);
    worker.stop();
    await worker.done;
    const claimed = fake.logLines.find((line) => line.message.includes('claimed'));
    expect(claimed).toMatchObject({ level: 'info', runId: run.launch.run.id });
    expect(fake.logLines.map((line) => line.message)).toContain('worker stopped');
  });

  it('claims a run, works in a clone, reports the transcript, the commits and the usage, and cleans up', async () => {
    const run = fake.enqueue(launchPackage({ repository: origin }));
    const worker = start({
      CLAUDE_FAKE_FIXTURE: fixture('success-text.jsonl'),
      CLAUDE_FAKE_COMMIT: 'README.md',
      ANTHROPIC_API_KEY: 'sk-ant-personal',
    });
    await waitFor(() => run.finish !== undefined);
    worker.stop();
    expect(await worker.done).toBe('stopped');

    const events = transcript(run);
    expect(events.map((event) => event.type)).toEqual([
      'started',
      'assistant_message',
      'usage',
      'usage',
      'result',
    ]);
    expect(foldRunStatus(events)).toBe('done');
    expect(run.finish).toEqual({
      status: 'done',
      summary: RESULT,
      artifacts: [
        { kind: 'report', ref: 'result', meta: { text: RESULT } },
        {
          kind: 'branch',
          ref: `agentome/${run.launch.run.id}`,
          meta: {
            commits: [{ sha: expect.stringMatching(/^[0-9a-f]{40}$/), subject: 'Add README.md' }],
            pushedTo: origin,
          },
        },
      ],
      usage: [
        {
          provider: 'anthropic',
          model: 'claude-opus-4-6[1m]',
          tokensIn: 1843,
          tokensOut: 96,
          tokensCacheRead: 12480,
          tokensCacheWrite: 311,
          tokensCacheWrite1h: 0,
          source: 'stream-json',
        },
      ],
    });
    expect(existsSync(join(home, 'runs', run.launch.run.id))).toBe(false);
    // The commit outlives the run's folder, in the repository it came from, under the agent's name.
    const kept = git('log', '-1', '--format=%s by %an <%ae>', `agentome/${run.launch.run.id}`);
    const email = `agent-${run.launch.agent.id.slice(0, 8)}@agentome.ai`;
    expect(kept.trim()).toBe(`Add README.md by Backend developer <${email}>`);

    const invocation = JSON.parse(readFileSync(record, 'utf8')) as {
      args: string[];
      cwd: string;
      stdin: string;
      env: Record<string, string>;
    };
    expect(invocation.cwd.endsWith(join(run.launch.run.id, 'repo'))).toBe(true);
    expect(invocation.args).toEqual(
      expect.arrayContaining(['--add-dir', join(home, 'runs', run.launch.run.id, 'profile')]),
    );
    expect(invocation.stdin).toBe(
      `# Add a README\n\nDescribe the project.\n\nThe working directory is a clone of ${origin}.\n`,
    );
    expect(invocation.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).toBe('1');
    expect(Object.keys(invocation.env).filter((name) => name.startsWith('AGENTOME_'))).toEqual([]);
    expect(JSON.stringify(invocation)).not.toContain(fake.seatToken);
    // A subscription computer: the person's own API key is never billed.
    expect(invocation.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(
      worker.logs.some((line) => line.endsWith('the API key in the environment is not used')),
    ).toBe(true);
  });

  it('names its build with each claim', async () => {
    const build = 'c'.repeat(64);
    const worker = start({}, { build });
    await waitFor(() => fake.claimQuery !== undefined);
    expect(fake.claimQuery?.get('worker')).toBe(build);
    worker.stop();
    await worker.done;
  });

  it('names the engine that is not signed in, until it is again', async () => {
    const out = join(dir, 'signed-out');
    writeFileSync(out, '');
    const worker = start({ CLAUDE_FAKE_LOGGED_OUT: out }, { signInEveryMs: 20 });
    await waitFor(() => fake.claimQuery?.get('signedOut') === 'claude-code');
    expect(worker.logs).toContain(
      'warn Claude Code is not signed in on this computer; taking no runs for it. Run `claude` and sign in.',
    );
    const status = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await main(['status'], { AGENTOME_WORKER_HOME: home });
    expect(status.mock.calls.join('\n')).toContain('Claude Code: not signed in, so its runs wait.');
    status.mockRestore();

    rmSync(out);
    await waitFor(() => fake.claimQuery?.has('signedOut') === false);
    expect(worker.logs).toContain('info Claude Code is signed in again; taking its runs');
    worker.stop();
    await worker.done;
  });

  it('asks again after an empty long poll, one run at a time', async () => {
    const worker = start({ CLAUDE_FAKE_FIXTURE: fixture('success-text.jsonl') });
    await waitFor(() => fake.claims >= 2);
    const first = fake.enqueue(launchPackage());
    const second = fake.enqueue(launchPackage());
    await waitFor(() => second.finish !== undefined);
    worker.stop();
    await worker.done;
    expect(first.finish?.status).toBe('done');
    // A new, empty repository: nothing was committed, so no branch is reported.
    expect(first.finish?.artifacts.map((artifact) => artifact.kind)).toEqual(['report']);
  });

  it('sends a batch again when its answer is lost, and the server keeps each event once', async () => {
    const run = fake.enqueue(launchPackage());
    run.failEvents = 1;
    const worker = start({ CLAUDE_FAKE_FIXTURE: fixture('success-text.jsonl') });
    await waitFor(() => run.finish !== undefined);
    worker.stop();
    await worker.done;
    const seqs = run.batches.map((batch) => batch.map((event) => event.seq));
    expect(seqs[1]?.slice(0, seqs[0]?.length)).toEqual(seqs[0]);
    expect([...run.events.keys()]).toEqual([0, 1, 2, 3, 4]);
    expect(run.events.get(2)).toMatchObject({
      type: 'usage',
      payload: { model: 'claude-opus-4-6[1m]', tokensIn: 1843 },
    });
  });

  it('stops the CLI when the heartbeat brings a cancel, and finishes the run as cancelled', async () => {
    const run = fake.enqueue(launchPackage());
    const worker = start({ CLAUDE_FAKE_FIXTURE: hanging, CLAUDE_FAKE_HANG: '1' });
    await waitFor(() => run.events.size > 0);
    run.cancelRequested = true;
    await waitFor(() => run.finish !== undefined);
    worker.stop();
    await worker.done;
    expect(run.finish).toMatchObject({ status: 'cancelled', errorCode: 'cancelled' });
    expect(foldRunStatus(transcript(run))).toBe('cancelled');
    expect(run.heartbeats).toBeGreaterThan(0);
    expect(run.heartbeatTypes.every((type) => type === undefined)).toBe(true);
  });

  it('cancels and finishes the run in progress when the worker is stopped', async () => {
    const run = fake.enqueue(launchPackage());
    const worker = start({ CLAUDE_FAKE_FIXTURE: hanging, CLAUDE_FAKE_HANG: '1' });
    await waitFor(() => run.events.size > 0);
    worker.stop();
    expect(await worker.done).toBe('stopped');
    expect(run.finish?.status).toBe('cancelled');
    expect(foldRunStatus(transcript(run))).toBe('cancelled');
  });

  it('stops a run the server closed, without finishing it, and goes on taking runs', async () => {
    const run = fake.enqueue(launchPackage());
    const worker = start({ CLAUDE_FAKE_FIXTURE: hanging, CLAUDE_FAKE_HANG: '1' });
    await waitFor(() => run.events.size > 0);
    run.open = false;
    await waitFor(() => !existsSync(join(home, 'runs', run.launch.run.id)));
    const claims = fake.claims;
    await waitFor(() => fake.claims > claims);
    worker.stop();
    await worker.done;
    expect(run.finish).toBeUndefined();
    expect(worker.logs).toContain(
      `warn run ${run.launch.run.id}: the server closed this run; stopping it`,
    );
  });

  it('leaves out a batch the server refuses, and still finishes the run', async () => {
    const run = fake.enqueue(launchPackage());
    run.refuseEvents = 1;
    const worker = start({ CLAUDE_FAKE_FIXTURE: fixture('success-text.jsonl') });
    await waitFor(() => run.finish !== undefined);
    worker.stop();
    await worker.done;
    expect(run.finish?.status).toBe('done');
    expect(worker.logs.some((line) => line.includes('the server refused'))).toBe(true);
  });

  it('still sends finish when the transcript could not be delivered in time', async () => {
    const run = fake.enqueue(launchPackage());
    run.failEvents = 1_000;
    const worker = start({ CLAUDE_FAKE_FIXTURE: fixture('success-text.jsonl') }, {}, 200);
    await waitFor(() => run.finish !== undefined);
    worker.stop();
    await worker.done;
    expect(run.finish?.status).toBe('done');
  });

  it('removes the folders a killed worker left behind, before it takes a run', async () => {
    const leftover = join(home, 'runs', 'b9b1c0de-0000-4000-8000-000000000000', 'repo');
    const kept = cliProjectDir(leftover, { HOME: dir });
    for (const folder of [leftover, kept]) {
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, 'secret.txt'), 'work of an earlier run\n');
    }
    const worker = start();
    await waitFor(() => fake.claims > 0);
    expect(existsSync(join(home, 'runs'))).toBe(false);
    expect(existsSync(kept)).toBe(false);
    worker.stop();
    await worker.done;
  });

  it('notes in the transcript when the commits could not be kept, and finishes the run', async () => {
    const run = fake.enqueue(launchPackage({ repository: origin }));
    // The origin can be read and cloned, but takes no new branch.
    const heads = join(origin, '.git', 'refs', 'heads');
    chmodSync(heads, 0o555);
    try {
      const worker = start({
        CLAUDE_FAKE_FIXTURE: fixture('success-text.jsonl'),
        CLAUDE_FAKE_COMMIT: 'README.md',
      });
      await waitFor(() => run.finish !== undefined);
      worker.stop();
      await worker.done;
    } finally {
      chmodSync(heads, 0o755);
    }
    expect(run.finish?.status).toBe('done');
    expect(run.finish?.artifacts[1]).toMatchObject({ kind: 'branch', meta: { pushedTo: null } });
    const events = transcript(run);
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'push_failed', fatal: false });
    expect(foldRunStatus(events)).toBe('done');
  });

  it('fails the run when its repository cannot be cloned', async () => {
    const run = fake.enqueue(launchPackage({ repository: join(dir, 'missing') }));
    const worker = start();
    await waitFor(() => run.finish !== undefined);
    worker.stop();
    await worker.done;
    expect(run.finish).toMatchObject({
      status: 'failed',
      errorCode: 'workspace_failed',
      artifacts: [],
      usage: [],
    });
    expect(transcript(run)).toMatchObject([
      { type: 'error', code: 'workspace_failed', fatal: true },
    ]);
    expect(existsSync(join(home, 'runs', run.launch.run.id))).toBe(false);
  });

  it('takes no runs while nobody is at the computer', async () => {
    let idleMinutes = 20;
    const worker = start(
      { CLAUDE_FAKE_FIXTURE: fixture('success-text.jsonl') },
      { idle: async () => idleMinutes * 60_000, awayPauseMs: 10 },
    );
    const run = fake.enqueue(launchPackage());
    // Until the worker has looked: a slow machine takes longer than any fixed wait to start it.
    const away = () => {
      try {
        return 'awaySince' in JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
      } catch {
        return false;
      }
    };
    await waitFor(away);
    expect(fake.claims).toBe(0);
    idleMinutes = 1;
    await waitFor(() => run.finish !== undefined);
    worker.stop();
    await worker.done;
    expect(worker.logs).toContain('info somebody is at the computer again; taking runs');
  });

  it("takes the idle time the owner set on the platform over the environment's", async () => {
    // The computer has been idle 6 minutes: present by the environment's 15, away by the owner's 5.
    fake.idleMinutes = 5;
    const worker = start({}, { idle: async () => 6 * 60_000, awayPauseMs: 10 });
    await waitFor(() => worker.logs.some((line) => line.includes('idle time is now 5 min')));
    await waitFor(() =>
      worker.logs.some((line) => line.includes('nobody at the computer for 5 min')),
    );
    expect(fake.claims).toBe(1);
    worker.stop();
    await worker.done;
  });

  it('on a server seat, runs with the connection the server sent and exits after one run', async () => {
    const launch = {
      ...launchPackage(),
      model: {
        kind: 'gateway' as const,
        baseUrl: 'https://openrouter.ai/api',
        key: 'sk-or-agents',
      },
    };
    const run = fake.enqueue(launch);
    // Nobody at a keyboard counts for nothing here; a subscription in reach is never used.
    const worker = start(
      { CLAUDE_FAKE_FIXTURE: fixture('success-text.jsonl'), CLAUDE_CODE_OAUTH_TOKEN: 'personal' },
      {
        settings: { home, idleMinutes: 15, keepWorkspaces: false, server: true, place: false },
        idle: async () => 60 * 60_000,
      },
    );
    // No stop: the worker leaves by itself, so its container starts the next run clean.
    expect(await worker.done).toBe('stopped');
    expect(run.finish?.status).toBe('done');
    const { env } = JSON.parse(readFileSync(record, 'utf8')) as { env: Record<string, string> };
    expect(env.ANTHROPIC_BASE_URL).toBe('https://openrouter.ai/api');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-or-agents');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("on a server seat, keeps the model key out of the run's transcript and summary", async () => {
    // As if the agent had read the key out of its environment and said it.
    const key = 'already runs the linter';
    const run = fake.enqueue({
      ...launchPackage(),
      model: { kind: 'gateway' as const, baseUrl: 'https://openrouter.ai/api', key },
    });
    const worker = start(
      { CLAUDE_FAKE_FIXTURE: fixture('success-text.jsonl') },
      { settings: { home, idleMinutes: 15, keepWorkspaces: false, server: true, place: false } },
    );
    expect(await worker.done).toBe('stopped');
    const sent = JSON.stringify([...run.events.values(), run.finish]);
    expect(sent).not.toContain(key);
    expect(run.finish?.summary).toBe('The build script [the model key], so nothing has to change.');
  });

  it('on a server seat, fails a run that came without a model connection', async () => {
    const run = fake.enqueue(launchPackage());
    const worker = start(
      { CLAUDE_FAKE_FIXTURE: fixture('success-text.jsonl') },
      { settings: { home, idleMinutes: 15, keepWorkspaces: false, server: true, place: false } },
    );
    expect(await worker.done).toBe('stopped');
    expect(run.finish?.status).toBe('failed');
    expect(run.finish?.summary).toContain('gateway needs its key');
  });

  it('on a computer, never uses a key the server sent', async () => {
    const run = fake.enqueue({
      ...launchPackage(),
      model: {
        kind: 'anthropic' as const,
        baseUrl: 'https://api.anthropic.com',
        key: 'sk-company',
      },
    });
    const worker = start({ CLAUDE_FAKE_FIXTURE: fixture('success-text.jsonl') });
    await waitFor(() => run.finish !== undefined);
    worker.stop();
    await worker.done;
    const { env } = JSON.parse(readFileSync(record, 'utf8')) as { env: Record<string, string> };
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it('runs a Codex agent with codex, in the same workspace and transcript', async () => {
    const codexRecord = join(dir, 'codex.jsonl');
    const launch = launchPackage({ repository: origin });
    // On a server seat: on a computer Codex is refused (next test).
    const run = fake.enqueue({
      ...launch,
      agent: { ...launch.agent, engine: 'codex' },
      model: { kind: 'openai' as const, baseUrl: 'https://api.openai.com/v1', key: 'sk-agents' },
    });
    const worker = start(
      {
        CODEX_FAKE_FIXTURE: fileURLToPath(
          new URL('../src/codex/fixtures/success.jsonl', import.meta.url),
        ),
        CODEX_FAKE_RECORD: codexRecord,
      },
      {
        run: {
          cliPath: FAKE,
          codexPath: fileURLToPath(
            new URL('../src/codex/fixtures/fake-codex.mjs', import.meta.url),
          ),
          env: {
            PATH: process.env.PATH,
            HOME: dir,
            CODEX_FAKE_FIXTURE: fileURLToPath(
              new URL('../src/codex/fixtures/success.jsonl', import.meta.url),
            ),
            CODEX_FAKE_RECORD: codexRecord,
          },
          timing: { flushMs: 20, heartbeatMs: 50, endMs: 2_000, backoff: () => 10 },
        },
        settings: { home, idleMinutes: 15, keepWorkspaces: false, server: true, place: false },
      },
    );
    expect(await worker.done).toBe('stopped');
    expect(run.finish).toMatchObject({ status: 'done', summary: 'The board is tidy.' });
    expect(transcript(run).map((event) => event.type)).toContain('assistant_message');
    // Its tokens are OpenAI's to price, the cached part of the input apart.
    expect(run.finish?.usage).toMatchObject([
      { provider: 'openai', tokensIn: 400, tokensCacheRead: 800, tokensOut: 40 },
    ]);
    const invocation = JSON.parse(readFileSync(codexRecord, 'utf8')) as { args: string[] };
    // The agent's profile is its instructions for Codex too.
    const instructions = invocation.args.find((arg) => arg.startsWith('developer_instructions='));
    expect(instructions).toContain('Your profile folder');
    // Claude Code was not started for it.
    expect(existsSync(record)).toBe(false);
  });

  it("runs a Codex agent on a computer in Codex's own sandbox", async () => {
    const codexRecord = join(dir, 'codex-laptop.jsonl');
    const success = fileURLToPath(new URL('../src/codex/fixtures/success.jsonl', import.meta.url));
    const launch = launchPackage({ repository: origin });
    const run = fake.enqueue({ ...launch, agent: { ...launch.agent, engine: 'codex' } });
    const worker = start(
      {},
      {
        run: {
          cliPath: FAKE,
          codexPath: fileURLToPath(
            new URL('../src/codex/fixtures/fake-codex.mjs', import.meta.url),
          ),
          env: {
            PATH: process.env.PATH,
            HOME: dir,
            CODEX_FAKE_FIXTURE: success,
            CODEX_FAKE_RECORD: codexRecord,
          },
          timing: { flushMs: 20, heartbeatMs: 50, endMs: 2_000, backoff: () => 10 },
        },
      },
    );
    await waitFor(() => run.finish !== undefined);
    worker.stop();
    await worker.done;
    expect(run.finish).toMatchObject({ status: 'done', summary: 'The board is tidy.' });
    const invocation = JSON.parse(readFileSync(codexRecord, 'utf8')) as { args: string[] };
    const profile = invocation.args.find((arg) => arg.startsWith('permissions.agentome=')) ?? '';
    // Its profile folder to read, the platform's host to reach, and the older sandbox not named.
    expect(profile).toContain(`${join(home, 'runs', run.launch.run.id, 'profile')}" = "read"`);
    expect(profile).toContain('"agentome.test" = "allow"');
    expect(invocation.args.some((arg) => arg.startsWith('sandbox_mode'))).toBe(false);
  });

  it('stops for good when the server no longer knows the seat', async () => {
    fake.revoked = true;
    const worker = start();
    expect(await worker.done).toBe('disconnected');
    expect(worker.logs).toContain(`error ${DISCONNECTED}`);
  });
});

describe('agentome-worker connect', () => {
  const env = () => ({ AGENTOME_WORKER_HOME: home });

  it('trades the code for a seat and keeps its token where only the owner can read it', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await main(['connect', 'K7QX-M2PH', '--server', `${fake.url}/`], env())).toBe(0);
    const saved = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as Connection;
    expect(saved).toEqual({
      serverUrl: fake.url,
      seatId: expect.any(String),
      token: fake.seatToken,
    });
    expect(statSync(join(home, 'config.json')).mode & 0o777).toBe(0o600);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(fake.pairings).toEqual([
      {
        code: 'K7QX-M2PH',
        name: expect.any(String),
        kind: 'subscription-laptop',
        engines: ['claude-code'],
        capabilities: {},
      },
    ]);
    out.mockClear();
    expect(await main(['status'], env())).toBe(0);
    expect(out.mock.calls[0]?.[0]).toMatch(
      /^Connected to http:\/\/127\.0\.0\.1:\d+ as seat .+\.\nWorker: not running\.\nLast claim: never\./,
    );
    out.mockRestore();
  });

  it('says why a code or a server does not work, and keeps nothing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await main(['connect', 'AAAA-AAAA', '--server', fake.url], env())).toBe(1);
    expect(error).toHaveBeenLastCalledWith(
      'This code is not valid. Check it, or create a new one in Admin, Computers.',
    );
    await fake.close();
    expect(await main(['connect', 'K7QX-M2PH', '--server', fake.url], env())).toBe(1);
    expect(error.mock.lastCall?.[0]).toMatch(
      /^Could not reach http:\/\/127\.0\.0\.1:\d+ \(fetch failed: ECONNREFUSED\)/,
    );
    expect(await main(['connect', 'K7QX-M2PH', '--server', 'ftp://example.com'], env())).toBe(1);
    expect(await main(['run'], env())).toBe(1);
    expect(error).toHaveBeenLastCalledWith(
      expect.stringMatching(/^This computer is not connected/),
    );
    expect(existsSync(join(home, 'config.json'))).toBe(false);
    fake = await startFakeServer();
    error.mockRestore();
  });
});
