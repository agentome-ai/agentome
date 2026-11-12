import { describe, expect, it } from 'vitest';

import { RUN_CANCELLED_CODE, RunEvent, countedUsage, foldRunStatus } from './run-events.js';
import type { RunEventDraft, UsageEvent } from './run-events.js';

const at = '2026-10-21T10:00:00.000Z';

function events(...drafts: RunEventDraft[]): RunEvent[] {
  return drafts.map((draft, seq) => RunEvent.parse({ ...draft, seq, at }));
}

const started: RunEventDraft = { type: 'started', sessionId: 's-1' };
const note: RunEventDraft = { type: 'error', code: 'rate_limited', message: 'x', fatal: false };
const ok: RunEventDraft = { type: 'result', text: 'done', isError: false };
const failed: RunEventDraft = { type: 'result', text: 'API Error: 401', isError: true };
const timeout: RunEventDraft = { type: 'error', code: 'timeout', message: 'x', fatal: true };
const cancelled: RunEventDraft = {
  type: 'error',
  code: RUN_CANCELLED_CODE,
  message: 'The run was cancelled.',
  fatal: true,
};

describe('RunEvent', () => {
  it('refuses an event without its envelope or with a broken one', () => {
    expect(RunEvent.safeParse(started).success).toBe(false);
    expect(RunEvent.safeParse({ ...started, seq: -1, at }).success).toBe(false);
    expect(RunEvent.safeParse({ ...started, seq: 0, at: 'yesterday' }).success).toBe(false);
    expect(RunEvent.safeParse({ ...started, seq: 2 ** 31, at }).success).toBe(false);
    expect(RunEvent.safeParse({ type: 'diff', seq: 0, at }).success).toBe(false);
  });

  it('accepts a time with an offset, as a computer may stamp it', () => {
    expect(
      RunEvent.safeParse({ ...started, seq: 0, at: '2026-10-21T13:00:00+03:00' }).success,
    ).toBe(true);
  });
});

describe('foldRunStatus', () => {
  it('is queued before the first event and running after it', () => {
    expect(foldRunStatus([])).toBe('queued');
    expect(foldRunStatus(events(started))).toBe('running');
    expect(foldRunStatus(events({ type: 'unknown', rawType: 'system/api_retry', raw: {} }))).toBe(
      'running',
    );
  });

  it('ends with the result: done, or failed when the CLI says it failed', () => {
    expect(foldRunStatus(events(started, ok))).toBe('done');
    expect(foldRunStatus(events(started, failed))).toBe('failed');
  });

  it('reads a note as a note and a fatal error as the end', () => {
    expect(foldRunStatus(events(started, note))).toBe('running');
    expect(foldRunStatus(events(started, timeout))).toBe('failed');
    expect(foldRunStatus(events(started, cancelled))).toBe('cancelled');
  });

  it('lets the first terminal event win', () => {
    expect(foldRunStatus(events(started, cancelled, ok))).toBe('cancelled');
    expect(foldRunStatus(events(started, timeout, ok))).toBe('failed');
    expect(foldRunStatus(events(started, ok, timeout))).toBe('done');
    expect(foldRunStatus(events(started, failed, cancelled))).toBe('failed');
  });

  it('folds by seq, each position once, however the batch arrived', () => {
    const transcript = events(started, timeout, ok);
    expect(foldRunStatus([...transcript].reverse())).toBe('failed');
    expect(foldRunStatus([...transcript, ...transcript])).toBe('failed');
    // A second event at a position already taken is a delivery artefact, not news.
    const late = RunEvent.parse({ ...ok, seq: 1, at });
    expect(foldRunStatus([...transcript, late])).toBe('failed');
  });
});

type UsageDraft = Extract<RunEventDraft, { type: 'usage' }>;

describe('countedUsage', () => {
  /** A report of the tokens of one API message, or of none when the CLI gave no id. */
  const report = (messageId: string | undefined, tokensOut: number): UsageDraft => ({
    type: 'usage',
    model: 'claude-opus-5-5',
    tokensIn: 1,
    tokensOut,
    tokensCacheRead: 0,
    tokensCacheWrite: 0,
    tokensCacheWrite1h: 0,
    messageId,
  });
  /** The totals of one model from a `result` line. */
  const total = (model: string, tokensOut: number): UsageDraft => ({
    ...report(undefined, tokensOut),
    model,
    total: true,
  });
  const out = (counted: UsageEvent[]) => counted.map((event) => event.tokensOut);

  it('counts an API message once, at its latest report: the CLI repeats it on every line', () => {
    const answer = events(
      report('msg_1', 1),
      report('msg_1', 40),
      report('msg_1', 120),
      report('msg_2', 80),
      report('msg_2', 80),
    );
    expect(out(countedUsage(answer))).toEqual([120, 80]);
    // The latest wins even when it is the smaller one.
    expect(out(countedUsage(events(report('msg_1', 120), report('msg_1', 100))))).toEqual([100]);
  });

  it('counts a report without a message id as it is, each one', () => {
    const counted = countedUsage(
      events(report(undefined, 5), report(undefined, 5), report('m', 7)),
    );
    expect(out(counted)).toEqual([5, 5, 7]);
  });

  it('lists the messages in the order they first appeared, each with its latest report', () => {
    const counted = countedUsage(
      events(report('msg_1', 1), report('msg_2', 2), report('msg_1', 3)),
    );
    expect(counted.map(({ messageId, seq }) => [messageId, seq])).toEqual([
      ['msg_1', 2],
      ['msg_2', 1],
    ]);
  });

  it('counts the totals of a result instead of the turns before it', () => {
    // Recorded on Claude Code 2.1.280: three answers whose lines said 1, 2 and 1 output tokens,
    // and a result that knew they burned 1010.
    const run = events(
      report('msg_1', 1),
      report('msg_1', 1),
      report('msg_2', 2),
      report('msg_3', 1),
      total('claude-haiku-4-5', 1010),
    );
    expect(out(countedUsage(run))).toEqual([1010]);
    // One total per model, each counted.
    const twoModels = events(
      report('msg_1', 1),
      total('claude-opus-5-5', 900),
      total('claude-haiku-4-5', 50),
    );
    expect(countedUsage(twoModels).map(({ model, tokensOut }) => [model, tokensOut])).toEqual([
      ['claude-opus-5-5', 900],
      ['claude-haiku-4-5', 50],
    ]);
  });

  it('counts each session of a continued run by its own result, and turns after the last', () => {
    const run = events(
      report('msg_1', 1),
      total('claude-opus-5-5', 300),
      report('msg_2', 1),
      total('claude-opus-5-5', 200),
      report('msg_3', 7),
      report('msg_3', 9),
    );
    expect(out(countedUsage(run))).toEqual([300, 200, 9]);
  });

  it('reads the events in seq order, each position once, however the batch arrived', () => {
    const transcript = events(report('msg_1', 1), report('msg_1', 90), report(undefined, 4));
    const expected = countedUsage(transcript);
    expect(out(expected)).toEqual([90, 4]);
    expect(countedUsage([...transcript, ...transcript])).toEqual(expected);
    expect(countedUsage([...transcript].reverse())).toEqual(expected);
    // A second event at a position already taken is a delivery artefact, not news.
    const late = RunEvent.parse({ ...report('msg_1', 500), seq: 1, at });
    expect(countedUsage([...transcript, late])).toEqual(expected);
  });

  it('skips what is not usage, and takes any iterable of events', () => {
    expect(countedUsage([])).toEqual([]);
    expect(countedUsage(events(started, ok))).toEqual([]);
    expect(out(countedUsage(new Set(events(started, report('msg_1', 3)))))).toEqual([3]);
  });
});
