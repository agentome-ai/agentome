import type { Log } from './config.js';

// The worker's own lines, sent to the server too, so that Admin → Logs shows what
// happened on the computer beside what happened on the server. The file stays the record on the
// computer; a line the server never got is still there.

const EVERY_MS = 15_000;
const MAX_HELD = 500;
const STOP_MS = 3000;
const RUN = /\brun ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

export type ShippedLine = {
  at: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  runId?: string;
};

/** A log that writes as `base` does and sends its lines with `send` every `everyMs`. */
export function shippingLog(
  base: Log,
  send: (lines: ShippedLine[]) => Promise<unknown>,
  everyMs = EVERY_MS,
) {
  let held: ShippedLine[] = [];
  let sending: Promise<void> | undefined;

  const flush = () => {
    if (sending || held.length === 0) return sending;
    const lines = held;
    held = [];
    sending = send(lines)
      .then(
        () => undefined,
        // Kept for the next try, the newest first to go when there are too many: an outage
        // of the server is the time a worker's lines matter, and it writes them to the file.
        () => {
          held = [...lines, ...held].slice(-MAX_HELD);
        },
      )
      .finally(() => {
        sending = undefined;
      });
    return sending;
  };
  const timer = setInterval(() => void flush(), everyMs);
  timer.unref();

  const log: Log = (level, message) => {
    base(level, message);
    const runId = RUN.exec(message)?.[1];
    held.push({ at: new Date().toISOString(), level, message, ...(runId && { runId }) });
    if (held.length > MAX_HELD) held.shift();
  };
  return {
    log,
    /** Sends what is held and stops: the worker is stopping. */
    async stop() {
      clearInterval(timer);
      // Bounded: a server that does not answer must not hold up the worker's stop.
      const last = (async () => {
        await sending;
        await flush();
      })();
      await Promise.race([last, new Promise((resolve) => setTimeout(resolve, STOP_MS).unref())]);
    },
  };
}
