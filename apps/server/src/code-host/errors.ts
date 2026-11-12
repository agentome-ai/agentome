// What can go wrong with a code host, in our words: the gateway writes one of these into a
// tool call, the proxy answers git with one, and a screen shows its message. A token never
// appears in a message.

export const CODE_HOST_ERROR_KINDS = [
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'unavailable',
  'timeout',
  'too_large',
  'invalid_response',
  'network',
] as const;
export type CodeHostErrorKind = (typeof CODE_HOST_ERROR_KINDS)[number];

export class CodeHostError extends Error {
  override name = 'CodeHostError';

  constructor(
    readonly kind: CodeHostErrorKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** What a status means, whatever the host called it. */
export function kindOfStatus(status: number): CodeHostErrorKind {
  if (status === 401) return 'unauthorized';
  // 403 on GitHub is both "no scope" and a spent rate limit; the caller tells them apart by
  // the headers, and `rateLimited` below turns the second into rate_limited.
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409 || status === 422) return 'conflict';
  if (status === 429) return 'rate_limited';
  return status >= 500 ? 'unavailable' : 'invalid_response';
}

/** A spent rate limit: 429, or GitHub's 403 with nothing left in the window. */
export const isRateLimited = (status: number, headers: Headers): boolean =>
  status === 429 || (status === 403 && headers.get('x-ratelimit-remaining') === '0');

/** Seconds to wait, from `Retry-After` (seconds or a date) or GitHub's reset time. */
export function retryAfterMs(headers: Headers, now = Date.now()): number | undefined {
  const after = headers.get('retry-after');
  if (after !== null) {
    const seconds = Number(after);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const at = Date.parse(after);
    if (!Number.isNaN(at)) return Math.max(0, at - now);
  }
  const reset = Number(headers.get('x-ratelimit-reset'));
  return Number.isFinite(reset) && reset > 0 ? Math.max(0, reset * 1000 - now) : undefined;
}
