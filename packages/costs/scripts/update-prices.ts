import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { PriceEntry } from '../src/pricing.js';

// Rebuilds ../prices.json from LiteLLM's price table, the only source of prices.
// Run `pnpm --filter @agentome/costs update-prices`, read the changes it prints and commit the
// file: a price changes through a pull request, never behind anyone's back. It runs on Node's
// own type stripping (22.18 or newer), so it needs nothing but `fetch`.

export const SOURCE =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const PRICES_PATH = fileURLToPath(new URL('../prices.json', import.meta.url));

/**
 * Who lists Claude models. Bedrock lists every other vendor's models too, so the name is checked
 * as well; a Claude model that any other provider lists is kept when its name starts `claude`.
 */
const PROVIDERS = new Set(['anthropic', 'bedrock', 'vertex_ai-anthropic_models']);
/** OpenAI's own models under their own names, which are what Codex runs. */
const OPENAI_MODEL = /^(?:gpt-|o\d|codex)/;
/** Named like them, but not text models an agent's engine runs. */
const OTHER_MEDIA = /audio|image|realtime|search|transcribe|tts/;

export interface PricesFile {
  source: string;
  generatedAt: string;
  models: Record<string, PriceEntry>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** LiteLLM writes 0 where a kind of token has no price (an embedding model's output). */
function isPrice(value: unknown): value is number {
  return typeof value === 'number' && value > 0;
}

/**
 * The models of LiteLLM's table that an agent may run and that can be priced: Claude's (a name
 * with `claude` in it, listed by one of the providers above or named `claude…`) and OpenAI's own,
 * with a price above zero for input and for output. An entry without them (a commitment plan, a placeholder) would be a "known" model that
 * costs nothing. Each is cut to the fields the pricing reads, the five prices (the hour-long cache
 * write among them), plus the provider and the context window. A table with no such
 * model at all means LiteLLM changed its format, and an empty file must not replace the prices we
 * have.
 */
export function selectPrices(table: unknown): Record<string, PriceEntry> {
  if (!isRecord(table)) throw new Error("LiteLLM's price table is not a JSON object.");
  const models: [string, PriceEntry][] = [];
  for (const [name, raw] of Object.entries(table)) {
    if (!isRecord(raw)) continue;
    const provider = raw.litellm_provider;
    const openai = provider === 'openai' && OPENAI_MODEL.test(name) && !OTHER_MEDIA.test(name);
    if (!openai && !name.includes('claude')) continue;
    const [input, output] = [raw.input_cost_per_token, raw.output_cost_per_token];
    if (typeof provider !== 'string' || !isPrice(input) || !isPrice(output)) continue;
    if (!openai && !PROVIDERS.has(provider) && !name.startsWith('claude')) continue;
    const [cacheRead, cacheWrite, cacheWrite1h] = [
      raw.cache_read_input_token_cost,
      raw.cache_creation_input_token_cost,
      raw.cache_creation_input_token_cost_above_1hr,
    ];
    const maxInput = raw.max_input_tokens;
    models.push([
      name,
      {
        input_cost_per_token: input,
        output_cost_per_token: output,
        ...(typeof cacheRead === 'number' && { cache_read_input_token_cost: cacheRead }),
        ...(typeof cacheWrite === 'number' && { cache_creation_input_token_cost: cacheWrite }),
        ...(typeof cacheWrite1h === 'number' && {
          cache_creation_input_token_cost_above_1hr: cacheWrite1h,
        }),
        litellm_provider: provider,
        ...(typeof maxInput === 'number' && { max_input_tokens: maxInput }),
      },
    ]);
  }
  if (models.length === 0)
    throw new Error('LiteLLM prices no model we keep: has its format changed?');
  return Object.fromEntries(models);
}

/** What differs between two tables, one line per model. */
export function describeChanges(
  before: Record<string, PriceEntry>,
  after: Record<string, PriceEntry>,
): string[] {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return names.flatMap((name) => {
    const [was, now]: (Record<string, unknown> | undefined)[] = [before[name], after[name]];
    if (was === undefined) return `+ ${name}`;
    if (now === undefined) return `- ${name}`;
    const fields = [...new Set([...Object.keys(was), ...Object.keys(now)])].sort();
    const changed = fields.filter((field) => was[field] !== now[field]);
    const what = changed.map((field) => `${field} ${was[field]} -> ${now[field]}`);
    return what.length === 0 ? [] : `~ ${name}: ${what.join(', ')}`;
  });
}

/** The file as written: the keys of every object in order, so that one table is one file. */
export function serialize(file: PricesFile): string {
  const inOrder = (_key: string, value: unknown): unknown =>
    isRecord(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : value;
  return `${JSON.stringify(file, inOrder, 2)}\n`;
}

async function main(): Promise<void> {
  const response = await fetch(SOURCE, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${SOURCE} answered ${response.status}.`);
  const models = selectPrices(await response.json());
  const count = Object.keys(models).length;

  const previous: PricesFile | undefined = existsSync(PRICES_PATH)
    ? JSON.parse(readFileSync(PRICES_PATH, 'utf8'))
    : undefined;
  const changes = describeChanges(previous?.models ?? {}, models);
  if (previous !== undefined && changes.length === 0) {
    console.log(`${count} models, no changes: prices.json of ${previous.generatedAt} is current.`);
    return;
  }

  const text = serialize({ source: SOURCE, generatedAt: new Date().toISOString(), models });
  writeFileSync(PRICES_PATH, text);
  console.log(
    `${count} models written to prices.json (${Math.round(Buffer.byteLength(text) / 1024)} KB).`,
  );
  if (previous === undefined) return;
  console.log(`${changes.length} changes since ${previous.generatedAt}:`);
  for (const line of changes) console.log(`  ${line}`);
}

if (import.meta.main) await main();
