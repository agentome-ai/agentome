export type Role = 'admin' | 'member';
export type Me = { id: string; name: string; email: string; role: Role };

/** Every failed call: the server's { error: { code, message, details } }, or code "network". */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const asApiError = (error: unknown) =>
  error instanceof ApiError ? error : new ApiError(0, 'unknown', String(error));

async function send(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(path, init);
  } catch {
    throw new ApiError(
      0,
      'network',
      "Couldn't reach the server. Check your connection, then try again.",
    );
  }
}

/** The server's error answer as an ApiError, or what its status says when it has none. */
async function failure(response: Response): Promise<ApiError> {
  const data: unknown = await response.json().catch(() => undefined);
  const error = (data as { error?: { code?: string; message?: string; details?: unknown } })?.error;
  return new ApiError(
    response.status,
    error?.code ?? 'unknown',
    error?.message ?? `The server answered ${response.status}. Try again in a minute.`,
    error?.details,
  );
}

/** Calls the server's API with JSON in and out; the session travels in its cookie. */
export async function api<T>(
  path: string,
  options: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown } = {},
): Promise<T> {
  const { body, method = body === undefined ? 'GET' : 'POST' } = options;
  const response = await send(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw await failure(response);
  if (response.status === 204) return undefined as T;
  return (await response.json().catch(() => undefined)) as T;
}

/**
 * Saves the file a GET answers with, under the name the server gives it. A failed answer is
 * an ApiError like any call's, not a file that holds the error.
 */
export async function download(path: string): Promise<void> {
  const response = await send(path, {});
  if (!response.ok) throw await failure(response);
  const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(await response.blob());
  link.download = name?.[1] ?? '';
  link.click();
  URL.revokeObjectURL(link.href);
}

/** A validation_failed answer as messages by field: "body/admin/email" becomes "email". */
export function fieldErrors(error: ApiError): Record<string, string> {
  if (error.code !== 'validation_failed' || !Array.isArray(error.details)) return {};
  return Object.fromEntries(
    (error.details as { path: string; message: string }[]).map(({ path, message }) => [
      path.split('/').at(-1) ?? path,
      message,
    ]),
  );
}

// Intl's en-GB writes "Sept"; the product gives every month three letters.
const months = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
/** 21 Oct 2026, as everywhere in the product. */
export function formatDate(iso: string): string {
  const date = new Date(iso);
  return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
}

/** "just now", "12 min ago", "3 h ago", and the date after a day. */
/** "35m", "3h", "2d": how long ago, in the width a phone has for it. */
export function shortAgo(iso: string, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / (24 * 60))}d`;
}

export function timeAgo(iso: string, now = Date.now()): string {
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`;
  return formatDate(iso);
}
