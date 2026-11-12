import { createHmac } from 'node:crypto';
import {
  accounts,
  and,
  apiTokens,
  type Db,
  eq,
  gt,
  isNull,
  or,
  sessions,
  users,
  verifications,
} from '@agentome/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError } from 'better-auth/api';
import { genericOAuth, keycloak } from 'better-auth/plugins/generic-oauth';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Config } from './config.js';
import { AppError, withoutQueryParameters } from './errors.js';
import { bearerToken, hashSecret } from './tokens.js';
import { licenseRequired } from './license/service.js';
import { afterPasswordReset } from './password-reset.js';

// better-auth takes the client address, for its rate limit and the session record, from this
// header only. The server sets it from request.ip and drops a value the client sent.
const clientIpHeader = 'x-agentome-client-ip';

/** A key for one purpose, so that no two features sign or encrypt with the same key. */
export function deriveKey(secretKey: string, purpose: string): string {
  return createHmac('sha256', secretKey).update(`agentome:${purpose}`).digest('hex');
}

// Every option that better-auth would otherwise read from NODE_ENV is set here, so that
// tests, development and production behave alike. `onResetToken` is for the `agentome
// reset-password` command alone: with it this instance may issue a one-time token for a new
// password. The server's own instance has none, so nobody can ask it for one.
export function createAuth(
  db: Db,
  config: Config,
  log: Pick<FastifyBaseLogger, 'debug' | 'info' | 'warn' | 'error'>,
  onResetToken?: (token: string) => void,
) {
  const { origin, protocol } = new URL(config.publicUrl);
  const secure = protocol === 'https:';
  return betterAuth({
    appName: 'Agentome',
    // The origin only: the server answers at /api/auth even behind a proxy that adds a path.
    baseURL: origin,
    basePath: '/api/auth',
    secret: deriveKey(config.secretKey, 'better-auth'),
    trustedOrigins: [origin],
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: { users, sessions, accounts, verifications },
    }),
    user: {
      modelName: 'users',
      additionalFields: {
        role: { type: ['admin', 'member'], required: true, defaultValue: 'member', input: false },
        disabledAt: { type: 'date', required: false, input: false },
      },
    },
    session: { modelName: 'sessions' },
    account: {
      modelName: 'accounts',
      // Keycloak's tokens are kept only because better-auth keeps them; nothing reads them.
      encryptOAuthTokens: true,
      // A person who has a password here gets Keycloak beside it on one account, not a second
      // one, when both sides vouch for the address: Keycloak's email_verified, and ours (the
      // setup's or a fixed invitation's, migration 0035). Keycloak is not a trusted provider, so
      // a realm user who set someone else's address unverified cannot take over their account.
      accountLinking: { enabled: true },
    },
    verification: { modelName: 'verifications' },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      // A new password ends every session, and with onPasswordReset the person's API tokens:
      // whoever had the old one is out.
      revokeSessionsOnPasswordReset: true,
      onPasswordReset: async ({ user }: { user: { id: string } }) =>
        afterPasswordReset(db, user.id),
      ...(onResetToken && {
        sendResetPassword: async ({ token }: { token: string }) => onResetToken(token),
      }),
    },
    // People join through /setup and invitations, which create their accounts themselves.
    disabledPaths: ['/sign-up/email'],
    // In memory, per instance; sign-in allows 3 attempts in 10 s per address.
    rateLimit: { enabled: true, storage: 'memory' },
    advanced: {
      cookiePrefix: 'agentome',
      useSecureCookies: secure,
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', secure },
      disableOriginCheck: false,
      ipAddress: { ipAddressHeaders: [clientIpHeader] },
      database: { generateId: 'uuid' },
    },
    databaseHooks: {
      session: {
        create: {
          // Sign-in creates the session after the password check, so a wrong password
          // never learns that the account exists or is disabled.
          before: async (session) => {
            const [user] = await db
              .select({ disabledAt: users.disabledAt })
              .from(users)
              .where(eq(users.id, session.userId));
            if (user?.disabledAt) {
              throw new APIError('FORBIDDEN', {
                code: 'ACCOUNT_DISABLED',
                message: 'This account is disabled. Ask an admin to enable it.',
              });
            }
          },
        },
      },
    },
    logger: {
      level: 'warn',
      log: (level, message, ...args) =>
        log[level](
          { err: withoutQueryParameters(args.find((arg) => arg instanceof Error)) },
          message,
        ),
    },
    telemetry: { enabled: false },
    // Anyone the realm lets in joins on the first sign-in as a member: who may come in
    // is Keycloak's to say, and admins are made here.
    plugins: config.keycloak
      ? [genericOAuth({ config: [keycloak({ ...config.keycloak, pkce: true })] })]
      : [],
  });
}

export type Auth = ReturnType<typeof createAuth>;

export type SessionUser = { id: string; name: string; email: string; role: 'admin' | 'member' };

declare module 'fastify' {
  interface FastifyInstance {
    /** An onRequest hook: 401 unless an enabled person signed in; sets request.user. */
    requireSession: (request: FastifyRequest, reply?: FastifyReply) => Promise<void>;
    /** An onRequest hook: requireSession, then 403 unless that person is an admin. */
    requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    /** The signed-in person; set by requireSession and requireAdmin, null elsewhere. */
    user: SessionUser;
  }
}

/** Adds requireSession and requireAdmin to the root instance, for every route plugin. */
export function addSessionHooks(app: FastifyInstance, auth: Auth, db: Db, publicUrl: string) {
  const own = new URL(publicUrl).origin;
  const requireSession = async (request: FastifyRequest, reply?: FastifyReply) => {
    // A personal token signs a person in the way the browser's cookie does, for
    // the management MCP and scripts. It is never refreshed and leaves no cookie behind.
    const token = bearerToken(request);
    if (token) {
      const found = await userOfApiToken(db, token);
      if (!found) {
        throw new AppError('unauthorized', 'This token is not valid, has expired or was revoked');
      }
      // The management MCP's own POST carries reads as well: each of its tool calls comes back
      // here as a request of the route's own method, and is checked then.
      if (
        found.scope === 'read' &&
        !READS.has(request.method) &&
        request.routeOptions.url !== '/mcp/manage'
      ) {
        throw new AppError('forbidden', 'This token can only read');
      }
      request.user = found.user;
      viaToken.set(request, found.scope);
      return;
    }
    // The cookie is SameSite=Lax, which a page on a sibling host of the same site passes, and a
    // POST without a body needs no preflight: such a page could archive an agent or run a task
    // as the person looking at it. A browser says where a request that changes something comes
    // from; a client that is not a browser sends no Origin and has no cookie a page could use.
    const from = request.headers.origin;
    if (from !== undefined && from !== own && !READS.has(request.method)) {
      throw new AppError('forbidden', 'This request came from another site');
    }
    const { headers, response } = await auth.api.getSession({
      headers: webHeaders(request),
      // A session past half its life is extended, and the cookie with it; without a reply
      // the new cookie could not reach the browser, so the session is only read.
      query: { disableRefresh: !reply },
      returnHeaders: true,
    });
    if (reply) forwardCookies(headers, reply);
    if (!response || response.user.disabledAt) {
      throw new AppError('unauthorized', 'Sign in to continue');
    }
    const { id, name, email, role } = response.user;
    request.user = { id, name, email, role: role === 'admin' ? 'admin' : 'member' };
  };
  // A route that reads request.user without either hook fails loudly instead of
  // treating the request as nobody's.
  const signedIn = new WeakMap<FastifyRequest, SessionUser>();
  app.decorateRequest('user', {
    getter(this: FastifyRequest) {
      const user = signedIn.get(this);
      if (!user) throw new Error('request.user is set by requireSession or requireAdmin');
      return user;
    },
    setter(this: FastifyRequest, user: SessionUser) {
      signedIn.set(this, user);
    },
  });
  app.decorate('requireSession', requireSession);
  app.decorate('requireAdmin', async (request: FastifyRequest, reply: FastifyReply) => {
    await requireSession(request, reply);
    if (request.user.role !== 'admin') throw new AppError('forbidden', 'Only admins can do this');
  });
}

const READS = new Set(['GET', 'HEAD']);
const viaToken = new WeakMap<FastifyRequest, ApiTokenScope>();
/** Whether the person signed in with a personal token rather than the browser's session. */
export const signedInWithToken = (request: FastifyRequest) => viaToken.has(request);
/** The scope of the personal token the person signed in with, if they did. */
export const tokenScope = (request: FastifyRequest) => viaToken.get(request);

/**
 * For a route that hands out another long-lived secret (a token, a pairing code, an invitation):
 * only the browser's session may, so that revoking a leaked token revokes everything it could
 * reach, and a token never mints what outlives it.
 */
export function browserOnly(request: FastifyRequest): void {
  if (signedInWithToken(request)) {
    throw new AppError('forbidden', 'Sign in in the browser to do this');
  }
}

type ApiTokenScope = (typeof apiTokens.$inferSelect)['scope'];

/**
 * The enabled person whose unrevoked, unexpired token this is, and what it may do; its last use
 * is noted once a minute.
 */
async function userOfApiToken(
  db: Db,
  token: string,
): Promise<{ user: SessionUser; scope: ApiTokenScope } | undefined> {
  const [row] = await db
    .select({
      id: apiTokens.id,
      user: users,
      scope: apiTokens.scope,
      lastUsedAt: apiTokens.lastUsedAt,
    })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(
      and(
        eq(apiTokens.tokenHash, hashSecret(token)),
        isNull(apiTokens.revokedAt),
        or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, new Date())),
      ),
    );
  if (!row || row.user.disabledAt) return undefined;
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) {
    await db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, row.id));
  }
  const { id, name, email, role } = row.user;
  return {
    user: { id, name, email, role: role === 'admin' ? 'admin' : 'member' },
    scope: row.scope,
  };
}

export type User = { id: string; email: string; name: string };

/**
 * The signed-in person, or 401: what the seat and run routes call from inside a
 * handler. The same check as requireSession; `db` stays in the signature those routes use.
 */
export async function requireUser(_db: Db, request: FastifyRequest): Promise<User> {
  await request.server.requireSession(request);
  return request.user;
}

/** Starts a session for a person whose account was just created, as a sign-in would. */
export async function signIn(
  auth: Auth,
  request: FastifyRequest,
  reply: FastifyReply,
  credentials: { email: string; password: string },
) {
  const { headers } = await auth.api.signInEmail({
    body: credentials,
    headers: webHeaders(request),
    returnHeaders: true,
  });
  forwardCookies(headers, reply);
}

// Only what the web app calls. The rest of better-auth (profile and session management)
// stays unreachable until a task needs it and reviews it. change-password asks for the
// current password, and the Account dialog signs the person's other devices out with it.
// reset-password takes a one-time token that only `agentome reset-password` issues; the route
// that would issue one to anyone who asks, request-password-reset, is not here.
const exposed = new Set([
  '/api/auth/sign-in/email',
  '/api/auth/sign-in/social',
  '/api/auth/sign-out',
  '/api/auth/change-password',
  '/api/auth/reset-password',
]);

/** better-auth's sign-in, sign-out and password change, behind the Fastify router. */
export const authRoutes: FastifyPluginAsyncZod<{
  auth: Auth;
  publicUrl: string;
  /** Whether Keycloak may sign anyone in: a license matter. */
  keycloakAllowed: () => Promise<boolean>;
}> = async (app, { auth, publicUrl, keycloakAllowed }) => {
  app.post('/api/auth/*', { schema: { hide: true } }, async (request, reply) => {
    const url = new URL(request.url, publicUrl);
    if (!exposed.has(url.pathname))
      throw new AppError('not_found', `Route POST ${url.pathname} not found`);
    // Only the redirect to Keycloak: better-auth would also take an id_token posted here, which
    // skips the code flow and its PKCE, and the web app never sends one.
    if (url.pathname === '/api/auth/sign-in/social' && hasIdToken(request.body)) {
      throw new AppError('bad_request', 'Sign in through Keycloak');
    }
    if (url.pathname === '/api/auth/sign-in/social' && !(await keycloakAllowed())) {
      throw licenseRequired('keycloak');
    }
    const headers = webHeaders(request);
    // Fastify has parsed the JSON already; better-auth reads it again from the body.
    headers.set('content-type', 'application/json');
    const body = JSON.stringify(request.body ?? {});
    const response = await auth.handler(new Request(url, { method: 'POST', headers, body }));
    response.headers.forEach((value, key) => {
      if (key !== 'set-cookie' && key !== 'content-length') reply.header(key, value);
    });
    forwardCookies(response.headers, reply);
    reply.status(response.status);
    const text = await response.text();
    if (response.ok) return reply.send(text);
    return reply.type('application/json').send({ error: authError(response, text) });
  });

  // Where Keycloak sends the browser back: better-auth signs the person in and redirects to the
  // page the sign-in started from, or to the sign-in page with the error.
  app.get('/api/auth/callback/keycloak', { schema: { hide: true } }, async (request, reply) => {
    if (!(await keycloakAllowed())) return reply.redirect('/login?error=keycloak');
    const url = new URL(request.url, publicUrl);
    const response = await auth.handler(
      new Request(url, { method: 'GET', headers: webHeaders(request) }),
    );
    const location = response.headers.get('location');
    forwardCookies(response.headers, reply);
    if (location) return reply.redirect(location, response.status === 301 ? 302 : response.status);
    return reply.redirect('/login?error=keycloak');
  });
};

// better-auth answers errors as { code: 'INVALID_EMAIL_OR_PASSWORD', message }; the API
// answers every error as { error: { code, message } } with a lower-case code.
function authError(response: Response, body: string) {
  if (response.status >= 500) return { code: 'internal', message: 'Internal server error' };
  const { code, message } = parseJson(body);
  const fallback = { 404: 'not_found', 429: 'rate_limited' }[response.status] ?? 'bad_request';
  return {
    code: typeof code === 'string' ? code.toLowerCase() : fallback,
    message: typeof message === 'string' ? message : response.statusText,
  };
}

const hasIdToken = (body: unknown) =>
  typeof body === 'object' && body !== null && 'idToken' in body;

// Not every answer is JSON, and a broken one must not turn into a 500.
function parseJson(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function webHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (key === 'content-length' || key === 'transfer-encoding') continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined) headers.append(key, item);
    }
  }
  headers.set(clientIpHeader, request.ip);
  return headers;
}

function forwardCookies(headers: Headers | null | undefined, reply: FastifyReply) {
  for (const cookie of headers?.getSetCookie() ?? []) reply.header('set-cookie', cookie);
}
