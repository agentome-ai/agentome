import { pipeline, Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { agents, and, eq, modelConnections, type RelayTokens, runs, type Db } from '@agentome/db';
import { Meter, type Metered, metering } from './meter.js';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { connectionsKey, decryptSecret } from '../connections/crypto.js';
import { guardedFetch, type FetchLike } from '../mcp/remote.js';
import { RELAY_PATH } from '../runs/launch.js';
import { isWorking } from '../runs/service.js';
import { requireBudget } from '../budgets/service.js';
import { AppError } from '../errors.js';
import { hashSecret } from '../tokens.js';

// The model key stays here. A server seat's run calls /model/v1/... with its own
// token; the relay finds the run, puts its agent's model connection key on the request and passes
// it on to the provider, LiteLLM or the company's gateway, streaming the answer back. It does not
// route, price or cache. It does hold a run to its agent's model and the models its connection
// lists, and to a few calls at once: a run with a shell holds the token too, and could otherwise
// call the dearest model as fast as it likes.

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

type Upstream = {
  runId: string;
  /** The run's task, whose agent's and project's month a call is checked against. */
  taskId: string | null;
  kind: 'anthropic' | 'openai' | 'gateway';
  baseUrl: string;
  key: string;
  /**
   * The models this run may call: its agent's, and those its connection lists; none to hold it to
   * when the agent names no model, since the CLI then picks its own (Claude Code's or Codex's
   * default), whatever the provider.
   */
  models: Set<string> | undefined;
};

/** A request's body is read before it goes on, to see its model: up to this much. */
const MAX_BODY = 32 * 1024 * 1024;
/** Calls of one run at once: an engine's own and its helpers', not a flood. */
const MAX_AT_ONCE = 4;
/** Bodies the relay reads at once, of every run: each up to MAX_BODY, in one process's memory. */
const MAX_READING = 16;
/** How long a run's month is taken as checked: a call is not a query of the budgets each time. */
const BUDGET_CHECKED_MS = 30_000;

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
      runId: runs.id,
      taskId: runs.taskId,
      kind: modelConnections.kind,
      baseUrl: modelConnections.baseUrl,
      keyCiphertext: modelConnections.keyCiphertext,
      models: modelConnections.models,
      modelPref: agents.modelPref,
    })
    .from(runs)
    .innerJoin(agents, eq(agents.id, runs.agentId))
    .innerJoin(modelConnections, eq(modelConnections.id, agents.modelConnectionId))
    .where(and(eq(runs.tokenHash, hashSecret(token)), eq(agents.runsOn, 'server'), isWorking()));
  if (!row) return undefined;
  const key = decryptSecret(connectionsKey(secretKey), row.keyCiphertext);
  const models = row.modelPref ? new Set([row.modelPref, ...row.models]) : undefined;
  return {
    runId: row.runId,
    taskId: row.taskId,
    kind: row.kind,
    baseUrl: row.baseUrl.replace(/\/+$/, ''),
    key,
    models,
  };
}

/** Whose format a call's answer is in, for counting its usage; none for a call with no usage. */
function providerOf(kind: Upstream['kind'], path: string): RelayTokens['provider'] | undefined {
  if (path === '/v1/messages') return kind === 'openai' ? undefined : 'anthropic';
  if (path === '/v1/responses') return kind === 'anthropic' ? undefined : 'openai';
  return undefined;
}

/** Adds one call's tokens to the run's, under the run's row lock: calls end at once. */
async function recordUsage(db: Db, runId: string, metered: Metered): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ usage: runs.relayUsage })
      .from(runs)
      .where(eq(runs.id, runId))
      .for('update');
    const usage = { ...(row?.usage ?? {}) };
    const before = usage[metered.model];
    const add = metered.tokens;
    usage[metered.model] = before
      ? {
          provider: before.provider,
          tokensIn: before.tokensIn + add.tokensIn,
          tokensOut: before.tokensOut + add.tokensOut,
          tokensCacheRead: before.tokensCacheRead + add.tokensCacheRead,
          tokensCacheWrite: before.tokensCacheWrite + add.tokensCacheWrite,
        }
      : add;
    await tx.update(runs).set({ relayUsage: usage }).where(eq(runs.id, runId));
  });
}

/** Drops the oldest entries of a map past a thousand: the runs going now are the newest. */
function makeRoom(map: Map<string, number>) {
  for (const key of map.keys()) {
    if (map.size < 1000) return;
    map.delete(key);
  }
}

/** The request's body, whole, or undefined when it is longer than the relay reads. */
async function bodyOf(stream: Readable): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stream) {
    length += (chunk as Buffer).length;
    if (length > MAX_BODY) return undefined;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks, length);
}

/** The model a call names, when its body is JSON that names one. */
function modelOf(body: Buffer): string | undefined {
  try {
    const parsed = JSON.parse(body.toString('utf8')) as { model?: unknown };
    return typeof parsed.model === 'string' ? parsed.model : undefined;
  } catch {
    return undefined;
  }
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
  // The body is read here, as bytes, and goes on as it came; only its model is looked at.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', (_request, payload, done) => done(null, payload));
  /** Calls going now, by run token. */
  const going = new Map<string, number>();
  /** Bodies being read now, of every run. */
  let reading = 0;
  /** When each run's month was last found not spent. */
  const budgetSeen = new Map<string, number>();

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
      const key = token ?? '';
      if ((going.get(key) ?? 0) >= MAX_AT_ONCE) {
        return refuse(
          reply,
          429,
          'rate_limit_error',
          `A run makes at most ${MAX_AT_ONCE} model calls at once`,
        );
      }
      going.set(key, (going.get(key) ?? 0) + 1);
      const done = () => {
        const left = (going.get(key) ?? 1) - 1;
        if (left > 0) going.set(key, left);
        else going.delete(key);
      };
      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          done();
        }
      };
      reply.raw.once('close', release);
      // The run's own month, before its call costs anything more: a spent budget refuses the
      // call, as it refuses a new run (budgets/service.ts).
      if (
        upstream.taskId &&
        Date.now() - (budgetSeen.get(upstream.runId) ?? 0) > BUDGET_CHECKED_MS
      ) {
        try {
          await requireBudget(db, upstream.taskId);
          budgetSeen.delete(upstream.runId);
          makeRoom(budgetSeen);
          budgetSeen.set(upstream.runId, Date.now());
        } catch (error) {
          release();
          if (error instanceof AppError && error.code === 'budget_reached') {
            // 402, not 429: a spent month is not worth the CLI's retries.
            return refuse(reply, 402, 'billing_error', error.message);
          }
          throw error;
        }
      }
      // The body after the limit of calls at once, never before: a run that sends many large
      // bodies at once is refused before they are read.
      let body: Buffer | undefined;
      if (request.method === 'POST') {
        if (reading >= MAX_READING) {
          release();
          return refuse(
            reply,
            429,
            'rate_limit_error',
            'The relay is reading many calls: try again',
          );
        }
        reading += 1;
        try {
          body = await bodyOf(request.body as Readable);
        } finally {
          reading -= 1;
        }
        if (!body) {
          release();
          return refuse(reply, 413, 'request_too_large', 'The request is larger than 32 MB');
        }
        const model = modelOf(body);
        // A call that names no model is the provider's to refuse; one that names another is ours.
        if (upstream.models && model !== undefined && !upstream.models.has(model)) {
          release();
          return refuse(
            reply,
            403,
            'permission_error',
            `This run may call ${[...upstream.models].join(', ')}, not ${model}`,
          );
        }
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
          ...(body && { body: new Uint8Array(body) }),
          signal: hangUp(reply),
        } as RequestInit);
      } catch (error) {
        // How it failed, never with the key: the guard's words and the connection's host.
        const said = error instanceof Error ? error.message : String(error);
        release();
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
      const answer = Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>);
      // A model's answer is counted as it passes: the run is priced by what the provider said.
      const provider = providerOf(upstream.kind, path);
      if (!provider || !response.ok) return reply.send(answer);
      const meter = new Meter(provider);
      const stream = (response.headers.get('content-type') ?? '').includes('text/event-stream');
      const asked = body ? modelOf(body) : undefined;
      let counted_ = false;
      const count = () => {
        if (counted_) return;
        counted_ = true;
        const metered = meter.done(asked);
        if (metered) {
          void recordUsage(db, upstream.runId, metered).catch((error: unknown) =>
            request.log.warn(
              { err: error, runId: upstream.runId },
              'the relay could not count a call',
            ),
          );
        }
      };
      const counted = metering(meter, stream, count);
      // A caller that hangs up before the answer ends is still charged by the provider for what it
      // made: what the relay saw of the answer is counted too, the input at least.
      reply.raw.once('close', count);
      // pipeline, not pipe: a hang-up aborts the provider's answer, whose error pipe leaves
      // unheard, an uncaught exception. Fastify hears the counted stream's own.
      pipeline(answer, counted, () => undefined);
      return reply.send(counted);
    },
  });
};
