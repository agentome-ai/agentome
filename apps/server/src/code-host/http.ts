import { span, spanUrl } from '../logs/span.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { CodeHostError, isRateLimited, kindOfStatus, retryAfterMs } from './errors.js';

// Every byte to a code host leaves through here. octokit and gitbeaker bring the
// endpoints and the types; the transport is ours, because theirs retries ten times on a 429,
// has no deadline of its own and no ceiling on what it will read into memory.

/** A call waits this long in all, retry included. */
const TIMEOUT_MS = 20_000;
/** What one answer may be. A job log is read by `getPipelineFailures`, which asks for a range. */
const MAX_BYTES = 8 * 1024 * 1024;
/** One retry, and only when the host said when to come back or is plainly down. */
const MAX_RETRY_MS = 5_000;

export interface RequestOptions {
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  /** Keep only the last bytes of the answer instead of refusing a long one: a log's tail. */
  readonly keepTail?: number;
  /** For the tests, and for nothing else. */
  readonly fetchImpl?: typeof fetch;
}

const isRetryable = (status: number) => status === 429 || (status >= 500 && status < 600);

/**
 * One request, with a deadline over the whole thing, one retry on a rate limit or a host that
 * is down, and a ceiling on the answer. Redirects are not followed: the token rides in a
 * header, and a redirect would hand it to whatever host the answer named.
 */
export function request(
  input: Request,
  options: RequestOptions = {},
): Promise<{ response: Response; body: Uint8Array }> {
  // A span per call, retry included: how long the host took and what it answered.
  return span(
    `${input.method} ${spanUrl(input.url)}`,
    () => send(input, options),
    ({ response }) => ({ status: response.status }),
  );
}

async function send(
  input: Request,
  options: RequestOptions,
): Promise<{ response: Response; body: Uint8Array }> {
  const call = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const deadline = Date.now() + (options.timeoutMs ?? TIMEOUT_MS);

  for (let attempt = 0; ; attempt++) {
    const left = deadline - Date.now();
    if (left <= 0) throw new CodeHostError('timeout', `${host(input)} did not answer in time`);

    let response: Response;
    try {
      response = await call(input.clone(), {
        redirect: 'manual',
        signal: AbortSignal.timeout(left),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      const kind = timedOut ? 'timeout' : 'network';
      const said = error instanceof Error ? error.message : String(error);
      throw new CodeHostError(kind, `${host(input)} did not answer: ${said}`, { cause: error });
    }

    if (attempt === 0 && isRetryable(response.status)) {
      const wait = retryAfterMs(response.headers) ?? 1000;
      if (wait <= Math.min(MAX_RETRY_MS, deadline - Date.now())) {
        await sleep(wait);
        continue;
      }
    }
    if (response.status >= 300 && response.status < 400) {
      // Not followed on purpose: the token rides in a header, and the answer names the host
      // it would be sent to next.
      await response.body?.cancel();
      throw new CodeHostError(
        'invalid_response',
        `${host(input)} answered with a redirect, which is not followed`,
      );
    }
    if (isRateLimited(response.status, response.headers)) {
      throw new CodeHostError('rate_limited', `${host(input)} is rate limiting this token`);
    }
    const body = options.keepTail
      ? await tail(response, options.keepTail)
      : await read(response, maxBytes, host(input));
    return { response, body };
  }
}

const host = (input: Request) => new URL(input.url).host;

/** The body, as long as it stays under the ceiling; a stream that runs past it is cut off. */
async function read(response: Response, maxBytes: number, where: string): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new CodeHostError('too_large', `${where} answered with more than ${maxBytes} bytes`);
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel();
      throw new CodeHostError('too_large', `${where} answered with more than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.length;
  }
  return body;
}

/** The last `size` bytes of a body however long it runs, holding at most twice that. */
async function tail(response: Response, size: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  let kept = new Uint8Array();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const next = new Uint8Array(kept.length + value.length);
    next.set(kept);
    next.set(value, kept.length);
    kept = next.length > size * 2 ? next.slice(next.length - size) : next;
  }
  return kept.length > size ? kept.slice(kept.length - size) : kept;
}

/** `request` in the shape `fetch` has, for a library that takes one (octokit). */
export const fetchThrough =
  (options: RequestOptions = {}): typeof fetch =>
  async (input, init) => {
    const { response, body } = await request(new Request(input as RequestInfo, init), options);
    // The body was read here, so the caller gets one it can read again.
    const empty = response.status === 204 || response.status === 304;
    return new Response(empty ? null : (body as BodyInit), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

/** The JSON of an answer, or the error its status means. A 204 carries none: `undefined`. */
export async function json<T>(input: Request, options: RequestOptions = {}): Promise<T> {
  const { response, body } = await request(input, options);
  const text = new TextDecoder().decode(body);
  if (!response.ok) {
    throw new CodeHostError(
      kindOfStatus(response.status),
      `${host(input)} answered ${String(response.status)}${hostMessage(text)}`,
    );
  }
  if (response.status === 204) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new CodeHostError('invalid_response', `${host(input)} answered with what is not JSON`, {
      cause: error,
    });
  }
}

/** What the host said about the failure, if it said anything short enough to show. */
/**
 * What the host said was wrong, as `: …` to append to a message, or nothing. GitHub and Jira
 * say it in a string; GitLab's validation errors are a list, or lists by field:
 * `{"message": {"title": ["is too long"]}}`.
 */
export function hostMessage(text: string): string {
  let body: { message?: unknown; error?: unknown; errorMessages?: unknown; errors?: unknown };
  try {
    body = (JSON.parse(text) ?? {}) as typeof body;
  } catch {
    return '';
  }
  // Jira's own shape: { errorMessages: ["The value 'X' does not exist…"], errors: { field: "…" } }
  const jira = [
    ...(Array.isArray(body.errorMessages) ? (body.errorMessages as unknown[]) : []),
    ...(body.errors && typeof body.errors === 'object' ? Object.values(body.errors) : []),
  ];
  const said =
    [body.message, body.error, ...jira].find((value) => typeof value === 'string') ??
    fieldErrors(body.message);
  return typeof said === 'string' && said !== '' ? `: ${said.slice(0, 300)}` : '';
}

/** GitLab's `["…"]` or `{ field: ["…"] }`, as one line: "title is too long; …". */
function fieldErrors(value: unknown): string | undefined {
  const words = (list: unknown) =>
    (Array.isArray(list) ? list : [list]).filter((item) => typeof item === 'string');
  if (Array.isArray(value)) return words(value).join('; ');
  if (!value || typeof value !== 'object') return undefined;
  return Object.entries(value)
    .flatMap(([field, list]) => words(list).map((said) => `${field} ${said}`))
    .join('; ');
}
