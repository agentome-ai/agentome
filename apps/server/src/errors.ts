import { DrizzleQueryError } from '@agentome/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';

// A code always comes with the same status, so clients can switch on the code alone. The
// exceptions: a request that Fastify or a library turned down as the client's mistake,
// answered as bad_request with their status, and better-auth's answers under /api/auth,
// which keep its status and lower-cased code.
const statusByCode = {
  validation_failed: 400,
  bad_request: 400,
  pairing_code_invalid: 400,
  pairing_code_expired: 400,
  // better-auth's code for a wrong current password (change-password), and ours too.
  invalid_password: 400,
  invalid_license: 400,
  unauthorized: 401,
  forbidden: 403,
  read_only: 403,
  license_required: 403,
  setup_completed: 403,
  not_found: 404,
  method_not_allowed: 405,
  agent_archived: 409,
  budget_reached: 409,
  connection_exists: 409,
  connection_unauthorized: 400,
  connection_unreachable: 502,
  email_taken: 409,
  environment_changed: 409,
  memory_conflict: 409,
  place_exists: 409,
  run_in_progress: 409,
  setup_required: 409,
  team_lead_taken: 409,
  invitation_invalid: 410,
  internal: 500,
  not_ready: 503,
  place_unavailable: 502,
} as const;

export type ErrorCode = keyof typeof statusByCode;

/** The only error the API answers with: `{ error: { code, message, details? } }`. */
export class AppError extends Error {
  override name = 'AppError';
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.status = statusByCode[code];
  }
}

export function errorHandler(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  const { status, code, message, details } = toResponseError(error);
  if (status >= 500) request.log.error({ err: withoutQueryParameters(error) }, message);
  return reply.status(status).send({ error: { code, message, details } });
}

/**
 * Drizzle repeats a failed query's parameters (emails, password hashes, token hashes) in the
 * error's message and stack; the log gets the SQL and the database's error code instead.
 */
export function withoutQueryParameters(error: unknown): unknown {
  if (!(error instanceof DrizzleQueryError)) return error;
  const cause = error.cause as { code?: unknown; message?: unknown } | undefined;
  const safe = Object.assign(new Error(`Failed query: ${error.query}: ${String(cause?.message)}`), {
    code: cause?.code,
  });
  safe.name = 'DrizzleQueryError';
  const frames = error.stack?.indexOf('\n    at ') ?? -1;
  safe.stack = `${safe.name}: ${safe.message}${frames >= 0 ? error.stack?.slice(frames) : ''}`;
  return safe;
}

/** The SQLSTATE of a failed query, such as 23505 for a unique violation. */
export function postgresCode(error: unknown): string | undefined {
  const cause = error instanceof DrizzleQueryError ? error.cause : error;
  const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
  return typeof code === 'string' ? code : undefined;
}

export async function notFoundHandler(request: FastifyRequest): Promise<never> {
  throw new AppError('not_found', `Route ${request.method} ${request.url} not found`);
}

function toResponseError(
  error: unknown,
): Pick<AppError, 'status' | 'code' | 'message' | 'details'> {
  if (error instanceof AppError) return error;
  if (hasZodFastifySchemaValidationErrors(error)) {
    const issues = error.validation.map((issue) => ({
      path: `${error.validationContext ?? ''}${issue.instancePath.replace(/^\/$/, '')}`,
      message: issue.message ?? 'Invalid value',
    }));
    return new AppError('validation_failed', 'The request is not valid', issues);
  }
  // A malformed request that Fastify rejected itself (bad JSON or URL, unsupported content
  // type, body too large), or a 4xx that a library marked as fit for the client to see
  // (http-errors' `expose`, such as @fastify/send's 416 for a Range past the end of a file):
  // the client's mistake, so it must not turn into a 500.
  if (isClientRejection(error)) {
    return { status: error.statusCode, code: 'bad_request', message: error.message };
  }
  // Anything else is a bug, or a library error whose status is not the client's business;
  // its message may hold internals or tokens, so only the log sees it.
  return new AppError('internal', 'Internal server error');
}

function isClientRejection(error: unknown): error is Error & { statusCode: number } {
  if (!(error instanceof Error) || !('statusCode' in error)) return false;
  const fastify =
    'code' in error && typeof error.code === 'string' && error.code.startsWith('FST_ERR_');
  const exposed = 'expose' in error && error.expose === true;
  const { statusCode } = error;
  return (
    (fastify || exposed) && typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500
  );
}
