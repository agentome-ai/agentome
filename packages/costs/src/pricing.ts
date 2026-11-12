import prices from '../prices.json' with { type: 'json' };

import type { UsageRow } from './usage.js';

// What a run's tokens cost in dollars, by LiteLLM's price table: vendored as ../prices.json and
// refreshed by scripts/update-prices.ts. There is no table of our own. The result
// is an estimate at API list prices: on a subscription it is what the run would have cost with
// an API key, not money anyone was charged (README).

/** One row of prices.json: dollars per token, under the names LiteLLM gives them. */
export type PriceEntry = {
  readonly input_cost_per_token: number;
  readonly output_cost_per_token: number;
  /** Absent for the models that LiteLLM lists without prompt caching. */
  readonly cache_read_input_token_cost?: number;
  readonly cache_creation_input_token_cost?: number;
  /** A cache write that lives for an hour, as Claude Code's do. */
  readonly cache_creation_input_token_cost_above_1hr?: number;
  readonly litellm_provider: string;
  readonly max_input_tokens?: number;
};
export type PriceTable = Readonly<Record<string, PriceEntry>>;

const TABLE: PriceTable = prices.models;

/** Every model name the table holds. */
export const KNOWN_MODELS: readonly string[] = Object.keys(TABLE);

export type PricedUsage = Pick<
  UsageRow,
  'model' | 'tokensIn' | 'tokensOut' | 'tokensCacheRead' | 'tokensCacheWrite' | 'tokensCacheWrite1h'
>;

export interface Priced {
  /**
   * Dollars as a decimal string with six places, the scale of `cost_events.usd`. Null when there
   * is no honest price: the model is not in the table, or the run burned tokens of a kind (cache)
   * that the table gives the model no price for.
   */
  readonly usd: string | null;
  /** The table's name for the model; null when the table does not know it. */
  readonly matchedModel: string | null;
}

/** LiteLLM puts the provider before the model: `anthropic/claude-sonnet-4-5`. */
const PROVIDER_PREFIX = /^(?:anthropic|bedrock|vertex_ai|openai)\//;
/** The snapshot of a model: `claude-sonnet-4-5-20250929`. */
const RELEASE_DATE = /-\d{8}$/;

const withoutDate = (name: string) => name.replace(RELEASE_DATE, '');
/** Claude Code marks a model it runs with the million-token context: `claude-opus-5-5[1m]`. */
const LONG_CONTEXT = /\[1m\]$/;

/**
 * The table's name for a model, or null. A provider prefix, a release date and an alias are
 * spellings of one model, and nothing else is: a name that merely looks like a known model is
 * not that model, and its price is unknown, not a neighbour's.
 */
function resolve(model: string, table: PriceTable): string | null {
  const known = (name: string) => Object.hasOwn(table, name);
  if (known(model)) return model;
  // The long context is the same model, and long-context tiers are not in the table anyway.
  const bare = model.replace(PROVIDER_PREFIX, '').replace(LONG_CONTEXT, '');
  if (known(bare)) return bare;
  // A dated name stands for its alias, the undated one.
  const undated = withoutDate(bare);
  if (undated !== bare) return known(undated) ? undated : null;
  // An undated name stands for the one dated name under it. `bare` is not a key, so only a dated
  // name can lose its date and become it.
  const dated = Object.keys(table).filter((name) => withoutDate(name) === bare);
  return dated.length === 1 ? (dated[0] ?? null) : null;
}

/** Whether the table has the model, under any spelling that `priceUsage` accepts. */
export function isKnownModel(model: string, table: PriceTable = TABLE): boolean {
  return resolve(model, table) !== null;
}

// A rate is a decimal of a few places, and the sum of rates times token counts must not pick up
// the noise of binary floating point: it is added up in whole units of 10^-12 dollar.
const RATE_PLACES = 12;
const UNITS_PER_MICRODOLLAR = 10n ** BigInt(RATE_PLACES - 6);

const toUnits = (rate: number) => BigInt(rate.toFixed(RATE_PLACES).replace('.', ''));

/** Units of 10^-12 dollar as dollars with six places; a half microdollar rounds up. */
function formatUsd(units: bigint): string {
  const micros = (units + UNITS_PER_MICRODOLLAR / 2n) / UNITS_PER_MICRODOLLAR;
  return `${micros / 1_000_000n}.${String(micros % 1_000_000n).padStart(6, '0')}`;
}

/**
 * Prices the tokens of one model. A count that is not a whole number, zero or more, or an
 * hour-long cache write larger than all cache writes, is a bug of the caller and throws a
 * RangeError. A cache write is priced by how long it lives; otherwise the price is flat per
 * token: LiteLLM's tiers for long contexts are not in the table, so a call that falls under one is
 * priced low. `table` is there for the tests, to price against a table of their own.
 */
export function priceUsage(usage: PricedUsage, table: PriceTable = TABLE): Priced {
  const counts = [
    usage.tokensIn,
    usage.tokensOut,
    usage.tokensCacheRead,
    usage.tokensCacheWrite,
    usage.tokensCacheWrite1h,
  ];
  if (!counts.every((tokens) => Number.isSafeInteger(tokens) && tokens >= 0)) {
    throw new RangeError('Token counts must be whole numbers, zero or more.');
  }
  if (usage.tokensCacheWrite1h > usage.tokensCacheWrite) {
    throw new RangeError('Hour-long cache writes are a part of all cache writes.');
  }
  const matchedModel = resolve(usage.model, table);
  const price = matchedModel === null ? undefined : table[matchedModel];
  if (price === undefined) return { usd: null, matchedModel };

  const buckets = [
    [usage.tokensIn, price.input_cost_per_token],
    [usage.tokensOut, price.output_cost_per_token],
    [usage.tokensCacheRead, price.cache_read_input_token_cost],
    [usage.tokensCacheWrite - usage.tokensCacheWrite1h, price.cache_creation_input_token_cost],
    [usage.tokensCacheWrite1h, price.cache_creation_input_token_cost_above_1hr],
  ] as const;
  let units = 0n;
  for (const [tokens, rate] of buckets) {
    if (tokens === 0) continue;
    if (rate === undefined) return { usd: null, matchedModel };
    units += BigInt(tokens) * toUnits(rate);
  }
  return { usd: formatUsd(units), matchedModel };
}
