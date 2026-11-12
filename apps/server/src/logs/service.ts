import {
  and,
  asc,
  type Db,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  logEntries,
  lt,
  or,
  runs,
  sql,
} from '@agentome/db';
import { redactText } from './redact.js';

/** pino's numbers for its level names. */
export const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as const;
export type LevelName = keyof typeof LEVELS;

export type LogQuery = {
  /** This level and above. */
  level?: number;
  source?: 'server' | 'worker';
  run?: string;
  trace?: string;
  q?: string;
  /** Older than this id: the next page. */
  before?: number;
  /** Newer than this id: what came since the last look. */
  after?: number;
  limit: number;
};

const view = {
  id: logEntries.id,
  at: logEntries.at,
  level: logEntries.level,
  source: logEntries.source,
  message: logEntries.message,
  context: logEntries.context,
  traceId: logEntries.traceId,
  runId: logEntries.runId,
  seatId: logEntries.seatId,
  span: logEntries.span,
  durationMs: logEntries.durationMs,
};

const shown = <T extends { at: Date }>(row: T) => ({ ...row, at: row.at.toISOString() });

/** The log lines that match, newest first, and the cursor of the page after them. */
export async function listLogs(db: Db, query: LogQuery) {
  const text = query.q?.trim();
  const rows = await db
    .select(view)
    .from(logEntries)
    .where(
      and(
        query.level ? gte(logEntries.level, query.level) : undefined,
        query.source ? eq(logEntries.source, query.source) : undefined,
        query.run ? eq(logEntries.runId, query.run) : undefined,
        query.trace ? eq(logEntries.traceId, query.trace) : undefined,
        text
          ? or(
              ilike(logEntries.message, `%${escapeLike(text)}%`),
              ilike(logEntries.span, `%${escapeLike(text)}%`),
              sql`${logEntries.context}::text ilike ${`%${escapeLike(text)}%`}`,
            )
          : undefined,
        query.before ? lt(logEntries.id, query.before) : undefined,
        query.after ? gt(logEntries.id, query.after) : undefined,
      ),
    )
    .orderBy(desc(logEntries.id))
    .limit(query.limit + 1);
  const more = rows.length > query.limit;
  const page = rows.slice(0, query.limit);
  return { entries: page.map(shown), nextBefore: more ? (page.at(-1)?.id ?? null) : null };
}

/** A trace's lines in the order they happened: the request, its calls out and what it logged. */
export async function traceOf(db: Db, traceId: string) {
  const rows = await db
    .select(view)
    .from(logEntries)
    .where(eq(logEntries.traceId, traceId))
    .orderBy(asc(logEntries.at), asc(logEntries.id))
    .limit(1000);
  return { traceId, entries: rows.map(shown) };
}

export type WorkerLine = {
  at: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  runId?: string;
};

// A worker's clock may be off, and a line must not dodge the retention by its date.
const SKEW_MS = 5 * 60_000;

/**
 * A worker's lines under its seat. A line keeps the run it names only when the run is
 * this seat's: a seat cannot file lines under another person's run. Its time is the worker's,
 * within a few minutes of the server's.
 */
export async function storeWorkerLines(db: Db, seatId: string, lines: WorkerLine[]) {
  if (!lines.length) return;
  const named = [...new Set(lines.flatMap((line) => (line.runId ? [line.runId] : [])))];
  const own = named.length
    ? new Set(
        (
          await db
            .select({ id: runs.id })
            .from(runs)
            .where(and(inArray(runs.id, named), eq(runs.seatId, seatId)))
        ).map((run) => run.id),
      )
    : new Set<string>();
  const now = Date.now();
  await db.insert(logEntries).values(
    lines.map((line) => ({
      at: new Date(Math.min(now + SKEW_MS, Math.max(now - SKEW_MS, Date.parse(line.at)))),
      level: LEVELS[line.level],
      source: 'worker' as const,
      message: redactText(line.message).slice(0, 2000),
      runId: line.runId && own.has(line.runId) ? line.runId : null,
      seatId,
    })),
  );
}

/** Deletes the lines older than the retention: an hour's worth at a time. */
export async function pruneLogs(db: Db, days: number) {
  await db.delete(logEntries).where(lt(logEntries.at, sql`now() - make_interval(days => ${days})`));
}

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (match) => `\\${match}`);
