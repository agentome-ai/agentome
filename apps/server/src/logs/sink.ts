import { setTimeout as sleep } from 'node:timers/promises';
import { type Db, logEntries } from '@agentome/db';
import { redactText, redactValue } from './redact.js';

// The server's log lines on their way to `log_entries`, beside stdout: kept in memory
// and written in batches, so a line never waits on the database. While the database is away the
// oldest lines go first; stdout keeps them all.

const FLUSH_MS = 1000;
const BATCH = 500;
const MAX_HELD = 5000;
const CLOSE_MS = 2000;
// pino's own fields and Fastify's, which become columns or say nothing new.
const OWN = new Set([
  'level',
  'time',
  'pid',
  'hostname',
  'msg',
  'reqId',
  'traceId',
  'runId',
  'seatId',
  'span',
  'durationMs',
  'responseTime',
  'route',
]);

type Row = typeof logEntries.$inferInsert;

export class LogSink {
  private held: Row[] = [];
  private db: Db | undefined;
  private timer: NodeJS.Timeout | undefined;
  private writing: Promise<void> | undefined;

  /** pino's destination: one JSON line at a time. */
  write(line: string) {
    const row = rowOf(line);
    if (!row) return;
    if (this.held.length >= MAX_HELD) this.held.shift();
    this.held.push(row);
    if (this.held.length >= BATCH) void this.flush();
  }

  /** Starts writing to the database: until now the lines waited. */
  attach(db: Db) {
    this.db = db;
    this.timer = setInterval(() => void this.flush(), FLUSH_MS);
    this.timer.unref();
  }

  async flush() {
    if (!this.db || this.writing || this.held.length === 0) return this.writing;
    const rows = this.held.splice(0, BATCH);
    const db = this.db;
    this.writing = db
      .insert(logEntries)
      .values(rows)
      .then(
        () => undefined,
        // Not to the logger: that line would come back here. stderr, once per failed batch.
        (error: unknown) => {
          // The driver's own reason, not drizzle's message, which repeats the whole batch.
          const cause =
            error instanceof Error && error.cause instanceof Error ? error.cause : error;
          const reason = cause instanceof Error ? cause.message : String(cause);
          process.stderr.write(`${rows.length} log lines not stored: ${reason.slice(0, 200)}\n`);
        },
      )
      .finally(() => {
        this.writing = undefined;
      });
    await this.writing;
    if (this.held.length >= BATCH) await this.flush();
  }

  /**
   * Writes what is held and stops: the server is closing. Bounded, so a database that stalls
   * cannot keep the server from shutting down; what is left was on stdout.
   */
  async close() {
    clearInterval(this.timer);
    const drain = async () => {
      await this.writing;
      while (this.held.length > 0 && this.db) {
        const before = this.held.length;
        await this.flush();
        if (this.held.length >= before) break;
      }
    };
    await Promise.race([drain(), sleep(CLOSE_MS, undefined, { ref: false })]);
  }
}

/** A pino line as a row, or nothing for a line that says nothing new. */
export function rowOf(line: string): Row | undefined {
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const message = typeof entry.msg === 'string' ? entry.msg : '';
  // "request completed" says the same with the time it took.
  if (message === 'incoming request') return undefined;
  const text = (key: string) => (typeof entry[key] === 'string' ? (entry[key] as string) : null);
  const request = entry.res && typeof entry.responseTime === 'number';
  const context = Object.fromEntries(Object.entries(entry).filter(([key]) => !OWN.has(key)));
  return {
    at: new Date(typeof entry.time === 'number' ? entry.time : Date.now()),
    level: typeof entry.level === 'number' ? entry.level : 30,
    source: 'server',
    message: redactText(message).slice(0, 2000),
    context: Object.keys(context).length ? redactValue(context) : null,
    traceId: text('traceId') ?? text('reqId'),
    runId: uuidOrNull(entry.runId),
    seatId: uuidOrNull(entry.seatId),
    span: request ? text('route') : text('span'),
    durationMs: request
      ? Math.round(entry.responseTime as number)
      : typeof entry.durationMs === 'number'
        ? Math.round(entry.durationMs)
        : null,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (value: unknown) =>
  typeof value === 'string' && UUID.test(value) ? value : null;
