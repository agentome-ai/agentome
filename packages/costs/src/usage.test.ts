import type { RunEvent } from '@agentome/shared';
import { describe, expect, it } from 'vitest';

import { normalizeUsage } from './usage.js';

type Tokens = {
  tokensIn?: number;
  tokensOut?: number;
  tokensCacheRead?: number;
  tokensCacheWrite?: number;
  tokensCacheWrite1h?: number;
};

/** A `usage` event as the worker sends it, numbered by `seq`. */
function usage(seq: number, model: string, messageId: string | undefined, tokens: Tokens = {}) {
  return {
    type: 'usage',
    seq,
    at: '2026-10-21T10:00:00.000Z',
    model,
    tokensIn: 0,
    tokensOut: 0,
    tokensCacheRead: 0,
    tokensCacheWrite: 0,
    tokensCacheWrite1h: 0,
    messageId,
    ...tokens,
  } satisfies RunEvent;
}

const text = {
  type: 'assistant_message',
  seq: 9,
  at: '2026-10-21T10:00:00.000Z',
  text: 'hi',
} as const;

describe('normalizeUsage', () => {
  it('counts an API message once, though the CLI repeats its usage on every line of the answer', () => {
    const answer = { tokensIn: 6, tokensCacheRead: 12_000, tokensCacheWrite: 300 };
    const rows = normalizeUsage([
      usage(0, 'claude-sonnet-4-5', 'msg_1', { ...answer, tokensOut: 1 }),
      usage(1, 'claude-sonnet-4-5', 'msg_1', { ...answer, tokensOut: 40 }),
      usage(2, 'claude-sonnet-4-5', 'msg_1', { ...answer, tokensOut: 120 }),
      usage(3, 'claude-sonnet-4-5', 'msg_2', {
        tokensIn: 2,
        tokensOut: 80,
        tokensCacheRead: 12_300,
      }),
      usage(4, 'claude-sonnet-4-5', 'msg_2', {
        tokensIn: 2,
        tokensOut: 80,
        tokensCacheRead: 12_300,
      }),
    ]);
    expect(rows).toEqual([
      {
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        tokensIn: 8,
        tokensOut: 200,
        tokensCacheRead: 24_300,
        tokensCacheWrite: 300,
        tokensCacheWrite1h: 0,
        source: 'stream-json',
      },
    ]);
  });

  it('keeps the latest report of a message, as the launcher does for the token limit', () => {
    const rows = normalizeUsage([
      usage(0, 'claude-opus-5-5', 'msg_1', { tokensOut: 120 }),
      usage(1, 'claude-opus-5-5', 'msg_1', { tokensOut: 100 }),
    ]);
    expect(rows.map((row) => row.tokensOut)).toEqual([100]);
  });

  it('counts a report without a message id as it is, each one', () => {
    const rows = normalizeUsage([
      usage(0, 'claude-opus-5-5', undefined, { tokensIn: 10, tokensOut: 5 }),
      usage(1, 'claude-opus-5-5', undefined, { tokensIn: 10, tokensOut: 5 }),
    ]);
    expect(rows).toMatchObject([{ model: 'claude-opus-5-5', tokensIn: 20, tokensOut: 10 }]);
  });

  it('gives a row to each model of the run, in the order they first appear', () => {
    const rows = normalizeUsage([
      usage(0, 'claude-opus-5-5', 'msg_1', { tokensIn: 10, tokensOut: 100 }),
      usage(1, 'claude-haiku-5-5', 'msg_2', { tokensIn: 3, tokensCacheWrite: 7 }),
      usage(2, 'claude-opus-5-5', 'msg_3', { tokensIn: 20, tokensOut: 50 }),
    ]);
    expect(rows).toEqual([
      expect.objectContaining({ model: 'claude-opus-5-5', tokensIn: 30, tokensOut: 150 }),
      expect.objectContaining({ model: 'claude-haiku-5-5', tokensIn: 3, tokensCacheWrite: 7 }),
    ]);
  });

  it('takes the totals of a result over the turns, hour-long cache writes included', () => {
    const turn = { tokensIn: 10, tokensOut: 1, tokensCacheWrite: 900, tokensCacheWrite1h: 900 };
    const rows = normalizeUsage([
      usage(0, 'claude-haiku-4-5', 'msg_1', turn),
      usage(1, 'claude-haiku-4-5', 'msg_1', turn),
      {
        ...usage(2, 'claude-haiku-4-5', undefined, { ...turn, tokensOut: 617 }),
        total: true,
      },
    ]);
    expect(rows).toEqual([
      expect.objectContaining({ tokensOut: 617, tokensCacheWrite: 900, tokensCacheWrite1h: 900 }),
    ]);
  });

  it('reads the events in seq order, each position once', () => {
    const events = [
      usage(0, 'claude-opus-5-5', 'msg_1', { tokensOut: 1 }),
      usage(1, 'claude-opus-5-5', 'msg_1', { tokensOut: 90 }),
      usage(2, 'claude-opus-5-5', undefined, { tokensIn: 4 }),
    ];
    const expected = normalizeUsage(events);
    expect(expected).toMatchObject([{ tokensIn: 4, tokensOut: 90 }]);
    // A batch sent again, and a batch that arrived before the one ahead of it.
    expect(normalizeUsage([...events, ...events])).toEqual(expected);
    expect(normalizeUsage([...events].reverse())).toEqual(expected);
  });

  it('skips events that are not usage, and a run without any has no rows', () => {
    expect(normalizeUsage([text])).toEqual([]);
    expect(normalizeUsage([])).toEqual([]);
    const rows = normalizeUsage([text, usage(0, 'claude-opus-5-5', 'msg_1', { tokensOut: 3 })]);
    expect(rows).toMatchObject([{ tokensOut: 3 }]);
  });

  it('takes any iterable of events', () => {
    const events = new Set([usage(0, 'claude-opus-5-5', 'msg_1', { tokensIn: 1 })]);
    expect(normalizeUsage(events)).toMatchObject([{ tokensIn: 1 }]);
  });
});
