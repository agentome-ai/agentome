import { AsyncLocalStorage } from 'node:async_hooks';

// What every log line of a request carries without being told: its trace, and the
// run and seat it acts for once the request has found them.
export type LogContext = { traceId: string; route?: string; runId?: string; seatId?: string };

const store = new AsyncLocalStorage<LogContext>();

/** Runs `next` with this context: the request's own, set as it arrives. */
export const runWithLog = (context: LogContext, next: () => void) => store.run(context, next);

/** The current request's context, for pino's mixin. */
export const logContext = (): LogContext | undefined => store.getStore();

/** Names the run or seat the current request turned out to act for. */
export function tagLog(tags: { runId?: string; seatId?: string }) {
  const context = store.getStore();
  if (context) Object.assign(context, tags);
}
