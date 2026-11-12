import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { RunEvent, countedUsage, foldRunStatus } from '@agentome/shared';
import type { RunEventDraft } from '@agentome/shared';
import { describe, expect, it } from 'vitest';

import { MAX_LINE_BYTES, MAX_TEXT_CHARS, createStreamJsonParser } from './stream-json.js';

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');
}

function replay(name: string) {
  const parser = createStreamJsonParser();
  const events = [...parser.push(fixture(name)), ...parser.end()];
  return { events, state: parser.state };
}

function parseLines(...lines: string[]): RunEventDraft[] {
  const parser = createStreamJsonParser();
  return [...parser.push(lines.map((line) => `${line}\n`).join('')), ...parser.end()];
}

function types(events: readonly RunEventDraft[]): string[] {
  return events.map((event) =>
    event.type === 'unknown' ? `unknown:${event.rawType}` : event.type,
  );
}

/** What each line of a fixture makes of itself, in order: its kind and the events it gave. */
function perLine(name: string): [string, string[]][] {
  const parser = createStreamJsonParser();
  return fixture(name)
    .trim()
    .split('\n')
    .map((line) => {
      const { type, subtype } = JSON.parse(line) as { type: string; subtype?: string };
      return [subtype === undefined ? type : `${type}/${subtype}`, types(parser.push(`${line}\n`))];
    });
}

/** What the launcher does to a draft before the sink sees it. */
function stamp(events: readonly RunEventDraft[]): RunEvent[] {
  return events.map((draft, seq) =>
    RunEvent.parse({ ...draft, seq, at: '2026-10-21T10:00:00.000Z' }),
  );
}

const FIXTURES = [
  'auth-401.jsonl',
  'rate-limit-rejected.jsonl',
  'success-text.jsonl',
  'tool-use.jsonl',
  'garbage.jsonl',
  'resume-poisoned.jsonl',
  'resume-model-text.jsonl',
  'rate-limit-info.jsonl',
  'gateway-cache-usage.jsonl',
  'housekeeping.jsonl',
  'multi-block-usage.jsonl',
  'org-not-allowed.jsonl',
];

describe('stream-json fixtures', () => {
  it.each(FIXTURES)('%s: every event fits the platform schema', (name) => {
    expect(() => stamp(replay(name).events)).not.toThrow();
  });

  it('reads a successful text answer', () => {
    const { events, state } = replay('success-text.jsonl');
    expect(types(events)).toEqual(['started', 'assistant_message', 'usage', 'usage', 'result']);
    expect(events[0]).toEqual({
      type: 'started',
      sessionId: '2f7b9a10-6c3d-4e5f-9a8b-1c2d3e4f5a6b',
      model: 'claude-opus-4-6[1m]',
      cliVersion: '2.1.90',
    });
    expect(events[2]).toEqual({
      type: 'usage',
      model: 'claude-opus-4-6[1m]',
      tokensIn: 1843,
      tokensOut: 96,
      tokensCacheRead: 12480,
      tokensCacheWrite: 311,
      tokensCacheWrite1h: 0,
      messageId: 'msg_01SuccessText',
    });
    // The result's totals, without `modelUsage` in this CLI: one row for the run's model.
    expect(events[3]).toEqual({
      type: 'usage',
      model: 'claude-opus-4-6[1m]',
      tokensIn: 1843,
      tokensOut: 96,
      tokensCacheRead: 12480,
      tokensCacheWrite: 311,
      tokensCacheWrite1h: 0,
      total: true,
    });
    expect(events[4]).toEqual({
      type: 'result',
      text: 'The build script already runs the linter, so nothing has to change.',
      isError: false,
      sessionId: '2f7b9a10-6c3d-4e5f-9a8b-1c2d3e4f5a6b',
    });
    expect(foldRunStatus(stamp(events))).toBe('done');
    expect(state.result).toMatchObject({ isError: false, subtype: 'success' });
  });

  it("puts a team member's events under the lead's call, and keeps its model off the run", () => {
    const parent = 'toolu_lead_agent';
    const events = parseLines(
      JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-4-1' }),
      JSON.stringify({ type: 'system', subtype: 'task_started', task_id: 't1' }),
      JSON.stringify({
        type: 'user',
        parent_tool_use_id: parent,
        message: { role: 'user', content: [{ type: 'text', text: 'Build the refund API' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        parent_tool_use_id: parent,
        message: {
          id: 'msg_member',
          model: 'claude-haiku-4-5',
          content: [
            { type: 'text', text: 'On it.' },
            { type: 'tool_use', id: 'toolu_member', name: 'Read', input: { file_path: 'a.ts' } },
          ],
          usage: { input_tokens: 3, output_tokens: 5 },
        },
      }),
      JSON.stringify({
        type: 'user',
        parent_tool_use_id: parent,
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_member', content: 'x' }] },
      }),
      // A denial names the member's call, not the assignment.
      JSON.stringify({
        type: 'system',
        subtype: 'permission_denied',
        agent_id: 'a1',
        tool_name: 'Read',
        tool_use_id: 'toolu_member',
      }),
    );
    const lead = { type: 'system', subtype: 'permission_denied', tool_use_id: 'toolu_lead_write' };
    expect(parseLines(JSON.stringify(lead))[0]).not.toHaveProperty('parentToolUseId');
    // The assignment's text is the lead's call's input already; the progress lines say nothing more.
    const heartbeat = { type: 'tool_progress', heartbeat: true, tool_name: 'Agent' };
    expect(parseLines(JSON.stringify({ ...heartbeat, parent_tool_use_id: parent }))).toEqual([]);
    expect(types(events)).toEqual([
      'started',
      'assistant_message',
      'tool_use',
      'usage',
      'tool_result',
      'unknown:system/permission_denied',
    ]);
    for (const event of events.filter((e) => e.type !== 'started' && e.type !== 'usage')) {
      expect(event).toMatchObject({ parentToolUseId: parent });
    }
    expect(events.find((e) => e.type === 'usage')).toMatchObject({ model: 'claude-haiku-4-5' });
    expect(events.find((e) => e.type === 'usage')).not.toHaveProperty('parentToolUseId');
  });

  it('reads a tool call and its result, and drops the thinking block', () => {
    const { events } = replay('tool-use.jsonl');
    expect(types(events)).toEqual([
      'started',
      'assistant_message',
      'tool_use',
      'usage',
      'tool_result',
      'assistant_message',
      'usage',
      'usage',
      'result',
    ]);
    expect(events[2]).toEqual({
      type: 'tool_use',
      id: 'toolu_01ReadPackageJson',
      name: 'Read',
      input: { file_path: '/tmp/agentome-run/package.json' },
    });
    expect(events[4]).toMatchObject({
      type: 'tool_result',
      toolUseId: 'toolu_01ReadPackageJson',
      isError: false,
    });
    expect(JSON.stringify(events)).not.toContain('The manifest has no scripts section');
  });

  it('reports the turns as they come and the totals of the result after them', () => {
    const text = fixture('tool-use.jsonl').trim().split('\n');
    const reported = (JSON.parse(text.at(-1) ?? '{}') as { usage: Record<string, number> }).usage;
    const usage = replay('tool-use.jsonl').events.filter((event) => event.type === 'usage');
    const turns = usage.filter((event) => !event.total);
    const sum = (field: 'tokensIn' | 'tokensOut' | 'tokensCacheRead' | 'tokensCacheWrite') =>
      turns.reduce((total, event) => total + event[field], 0);

    expect(turns).toHaveLength(2);
    expect(sum('tokensIn')).toBe(reported.input_tokens);
    expect(sum('tokensCacheRead')).toBe(reported.cache_read_input_tokens);
    expect(usage.at(-1)).toMatchObject({
      total: true,
      tokensIn: reported.input_tokens,
      tokensOut: reported.output_tokens,
      tokensCacheRead: reported.cache_read_input_tokens,
      tokensCacheWrite: reported.cache_creation_input_tokens,
    });
  });

  it('multi-block-usage (recorded): the result knows the output tokens the turns do not', () => {
    // Claude Code 2.1.280 repeats the usage it had when an answer started on every line of it:
    // three answers (a Write, a commit with a heredoc, "done") whose lines say 1, 2 and 1 output
    // tokens, where the session log and the result say 617, 320 and 73.
    const { events } = replay('multi-block-usage.jsonl');
    const usage = events.filter((event) => event.type === 'usage');
    const turns = usage.filter((event) => !event.total);
    expect(turns.map((event) => event.tokensOut)).toEqual([1, 1, 1, 2, 2, 1, 1]);
    expect(turns.map((event) => event.tokensCacheWrite1h)).toEqual([
      8955, 8955, 8955, 2663, 2663, 414, 414,
    ]);
    expect(usage.filter((event) => event.total)).toEqual([
      {
        type: 'usage',
        model: 'claude-haiku-4-5-20251001',
        tokensIn: 26,
        tokensOut: 1010,
        tokensCacheRead: 61661,
        tokensCacheWrite: 12032,
        // Every write of the run lived for an hour; the turns say so, once per message.
        tokensCacheWrite1h: 12032,
        total: true,
      },
    ]);
    expect(countedUsage(stamp(events)).map((event) => event.tokensOut)).toEqual([1010]);
    expect(foldRunStatus(stamp(events))).toBe('done');
  });

  it('auth-401 (recorded): a "success" subtype with is_error is a failure, and costs nothing', () => {
    const { events, state } = replay('auth-401.jsonl');
    expect(types(events)).toEqual([
      'started',
      ...Array.from({ length: 10 }, () => 'unknown:system/api_retry'),
      'assistant_message',
      'error',
      'result',
    ]);
    expect(events.at(-2)).toMatchObject({ code: 'authentication_failed', fatal: false });
    expect(events.at(-1)).toMatchObject({ type: 'result', isError: true });
    expect(events.some((event) => event.type === 'usage')).toBe(false);
    expect(state.diagnostics).toContain('authentication_failed');
    expect(foldRunStatus(stamp(events))).toBe('failed');
  });

  it('rate-limit-rejected (recorded): a readable note, then the failed result', () => {
    const { events, state } = replay('rate-limit-rejected.jsonl');
    expect(types(events)).toEqual([
      'started',
      'unknown:rate_limit_event',
      'error',
      'assistant_message',
      'result',
    ]);
    expect(events[2]).toEqual({
      type: 'error',
      code: 'rate_limited',
      message:
        'The Claude account has reached its seven_day limit, which resets at 2026-09-22T05:00:00.000Z.',
      fatal: false,
    });
    expect(events.some((event) => event.type === 'usage')).toBe(false);
    expect(state.diagnostics).toContain('rate_limited');
  });

  it('rate-limit-info: an account with room left is housekeeping, not an event', () => {
    const { events } = replay('rate-limit-info.jsonl');
    expect(types(events)).toEqual(['started', 'assistant_message', 'usage', 'usage', 'result']);
  });

  it('housekeeping (recorded): the CLI notes about the computer are no part of the transcript', () => {
    expect(perLine('housekeeping.jsonl')).toEqual([
      ['system/init', ['started']],
      ['system/commands_changed', []],
      ['rate_limit_event', []],
      ['system/thinking_tokens', []],
      ['system/thinking_tokens', []],
      ['assistant', ['assistant_message', 'usage']],
      ['system/vcs_state_changed', []],
      ['result/success', ['usage', 'result']],
    ]);

    // The run reads as if the notes had never been there.
    const { events, state } = replay('housekeeping.jsonl');
    expect(events.at(-1)).toEqual({
      type: 'result',
      text: 'The README already says how to run the tests, so nothing has to change.',
      isError: false,
      sessionId: '5b1e8d24-7a39-4c60-8e15-9f3a6b2c4d70',
    });
    expect(foldRunStatus(stamp(events))).toBe('done');
    expect(state.result).toMatchObject({ isError: false, subtype: 'success' });
    expect(state.diagnostics).toEqual([]);
    // The person's commands are kept nowhere, not even as an `unknown` event.
    expect(JSON.stringify(events)).not.toContain('acme-release');
  });

  it('degrades every shape of garbage and still reads the lines around it', () => {
    const { events } = replay('garbage.jsonl');
    expect(types(events)).toEqual([
      'unknown:invalid_json',
      'unknown:system/compact_boundary',
      'unknown:stream_event',
      'unknown:quantum_entanglement',
      'unknown:non_object',
      'unknown:untyped',
      'unknown:assistant/tool_use',
      'unknown:assistant/image',
      'usage',
      'unknown:user/tool_result',
      'unknown:system/api_retry',
      'usage',
      'result',
    ]);
    expect(events[0]).toEqual({
      type: 'unknown',
      rawType: 'invalid_json',
      raw: 'this line is not json at all',
    });
    expect(foldRunStatus(stamp(events))).toBe('done');
  });

  it('resume-poisoned: keeps what the CLI said about the session, not just the result text', () => {
    const { state } = replay('resume-poisoned.jsonl');
    expect(state.result).toMatchObject({ isError: true, subtype: 'error_during_execution' });
    expect(state.diagnostics.join('\n')).toMatch(/previous_message_id.*starts with `msg_`/);
  });

  it('resume-model-text: the model writing about sessions is not a diagnostic', () => {
    const { state } = replay('resume-model-text.jsonl');
    expect(state.result).toMatchObject({ isError: true, subtype: 'error_max_turns' });
    expect(state.result?.text).toMatch(/no conversation found with session id/i);
    expect(state.diagnostics).toEqual([]);
  });

  it('gateway-cache-usage: a gateway model name passes through as the CLI spelled it', () => {
    const usage = replay('gateway-cache-usage.jsonl').events.find((e) => e.type === 'usage');
    expect(usage).toMatchObject({ model: 'litellm_proxy/claude-opus-4-6', tokensCacheWrite: 311 });
  });
});

describe('single lines', () => {
  it('turns lines nobody documented into unknown events, never an exception', () => {
    const events = parseLines(
      '{"type":"cron_reminder","at":"noon"}',
      '[1,2]',
      '{"note":"no type here"}',
      '{"type":"system","subtype":"weird"}',
      '{"type":"tool_progress","tool_use_id":"toolu_1"}',
      '{"type":"assistant","message":{"id":"msg_1","content":[{"type":"text","text":"cut off',
      '{"type":"assistant"}',
      '{"type":"user","message":{"content":"a prompt echoed as plain text"}}',
    );
    expect(types(events)).toEqual([
      'unknown:cron_reminder',
      'unknown:non_object',
      'unknown:untyped',
      'unknown:system/weird',
      'unknown:tool_progress',
      'unknown:invalid_json',
      'unknown:assistant',
      'unknown:user',
    ]);
    expect(events[0]).toEqual({
      type: 'unknown',
      rawType: 'cron_reminder',
      raw: { type: 'cron_reminder', at: 'noon' },
    });
  });

  it('ignores blank lines', () => {
    expect(parseLines('', '   ', '\t')).toEqual([]);
  });

  it('keeps an unreadable line, an oversized value and a tool output short', () => {
    const [line] = parseLines('x'.repeat(MAX_TEXT_CHARS * 2));
    expect(line).toMatchObject({ type: 'unknown', rawType: 'invalid_json' });
    expect(String(line?.type === 'unknown' ? line.raw : '')).toMatch(
      new RegExp(`^x{${String(MAX_TEXT_CHARS)}}… \\(${String(MAX_TEXT_CHARS)} more characters\\)$`),
    );

    const huge = 'y'.repeat(MAX_TEXT_CHARS * 2);
    const [call, result] = parseLines(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'Write', input: { content: huge } }],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: huge }] },
      }),
    );
    expect(call).toMatchObject({ type: 'tool_use', name: 'Write' });
    expect(call?.type === 'tool_use' ? call.input : undefined).toMatch(/^\{"content":"y+…/);
    expect(result?.type === 'tool_result' ? result.output.length : 0).toBeLessThan(
      MAX_TEXT_CHARS + 40,
    );
  });

  it('reads a tool output given as content blocks, and the tool verdict', () => {
    const [result] = parseLines(
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              is_error: true,
              content: [
                { type: 'text', text: 'line one' },
                { type: 'image', source: {} },
                { type: 'text', text: 'line two' },
              ],
            },
          ],
        },
      }),
    );
    expect(result).toEqual({
      type: 'tool_result',
      toolUseId: 'toolu_1',
      output: 'line one\n[image]\nline two',
      isError: true,
    });
  });

  it('reports the totals of a result per model, with the hour-long writes of the turns', () => {
    const turn = (id: string, model: string, oneHour: number) =>
      JSON.stringify({
        type: 'assistant',
        message: {
          id,
          model,
          content: [{ type: 'text', text: 'working' }],
          usage: {
            input_tokens: 5,
            output_tokens: 1,
            cache_creation_input_tokens: 100,
            cache_creation: { ephemeral_1h_input_tokens: oneHour },
          },
        },
      });
    const result = JSON.stringify({
      type: 'result',
      is_error: false,
      result: 'ok',
      usage: { input_tokens: 15, output_tokens: 700, cache_creation_input_tokens: 300 },
      modelUsage: {
        'claude-opus-5-5': {
          inputTokens: 10,
          outputTokens: 600,
          cacheCreationInputTokens: 200,
          costUSD: 0.1,
        },
        'claude-haiku-5-5': { inputTokens: 5, outputTokens: 100, cacheCreationInputTokens: 100 },
        '<synthetic>': { inputTokens: 0, outputTokens: 0 },
      },
    });
    const events = parseLines(
      turn('msg_1', 'claude-opus-5-5', 100),
      turn('msg_1', 'claude-opus-5-5', 100),
      turn('msg_2', 'claude-opus-5-5', 0),
      turn('msg_3', 'claude-haiku-5-5', 100),
      result,
    );
    const totals = events.filter((event) => event.type === 'usage' && event.total);
    expect(totals).toEqual([
      {
        type: 'usage',
        model: 'claude-opus-5-5',
        tokensIn: 10,
        tokensOut: 600,
        tokensCacheRead: 0,
        tokensCacheWrite: 200,
        // msg_1 once, though it came on two lines.
        tokensCacheWrite1h: 100,
        total: true,
      },
      {
        type: 'usage',
        model: 'claude-haiku-5-5',
        tokensIn: 5,
        tokensOut: 100,
        tokensCacheRead: 0,
        tokensCacheWrite: 100,
        tokensCacheWrite1h: 100,
        total: true,
      },
    ]);
  });

  it('reports the totals of a result with its own split when the CLI gives no modelUsage', () => {
    const events = parseLines(
      '{"type":"system","subtype":"init","session_id":"s-1","model":"claude-sonnet-5"}',
      '{"type":"result","is_error":false,"result":"ok","usage":{"input_tokens":12,"output_tokens":3,"cache_creation_input_tokens":40,"cache_creation":{"ephemeral_1h_input_tokens":30}}}',
    );
    expect(types(events)).toEqual(['started', 'usage', 'result']);
    expect(events[1]).toEqual({
      type: 'usage',
      model: 'claude-sonnet-5',
      tokensIn: 12,
      tokensOut: 3,
      tokensCacheRead: 0,
      tokensCacheWrite: 40,
      tokensCacheWrite1h: 30,
      total: true,
    });
    expect(events[2]).toMatchObject({ sessionId: 's-1' });
  });

  it('takes the split of a run with one model from the result, whatever its turns say', () => {
    const turn = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_1',
        // A turn may spell the model otherwise than modelUsage does.
        model: 'claude-opus-4-6[1m]',
        content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 1, cache_creation_input_tokens: 50 },
      },
    });
    const result = JSON.stringify({
      type: 'result',
      result: 'ok',
      usage: {
        input_tokens: 1,
        cache_creation_input_tokens: 50,
        cache_creation: { ephemeral_1h_input_tokens: 40 },
      },
      modelUsage: { 'claude-opus-4-6': { inputTokens: 1, cacheCreationInputTokens: 50 } },
    });
    expect(parseLines(turn, result).at(-2)).toMatchObject({
      model: 'claude-opus-4-6',
      tokensCacheWrite: 50,
      tokensCacheWrite1h: 40,
    });
  });

  it('starts the hour-long writes of the turns afresh for the result of a second session', () => {
    const parser = createStreamJsonParser();
    const line = (value: unknown) => parser.push(`${JSON.stringify(value)}\n`);
    const turn = (model: string) => ({
      type: 'assistant',
      message: {
        id: `msg_${model}`,
        model,
        content: [{ type: 'text', text: 'hi' }],
        usage: {
          input_tokens: 1,
          cache_creation_input_tokens: 50,
          cache_creation: { ephemeral_1h_input_tokens: 50 },
        },
      },
    });
    const result = {
      type: 'result',
      result: 'ok',
      modelUsage: {
        'claude-opus-5-5': { inputTokens: 1, cacheCreationInputTokens: 50 },
        'claude-haiku-5-5': { inputTokens: 1, cacheCreationInputTokens: 50 },
      },
    };
    line(turn('claude-opus-5-5'));
    line(turn('claude-haiku-5-5'));
    expect(line(result).slice(0, 2)).toMatchObject([
      { tokensCacheWrite1h: 50 },
      { tokensCacheWrite1h: 50 },
    ]);
    expect(line(result).slice(0, 2)).toMatchObject([
      { tokensCacheWrite1h: 0 },
      { tokensCacheWrite1h: 0 },
    ]);
  });

  it('drops an allowed rate limit, notes a rejected one and keeps any other status', () => {
    const limit = (status: string) =>
      JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status } });
    expect(parseLines(limit('allowed'))).toEqual([]);
    expect(types(parseLines(limit('rejected')))).toEqual(['unknown:rate_limit_event', 'error']);
    expect(types(parseLines(limit('allowed_warning'), limit('unheard_of')))).toEqual([
      'unknown:rate_limit_event',
      'unknown:rate_limit_event',
    ]);
  });

  it('survives a rejected rate limit whose block it does not know', () => {
    const events = parseLines(
      '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":"soon"}}',
      '{"type":"rate_limit_event"}',
    );
    expect(types(events)).toEqual([
      'unknown:rate_limit_event',
      'error',
      'unknown:rate_limit_event',
    ]);
    expect(events[1]).toMatchObject({
      code: 'rate_limited',
      message: 'The Claude account has reached its usage limit.',
    });
  });
});

describe('line splitting', () => {
  it('joins a line that arrived in pieces and accepts CRLF', () => {
    const parser = createStreamJsonParser();
    expect(parser.push('{"type":"system","subtype":"init","sessi')).toEqual([]);
    const events = parser.push('on_id":"s-9"}\r\n{"type":"system","subtype":"api_retry"}\r\n');
    expect(types(events)).toEqual(['started', 'unknown:system/api_retry']);
    expect(parser.state.sessionId).toBe('s-9');
  });

  it('delivers a last line that never got its newline, once', () => {
    const parser = createStreamJsonParser();
    expect(parser.push('{"type":"system","subtype":"api_retry"}')).toEqual([]);
    expect(types(parser.end())).toEqual(['unknown:system/api_retry']);
    expect(parser.end()).toEqual([]);
  });

  it('decodes a multi-byte character split across chunks', () => {
    const parser = createStreamJsonParser();
    const line = Buffer.from(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"ok — да"}]}}\n',
    );
    const events = [
      ...parser.push(line.subarray(0, 70)),
      ...parser.push(line.subarray(70)),
      ...parser.end(),
    ];
    expect(events).toEqual([{ type: 'assistant_message', text: 'ok — да' }]);
  });

  it('keeps a long but finite line', () => {
    const text = 'z'.repeat(MAX_LINE_BYTES / 2);
    const events = parseLines(
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }),
    );
    expect(events).toEqual([{ type: 'assistant_message', text }]);
  });

  it('drops a line that never ends, says so once, and reads the next line', () => {
    const parser = createStreamJsonParser();
    const chunk = 'x'.repeat(MAX_LINE_BYTES / 2 + 1);
    const events = [...parser.push(chunk), ...parser.push(chunk), ...parser.push(chunk)];
    expect(types(events)).toEqual(['unknown:line_overflow']);
    expect(types(parser.push('rest of the same line\n{"type":"system","subtype":"x"}\n'))).toEqual([
      'unknown:system/x',
    ]);
  });
});
