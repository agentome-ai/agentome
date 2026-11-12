import type { FastifyBaseLogger } from 'fastify';

// A span: a log line that says how long some work took and how it ended, inside the
// trace of the request that did it. The server's logger is set once it exists; before that, and
// in a test without a server, a span only runs its work.

let logger: FastifyBaseLogger | undefined;

export function useSpanLogger(log: FastifyBaseLogger) {
  logger = log;
}

/** A URL as a span names it: its origin and path, never its query, which may hold a secret. */
export const spanUrl = (url: string | URL) => {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(url).split('?')[0] ?? '';
  }
};

/** Times `work` and logs it as `name`: info when it answered, warn when it threw. */
export async function span<T>(
  name: string,
  work: () => Promise<T>,
  outcome?: (result: T) => Record<string, unknown>,
): Promise<T> {
  const start = performance.now();
  try {
    const result = await work();
    logger?.info(
      { span: name, durationMs: performance.now() - start, ...outcome?.(result) },
      'outbound call',
    );
    return result;
  } catch (error) {
    logger?.warn(
      {
        span: name,
        durationMs: performance.now() - start,
        error: error instanceof Error ? error.message : String(error),
      },
      'outbound call failed',
    );
    throw error;
  }
}
