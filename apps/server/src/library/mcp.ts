import {
  agents,
  and,
  catalogItems,
  type Db,
  eq,
  inArray,
  mcpAuthorizations,
  or,
  sql,
  users,
} from '@agentome/db';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { agentFor, agentsThat, Holders } from '../agents/service.js';
import type { Config } from '../config.js';
import { connectionsKey, decryptSecret, encryptSecret } from '../connections/crypto.js';
import { AppError } from '../errors.js';
import {
  type FetchLike,
  guardedFetch,
  listRemoteTools,
  RemoteError,
  type RemoteServer,
  type RemoteTool,
} from '../mcp/remote.js';
import { IdParams } from '../protocol.js';
import {
  beginSignIn,
  bearerFor,
  CALLBACK_PATH,
  finishSignIn,
  type OAuthSpec,
  pendingSignIn,
  signedInTo,
  signOut,
} from './mcp-oauth.js';

// The library's MCP servers: catalog_items of kind mcp, one row per server, changed in
// place. A person adds one for themself (private), an admin shares it (org). The Authorization
// header is encrypted like a host token and no answer carries it. The tools the server listed
// at its last check are kept, so an agent's policies and its runs see them without a call.

const ServerName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'Use lowercase letters, digits and hyphens, such as jira')
  .describe('Its tools reach the agent as <name>__<tool>');
const ServerUrl = z.url({ protocol: /^https?$/ }).max(500);
const Authorization = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .regex(/^[^\r\n]*$/);

type Spec = {
  url: string;
  description: string;
  /** How the gateway signs in: a fixed header, or each person's OAuth sign-in. */
  auth?: 'header' | 'oauth';
  authorization: string | null;
  oauth?: OAuthSpec;
  tools: RemoteTool[];
  checkedAt: string;
};
const specOf = (spec: unknown) => spec as Spec;

const columns = {
  id: catalogItems.id,
  name: catalogItems.name,
  spec: catalogItems.spec,
  visibility: catalogItems.visibility,
  ownerId: catalogItems.ownerUserId,
  ownerName: users.name,
  createdAt: catalogItems.createdAt,
};
type Row = { [K in keyof typeof columns]: (typeof columns)[K]['_']['data'] | null };

const Summary = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string(),
  url: z.string(),
  hasAuthorization: z.boolean(),
  auth: z.enum(['header', 'oauth']),
  /** Whether the person asking has signed in, for a server that uses OAuth. */
  signedIn: z.boolean(),
  tools: z.array(z.object({ name: z.string(), title: z.string(), description: z.string() })),
  checkedAt: z.iso.datetime(),
  owner: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  visibility: z.enum(['org', 'private']),
});

const toSummary = (row: Row, signedIn: Set<string> = new Set()) => {
  const spec = specOf(row.spec);
  return {
    id: row.id ?? '',
    name: row.name ?? '',
    description: spec.description,
    url: spec.url,
    hasAuthorization: spec.authorization !== null,
    auth: spec.auth ?? 'header',
    signedIn: signedIn.has(row.id ?? ''),
    tools: spec.tools.map(({ name, title, description }) => ({ name, title, description })),
    checkedAt: spec.checkedAt,
    owner: row.ownerId ? { id: row.ownerId, name: row.ownerName ?? '' } : null,
    visibility: row.visibility ?? 'private',
  };
};

const select = (db: Db) =>
  db.select(columns).from(catalogItems).leftJoin(users, eq(users.id, catalogItems.ownerUserId));

const visibleTo = (userId: string) =>
  and(
    eq(catalogItems.kind, 'mcp'),
    or(eq(catalogItems.visibility, 'org'), eq(catalogItems.ownerUserId, userId)),
  );

async function rowFor(db: Db, id: string, userId: string) {
  const [row] = await select(db).where(and(eq(catalogItems.id, id), visibleTo(userId)));
  if (!row) throw new AppError('not_found', 'MCP server not found');
  return row;
}

/**
 * The library servers a person may give an agent, by name: their own before a shared
 * one of the same name. An imported agent names its servers, since ids are this install's.
 */
export async function serversNamed(db: Db, userId: string, names: string[]) {
  const found = new Map<string, string>();
  if (names.length === 0) return found;
  const rows = await db
    .select({ id: catalogItems.id, name: catalogItems.name, ownerUserId: catalogItems.ownerUserId })
    .from(catalogItems)
    .where(and(visibleTo(userId), inArray(catalogItems.name, names)));
  for (const row of rows.sort(
    (a, b) => Number(b.ownerUserId === userId) - Number(a.ownerUserId === userId),
  )) {
    if (!found.has(row.name)) found.set(row.name, row.id);
  }
  return found;
}

/** The library servers an agent was given, by the `{ server }` entries of `agents.tools`. */
export async function serversOf(db: Db, agentTools: unknown) {
  const ids = z
    .array(z.object({ server: z.uuid() }).catch(null as never))
    .catch([])
    .parse(agentTools)
    .flatMap((entry) => (entry ? [entry.server] : []));
  if (ids.length === 0) return [];
  const rows = await select(db).where(
    and(eq(catalogItems.kind, 'mcp'), inArray(catalogItems.id, ids)),
  );
  return rows.map((row) => ({ ...toSummary(row), spec: specOf(row.spec) }));
}

/** The name an agent calls a server's tool by: one gateway, many servers. */
export const remoteToolName = (server: string, tool: string) => `${server}__${tool}`;

/** A server with its header decrypted, for the gateway's own request and nothing else. */
export const remoteOf = (key: Buffer, spec: Spec): RemoteServer => ({
  url: spec.url,
  authorization: spec.authorization === null ? null : decryptSecret(key, spec.authorization),
});

/**
 * A server as one person calls it: its fixed header, or that person's OAuth token.
 * `who` names the person in the refusal an agent reads.
 */
export async function remoteFor(
  db: Db,
  key: Buffer,
  server: { id: string; name: string; spec: Spec },
  userId: string,
  fetchImpl: FetchLike,
  who = 'You have',
): Promise<RemoteServer> {
  if (server.spec.auth !== 'oauth') return remoteOf(key, server.spec);
  const authorization = await bearerFor(db, key, oauthServer(server), userId, fetchImpl);
  if (!authorization) {
    throw new RemoteError(
      `${who} not signed in to ${server.name}: Library, MCP servers, ${server.name}, Sign in.`,
    );
  }
  return { url: server.spec.url, authorization };
}

/** This machine's own names: an address only a browser on it can open. */
const isLoopback = (hostname: string) =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';

const oauthServer = (server: { id: string; name: string; spec: Spec }) => ({
  id: server.id,
  name: server.name,
  url: server.spec.url,
  oauth: server.spec.oauth,
});

async function check(server: RemoteServer | Promise<RemoteServer>, fetchImpl: FetchLike) {
  try {
    return await listRemoteTools(await server, fetchImpl);
  } catch (error) {
    if (error instanceof RemoteError) throw new AppError('validation_failed', error.message);
    throw error;
  }
}

export const mcpLibraryRoutes: FastifyPluginAsyncZod<{
  db: Db;
  config: Config;
  fetchImpl?: FetchLike;
}> = async (app, { db, config, fetchImpl = guardedFetch }) => {
  const key = connectionsKey(config.secretKey);
  const redirectUri = new URL(CALLBACK_PATH, config.oauthReturnUrl).toString();
  // A return address on this machine comes back without the session's cookie, which belongs
  // to the public address; there the sign-in's state names the person.
  const loopbackReturn = isLoopback(new URL(config.oauthReturnUrl).hostname);
  const library = (query: Record<string, string>) =>
    `${loopbackReturn ? config.publicUrl : ''}/library?${new URLSearchParams(query).toString()}`;
  app.addHook('onRequest', async (request, reply) => {
    if (loopbackReturn && request.routeOptions.url === CALLBACK_PATH) return;
    return app.requireSession(request, reply);
  });

  const summaryOf = async (row: Row, userId: string) =>
    toSummary(row, await signedInTo(db, userId));
  const save = async (id: string, spec: Spec, userId: string) => {
    await db.update(catalogItems).set({ spec }).where(eq(catalogItems.id, id));
    return summaryOf(await rowFor(db, id, userId), userId);
  };
  const asServer = (row: Row) => ({
    id: row.id ?? '',
    name: row.name ?? '',
    spec: specOf(row.spec),
  });

  app.get(
    '/api/library/mcp',
    {
      schema: {
        summary: 'The MCP servers the person may give their agents',
        response: { 200: z.object({ servers: z.array(Summary) }) },
      },
    },
    async (request) => {
      const rows = await select(db).where(visibleTo(request.user.id)).orderBy(catalogItems.name);
      const signed = await signedInTo(db, request.user.id);
      return { servers: rows.map((row) => toSummary(row, signed)) };
    },
  );

  app.post(
    '/api/library/mcp',
    {
      schema: {
        summary:
          'Adds an MCP server for the person, once it answers with its tools; one that signs in with OAuth is listed once someone signs in',
        body: z.object({
          name: ServerName,
          url: ServerUrl,
          description: z.string().trim().max(500).default(''),
          auth: z.enum(['header', 'oauth']).default('header'),
          authorization: Authorization.optional(),
        }),
        response: { 201: Summary },
      },
    },
    async (request, reply) => {
      const { name, url, description, auth, authorization } = request.body;
      if (auth === 'oauth' && authorization) {
        throw new AppError('validation_failed', 'A server that signs in with OAuth takes no token');
      }
      const [taken] = await db
        .select({ id: catalogItems.id })
        .from(catalogItems)
        .where(
          and(
            eq(catalogItems.kind, 'mcp'),
            eq(catalogItems.name, name),
            eq(catalogItems.ownerUserId, request.user.id),
          ),
        );
      if (taken) throw new AppError('validation_failed', `You already have a server named ${name}`);
      // Its tools are listed with the first sign-in: before it, the server lets nobody in.
      const tools =
        auth === 'oauth'
          ? []
          : await check({ url, authorization: authorization ?? null }, fetchImpl);
      const spec: Spec = {
        url,
        description,
        auth,
        authorization: authorization ? encryptSecret(key, authorization) : null,
        tools,
        checkedAt: new Date().toISOString(),
      };
      const [row] = await db
        .insert(catalogItems)
        .values({
          kind: 'mcp',
          name,
          version: '1',
          spec,
          ownerUserId: request.user.id,
          visibility: 'private',
        })
        .returning({ id: catalogItems.id });
      return reply
        .code(201)
        .send(await summaryOf(await rowFor(db, row?.id ?? '', request.user.id), request.user.id));
    },
  );

  app.get(
    '/api/library/mcp/:id/agents',
    {
      schema: {
        summary: "The person's agents that have the server",
        params: IdParams,
        response: { 200: Holders },
      },
    },
    async (request) => {
      const row = await rowFor(db, request.params.id, request.user.id);
      const holds = sql`exists (
        select 1 from jsonb_array_elements(${agents.tools}) held where held->>'server' = ${row.id})`;
      return { agents: await agentsThat(db, request.user.id, holds) };
    },
  );

  app.patch(
    '/api/library/mcp/:id',
    {
      schema: {
        summary: "Changes the person's own server; null removes its Authorization header",
        params: IdParams,
        body: z.object({
          url: ServerUrl.optional(),
          description: z.string().trim().max(500).optional(),
          authorization: Authorization.nullable().optional(),
        }),
        response: { 200: Summary },
      },
    },
    async (request) => {
      const row = await rowFor(db, request.params.id, request.user.id);
      if (row.ownerId !== request.user.id)
        throw new AppError('forbidden', 'Only its author changes a server');
      const old = specOf(row.spec);
      const { url = old.url, description = old.description, authorization } = request.body;
      if (old.auth === 'oauth') {
        if (authorization) {
          throw new AppError(
            'validation_failed',
            'A server that signs in with OAuth takes no token',
          );
        }
        if (url === old.url) {
          return save(request.params.id, { ...old, description }, request.user.id);
        }
        // Everyone's sign-in was made for the old address: their tokens and Agentome's client
        // there must not go to the new one, so all of it goes, and each person signs in again.
        await db.delete(mcpAuthorizations).where(eq(mcpAuthorizations.serverId, request.params.id));
        const moved: Spec = {
          url,
          description,
          auth: 'oauth',
          authorization: null,
          tools: [],
          checkedAt: new Date().toISOString(),
        };
        return save(request.params.id, moved, request.user.id);
      }
      const header =
        authorization === undefined
          ? old.authorization
          : authorization && encryptSecret(key, authorization);
      const tools = await check(remoteOf(key, { ...old, url, authorization: header }), fetchImpl);
      const spec = {
        url,
        description,
        authorization: header,
        tools,
        checkedAt: new Date().toISOString(),
      };
      return save(request.params.id, spec, request.user.id);
    },
  );

  app.post(
    '/api/library/mcp/:id/check',
    {
      schema: {
        summary: 'Asks the server for its tools again and keeps the answer',
        params: IdParams,
        response: { 200: Summary },
      },
    },
    async (request) => {
      const row = await rowFor(db, request.params.id, request.user.id);
      const old = specOf(row.spec);
      const tools = await check(
        remoteFor(db, key, asServer(row), request.user.id, fetchImpl),
        fetchImpl,
      );
      return save(
        request.params.id,
        { ...old, tools, checkedAt: new Date().toISOString() },
        request.user.id,
      );
    },
  );

  app.post(
    '/api/library/mcp/:id/sign-in',
    {
      schema: {
        summary:
          'Starts the person’s OAuth sign-in to a server: the address to open in the browser',
        params: IdParams,
        response: { 200: z.object({ url: z.string() }) },
      },
    },
    async (request) => {
      const row = await rowFor(db, request.params.id, request.user.id);
      const server = asServer(row);
      if (server.spec.auth !== 'oauth') {
        throw new AppError('validation_failed', `${server.name} signs in with a token, not OAuth`);
      }
      try {
        const url = await beginSignIn(
          db,
          key,
          { id: server.id, name: server.name, url: server.spec.url, oauth: server.spec.oauth },
          request.user.id,
          redirectUri,
          fetchImpl,
        );
        return { url };
      } catch (error) {
        if (error instanceof RemoteError) throw new AppError('validation_failed', error.message);
        throw error;
      }
    },
  );

  app.delete(
    '/api/library/mcp/:id/sign-in',
    {
      schema: {
        summary: 'Signs the person out of a server; their agents lose its tools until they sign in',
        params: IdParams,
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      await rowFor(db, request.params.id, request.user.id);
      await signOut(db, request.params.id, request.user.id);
      return reply.code(204).send(null);
    },
  );

  // The authorization server sends the browser here; the person's own session comes with it.
  // It answers with a redirect to the library, which says how the sign-in went.
  app.get(
    CALLBACK_PATH,
    {
      schema: {
        summary: 'Where the browser comes back from an OAuth sign-in',
        querystring: z.object({
          code: z.string().max(4000).optional(),
          state: z.string().max(200).optional(),
          error: z.string().max(200).optional(),
          error_description: z.string().max(500).optional(),
        }),
      },
    },
    async (request, reply) => {
      const back = (query: Record<string, string>) => reply.redirect(library(query));
      const { code, state, error, error_description: said } = request.query;
      if (!code || !state) return back({ mcpError: said ?? error ?? 'The sign-in was cancelled' });
      try {
        const pending = await pendingSignIn(db, state, loopbackReturn ? null : request.user.id);
        const userId = pending.userId;
        const row = await rowFor(db, pending.serverId, userId);
        const server = asServer(row);
        const oauth = {
          id: server.id,
          name: server.name,
          url: server.spec.url,
          oauth: server.spec.oauth,
        };
        await finishSignIn(db, key, oauth, pending, code, redirectUri, fetchImpl);
        // The tools as the server lists them to this person.
        const fresh = specOf((await rowFor(db, server.id, userId)).spec);
        const tools = await check(
          remoteFor(db, key, { ...server, spec: fresh }, userId, fetchImpl),
          fetchImpl,
        );
        await save(server.id, { ...fresh, tools, checkedAt: new Date().toISOString() }, userId);
        return back({ mcpSignedIn: server.name });
      } catch (caught) {
        if (caught instanceof AppError || caught instanceof RemoteError) {
          return back({ mcpError: caught.message });
        }
        throw caught;
      }
    },
  );

  app.post(
    '/api/library/mcp/:id/share',
    {
      onRequest: app.requireAdmin,
      schema: {
        summary: 'Shares a server with everyone',
        params: IdParams,
        response: { 200: Summary },
      },
    },
    async (request) => {
      await rowFor(db, request.params.id, request.user.id);
      await db
        .update(catalogItems)
        .set({ visibility: 'org', approvedBy: request.user.id })
        .where(eq(catalogItems.id, request.params.id));
      return summaryOf(await rowFor(db, request.params.id, request.user.id), request.user.id);
    },
  );

  app.delete(
    '/api/library/mcp/:id',
    {
      schema: {
        summary:
          'Deletes a server: its author, or an admin once it is shared; agents lose it from their next run',
        params: IdParams,
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const row = await rowFor(db, request.params.id, request.user.id);
      const admin = request.user.role === 'admin' && row.visibility === 'org';
      if (row.ownerId !== request.user.id && !admin)
        throw new AppError('forbidden', 'Only its author or an admin deletes a server');
      // An agent keeps the id in agents.tools, and its runs skip a server that is gone.
      await db.delete(catalogItems).where(eq(catalogItems.id, request.params.id));
      return reply.code(204).send(null);
    },
  );

  app.put(
    '/api/agents/:id/mcp',
    {
      schema: {
        summary:
          "Sets the agent's MCP servers; their tools ask the owner until a policy says otherwise",
        params: IdParams,
        body: z.object({ servers: z.array(z.uuid()).max(20) }),
        response: { 200: z.object({ servers: z.array(Summary) }) },
      },
    },
    async (request) => {
      const agent = await agentFor(db, request.params.id, request.user.id);
      const wanted = [...new Set(request.body.servers)];
      const found = await Promise.all(wanted.map((id) => rowFor(db, id, request.user.id)));
      if (new Set(found.map((row) => row.name)).size !== found.length) {
        throw new AppError('validation_failed', 'Give the agent one server of each name');
      }
      const entries = JSON.stringify(wanted.map((server) => ({ server })));
      // The policies stay; only the server entries are replaced, in one statement.
      await db
        .update(agents)
        .set({
          tools: sql`coalesce((select jsonb_agg(e) from jsonb_array_elements(${agents.tools}) e where e->>'server' is null), '[]'::jsonb) || ${entries}::jsonb`,
        })
        .where(eq(agents.id, agent.id));
      return { servers: found.map((row) => toSummary(row)) };
    },
  );
};
