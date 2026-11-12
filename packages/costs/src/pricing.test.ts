import { describe, expect, it } from 'vitest';

import { KNOWN_MODELS, isKnownModel, priceUsage } from './pricing.js';
import type { PriceEntry, PriceTable, PricedUsage } from './pricing.js';

const none = {
  tokensIn: 0,
  tokensOut: 0,
  tokensCacheRead: 0,
  tokensCacheWrite: 0,
  tokensCacheWrite1h: 0,
};
const usage = (model: string, tokens: Partial<PricedUsage> = {}): PricedUsage => ({
  ...none,
  ...tokens,
  model,
});

/** A row of a made-up table; the real one is for the tests that price against it. */
const row = (input: number, output: number, rest: Partial<PriceEntry> = {}): PriceEntry => ({
  input_cost_per_token: input,
  output_cost_per_token: output,
  litellm_provider: 'anthropic',
  ...rest,
});

describe('priceUsage against the vendored table', () => {
  // Rates are those of prices.json, read off by hand; every figure below is tokens times the
  // rate, so the expected string is not computed by the code under test.
  it('prices the four kinds of token of Sonnet 4.5, each at its own rate', () => {
    // input 3e-6, output 1.5e-5, cache read 3e-7, cache write 3.75e-6 per token
    const tokens = { tokensIn: 12_345, tokensOut: 2_345, tokensCacheRead: 100_000 };
    expect(
      priceUsage(usage('claude-sonnet-4-5-20250929', { ...tokens, tokensCacheWrite: 20_000 })),
    ).toEqual({ usd: '0.177210', matchedModel: 'claude-sonnet-4-5-20250929' });
    // 0.037035 + 0.035175 + 0.03 + 0.075
  });

  it('prices Opus 4.5 by its own list: 5e-6, 2.5e-5, 5e-7 and 6.25e-6 per token', () => {
    const tokens = { tokensIn: 1_000, tokensOut: 500, tokensCacheRead: 200_000 };
    expect(priceUsage(usage('claude-opus-4-5', { ...tokens, tokensCacheWrite: 10_000 }))).toEqual({
      usd: '0.180000', // 0.005 + 0.0125 + 0.1 + 0.0625
      matchedModel: 'claude-opus-4-5',
    });
  });

  it('prices Opus 5.5, which reads the cache cheaper than Opus 5, at a dollar per bucket', () => {
    // 4e-6 in, 2e-5 out, 2e-7 cache read, 5e-6 cache write: each count below is worth $1.
    const dollar = {
      tokensIn: 250_000,
      tokensOut: 50_000,
      tokensCacheRead: 5_000_000,
      tokensCacheWrite: 200_000,
    };
    expect(priceUsage(usage('claude-opus-5-5', dollar)).usd).toBe('4.000000');
    expect(priceUsage(usage('claude-opus-5', { tokensCacheRead: 5_000_000 })).usd).toBe('2.500000');
  });

  it('prices Haiku 5.5, whose rates are the smallest in the table', () => {
    // 1e-7 in, 5e-7 out, 1e-8 cache read, 1.25e-7 cache write
    const tokens = { tokensIn: 3_000_000, tokensOut: 1_000_000, tokensCacheRead: 10_000_000 };
    expect(
      priceUsage(usage('claude-haiku-5-5', { ...tokens, tokensCacheWrite: 2_000_000 })).usd,
    ).toBe('1.150000'); // 0.3 + 0.5 + 0.1 + 0.25
  });

  it('prices a cache write by how long it lives: an hour costs 1.6 times five minutes', () => {
    // Haiku 4.5: 1.25e-6 for five minutes, 2e-6 for an hour.
    const writes = { tokensCacheWrite: 1_000_000, tokensCacheWrite1h: 400_000 };
    expect(priceUsage(usage('claude-haiku-4-5', writes)).usd).toBe('1.550000'); // 0.75 + 0.8
  });

  it('prices a recorded run as Claude Code did, to the microdollar', () => {
    // The result of a three-turn Haiku 4.5 run on CLI 2.1.280, whose cache writes all lived for
    // an hour; its total_cost_usd was 0.0353061.
    const run = {
      tokensIn: 26,
      tokensOut: 1_010,
      tokensCacheRead: 61_661,
      tokensCacheWrite: 12_032,
      tokensCacheWrite1h: 12_032,
    };
    expect(priceUsage(usage('claude-haiku-4-5-20251001', run)).usd).toBe('0.035306');
  });

  it('keeps the cache read rate per model: Fable 5.1 reads four times cheaper than Fable 5', () => {
    const million = { tokensCacheRead: 1_000_000 };
    expect(priceUsage(usage('claude-fable-5-1', million)).usd).toBe('0.250000');
    expect(priceUsage(usage('claude-fable-5', million)).usd).toBe('1.000000');
  });

  it('knows the current Claude models by the names the API gives them', () => {
    expect(isKnownModel('claude-sonnet-5-5')).toBe(true);
    expect(isKnownModel('claude-opus-5-5')).toBe(true);
    expect(isKnownModel('claude-haiku-4-5-20251001')).toBe(true);
  });

  it("prices a Codex run by OpenAI's rates, the cached input at its own", () => {
    // gpt-5-codex: $1.25 a million in, $0.125 cached, $10 out.
    const run = { tokensIn: 1_000_000, tokensCacheRead: 1_000_000, tokensOut: 100_000 };
    expect(priceUsage(usage('gpt-5-codex', run))).toEqual({
      usd: '2.375000',
      matchedModel: 'gpt-5-codex',
    });
    expect(priceUsage(usage('openai/gpt-5-codex', run)).usd).toBe('2.375000');
    expect(priceUsage(usage('gpt-5-codex-of-ours', run)).usd).toBeNull();
  });

  it('prices every model of the table: every name finds itself, and none is free', () => {
    expect(KNOWN_MODELS.length).toBeGreaterThan(50);
    for (const model of KNOWN_MODELS) {
      const priced = priceUsage(usage(model, { tokensIn: 1_000_000, tokensOut: 1_000_000 }));
      expect(priced.matchedModel, model).toBe(model);
      expect(priced.usd, model).toMatch(/^\d+\.\d{6}$/);
      expect(Number(priced.usd), model).toBeGreaterThan(0);
    }
  });
});

describe('priceUsage rounds to six places', () => {
  // A quarter of a microdollar a token, so that the count decides where it falls.
  const table: PriceTable = { 'claude-quarter': row(2.5e-7, 1e-7) };
  const cost = (tokensIn: number) => priceUsage(usage('claude-quarter', { tokensIn }), table).usd;

  it('rounds a half microdollar up, and anything below it down', () => {
    expect(cost(1)).toBe('0.000000'); // 0.25 microdollar
    expect(cost(2)).toBe('0.000001'); // 0.5
    expect(cost(3)).toBe('0.000001'); // 0.75
    expect(cost(5)).toBe('0.000001'); // 1.25
    expect(cost(6)).toBe('0.000002'); // 1.5
  });

  it('adds the buckets exactly, where floating point would land under the half', () => {
    // 5 tokens at 1e-7 is 4.9999999999999998e-7 in floating point, and 0.5 microdollar in fact.
    expect(priceUsage(usage('claude-quarter', { tokensOut: 5 }), table).usd).toBe('0.000001');
    expect(priceUsage(usage('claude-quarter', { tokensIn: 2, tokensOut: 5 }), table).usd).toBe(
      '0.000001', // 5e-7 + 5e-7 = 1e-6
    );
  });

  it('writes zero and large runs with all six places', () => {
    expect(cost(0)).toBe('0.000000');
    // 123 456 789 tokens at 3e-6 dollars
    expect(priceUsage(usage('claude-sonnet-4-5', { tokensIn: 123_456_789 })).usd).toBe(
      '370.370367',
    );
  });
});

describe('priceUsage finds the table name of a model', () => {
  const table: PriceTable = {
    'claude-aaa': row(1e-6, 5e-6),
    'claude-aaa-20250101': row(1e-6, 5e-6),
    'claude-bbb-20250202': row(2e-6, 1e-5),
    'claude-ccc-20250303': row(3e-6, 1.5e-5),
    'claude-ccc-20250404': row(3e-6, 1.5e-5),
    'claude-ddd': row(4e-6, 2e-5),
    'vertex_ai/claude-eee': row(5e-6, 2.5e-5),
  };
  const match = (model: string) => priceUsage(usage(model), table).matchedModel;

  it('takes an exact name, a dated one included', () => {
    expect(match('claude-aaa')).toBe('claude-aaa');
    expect(match('claude-aaa-20250101')).toBe('claude-aaa-20250101');
    expect(match('claude-bbb-20250202')).toBe('claude-bbb-20250202');
  });

  it('takes a name exactly as the table spells it, prefix and all, before stripping anything', () => {
    expect(match('vertex_ai/claude-eee')).toBe('vertex_ai/claude-eee');
  });

  it('strips the provider prefix of anthropic, bedrock and vertex_ai', () => {
    expect(match('anthropic/claude-aaa')).toBe('claude-aaa');
    expect(match('bedrock/claude-ddd')).toBe('claude-ddd');
    expect(match('vertex_ai/claude-ddd')).toBe('claude-ddd');
  });

  it('strips one prefix of these three, from the front, and no other', () => {
    expect(match('openrouter/claude-ddd')).toBeNull();
    expect(match('litellm_proxy/claude-ddd')).toBeNull();
    expect(match('anthropic/anthropic/claude-ddd')).toBeNull();
    expect(match('x/anthropic/claude-ddd')).toBeNull();
  });

  it('reads the million-token context of a model as the model', () => {
    expect(match('claude-aaa[1m]')).toBe('claude-aaa');
    expect(match('anthropic/claude-ddd-20250909[1m]')).toBe('claude-ddd');
    expect(match('claude-aaa[2m]')).toBeNull();
  });

  it('reads a dated name as its undated alias when the table has the alias', () => {
    expect(match('claude-ddd-20250909')).toBe('claude-ddd');
    expect(match('anthropic/claude-ddd-20250909')).toBe('claude-ddd');
  });

  it('reads an undated name as its dated one when the table has exactly one', () => {
    expect(match('claude-bbb')).toBe('claude-bbb-20250202');
    expect(match('vertex_ai/claude-bbb')).toBe('claude-bbb-20250202');
  });

  it('does not choose between two dates', () => {
    expect(match('claude-ccc')).toBeNull();
    expect(priceUsage(usage('claude-ccc', { tokensIn: 1 }), table)).toEqual({
      usd: null,
      matchedModel: null,
    });
  });

  it('does not take a name for another that it resembles', () => {
    for (const model of [
      'claude-aa',
      'claude-aaaa',
      'claude-aaa-turbo',
      'claude-aaa-20250101-v1:0',
      'claude-ddd@20250909',
      'claude-ddd-2025-09-09',
      'claude-ddd-2025090',
      'Claude-AAA',
      ' claude-aaa',
      'claude-aaa ',
      'claude',
      '',
    ]) {
      expect(match(model), JSON.stringify(model)).toBeNull();
    }
  });

  it('does not take the properties every object has for models', () => {
    for (const model of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(match(model), model).toBeNull();
    }
  });

  it('tells isKnownModel the same', () => {
    expect(isKnownModel('anthropic/claude-bbb', table)).toBe(true);
    expect(isKnownModel('claude-ccc', table)).toBe(false);
  });
});

describe('priceUsage without a price', () => {
  it('has none for a model the table does not know, nor for a near miss of one', () => {
    for (const model of [
      'gemini-pro',
      'unknown',
      '<synthetic>',
      '',
      'claude-opus-5-turbo-preview',
    ]) {
      const priced = priceUsage(usage(model, { tokensIn: 1_000, tokensOut: 1_000 }));
      expect(priced, JSON.stringify(model)).toEqual({ usd: null, matchedModel: null });
    }
    expect(isKnownModel('gemini-pro')).toBe(false);
  });

  // A model that LiteLLM lists without prompt caching.
  const table: PriceTable = { 'claude-old': row(8e-6, 2.4e-5) };

  it('has none for tokens of a kind the model has no price for, and says which model it is', () => {
    const cached = usage('claude-old', { tokensIn: 100, tokensCacheRead: 1 });
    expect(priceUsage(cached, table)).toEqual({ usd: null, matchedModel: 'claude-old' });
    expect(priceUsage(usage('claude-old', { tokensCacheWrite: 1 }), table).usd).toBeNull();
  });

  it('has none for an hour-long cache write when the table knows only five minutes', () => {
    const fiveMinutes: PriceTable = {
      'claude-short': row(1e-6, 5e-6, { cache_creation_input_token_cost: 1.25e-6 }),
    };
    const hour = usage('claude-short', { tokensCacheWrite: 10, tokensCacheWrite1h: 10 });
    expect(priceUsage(hour, fiveMinutes).usd).toBeNull();
    const short = usage('claude-short', { tokensCacheWrite: 10 });
    expect(priceUsage(short, fiveMinutes).usd).toBe('0.000013');
  });

  it('prices such a model when the run used no cache', () => {
    const plain = usage('claude-old', { tokensIn: 1_000, tokensOut: 1_000 });
    expect(priceUsage(plain, table)).toEqual({ usd: '0.032000', matchedModel: 'claude-old' });
  });

  it('refuses a count that is not a whole number of tokens', () => {
    for (const tokens of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => priceUsage(usage('claude-opus-5-5', { tokensOut: tokens }))).toThrow(RangeError);
    }
  });

  it('refuses more hour-long cache writes than cache writes', () => {
    const over = usage('claude-opus-5-5', { tokensCacheWrite: 1, tokensCacheWrite1h: 2 });
    expect(() => priceUsage(over)).toThrow(RangeError);
  });
});
