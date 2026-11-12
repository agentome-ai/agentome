import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeUsage } from '@agentome/costs';
import { RunEvent, foldRunStatus } from '@agentome/shared';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { claudeSignedOut, KILL_GRACE_MS, probe, runClaude } from './launcher.js';
import type { ClaudeRunOptions, UsageTotals } from './launcher.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

/** What `fake-claude.mjs` writes down about each invocation. */
interface Invocation {
  readonly args: string[];
  readonly cwd: string;
  readonly stdin: string;
  readonly env: Record<string, string>;
  readonly pid: number;
  readonly childPid: number | null;
}

let dir: string;
let workspace: string;
let profile: string;
let record: string;

beforeAll(() => {
  // Git keeps the executable bit, but a checkout through some tools does not.
  chmodSync(FAKE, 0o755);
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentome-launcher-'));
  workspace = join(dir, 'workspace');
  profile = join(dir, 'profile');
  record = join(dir, 'invocations.jsonl');
  mkdirSync(workspace);
  mkdirSync(profile);
  writeFileSync(join(profile, 'settings.json'), '{}\n');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function options(
  fake: Record<string, string> = {},
  overrides: Partial<ClaudeRunOptions> = {},
): ClaudeRunOptions {
  return {
    cwd: workspace,
    prompt: 'Add a README to the repository',
    profileDir: profile,
    allowedTools: ['Read', 'Edit', 'Bash(git:*)'],
    permissionMode: 'acceptEdits',
    limits: { timeoutMs: 30_000, maxTurns: 20, maxTokens: 1_000_000 },
    billing: { mode: 'subscription' },
    cliPath: FAKE,
    env: { PATH: process.env.PATH, CLAUDE_FAKE_RECORD: record, ...fake },
    ...overrides,
  };
}

async function run(runOptions: ClaudeRunOptions, signal = new AbortController().signal) {
  const events: RunEvent[] = [];
  const outcome = await runClaude(runOptions, (event) => events.push(event), signal);
  return { outcome, events, types: events.map((event) => event.type) };
}

function invocations(): Invocation[] {
  if (!existsSync(record)) return [];
  return readFileSync(record, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Invocation);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('runClaude: the invocation', () => {
  it('passes the run as arguments and the prompt on stdin', async () => {
    await run(options({ CLAUDE_FAKE_FIXTURE: fixture('success-text.jsonl') }, { model: 'opus' }));
    const [invocation] = invocations();
    expect(invocation?.args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--setting-sources',
      'user',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--model',
      'opus',
      '--max-turns',
      '20',
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      'Read',
      'Edit',
      'Bash(git:*)',
      '--add-dir',
      profile,
      '--add-dir',
      workspace,
      '--settings',
      join(profile, 'settings.json'),
    ]);
    expect(invocation?.stdin).toBe('Add a README to the repository');
    expect(invocation?.cwd).toBe(realpathSync(workspace));
    // Neither the CLI's transcript nor its own memory stays on the computer.
    expect(invocation?.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
  });

  it('loads the platform gateway and gives a waiting call the whole run', async () => {
    const mcpConfig = join(profile, '..', 'mcp.json');
    await run(options({ CLAUDE_FAKE_FIXTURE: fixture('success-text.jsonl') }, { mcpConfig }));
    const [invocation] = invocations();
    const args = invocation?.args ?? [];
    // Only the platform's servers: the repository's .mcp.json is skipped, ours is named.
    expect(args).toContain('--strict-mcp-config');
    expect(args[args.indexOf('--mcp-config') + 1]).toBe(mcpConfig);
    // Milliseconds, seven days whatever the run's time limit (30 s here): a call that waits
    // for the owner is not the run's own time.
    expect(invocation?.env.MCP_TOOL_TIMEOUT).toBe('604800000');
  });

  it('passes a team as subagents whose assignments run in the foreground', async () => {
    const agents = { qa: { description: 'QA engineer', prompt: 'You are QA.' } };
    await run(options({ CLAUDE_FAKE_FIXTURE: fixture('success-text.jsonl') }, { agents }));
    const [invocation] = invocations();
    const args = invocation?.args ?? [];
    expect(JSON.parse(args[args.indexOf('--agents') + 1] ?? '')).toEqual(agents);
    expect(args).toContain('--forward-subagent-text');
    expect(invocation?.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1');
  });

  it.each([
    ['subscription', { mode: 'subscription' }],
    ['API', { mode: 'api', apiKey: 'sk-of-the-run' }],
  ] as const)(
    'never loads the settings or MCP servers of the repository (%s)',
    async (_, billing) => {
      await run(options({ CLAUDE_FAKE_FIXTURE: fixture('success-text.jsonl') }, { billing }));
      const args = invocations()[0]?.args ?? [];
      expect(
        args.slice(args.indexOf('--setting-sources'), args.indexOf('--setting-sources') + 2),
      ).toEqual(['--setting-sources', 'user']);
      expect(args).toContain('--strict-mcp-config');
    },
  );

  it('gives a subscription run no API key and nothing of the worker', async () => {
    const env = {
      ANTHROPIC_API_KEY: 'sk-of-the-machine',
      ANTHROPIC_AUTH_TOKEN: 'token-of-the-machine',
      CLAUDE_CODE_OAUTH_TOKEN: 'subscription-token',
      AGENTOME_SEAT_TOKEN: 'seat-token',
    };
    await run(options({ ...env, CLAUDE_FAKE_FIXTURE: fixture('success-text.jsonl') }));
    const seen = invocations()[0]?.env ?? {};
    expect(seen.ANTHROPIC_API_KEY).toBeUndefined();
    expect(seen.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(seen.AGENTOME_SEAT_TOKEN).toBeUndefined();
    expect(seen.CLAUDE_CODE_OAUTH_TOKEN).toBe('subscription-token');
  });

  it('keeps the session of a Claude Code terminal from the run, and its sign-in in', async () => {
    const env = {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:52811',
      CLAUDE_CODE_MESSAGING_TOKEN: 'desktop-token',
      CLAUDE_CODE_SESSION_ID: 'desktop-session',
      CLAUDE_CONFIG_DIR: '/Users/someone/.claude-work',
    };
    await run(options({ ...env, CLAUDE_FAKE_FIXTURE: fixture('success-text.jsonl') }));
    const seen = invocations()[0]?.env ?? {};
    expect(seen.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(seen.CLAUDE_CODE_MESSAGING_TOKEN).toBeUndefined();
    expect(seen.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(seen.CLAUDE_CONFIG_DIR).toBe('/Users/someone/.claude-work');
    // The profile's CLAUDE.md, read from an --add-dir folder only with this.
    expect(seen.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).toBe('1');
  });

  it('gives an API run its own key and no subscription to fall back to', async () => {
    const env = {
      ANTHROPIC_API_KEY: 'sk-of-the-machine',
      CLAUDE_CODE_OAUTH_TOKEN: 'subscription-token',
      CLAUDE_FAKE_FIXTURE: fixture('success-text.jsonl'),
    };
    await run(options(env, { billing: { mode: 'api', apiKey: 'sk-of-the-run' } }));
    const seen = invocations()[0]?.env ?? {};
    expect(seen.ANTHROPIC_API_KEY).toBe('sk-of-the-run');
    expect(seen.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it('refuses options it cannot pass safely, without starting the CLI', async () => {
    const flag = await run(
      options({}, { allowedTools: ['Read', '--dangerously-skip-permissions'] }),
    );
    const bypass = await run(
      options({}, { permissionMode: 'bypassPermissions' as ClaudeRunOptions['permissionMode'] }),
    );
    const noWorkspace = await run(options({}, { cwd: join(dir, 'missing') }));
    const noSettings = await run(options({}, { profileDir: workspace }));

    for (const { outcome, events } of [flag, bypass, noWorkspace, noSettings]) {
      expect(outcome).toMatchObject({ status: 'failed', error: { code: 'invalid_options' } });
      expect(events).toMatchObject([{ type: 'error', code: 'invalid_options', fatal: true }]);
    }
    expect(noWorkspace.outcome.error?.message).toContain('does not exist');
    expect(noSettings.outcome.error?.message).toContain('has no settings.json');
    expect(invocations()).toEqual([]);
  });
});

describe('runClaude: endings', () => {
  it('reports a successful run numbered, stamped, with its usage and result', async () => {
    const { outcome, events, types } = await run(
      options({ CLAUDE_FAKE_FIXTURE: fixture('success-text.jsonl') }),
    );
    expect(types).toEqual(['started', 'assistant_message', 'usage', 'usage', 'result']);
    expect(events.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4]);
    for (const event of events) expect(RunEvent.safeParse(event).success).toBe(true);
    expect(outcome).toEqual({
      status: 'done',
      sessionId: '2f7b9a10-6c3d-4e5f-9a8b-1c2d3e4f5a6b',
      resultText: 'The build script already runs the linter, so nothing has to change.',
      error: undefined,
      usage: { tokensIn: 1843, tokensOut: 96, tokensCacheRead: 12480, tokensCacheWrite: 311 },
    });
    expect(foldRunStatus(events)).toBe('done');
  });

  it('counts a message once, however many lines repeat its usage', async () => {
    const usage = '"usage":{"input_tokens":100,"output_tokens":10,"cache_read_input_tokens":1000}';
    const lines = [
      '{"type":"system","subtype":"init","session_id":"s-r","model":"claude-opus-5"}',
      `{"type":"assistant","message":{"id":"msg_1","content":[{"type":"text","text":"Reading."}],${usage}}}`,
      `{"type":"assistant","message":{"id":"msg_1","content":[{"type":"tool_use","id":"toolu_1","name":"Read","input":{}}],${usage}}}`,
      '{"type":"result","subtype":"success","is_error":false,"result":"ok"}',
    ];
    writeFileSync(join(dir, 'repeated.jsonl'), `${lines.join('\n')}\n`);
    // Counted twice, the run would be over its limit; counted once it is not.
    const { outcome, types } = await run(
      options(
        { CLAUDE_FAKE_FIXTURE: join(dir, 'repeated.jsonl') },
        { limits: { timeoutMs: 30_000, maxTurns: 20, maxTokens: 1500 } },
      ),
    );
    expect(types.filter((type) => type === 'usage')).toHaveLength(2);
    expect(outcome).toMatchObject({
      status: 'done',
      usage: { tokensIn: 100, tokensOut: 10, tokensCacheRead: 1000, tokensCacheWrite: 0 },
    });
  });

  it.each([
    ['auth-401.jsonl', 'not_authenticated'],
    ['rate-limit-rejected.jsonl', 'rate_limited'],
    ['org-not-allowed.jsonl', 'subscription_not_allowed'],
  ])('reads %s as %s', async (name, code) => {
    const { outcome, events } = await run(options({ CLAUDE_FAKE_FIXTURE: fixture(name) }));
    expect(outcome).toMatchObject({ status: 'failed', error: { code } });
    expect(events.at(-2)).toMatchObject({ type: 'result', isError: true });
    expect(events.at(-1)).toMatchObject({ type: 'error', code, fatal: true });
    expect(foldRunStatus(events)).toBe('failed');
  });

  it('reads the CLI turn limit as max_turns, and does not retry it as a lost session', async () => {
    const { outcome } = await run(
      options(
        { CLAUDE_FAKE_RESUME_FIXTURE: fixture('resume-model-text.jsonl') },
        { resumeSessionId: '9e8d7c6b-5a4f-4e3d-2c1b-0a9f8e7d6c5b' },
      ),
    );
    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'max_turns' } });
    expect(outcome.error?.message).toBe('The run reached its limit of 20 turns.');
    expect(invocations()).toHaveLength(1);
  });

  it('turns an exit code without a result into exit_<n>, with the end of stderr', async () => {
    const { outcome, events } = await run(
      options({ CLAUDE_FAKE_EXIT: '3', CLAUDE_FAKE_STDERR: 'fatal: disk full' }),
    );
    expect(outcome.error).toEqual({
      code: 'exit_3',
      message:
        'Claude Code exited without a result (exit code 3). Claude Code said: fatal: disk full',
    });
    expect(events).toMatchObject([{ type: 'error', code: 'exit_3', fatal: true }]);
  });

  it('takes a result that says success over the exit code that follows it', async () => {
    const { outcome } = await run(
      options({ CLAUDE_FAKE_FIXTURE: fixture('success-text.jsonl'), CLAUDE_FAKE_EXIT: '1' }),
    );
    expect(outcome).toMatchObject({ status: 'done', error: undefined });
  });

  it('fails a clean exit that printed no result', async () => {
    const { outcome } = await run(options());
    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'exit_0' } });
  });

  it('reports a missing binary as not_installed', async () => {
    const { outcome, events } = await run(options({}, { cliPath: join(dir, 'no-claude-here') }));
    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'not_installed' } });
    expect(outcome.error?.message).toContain('ENOENT');
    expect(foldRunStatus(events)).toBe('failed');
  });
});

describe('runClaude: limits and cancellation', () => {
  it('leaves nothing the CLI started behind, even after a clean exit', async () => {
    await run(
      options({ CLAUDE_FAKE_FIXTURE: fixture('success-text.jsonl'), CLAUDE_FAKE_SPAWN_CHILD: '1' }),
    );
    const childPid = invocations()[0]?.childPid ?? 0;
    expect(childPid).toBeGreaterThan(0);
    await vi.waitFor(() => expect(alive(childPid)).toBe(false));
  });

  it('stops the CLI and what it started when the time limit runs out', async () => {
    const { outcome, events } = await run(
      options(
        { CLAUDE_FAKE_HANG: '1', CLAUDE_FAKE_SPAWN_CHILD: '1' },
        { limits: { timeoutMs: 300, maxTurns: 20, maxTokens: 1_000_000 } },
      ),
    );
    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'timeout' } });
    expect(events).toMatchObject([{ type: 'error', code: 'timeout', fatal: true }]);
    const [invocation] = invocations();
    expect(alive(invocation?.pid ?? 0)).toBe(false);
    await vi.waitFor(() => expect(alive(invocation?.childPid ?? 0)).toBe(false));
  });

  it('moves the time limit by the time the run waited for its owner', async () => {
    const startedAt = Date.now();
    // As the heartbeat would say it: nothing at first, then 600 ms of waiting.
    const waitedMs = () => (Date.now() - startedAt > 150 ? 600 : 0);
    const { outcome } = await run(
      options(
        { CLAUDE_FAKE_HANG: '1' },
        { limits: { timeoutMs: 300, maxTurns: 20, maxTokens: 1_000_000, waitedMs } },
      ),
    );
    expect(outcome.error?.code).toBe('timeout');
    // 300 ms of its own and the 600 it waited, not 300 in all.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(880);
  });

  it(
    'escalates to SIGKILL when the CLI ignores SIGTERM',
    async () => {
      const startedAt = Date.now();
      const { outcome } = await run(
        options(
          { CLAUDE_FAKE_HANG: '1', CLAUDE_FAKE_IGNORE_SIGTERM: '1' },
          { limits: { timeoutMs: 200, maxTurns: 20, maxTokens: 1_000_000 } },
        ),
      );
      expect(outcome.error?.code).toBe('timeout');
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(KILL_GRACE_MS);
      expect(alive(invocations()[0]?.pid ?? 0)).toBe(false);
    },
    KILL_GRACE_MS + 10_000,
  );

  it('stops the run when the signal aborts, ahead of whatever the CLI prints next', async () => {
    const controller = new AbortController();
    const events: RunEvent[] = [];
    const outcome = await runClaude(
      options({
        CLAUDE_FAKE_FIXTURE: fixture('success-text.jsonl'),
        CLAUDE_FAKE_LINE_DELAY_MS: '2000',
      }),
      (event) => {
        events.push(event);
        if (event.type === 'started') queueMicrotask(() => controller.abort());
      },
      controller.signal,
    );
    expect(events.map((event) => event.type)).toEqual(['started', 'error']);
    expect(outcome).toMatchObject({ status: 'cancelled', error: { code: 'cancelled' } });
    expect(foldRunStatus(events)).toBe('cancelled');
    expect(alive(invocations()[0]?.pid ?? 0)).toBe(false);
  });

  it('does not start the CLI for a run cancelled before it began', async () => {
    const controller = new AbortController();
    controller.abort();
    const { outcome, events } = await run(options(), controller.signal);
    expect(outcome.status).toBe('cancelled');
    expect(events).toMatchObject([{ type: 'error', code: 'cancelled', fatal: true }]);
    expect(invocations()).toEqual([]);
  });

  it('stops the run past its token limit', async () => {
    const { outcome, events, types } = await run(
      options(
        { CLAUDE_FAKE_FIXTURE: fixture('tool-use.jsonl'), CLAUDE_FAKE_LINE_DELAY_MS: '300' },
        { limits: { timeoutMs: 30_000, maxTurns: 20, maxTokens: 10_000 } },
      ),
    );
    expect(types).toEqual(['started', 'assistant_message', 'tool_use', 'usage', 'error']);
    expect(outcome).toMatchObject({
      status: 'failed',
      error: {
        code: 'token_limit',
        message: 'The run used 11442 tokens, more than its limit of 10000, and was stopped.',
      },
    });
    expect(foldRunStatus(events)).toBe('failed');
    expect(alive(invocations()[0]?.pid ?? 0)).toBe(false);
  });

  it('keeps the token limit however stdout is cut, the result in the same chunk included', async () => {
    const { outcome, events } = await run(
      options(
        { CLAUDE_FAKE_FIXTURE: fixture('tool-use.jsonl') },
        { limits: { timeoutMs: 30_000, maxTurns: 20, maxTokens: 10_000 } },
      ),
    );
    expect(outcome.error?.code).toBe('token_limit');
    expect(foldRunStatus(events)).toBe('failed');
  });
});

describe('runClaude: a session that cannot be continued', () => {
  it.each([
    ['poisoned', { CLAUDE_FAKE_RESUME_FIXTURE: fixture('resume-poisoned.jsonl') }],
    ['unknown here', { CLAUDE_FAKE_RESUME_UNKNOWN: '1' }],
  ])('starts a fresh session when the old one is %s', async (_, fake) => {
    const { outcome, events } = await run(
      options(
        { ...fake, CLAUDE_FAKE_FIXTURE: fixture('success-text.jsonl') },
        { resumeSessionId: 'old-session' },
      ),
    );
    const [first, second] = invocations();
    const resumed = first?.args ?? [];
    expect(resumed[resumed.indexOf('--resume') + 1]).toBe('old-session');
    expect(second?.args).not.toContain('--resume');
    // The fresh attempt is isolated from the repository's settings exactly like the first one.
    for (const attemptArgs of [first?.args, second?.args]) {
      expect(attemptArgs).toEqual(expect.arrayContaining(['--setting-sources', 'user']));
      expect(attemptArgs).toContain('--strict-mcp-config');
    }

    const fallback = events.find((event) => event.type === 'unknown');
    expect(fallback).toMatchObject({
      rawType: 'resume_fallback',
      raw: { sessionId: 'old-session' },
    });
    // The failed attempt's result is left out: the run is not over.
    expect(events.filter((event) => event.type === 'result')).toMatchObject([{ isError: false }]);
    expect(events.map((event) => event.seq)).toEqual(events.map((_event, index) => index));
    expect(outcome).toMatchObject({
      status: 'done',
      sessionId: '2f7b9a10-6c3d-4e5f-9a8b-1c2d3e4f5a6b',
    });
    expect(foldRunStatus(events)).toBe('done');
  });

  it('does not start afresh a session that already did work, whatever stderr says', async () => {
    const { outcome } = await run(
      options(
        {
          CLAUDE_FAKE_RESUME_FIXTURE: fixture('resume-model-text.jsonl'),
          CLAUDE_FAKE_STDERR: 'MCP session 7f3a not found',
        },
        { resumeSessionId: 'old-session' },
      ),
    );
    expect(invocations()).toHaveLength(1);
    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'max_turns' } });
  });
});

// The token limit and the server's ledger both read `countedUsage`: `outcome.usage` is what the
// limit counts, `normalizeUsage` is what `cost_events` are written from. These hold the two to
// each other on whole transcripts, so that a run is never stopped for tokens it is not billed for,
// or billed for tokens its limit never saw.
describe('runClaude: the token limit counts what the ledger counts', () => {
  /** The ledger's rows added up into the four counts of `outcome.usage`. */
  function ledgerTotals(events: RunEvent[]): UsageTotals {
    const rows = normalizeUsage(events);
    const sum = (field: keyof UsageTotals) => rows.reduce((total, row) => total + row[field], 0);
    return {
      tokensIn: sum('tokensIn'),
      tokensOut: sum('tokensOut'),
      tokensCacheRead: sum('tokensCacheRead'),
      tokensCacheWrite: sum('tokensCacheWrite'),
    };
  }

  const fixtures = readdirSync(new URL('./fixtures/', import.meta.url)).filter((name) =>
    name.endsWith('.jsonl'),
  );

  it.each(fixtures)('counts %s as the ledger does', async (name) => {
    const { outcome, events } = await run(options({ CLAUDE_FAKE_FIXTURE: fixture(name) }));
    expect(outcome.usage).toEqual(ledgerTotals(events));
  });

  /** An assistant line; the CLI writes one per content block of an answer, each with its usage. */
  const answer = (id: string, model: string, usage: object, block: object) =>
    JSON.stringify({ type: 'assistant', message: { id, model, content: [block], usage } });
  const text = { type: 'text', text: 'Reading.' };
  const call = { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} };
  const init = '{"type":"system","subtype":"init","session_id":"s-c","model":"claude-opus-5-5"}';
  const result = (usage: object) =>
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage });

  async function replay(name: string, lines: string[]) {
    writeFileSync(join(dir, name), `${lines.join('\n')}\n`);
    return run(options({ CLAUDE_FAKE_FIXTURE: join(dir, name) }));
  }

  it('counts the lines of one answer and two models alike while no result has come', async () => {
    const first = { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 100 };
    const cheap = { input_tokens: 5, output_tokens: 20, cache_creation_input_tokens: 30 };
    const { outcome, events } = await replay('turns.jsonl', [
      init,
      // One answer on two lines, its usage repeated and grown: the later report counts.
      answer('msg_1', 'claude-opus-5-5', first, text),
      answer('msg_1', 'claude-opus-5-5', { ...first, output_tokens: 40 }, call),
      answer('msg_2', 'claude-haiku-5-5', cheap, text),
      answer('msg_2', 'claude-haiku-5-5', cheap, call),
      answer('msg_3', 'claude-opus-5-5', { input_tokens: 7, output_tokens: 9 }, text),
      // A run killed before its result: the turns are all there is.
    ]);

    const burned = { tokensIn: 22, tokensOut: 69, tokensCacheRead: 100, tokensCacheWrite: 30 };
    expect(outcome.usage).toEqual(burned);
    expect(ledgerTotals(events)).toEqual(burned);
    expect(normalizeUsage(events)).toMatchObject([
      { model: 'claude-opus-5-5', tokensIn: 17, tokensOut: 49, tokensCacheRead: 100 },
      { model: 'claude-haiku-5-5', tokensIn: 5, tokensOut: 20, tokensCacheWrite: 30 },
    ]);
  });

  it('counts the totals of a result instead of the turns, which undercount output', async () => {
    const turn = { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 30 };
    const { outcome, events } = await replay('result-wins.jsonl', [
      init,
      answer('msg_1', 'claude-opus-5-5', turn, text),
      answer('msg_1', 'claude-opus-5-5', turn, call),
      result({ input_tokens: 10, output_tokens: 400, cache_creation_input_tokens: 30 }),
    ]);
    const burned = { tokensIn: 10, tokensOut: 400, tokensCacheRead: 0, tokensCacheWrite: 30 };
    expect(outcome.usage).toEqual(burned);
    expect(ledgerTotals(events)).toEqual(burned);
  });

  it('does not stop a run that is over for totals its turns did not see coming', async () => {
    const turn = { input_tokens: 100, output_tokens: 1 };
    const { outcome, types } = await run(
      options(
        {
          CLAUDE_FAKE_FIXTURE: (() => {
            const lines = [
              init,
              answer('msg_1', 'claude-opus-5-5', turn, text),
              result({ input_tokens: 100, output_tokens: 5000 }),
            ];
            writeFileSync(join(dir, 'over.jsonl'), `${lines.join('\n')}\n`);
            return join(dir, 'over.jsonl');
          })(),
        },
        { limits: { timeoutMs: 30_000, maxTurns: 20, maxTokens: 1500 } },
      ),
    );
    expect(types).toEqual(['started', 'assistant_message', 'usage', 'usage', 'result']);
    expect(outcome).toMatchObject({ status: 'done', usage: { tokensOut: 5000 } });
  });

  it('counts the totals of a result as they are when no turn reported its usage', async () => {
    const { outcome, events } = await replay('total.jsonl', [
      init,
      result({ input_tokens: 50, output_tokens: 5 }),
    ]);

    const [total, ...others] = events.filter((event) => event.type === 'usage');
    expect(total).toMatchObject({ model: 'claude-opus-5-5', tokensIn: 50, tokensOut: 5 });
    expect(total).not.toHaveProperty('messageId');
    expect(total).toMatchObject({ total: true });
    expect(others).toEqual([]);
    const burned = { tokensIn: 50, tokensOut: 5, tokensCacheRead: 0, tokensCacheWrite: 0 };
    expect(outcome.usage).toEqual(burned);
    expect(ledgerTotals(events)).toEqual(burned);
  });
});

describe('runClaude: a sink that throws', () => {
  it('stops the CLI and rejects with the sink error', async () => {
    const failing = runClaude(
      options({ CLAUDE_FAKE_FIXTURE: fixture('success-text.jsonl'), CLAUDE_FAKE_HANG: '1' }),
      () => {
        throw new Error('the outbox is closed');
      },
      new AbortController().signal,
    );
    await expect(failing).rejects.toThrow('the outbox is closed');
    expect(alive(invocations()[0]?.pid ?? 0)).toBe(false);
  });
});

describe('probe', () => {
  it('reports the version and who would pay', async () => {
    const env = { PATH: process.env.PATH, CLAUDE_FAKE_VERSION: '2.1.274 (Claude Code)' };
    expect(await probe({ cliPath: FAKE, env })).toEqual({
      installed: true,
      version: '2.1.274',
      billing: 'subscription',
    });
    expect(await probe({ cliPath: FAKE, env: { ...env, ANTHROPIC_API_KEY: 'sk' } })).toMatchObject({
      billing: 'api',
    });
  });

  it('answers "not installed" instead of throwing', async () => {
    expect(await probe({ cliPath: join(dir, 'no-claude-here'), env: {} })).toEqual({
      installed: false,
      billing: 'subscription',
    });
  });
});

describe('claudeSignedOut', () => {
  it('believes a CLI that says it is signed out, and nothing else', async () => {
    const out = join(dir, 'signed-out');
    const env = { PATH: process.env.PATH, CLAUDE_FAKE_LOGGED_OUT: out };
    expect(await claudeSignedOut({ cliPath: FAKE, env })).toBe(false);
    writeFileSync(out, '');
    expect(await claudeSignedOut({ cliPath: FAKE, env })).toBe(true);
    // A token from `claude setup-token` is the sign-in, whatever `auth status` makes of it.
    const token = { ...env, CLAUDE_CODE_OAUTH_TOKEN: 'token' };
    expect(await claudeSignedOut({ cliPath: FAKE, env: token })).toBe(false);
    // A CLI that is not there says nothing: the run it cannot start tells that.
    expect(await claudeSignedOut({ cliPath: join(dir, 'no-claude-here'), env })).toBe(false);
  });
});
