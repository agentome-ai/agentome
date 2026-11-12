import type { Db } from '@agentome/db';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { LEVELS, type LevelName, listLogs, traceOf } from './service.js';

const LevelName = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
const Entry = z.object({
  id: z.number(),
  at: z.iso.datetime(),
  level: z.number(),
  source: z.enum(['server', 'worker']),
  message: z.string(),
  context: z.unknown().nullable(),
  traceId: z.string().nullable(),
  runId: z.uuid().nullable(),
  seatId: z.uuid().nullable(),
  span: z.string().nullable(),
  durationMs: z.number().nullable(),
});

/** Admin → Logs: the server's and the workers' lines, a month of them, and traces. */
export const logRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.get(
    '/api/admin/logs',
    {
      onRequest: app.requireAdmin,
      schema: {
        summary:
          'Log lines of the server and the workers, newest first: from a level up, by source, run, trace or text',
        querystring: z.object({
          level: LevelName.optional(),
          source: z.enum(['server', 'worker']).optional(),
          run: z.uuid().optional(),
          trace: z.string().max(64).optional(),
          q: z.string().max(200).optional(),
          before: z.coerce.number().int().positive().optional(),
          after: z.coerce.number().int().nonnegative().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        }),
        response: { 200: z.object({ entries: z.array(Entry), nextBefore: z.number().nullable() }) },
      },
    },
    async (request) => {
      const { level, ...query } = request.query;
      return listLogs(db, { ...query, level: level ? LEVELS[level] : undefined });
    },
  );

  app.get(
    '/api/admin/logs/traces/:id',
    {
      onRequest: app.requireAdmin,
      schema: {
        summary: "A trace's lines in order: the request, the calls it made out and what it logged",
        params: z.object({ id: z.string().min(1).max(64) }),
        response: { 200: z.object({ traceId: z.string(), entries: z.array(Entry) }) },
      },
    },
    async (request) => traceOf(db, request.params.id),
  );

  app.get(
    '/api/admin/logs/level',
    {
      onRequest: app.requireAdmin,
      schema: {
        summary: "The server's log level now",
        response: { 200: z.object({ level: LevelName }) },
      },
    },
    () => ({ level: levelNow(app.log.level) }),
  );

  app.put(
    '/api/admin/logs/level',
    {
      onRequest: app.requireAdmin,
      schema: {
        summary:
          "Sets the server's log level until it restarts, when AGENTOME_LOG_LEVEL holds again",
        body: z.object({ level: LevelName }),
        response: { 200: z.object({ level: LevelName }) },
      },
    },
    (request) => {
      app.log.level = request.body.level;
      request.log.warn({ to: request.body.level }, 'log level changed');
      return { level: levelNow(app.log.level) };
    },
  );
};

const levelNow = (level: string): LevelName => (level in LEVELS ? (level as LevelName) : 'info');
