import { tagLog } from '../logs/context.js';
import type { Db } from '@agentome/db';
import { RunStatus } from '@agentome/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireUser } from '../auth.js';
import { AppError, withoutQueryParameters } from '../errors.js';
import {
  EventsBody,
  EventsResponse,
  FinishBody,
  FinishResponse,
  HeartbeatResponse,
  IdParams,
  noStore,
} from '../protocol.js';
import { bearerToken, hashSecret } from '../tokens.js';
import {
  assertReadable,
  EventPage,
  EVENTS_PAGE,
  EventsQuery,
  getRun,
  ListQuery,
  listRuns,
  ReadQuery,
  readEvents,
  RunDetail,
  RunList,
  sseWriter,
  streamRun,
} from './read.js';
import { cancelRun, finishRun, heartbeat, recordEvents } from './service.js';
import type { Jobs } from '../jobs.js';
import { tellJira } from '../jira/push.js';
import { notifyBudget } from '../budgets/service.js';
import { notifyRunEnded } from '../push/service.js';

// A batch may carry a large diff or tool output; Fastify's default of 1 MiB is too tight.
const EVENTS_BODY_LIMIT = 8 * 1024 * 1024;

const ended = () =>
  new AppError('unauthorized', 'This run token is not valid any more: the run has ended.');

export const runRoutes: FastifyPluginAsyncZod<{
  db: Db;
  jobs: Pick<Jobs, 'fileJira' | 'filePush'>;
}> = async (app, { db, jobs }) => {
  app.addHook('onSend', noStore);

  app.post(
    '/api/runs/:id/events',
    {
      bodyLimit: EVENTS_BODY_LIMIT,
      schema: {
        summary: 'Appends a batch of run events; a batch sent again is ignored by seq',
        params: IdParams,
        body: EventsBody,
        response: { 200: EventsResponse },
      },
    },
    async (request) => {
      const token = requireRun(request);
      const result = await recordEvents(db, request.params.id, token, request.body);
      if (!result) throw ended();
      // Only once the run's token opened it: a wrong token files nothing under the run.
      tagLog({ runId: request.params.id });
      return result;
    },
  );

  app.post(
    '/api/runs/:id/heartbeat',
    {
      schema: {
        summary: 'Keeps a run alive and tells the seat whether to stop',
        params: IdParams,
        response: { 200: HeartbeatResponse },
      },
    },
    async (request) => {
      const result = await heartbeat(db, request.params.id, requireRun(request));
      if (!result) throw ended();
      tagLog({ runId: request.params.id });
      return result;
    },
  );

  app.post(
    '/api/runs/:id/finish',
    {
      schema: {
        summary: 'Ends a run with its summary, artifacts and usage',
        params: IdParams,
        body: FinishBody,
        response: { 200: FinishResponse },
      },
    },
    async (request) => {
      const token = requireRun(request);
      const run = await finishRun(db, request.params.id, token, request.body);
      if (!run) throw ended();
      tagLog({ runId: request.params.id });
      await notifyRunEnded(db, request.params.id)
        .then(async (ids) => [...ids, ...(await notifyBudget(db, request.params.id))])
        .then(jobs.filePush)
        .catch((error: unknown) =>
          request.log.warn({ err: error, runId: request.params.id }, 'the run notification failed'),
        );
      if (run.taskId) {
        const job = { step: 'comment', taskId: run.taskId, runId: request.params.id } as const;
        await tellJira(db, jobs.fileJira, job, request.log);
      }
      return { status: run.status };
    },
  );

  app.post(
    '/api/runs/:id/cancel',
    {
      schema: {
        summary: 'Cancels a queued run, or asks the seat to stop a running one',
        params: IdParams,
        response: { 200: z.object({ status: RunStatus, cancelRequested: z.boolean() }) },
      },
    },
    async (request) => cancelRun(db, request.params.id, (await requireUser(db, request)).id),
  );

  // What people read (read.ts). preClose runs before Fastify waits for requests in flight:
  // without it, shutdown would wait for every open stream to end.
  const closing = new AbortController();
  app.addHook('preClose', async () => closing.abort());

  app.get(
    '/api/runs',
    {
      onRequest: app.requireSession,
      schema: {
        summary: 'Runs the signed-in person may read, newest first',
        querystring: ListQuery,
        response: { 200: RunList },
      },
    },
    async (request) => listRuns(db, request.user, request.query),
  );

  app.get(
    '/api/runs/:id',
    {
      onRequest: app.requireSession,
      schema: {
        summary: 'A run with its artifacts and cost',
        params: IdParams,
        querystring: ReadQuery,
        response: { 200: RunDetail },
      },
    },
    async (request) => getRun(db, request.user, request.params.id, request.query.all),
  );

  app.get(
    '/api/runs/:id/events',
    {
      onRequest: app.requireSession,
      schema: {
        summary: `The transcript of a run after a seq, at most ${EVENTS_PAGE} events`,
        params: IdParams,
        querystring: EventsQuery,
        response: { 200: EventPage },
      },
    },
    async (request) => {
      const { id } = request.params;
      await assertReadable(db, request.user, id, request.query.all);
      const events = await readEvents(db, id, request.query.after, EVENTS_PAGE + 1);
      const page = events.slice(0, EVENTS_PAGE);
      const more = events.length > EVENTS_PAGE;
      return { events: page, nextAfter: more ? (page.at(-1)?.seq ?? null) : null };
    },
  );

  app.get(
    '/api/runs/:id/stream',
    {
      onRequest: app.requireSession,
      schema: {
        summary: 'The transcript of a run as server-sent events, live until the run ends',
        params: IdParams,
        querystring: EventsQuery,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      // Refusals before the stream starts, as JSON like any other error.
      await assertReadable(db, request.user, id, request.query.all);
      reply.hijack();
      // What the hooks set stays: a session past half its life sends its new cookie here.
      for (const [name, value] of Object.entries(reply.getHeaders())) {
        if (value !== undefined) reply.raw.setHeader(name, value);
      }
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        // A proxy that buffers responses (nginx) would hold the events back.
        'x-accel-buffering': 'no',
      });
      const hungUp = new AbortController();
      reply.raw.once('close', () => hungUp.abort());
      const signal = AbortSignal.any([hungUp.signal, closing.signal]);
      try {
        await streamRun(db, id, request.query.after, sseWriter(reply.raw, signal), signal);
      } catch (error) {
        // A client that left mid-write is no error; a failed query is. Either way the stream
        // ends, and the client reconnects with the last seq it has.
        if (!signal.aborted)
          request.log.error({ err: withoutQueryParameters(error) }, 'run stream');
      }
      reply.raw.end();
    },
  );
};

/**
 * The hash of the request's run token. Whether it opens the run is checked by the statement
 * that acts on the run (service.ts, `live`), so the check and the change cannot drift apart.
 */
function requireRun(request: FastifyRequest): string {
  const token = bearerToken(request);
  if (!token) throw ended();
  return hashSecret(token);
}
