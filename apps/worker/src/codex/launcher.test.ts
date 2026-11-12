import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunEvent } from '@agentome/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type CodexRunOptions,
  codexArgs,
  codexSignedOut,
  nodeRoots,
  runCodex,
} from './launcher.js';

// The codex launcher against fake-codex, which replays what codex-cli 0.163.0 printed.

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const FAKE = join(fixtures, 'fake-codex.mjs');
let dir: string;
let record: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentome-codex-'));
  record = join(dir, 'invocations.jsonl');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function options(env: Record<string, string>, change: Partial<CodexRunOptions> = {}) {
  return {
    cwd: dir,
    prompt: '# Tidy the board\n',
    instructions: '# Jira admin\n\nKeep the board tidy.',
    mcp: { url: 'https://agentome.example.com/mcp', token: 'run-token' },
    model: 'gpt-5-codex',
    shell: true,
    server: false,
    limits: { timeoutMs: 30_000, maxTokens: 1_000_000 },
    billing: { mode: 'subscription' as const },
    cliPath: FAKE,
    env: { PATH: process.env.PATH, HOME: dir, CODEX_FAKE_RECORD: record, ...env },
    ...change,
  } satisfies CodexRunOptions;
}

async function run(env: Record<string, string>, change: Partial<CodexRunOptions> = {}) {
  const events: RunEvent[] = [];
  const outcome = await runCodex(
    options(env, change),
    (event) => events.push(event),
    new AbortController().signal,
  );
  const invocation = JSON.parse(readFileSync(record, 'utf8')) as {
    args: string[];
    stdin: string;
    env: Record<string, string>;
  };
  return { events, outcome, invocation };
}

describe('runCodex', () => {
  it('runs a turn and reports its transcript, its plan, its tools and its usage', async () => {
    const { events, outcome, invocation } = await run({
      CODEX_FAKE_FIXTURE: join(fixtures, 'success.jsonl'),
      OPENAI_API_KEY: 'sk-personal',
    });
    expect(events.map((event) => event.type)).toEqual([
      'started',
      'tool_use',
      'tool_use',
      'tool_result',
      'tool_use',
      'tool_result',
      'assistant_message',
      'usage',
      'result',
    ]);
    expect(events[1]).toMatchObject({
      name: 'TodoWrite',
      input: {
        todos: [
          { content: 'Read the board', status: 'completed' },
          { content: 'Tidy it', status: 'pending' },
        ],
      },
    });
    expect(events[2]).toMatchObject({ id: 'item_1', name: 'mcp__agentome__jira_search' });
    expect(events[4]).toMatchObject({ name: 'Bash', input: { command: 'git status' } });
    // OpenAI counts the cached tokens inside the input; the ledger keeps them apart.
    expect(events[7]).toMatchObject({
      model: 'gpt-5-codex',
      tokensIn: 400,
      tokensCacheRead: 800,
      tokensOut: 40,
    });
    expect(outcome).toMatchObject({ status: 'done', resultText: 'The board is tidy.' });
    expect(outcome.sessionId).toBe('01a196df-22d0-7b03-9946-614b7d13f889');

    expect(invocation.stdin).toBe('# Tidy the board\n');
    expect(invocation.args.slice(0, 5)).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--ephemeral',
      '--ignore-user-config',
    ]);
    // A computer is its owner's ChatGPT sign-in: a personal key never reaches the CLI.
    expect(invocation.env.OPENAI_API_KEY).toBeUndefined();
    expect(invocation.env.AGENTOME_RUN_TOKEN).toBe('run-token');
    expect(invocation.args).toContain(
      'mcp_servers.agentome.bearer_token_env_var="AGENTOME_RUN_TOKEN"',
    );
    // Seven days, whatever the run's time limit: a call may wait for the owner.
    expect(invocation.args).toContain('mcp_servers.agentome.tool_timeout_sec=604800');
    expect(invocation.args).not.toContain('model_provider="agentome"');
  });

  it("on a computer, runs the agent's commands in Codex's own sandbox", async () => {
    const { outcome, invocation } = await run(
      { CODEX_FAKE_FIXTURE: join(fixtures, 'success.jsonl') },
      {
        sandbox: {
          readable: ['/runs/1/profile', '/runs/1/git-credentials'],
          hosts: ['agentome.example.com'],
        },
      },
    );
    expect(outcome.status).toBe('done');
    const value = (key: string) =>
      invocation.args.find((arg) => arg.startsWith(`${key}=`))?.slice(key.length + 1) ?? '';
    expect(value('default_permissions')).toBe('"agentome"');
    // Without the proxy the list of hosts restricts nothing.
    expect(value('features.network_proxy')).toBe('true');
    const profile = value('permissions.agentome');
    // The system's minimum and what the run names, never the person's home; the clone to write,
    // with the .git Codex would otherwise keep read-only.
    expect(profile).toContain('":minimal" = "read"');
    expect(profile).toContain('"/runs/1/profile" = "read"');
    expect(profile).toContain('"/runs/1/git-credentials" = "read"');
    expect(profile).toContain('":workspace_roots" = { "." = "write", ".git" = "write" }');
    expect(profile).toContain(
      'network = { enabled = true, domains = { "agentome.example.com" = "allow" } }',
    );
    // The older sandbox reads the whole disk, and Codex takes one or the other.
    expect(invocation.args.some((arg) => arg.startsWith('sandbox_mode'))).toBe(false);
    // The run token is the gateway's, not the commands'.
    expect(value('shell_environment_policy')).toContain('exclude = ["AGENTOME_*"]');
    // What a ChatGPT sign-in brings with it stays out: the agent's tools are the gateway's.
    for (const feature of ['apps', 'plugins', 'hooks', 'multi_agent_v2', 'tool_suggest']) {
      expect(invocation.args[invocation.args.indexOf(feature) - 1]).toBe('--disable');
    }
  });

  it('on a computer, checks the sandbox the run will have, whatever the server names its host', async () => {
    const checked = join(dir, 'sandbox.json');
    const { invocation } = await run(
      { CODEX_FAKE_FIXTURE: join(fixtures, 'success.jsonl'), CODEX_FAKE_SANDBOX_RECORD: checked },
      {
        // A host Node would read as an option of its own, and exit well without the probe.
        mcp: { url: 'https://-v/mcp', token: 'run-token' },
        sandbox: { readable: ['/runs/1/profile'], hosts: ['agentome.example.com'] },
      },
    );
    const args = JSON.parse(readFileSync(checked, 'utf8')) as string[];
    expect(args.slice(0, 5)).toEqual(['sandbox', '-P', 'agentome', '-C', dir]);
    // The same profile as the run's own.
    const profile = (from: string[]) => from.find((arg) => arg.startsWith('permissions.agentome='));
    expect(profile(args)).toBe(profile(invocation.args));
    // Node, the probe, then `--` before what the server sent.
    expect(args.slice(-3)).toEqual(['--', '-v', '443']);
    expect(args[args.length - 5]).toBe('-e');
  });

  it("opens a Node in the person's home as itself, not as the folder it is in", () => {
    const home = '/Users/x';
    // A version manager's folder, or Homebrew's: the whole of it.
    expect(nodeRoots('/opt/homebrew/Cellar/node@22/22.1.0/bin/node', home)).toEqual([
      '/opt/homebrew/Cellar/node@22/22.1.0',
    ]);
    expect(nodeRoots('/usr/bin/node', home)).toEqual(['/usr']);
    // In the home, above it, or at the root: the binary and its modules, never the folder.
    for (const path of [
      '/Users/x/.nvm/versions/node/v22.1.0/bin/node',
      '/Users/x/.local/bin/node',
      '/Users/x/Library/tools/node',
      '/Users/x/bin/node',
      '/Users/x/node',
      '/bin/node',
      '/node',
    ]) {
      const roots = nodeRoots(path, home);
      expect(roots[0]).toBe(path);
      expect(roots).toHaveLength(2);
      expect(roots[1]).toMatch(/\/lib\/node_modules$/);
    }
  });

  it('on a computer, starts no run when the sandbox lets a command through', async () => {
    for (const [exit, said] of [
      ['41', 'list your home folder'],
      ['42', 'connect past the proxy'],
      ['1', 'the check could not run'],
    ] as const) {
      const outcome = await runCodex(
        options({ CODEX_FAKE_FIXTURE: join(fixtures, 'success.jsonl'), CODEX_FAKE_SANDBOX: exit }),
        () => undefined,
        new AbortController().signal,
      );
      expect(outcome).toMatchObject({ status: 'failed', error: { code: 'sandbox_unavailable' } });
      expect(outcome.error?.message).toContain(said);
    }
    // `codex exec` was never started.
    expect(existsSync(record)).toBe(false);
  });

  it('on a computer, starts no run on a Codex older than its sandbox was checked against', async () => {
    const outcome = await runCodex(
      options({
        CODEX_FAKE_FIXTURE: join(fixtures, 'success.jsonl'),
        CODEX_FAKE_VERSION: '0.150.2',
      }),
      () => undefined,
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'sandbox_unavailable' } });
    expect(outcome.error?.message).toContain('Codex 0.150.2 is too old');
    expect(existsSync(record)).toBe(false);
  });

  it('on the server, sends the connection as the provider and turns the shell off unless allowed', async () => {
    const server = {
      server: true,
      shell: false,
      billing: { mode: 'provider' as const, baseUrl: 'https://openrouter.ai/api', key: 'sk-or' },
    };
    const { invocation, outcome } = await run(
      { CODEX_FAKE_FIXTURE: join(fixtures, 'success.jsonl') },
      server,
    );
    expect(outcome.status).toBe('done');
    expect(invocation.env.AGENTOME_MODEL_KEY).toBe('sk-or');
    expect(invocation.args).toContain('model_provider="agentome"');
    expect(invocation.args.join(' ')).toContain('base_url = "https://openrouter.ai/api/v1"');
    expect(invocation.args.join(' ')).toContain('--disable shell_tool --disable unified_exec');
    const shell = codexArgs(options({}, { ...server, shell: true }));
    // No team of subagents, on a server or a computer.
    expect(shell).toContain('agents.enabled=false');
    expect(codexArgs(options({}))).toContain('agents.enabled=false');
    expect(shell).not.toContain('shell_tool');
    expect(shell).toContain('sandbox_mode="danger-full-access"');
  });

  it('fails a turn the model refused, saying how to sign in', async () => {
    const { events, outcome } = await run({
      CODEX_FAKE_FIXTURE: join(fixtures, 'failed.jsonl'),
      CODEX_FAKE_EXIT: '1',
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('not_authenticated');
    expect(events.at(-1)).toMatchObject({ type: 'error', fatal: true, code: 'not_authenticated' });
    // Codex's own reconnecting is a note, not the end.
    expect(events.some((event) => event.type === 'error' && !event.fatal)).toBe(true);
  });

  it('moves the time limit by the time the run waited for its owner', async () => {
    const startedAt = Date.now();
    const waitedMs = () => (Date.now() - startedAt > 150 ? 600 : 0);
    const base = options({
      CODEX_FAKE_FIXTURE: join(fixtures, 'failed.jsonl'),
      CODEX_FAKE_HANG: '1',
    });
    const outcome = await runCodex(
      { ...base, limits: { ...base.limits, timeoutMs: 300, waitedMs } },
      () => undefined,
      new AbortController().signal,
    );
    expect(outcome.error?.code).toBe('timeout');
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(880);
  });

  it('stops a run that is cancelled', async () => {
    const stop = new AbortController();
    const events: RunEvent[] = [];
    const running = runCodex(
      options({ CODEX_FAKE_FIXTURE: join(fixtures, 'failed.jsonl'), CODEX_FAKE_HANG: '1' }),
      (event) => events.push(event),
      stop.signal,
    );
    setTimeout(() => stop.abort(), 300);
    const outcome = await running;
    expect(outcome.status).toBe('cancelled');
  });

  it('stops the commands of a cancelled run with it', async () => {
    // Codex starts a command in a process group of its own: a signal to Codex's group alone
    // would leave it running on the person's computer.
    const pidFile = join(dir, 'command.pid');
    const stop = new AbortController();
    const running = runCodex(
      options({
        CODEX_FAKE_FIXTURE: join(fixtures, 'failed.jsonl'),
        CODEX_FAKE_HANG: '1',
        CODEX_FAKE_COMMAND: pidFile,
      }),
      () => undefined,
      stop.signal,
    );
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 5_000 });
    const command = Number(readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(command, 0)).not.toThrow();
    stop.abort();
    expect((await running).status).toBe('cancelled');
    await vi.waitFor(() => expect(() => process.kill(command, 0)).toThrow(), { timeout: 5_000 });
  });
});

describe('codexSignedOut', () => {
  it('believes a CLI that says it is signed out, and nothing else', async () => {
    const out = join(dir, 'signed-out');
    const env = { PATH: process.env.PATH, CODEX_FAKE_LOGGED_OUT: out };
    expect(await codexSignedOut({ cliPath: FAKE, env })).toBe(false);
    writeFileSync(out, '');
    expect(await codexSignedOut({ cliPath: FAKE, env })).toBe(true);
    expect(await codexSignedOut({ cliPath: join(dir, 'no-codex-here'), env })).toBe(false);
  });
});
