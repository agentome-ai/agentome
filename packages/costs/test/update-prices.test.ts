import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { SOURCE, describeChanges, selectPrices, serialize } from '../scripts/update-prices.js';
import type { PricesFile } from '../scripts/update-prices.js';

/** Entries as LiteLLM writes them: many fields more than the pricing reads. */
const litellm = {
  sample_spec: { litellm_provider: 'one of the providers', input_cost_per_token: 0 },
  'claude-sonnet-4-5': {
    litellm_provider: 'anthropic',
    mode: 'chat',
    input_cost_per_token: 3e-6,
    output_cost_per_token: 1.5e-5,
    cache_read_input_token_cost: 3e-7,
    cache_creation_input_token_cost: 3.75e-6,
    input_cost_per_token_above_200k_tokens: 6e-6,
    max_input_tokens: 200000,
    max_tokens: 64000,
    supports_vision: true,
  },
  'vertex_ai/claude-3-haiku': {
    litellm_provider: 'vertex_ai-anthropic_models',
    input_cost_per_token: 2.5e-7,
    output_cost_per_token: 1.25e-6,
  },
  'anthropic.claude-v2:1': {
    litellm_provider: 'bedrock',
    input_cost_per_token: 8e-6,
    output_cost_per_token: 2.4e-5,
    max_input_tokens: 100000,
  },
  // Bedrock lists other vendors' models too.
  'amazon.nova-pro-v1:0': {
    litellm_provider: 'bedrock',
    input_cost_per_token: 8e-7,
    output_cost_per_token: 3.2e-6,
  },
  // Another provider's Claude, with no `claude` at the start of the name.
  'azure_ai/claude-opus-4-5': {
    litellm_provider: 'azure_ai',
    input_cost_per_token: 5e-6,
    output_cost_per_token: 2.5e-5,
  },
  // Another provider's, but named like Anthropic's own.
  'claude-via-gateway': {
    litellm_provider: 'some_gateway',
    input_cost_per_token: 1e-6,
    output_cost_per_token: 5e-6,
  },
  // OpenAI's own, which Codex runs; its audio model and another provider's copy are not kept.
  'gpt-5-codex': {
    litellm_provider: 'openai',
    mode: 'responses',
    input_cost_per_token: 1.25e-6,
    output_cost_per_token: 1e-5,
    cache_read_input_token_cost: 1.25e-7,
  },
  'gpt-audio': {
    litellm_provider: 'openai',
    mode: 'chat',
    input_cost_per_token: 2.5e-6,
    output_cost_per_token: 1e-5,
  },
  'azure/gpt-5-codex': {
    litellm_provider: 'azure',
    mode: 'responses',
    input_cost_per_token: 1.25e-6,
    output_cost_per_token: 1e-5,
  },
  // Listed without a price: a commitment plan, an embedding model.
  'bedrock/us-east-1/1-month-commitment/anthropic.claude-v2:1': {
    litellm_provider: 'bedrock',
    max_input_tokens: 100000,
  },
  'anthropic.claude-embed': {
    litellm_provider: 'bedrock',
    mode: 'embedding',
    input_cost_per_token: 1e-7,
  },
  'claude-text-prices': {
    litellm_provider: 'anthropic',
    input_cost_per_token: '3e-6',
    output_cost_per_token: 1.5e-5,
  },
  // Zero is no price either: it would make the model free.
  'claude-zero-prices': {
    litellm_provider: 'anthropic',
    input_cost_per_token: 0,
    output_cost_per_token: 0,
  },
};

describe('selectPrices', () => {
  it("keeps the priced Claude models of Anthropic, Bedrock and Vertex, any named claude, and OpenAI's own text models", () => {
    expect(Object.keys(selectPrices(litellm)).sort()).toEqual([
      'anthropic.claude-v2:1',
      'claude-sonnet-4-5',
      'claude-via-gateway',
      'gpt-5-codex',
      'vertex_ai/claude-3-haiku',
    ]);
  });

  it('cuts an entry to the fields the pricing reads', () => {
    expect(selectPrices(litellm)['claude-sonnet-4-5']).toStrictEqual({
      input_cost_per_token: 3e-6,
      output_cost_per_token: 1.5e-5,
      cache_read_input_token_cost: 3e-7,
      cache_creation_input_token_cost: 3.75e-6,
      litellm_provider: 'anthropic',
      max_input_tokens: 200000,
    });
    expect(selectPrices(litellm)['vertex_ai/claude-3-haiku']).toStrictEqual({
      input_cost_per_token: 2.5e-7,
      output_cost_per_token: 1.25e-6,
      litellm_provider: 'vertex_ai-anthropic_models',
    });
  });

  it('refuses a table that is not an object', () => {
    for (const table of [null, [], 'prices', 3]) {
      expect(() => selectPrices(table)).toThrow('not a JSON object');
    }
  });

  it('refuses a table without one model it keeps, so that it cannot empty prices.json', () => {
    expect(() => selectPrices({})).toThrow('prices no model we keep');
    expect(() => selectPrices({ 'gpt-5': litellm['amazon.nova-pro-v1:0'] })).toThrow('no model');
  });
});

describe('describeChanges', () => {
  // Whole numbers for prices, so that the lines below do not depend on how a tiny number prints.
  const entry = (input: number, output: number, extra = {}) => ({
    input_cost_per_token: input,
    output_cost_per_token: output,
    litellm_provider: 'anthropic',
    ...extra,
  });
  const before = { 'claude-a': entry(1, 5), 'claude-b': entry(2, 10), 'claude-c': entry(3, 15) };

  it('says nothing when nothing changed', () => {
    expect(describeChanges(before, { ...before })).toEqual([]);
  });

  it('names the models added and removed, and the fields of those whose price moved', () => {
    const after = {
      'claude-a': entry(1, 5),
      'claude-b': entry(2, 12, { cache_read_input_token_cost: 7 }),
      'claude-d': entry(4, 20),
    };
    expect(describeChanges(before, after)).toEqual([
      '~ claude-b: cache_read_input_token_cost undefined -> 7, output_cost_per_token 10 -> 12',
      '- claude-c',
      '+ claude-d',
    ]);
  });
});

describe('serialize', () => {
  it('writes the keys of every object in order, whatever order they came in', () => {
    const entry = { output_cost_per_token: 2, input_cost_per_token: 1, litellm_provider: 'x' };
    const forward: PricesFile = { source: 's', generatedAt: 't', models: { b: entry, a: entry } };
    const backward: PricesFile = { models: { a: entry, b: entry }, generatedAt: 't', source: 's' };
    expect(serialize(forward)).toBe(serialize(backward));
    expect(serialize(forward)).toBe(`{
  "generatedAt": "t",
  "models": {
    "a": {
      "input_cost_per_token": 1,
      "litellm_provider": "x",
      "output_cost_per_token": 2
    },
    "b": {
      "input_cost_per_token": 1,
      "litellm_provider": "x",
      "output_cost_per_token": 2
    }
  },
  "source": "s"
}
`);
  });
});

describe('the vendored prices.json', () => {
  const text = readFileSync(new URL('../prices.json', import.meta.url), 'utf8');
  const file: PricesFile = JSON.parse(text);

  it('names its source and the time it was made', () => {
    expect(file.source).toBe(SOURCE);
    expect(new Date(file.generatedAt).toISOString()).toBe(file.generatedAt);
  });

  it('is what the filter keeps of itself, in the order the script writes it', () => {
    expect(selectPrices(file.models)).toStrictEqual(file.models);
    expect(text).toBe(serialize(file));
  });
});
