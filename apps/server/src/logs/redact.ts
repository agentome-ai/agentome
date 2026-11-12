// What a stored log line may never carry: pino's `redact` covers the paths we know;
// this covers what a context or a message brings along by accident.

const SECRET_KEY = /authorization|cookie|token|secret|password|passphrase|api[-_]?key/i;
// Bearer credentials and the token formats of the hosts we talk to.
const SECRET_VALUE =
  /\b(Bearer\s+)[\w.~+/-]+=*|\b(?:glpat|gldt|glptt|ghp|gho|ghu|ghs|ghr)[-_][\w-]{10,}|\bgithub_pat_\w{20,}|\bsk-[\w-]{16,}/g;

/** The text with its credentials replaced. */
export const redactText = (text: string) =>
  text.replace(SECRET_VALUE, (match, bearer: string | undefined) =>
    bearer ? `${bearer}[redacted]` : '[redacted]',
  );

/** A copy of the value with secret keys and credential-looking strings replaced. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  // Deeper than any error or header this server logs: not read, so nothing unread is kept.
  if (depth > 6) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactValue(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SECRET_KEY.test(key) && item !== null && item !== undefined
        ? '[redacted]'
        : redactValue(item, depth + 1),
    ]),
  );
}
