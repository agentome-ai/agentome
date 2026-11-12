import { countedUsage } from '@agentome/shared';
import type { RunEvent } from '@agentome/shared';

// What a run burned, per model, from the `usage` events of its transcript: the rows that become
// `cost_events` once they are priced. The rule is "one API call, one row", kept in
// `countedUsage`, which the worker's launcher counts its token
// limit by as well, so that the limit and the ledger cannot disagree.

export interface UsageRow {
  /** Whose models the engine runs: Anthropic's for Claude Code, OpenAI's for Codex. */
  provider: 'anthropic' | 'openai';
  model: string;
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  /** The part of `tokensCacheWrite` cached for an hour. */
  tokensCacheWrite1h: number;
  source: 'stream-json';
}

/**
 * One row per model, in the order they first appear, for the events of one run: the sums of the
 * tokens that `countedUsage` counts. Events that are not `usage` are ignored.
 */
export function normalizeUsage(
  events: Iterable<RunEvent>,
  provider: UsageRow['provider'] = 'anthropic',
): UsageRow[] {
  const rows = new Map<string, UsageRow>();
  for (const event of countedUsage(events)) {
    const row: UsageRow = rows.get(event.model) ?? {
      provider,
      model: event.model,
      tokensIn: 0,
      tokensOut: 0,
      tokensCacheRead: 0,
      tokensCacheWrite: 0,
      tokensCacheWrite1h: 0,
      source: 'stream-json',
    };
    row.tokensIn += event.tokensIn;
    row.tokensOut += event.tokensOut;
    row.tokensCacheRead += event.tokensCacheRead;
    row.tokensCacheWrite += event.tokensCacheWrite;
    row.tokensCacheWrite1h += event.tokensCacheWrite1h;
    rows.set(event.model, row);
  }
  return [...rows.values()];
}
