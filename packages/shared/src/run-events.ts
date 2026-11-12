import { z } from 'zod';

// A type-only import: `index.ts` re-exports this module, and nothing here runs before it.
import type { RunStatus } from './index.js';

// The events of one run: the worker turns what Claude Code prints into these, the server stores
// and folds them, and nothing downstream reads the CLI's own format.

/** `error.code` of a run stopped on purpose; the fold reads it as `cancelled`, not `failed`. */
export const RUN_CANCELLED_CODE = 'cancelled';

const envelope = {
  /** Position in the transcript, numbered by the worker from 0; order is `seq`, never `at`. */
  seq: z.int().nonnegative().max(2_147_483_647),
  /** When the worker saw the event; for display only, computer clocks drift. */
  at: z.iso.datetime({ offset: true }),
};
const tokens = z.int().nonnegative();
const nonEmpty = z.string().min(1);
/** A team member's event: the lead's Agent call it works under. Absent for the lead. */
const nested = { parentToolUseId: nonEmpty.optional() };

export const RunEvent = z.discriminatedUnion('type', [
  z.object({
    ...envelope,
    type: z.literal('started'),
    /** The CLI's session: what `--resume` takes to continue it. */
    sessionId: nonEmpty.optional(),
    model: nonEmpty.optional(),
    /** The Claude Code build that wrote the transcript, to tell format drift from bugs. */
    cliVersion: nonEmpty.optional(),
  }),
  z.object({ ...envelope, ...nested, type: z.literal('assistant_message'), text: z.string() }),
  z.object({
    ...envelope,
    ...nested,
    type: z.literal('tool_use'),
    /** The CLI's id of the call, which its `tool_result` carries too. */
    id: nonEmpty,
    name: nonEmpty,
    /** The arguments as reported, or their JSON cut short when it was too long. */
    input: z.unknown(),
  }),
  z.object({
    ...envelope,
    ...nested,
    type: z.literal('tool_result'),
    toolUseId: nonEmpty,
    /** The output as text, cut short: a transcript is for reading, not a copy of every file. */
    output: z.string(),
    /** The tool's own verdict, not the run's. */
    isError: z.boolean(),
  }),
  z.object({
    ...envelope,
    type: z.literal('usage'),
    model: nonEmpty,
    tokensIn: tokens,
    tokensOut: tokens,
    tokensCacheRead: tokens,
    tokensCacheWrite: tokens,
    /**
     * The part of `tokensCacheWrite` cached for an hour, which costs more than the five-minute
     * default; Claude Code writes its cache for an hour. Absent from events stored before it.
     */
    tokensCacheWrite1h: tokens.default(0),
    /**
     * The API message of these tokens. The CLI repeats an answer's usage on every line it
     * splits the answer into: a sum keeps one value per message. Absent on a run total.
     */
    messageId: nonEmpty.optional(),
    /**
     * The totals of one model from the CLI's `result` line, which replace the turns before it:
     * the CLI repeats the usage it had at the start of an answer on every line of it, so a
     * turn's output tokens are what the first line knew, not what the answer burned.
     */
    total: z.literal(true).optional(),
  }),
  z.object({
    ...envelope,
    type: z.literal('result'),
    /** The CLI's final text: the agent's last answer, or what went wrong. */
    text: z.string(),
    /** From `is_error`: the CLI calls a failed login a `success` subtype. */
    isError: z.boolean(),
    sessionId: nonEmpty.optional(),
  }),
  z.object({
    ...envelope,
    type: z.literal('error'),
    /** Machine-readable: `not_authenticated`, `timeout`, `exit_1`… */
    code: nonEmpty,
    message: z.string(),
    /** A fatal error ends the run; any other is a note in the transcript. */
    fatal: z.boolean(),
  }),
  z.object({
    ...envelope,
    ...nested,
    type: z.literal('unknown'),
    /** What the producer called it, or how the line failed (`invalid_json`, `untyped`). */
    rawType: z.string(),
    raw: z.unknown(),
  }),
]);
export type RunEvent = z.infer<typeof RunEvent>;

// Distributes over the union, so that each variant keeps its own fields.
type WithoutEnvelope<E> = E extends unknown ? Omit<E, 'seq' | 'at'> : never;
/** An event before the worker numbers and stamps it. */
export type RunEventDraft = WithoutEnvelope<RunEvent>;

const TERMINAL: ReadonlySet<RunStatus> = new Set<RunStatus>(['done', 'failed', 'cancelled']);

/** Each position of a transcript once, the first event delivered at it, in `seq` order. */
function inSeqOrder(events: Iterable<RunEvent>): RunEvent[] {
  const bySeq = new Map<number, RunEvent>();
  for (const event of events) if (!bySeq.has(event.seq)) bySeq.set(event.seq, event);
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
}

function statusAfter(event: RunEvent): RunStatus {
  if (event.type === 'result') return event.isError ? 'failed' : 'done';
  if (event.type !== 'error' || !event.fatal) return 'running';
  return event.code === RUN_CANCELLED_CODE ? 'cancelled' : 'failed';
}

/**
 * The status of a run is a fold over its events; `runs.status` is a copy of it. No
 * events is `queued`, any event `running`; a `result` ends the run `done` or `failed`, a fatal
 * `error` ends it `failed` or `cancelled`. The first terminal event wins: the worker writes its
 * own ending (a timeout, a cancel) before whatever the dying CLI still prints. Events fold in
 * `seq` order, each position once, so a re-sent or reordered batch changes nothing.
 * `waiting_approval` comes with tool-call approvals (the MCP gateway); no event produces it yet.
 */
export function foldRunStatus(events: Iterable<RunEvent>): RunStatus {
  let status: RunStatus = 'queued';
  for (const event of inSeqOrder(events)) {
    if (TERMINAL.has(status)) break;
    status = statusAfter(event);
  }
  return status;
}

export type UsageEvent = Extract<RunEvent, { type: 'usage' }>;

/**
 * The `usage` events whose tokens a run burned: the one rule that the token limit of the worker
 * and the ledger of the server (`cost_events`) both count by, so that they cannot disagree.
 * The totals of a `result` (`total`) replace the turns that came before them, since a turn
 * undercounts its output; a run continued in a fresh session has a `result` per session. Turns
 * after the last `result` (a run that was killed) count on their own: the CLI repeats an
 * answer's usage on every line it splits the answer into, so of the events with one
 * `messageId` the latest counts, once, and an event without one counts as it is. Events are
 * read in `seq` order, each position once, as the fold of the run's status reads them: a batch
 * that was sent twice or out of order changes nothing. While a run goes, before its `result`,
 * the count is the turns' and low on output tokens.
 */
export function countedUsage(events: Iterable<RunEvent>): UsageEvent[] {
  const counted: UsageEvent[] = [];
  let turns = new Map<string | symbol, UsageEvent>();
  for (const event of inSeqOrder(events)) {
    if (event.type !== 'usage') continue;
    if (event.total) {
      counted.push(event);
      turns = new Map();
    } else {
      turns.set(event.messageId ?? Symbol('turn without an id'), event);
    }
  }
  return [...counted, ...turns.values()];
}
