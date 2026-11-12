import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { agents, and, eq, modelConnections, runs, type Db } from '@agentome/db';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { connectionsKey, decryptSecret } from '../connections/crypto.js';
import { guardedFetch, type FetchLike } from '../mcp/remote.js';
import { RELAY_PATH } from '../runs/launch.js';
import { isWorking } from '../runs/service.js';
import { hashSecret } from '../tokens.js';

// The model key stays here. A server seat's run calls /model/v1/... with its own
// token; the relay finds the run, puts its agent's model connection key on the request and passes
// it on to the provider, LiteLLM or the company's gateway, streaming the answer back. It does not
// route, price or cache: the engines' calls go through as they are.

/** The calls an engine makes: Claude Code's in Anthropic's format, Codex's in OpenAI's. */
const CALLS: Record<string, 'GET' | 'POST'> = {
  '/v1/messages': 'POST',
  '/v1/messages/count_tokens': 'POST',
  '/v1/responses': 'POST',
  '/v1/models': 'GET',
};

/** What the caller's request carries on to the provider: its format, never its credentials. */
const PASSED_ON = ['content-type', 'accept', 'anthropic-version', 'anthropic-beta', 'openai-beta'];

/** What never goes back: hop-by-hop, and what fetch has already undone or the stream sets. */
const HELD_BACK = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-encoding',
  'content-length',
  'set-cookie',
]);

type Upstream = { kind: 'anthropic' | 'openai' | 'gateway'; baseUrl: string; key: string };

/** The run's own token, as Claude Code sends it (bearer) or as some clients do (x-api-key). */
function tokenOf(request: FastifyRequest): string | undefined {
  const bearer = /^Bearer (\S+)$/i.exec(request.headers.authorization ?? '')?.[1];
  const header = request.headers['x-api-key'];
  return bearer ?? (typeof header === 'string' ? header : undefined);
}

/** The model connection of a working server run with this token, its key decrypted. */
async function upstreamOf(db: Db, secretKey: string, token: string): Promise<Upstream | undefined> {
  const [row] = await db
    .select({
      kind: modelConnections.kind,
      baseUrl: modelConnections.baseUrl,
      keyCiphertext: modelConnections.keyCiphertext,
    })
    .from(runs)
    .innerJoin(agents, eq(agents.id, runs.agentId))
    .innerJoin(modelConnections, eq(modelConnections.id, agents.modelConnectionId))
    .where(and(eq(runs.tokenHash, hashSecret(token)), eq(agents.runsOn, 'server'), isWorking()));
  if (!row) return undefined;
  const key = decryptSecret(connectionsKey(secretKey), row.keyCiphertext);
  return { kind: row.kind, baseUrl: row.baseUrl.replace(/\/+$/, ''), key };
}

/** An error in the shape both engines read: Anthropic's and OpenAI's have `error.message`. */
function refuse(reply: FastifyReply, status: number, type: string, message: string) {
  return reply.code(status).send({ type: 'error', error: { type, message } });
}

/** Aborts the provider's side when the seat hangs up before the answer is out. */
function hangUp(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  reply.raw.once('close', () => {
    if (!reply.raw.writableFinished) controller.abort();
  });
  return controller.signal;
}

export const relayRoutes: FastifyPluginAsync<{
  db: Db;
  config: Config;
  fetchImpl?: FetchLike;
}> = async (app, { db, config, fetchImpl = guardedFetch }) => {
  // The body goes on as it came: no parsing, no limit beyond the provider's own.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', (_request, payload, done) => done(null, payload));

  app.route({
    method: ['GET', 'POST'],
    url: `${RELAY_PATH}/*`,
    schema: { hide: true },
    handler: async (request, reply) => {
      const [path = '', query] = request.url.slice(RELAY_PATH.length).split(/\?(.*)/s, 2);
      if (CALLS[path] !== request.method) {
        return refuse(
          reply,
          404,
          'not_found_error',
          `${request.method} ${path} is not a model call`,
        );
      }
      const token = tokenOf(request);
      const upstream = token ? await upstreamOf(db, config.secretKey, token) : undefined;
      if (!upstream) {
        return refuse(
          reply,
          401,
          'authentication_error',
          'This token opens no working server run with a model connection',
        );
      }
      const headers: Record<string, string> = {};
      for (const name of PASSED_ON) {
        const value = request.headers[name];
        if (typeof value === 'string') headers[name] = value;
      }
      if (upstream.kind === 'anthropic') headers['x-api-key'] = upstream.key;
      else headers.authorization = `Bearer ${upstream.key}`;
      const url = `${upstream.baseUrl}${path}${query ? `?${query}` : ''}`;
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: request.method,
          headers,
          ...(request.method === 'POST' && {
            body: Readable.toWeb(request.body as Readable) as unknown as BodyInit,
            duplex: 'half',
          }),
          signal: hangUp(reply),
        } as RequestInit);
      } catch (error) {
        // How it failed, never with the key: the guard's words and the connection's host.
        const said = error instanceof Error ? error.message : String(error);
        request.log.warn({ host: new URL(url).host }, 'the model connection could not be reached');
        return refuse(
          reply,
          502,
          'api_error',
          `The model connection could not be reached: ${said}`,
        );
      }
      reply.code(response.status);
      response.headers.forEach((value, name) => {
        if (!HELD_BACK.has(name)) reply.header(name, value);
      });
      if (!response.body) return reply.send(Buffer.alloc(0));
      return reply.send(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>));
    },
  });
};
