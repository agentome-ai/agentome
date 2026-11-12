import { createHash, randomBytes } from 'node:crypto';
import { and, catalogItems, type Db, eq, gt, mcpAuthorizations, sql } from '@agentome/db';
import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js';
import {
  type OAuthClientInformationFull,
  OAuthClientInformationFullSchema,
  type OAuthTokens,
  OAuthTokensSchema,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { OAuthError, ServerError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { decryptSecret, encryptSecret } from '../connections/crypto.js';
import { AppError } from '../errors.js';
import { type FetchLike, failureOf, RemoteError } from '../mcp/remote.js';

// Signing in to a library MCP server with OAuth: the authorization code flow with
// PKCE, a client Agentome registers once per server, and a token per person that the gateway
// refreshes when it is about to run out. Every request goes through the gateway's guarded fetch.

/** Where the authorization server sends the browser back. */
export const CALLBACK_PATH = '/api/library/mcp/oauth/callback';

/** How long a sign-in may take in the browser. */
const PENDING_MS = 10 * 60_000;
/** A token this close to its end is refreshed before the call. */
const MARGIN_MS = 60_000;

/** What a server that uses OAuth keeps in its spec: the client Agentome registered, encrypted. */
export type OAuthSpec = { client: string | null };

type Server = { id: string; name: string; url: string; oauth: OAuthSpec | undefined };

const hashState = (state: string) => createHash('sha256').update(state).digest('base64url');

/**
 * How a step of the sign-in failed, never what the address answered. The server's metadata
 * names the endpoints Agentome calls, anyone may add a server, and the SDK puts the body of an
 * answer that is not OAuth into its error: passed on, that reads a service on the company's
 * network. An OAuth error's code is one of the SDK's fixed list; the gateway's refusals are its
 * own words.
 */
function stepFailure(error: unknown): string {
  if (error instanceof RemoteError) return error.message;
  if (error instanceof OAuthError && !(error instanceof ServerError)) {
    return `it answered ${error.errorCode}`;
  }
  const status = error instanceof Error ? /^HTTP (\d{3})\b/.exec(error.message)?.[1] : undefined;
  return status ? `it answered HTTP ${status}` : failureOf(error);
}

async function infoOf(server: Server, fetchFn: FetchLike) {
  const info = await discoverOAuthServerInfo(server.url, { fetchFn }).catch((error: unknown) => {
    throw new RemoteError(`${server.name} did not say how to sign in: ${stepFailure(error)}`, {
      cause: error,
    });
  });
  if (!info.authorizationServerMetadata) {
    throw new RemoteError(`${server.name} does not publish how to sign in to it`);
  }
  // Scopes as the resource lists them, else as its authorization server does.
  const scopes =
    info.resourceMetadata?.scopes_supported ?? info.authorizationServerMetadata.scopes_supported;
  return {
    url: info.authorizationServerUrl,
    metadata: info.authorizationServerMetadata,
    resource: info.resourceMetadata ? new URL(info.resourceMetadata.resource) : undefined,
    scope: scopes?.join(' ') || undefined,
  };
}

function clientOf(key: Buffer, oauth: OAuthSpec | undefined) {
  if (!oauth?.client) return undefined;
  return OAuthClientInformationFullSchema.parse(JSON.parse(decryptSecret(key, oauth.client)));
}

/**
 * Starts a person's sign-in: registers Agentome with the server's authorization server the
 * first time (or when the address it returns to changed), keeps the state's hash and the PKCE
 * verifier, and answers the address the browser opens.
 */
export async function beginSignIn(
  db: Db,
  key: Buffer,
  server: Server,
  userId: string,
  redirectUri: string,
  fetchFn: FetchLike,
): Promise<string> {
  const info = await infoOf(server, fetchFn);
  let client: OAuthClientInformationFull | undefined = clientOf(key, server.oauth);
  if (!client || !client.redirect_uris.includes(redirectUri)) {
    client = await registerClient(info.url, {
      metadata: info.metadata,
      clientMetadata: {
        client_name: 'Agentome',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
      scope: info.scope,
      fetchFn,
    }).catch((error: unknown) => {
      throw new RemoteError(`${server.name} refused to register Agentome: ${stepFailure(error)}`, {
        cause: error,
      });
    });
    const sealed = encryptSecret(key, JSON.stringify(client));
    await db
      .update(catalogItems)
      .set({
        spec: sql`jsonb_set(${catalogItems.spec}, '{oauth}', ${JSON.stringify({ client: sealed })}::jsonb)`,
      })
      .where(eq(catalogItems.id, server.id));
  }
  const state = randomBytes(32).toString('base64url');
  const { authorizationUrl, codeVerifier } = await startAuthorization(info.url, {
    metadata: info.metadata,
    clientInformation: client,
    redirectUrl: redirectUri,
    scope: info.scope,
    state,
    resource: info.resource,
  });
  const pending = {
    pendingState: hashState(state),
    pendingVerifier: encryptSecret(key, codeVerifier),
    pendingUntil: new Date(Date.now() + PENDING_MS),
  };
  await db
    .insert(mcpAuthorizations)
    .values({ serverId: server.id, userId, ...pending })
    .onConflictDoUpdate({
      target: [mcpAuthorizations.serverId, mcpAuthorizations.userId],
      set: pending,
    });
  return authorizationUrl.toString();
}

/**
 * The server a sign-in under way belongs to, if the state is still fresh and, when `userId` is
 * given, the person's. Without it the state alone names the person: the callback on a loopback
 * address, which only a browser on this machine reaches, comes with no session.
 */
export async function pendingSignIn(db: Db, state: string, userId: string | null) {
  const [row] = await db
    .select({
      id: mcpAuthorizations.id,
      serverId: mcpAuthorizations.serverId,
      userId: mcpAuthorizations.userId,
      verifier: mcpAuthorizations.pendingVerifier,
    })
    .from(mcpAuthorizations)
    .where(
      and(
        eq(mcpAuthorizations.pendingState, hashState(state)),
        userId ? eq(mcpAuthorizations.userId, userId) : undefined,
        gt(mcpAuthorizations.pendingUntil, new Date()),
      ),
    );
  if (!row?.verifier) {
    throw new AppError(
      'validation_failed',
      'This sign-in has expired or was started by someone else. Start it again from Library.',
    );
  }
  return { ...row, verifier: row.verifier };
}

const sealTokens = (key: Buffer, tokens: OAuthTokens) => ({
  tokens: encryptSecret(key, JSON.stringify(tokens)),
  expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null,
});

/** Trades the code the browser brought back for the person's tokens, and keeps them. */
export async function finishSignIn(
  db: Db,
  key: Buffer,
  server: Server,
  pending: { id: string; verifier: string },
  code: string,
  redirectUri: string,
  fetchFn: FetchLike,
): Promise<void> {
  const info = await infoOf(server, fetchFn);
  const client = clientOf(key, server.oauth);
  if (!client) throw new RemoteError(`Agentome is not registered with ${server.name} yet`);
  const tokens = await exchangeAuthorization(info.url, {
    metadata: info.metadata,
    clientInformation: client,
    authorizationCode: code,
    codeVerifier: decryptSecret(key, pending.verifier),
    redirectUri,
    resource: info.resource,
    fetchFn,
  }).catch((error: unknown) => {
    throw new RemoteError(`${server.name} did not accept the sign-in: ${stepFailure(error)}`, {
      cause: error,
    });
  });
  await db
    .update(mcpAuthorizations)
    .set({
      ...sealTokens(key, tokens),
      pendingState: null,
      pendingVerifier: null,
      pendingUntil: null,
    })
    .where(eq(mcpAuthorizations.id, pending.id));
}

/**
 * The Authorization header for a person's calls to a server, refreshing a token that is about
 * to run out; null when the person has not signed in.
 */
export async function bearerFor(
  db: Db,
  key: Buffer,
  server: Server,
  userId: string,
  fetchFn: FetchLike,
): Promise<string | null> {
  const [row] = await db
    .select({
      id: mcpAuthorizations.id,
      tokens: mcpAuthorizations.tokens,
      expiresAt: mcpAuthorizations.expiresAt,
    })
    .from(mcpAuthorizations)
    .where(and(eq(mcpAuthorizations.serverId, server.id), eq(mcpAuthorizations.userId, userId)));
  if (!row?.tokens) return null;
  let tokens = OAuthTokensSchema.parse(JSON.parse(decryptSecret(key, row.tokens)));
  const ending = row.expiresAt && row.expiresAt.getTime() - Date.now() < MARGIN_MS;
  if (ending && tokens.refresh_token) {
    const info = await infoOf(server, fetchFn);
    const client = clientOf(key, server.oauth);
    if (!client) return null;
    const fresh = await refreshAuthorization(info.url, {
      metadata: info.metadata,
      clientInformation: client,
      refreshToken: tokens.refresh_token,
      resource: info.resource,
      fetchFn,
    }).catch((error: unknown) => {
      throw new RemoteError(
        `${server.name} did not renew the sign-in: ${stepFailure(error)}. Sign in again in Library.`,
        { cause: error },
      );
    });
    // A server may keep the refresh token and send only a new access token.
    tokens = { ...fresh, refresh_token: fresh.refresh_token ?? tokens.refresh_token };
    await db
      .update(mcpAuthorizations)
      .set(sealTokens(key, tokens))
      .where(eq(mcpAuthorizations.id, row.id));
  }
  return `Bearer ${tokens.access_token}`;
}

/** The servers a person has signed in to, for their view of the library. */
export async function signedInTo(db: Db, userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ serverId: mcpAuthorizations.serverId })
    .from(mcpAuthorizations)
    .where(and(eq(mcpAuthorizations.userId, userId), sql`${mcpAuthorizations.tokens} is not null`));
  return new Set(rows.map((row) => row.serverId));
}

/** Signs a person out of a server: their tokens go. */
export async function signOut(db: Db, serverId: string, userId: string): Promise<void> {
  await db
    .delete(mcpAuthorizations)
    .where(and(eq(mcpAuthorizations.serverId, serverId), eq(mcpAuthorizations.userId, userId)));
}
