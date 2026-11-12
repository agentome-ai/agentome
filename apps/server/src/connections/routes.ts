import type { Db } from '@agentome/db';
import { ConnectionKind } from '@agentome/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Config } from '../config.js';
import { AppError } from '../errors.js';
import { IdParams } from '../protocol.js';
import { pollConnection } from '../jira/poll.js';
import { connectionsKey } from './crypto.js';
import {
  asApiError,
  ConnectionConfig,
  connectionView,
  createConnection,
  deleteConnection,
  listConnections,
  testConnection,
  Token,
  updateConnection,
  webhookSettings,
} from './service.js';

// Connections are the administrator's: they hold the tokens the whole installation acts
// with on a host. Every answer here is without the token.

const Iso = z.iso.datetime();
const Connection = z.object({
  id: z.uuid(),
  project: z.object({ id: z.uuid(), name: z.string() }),
  // One agent's own token, or every agent's of the project (null).
  agent: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  kind: ConnectionKind,
  config: z.record(z.string(), z.string()),
  host: z.string(),
  namespace: z.string(),
  accountLogin: z.string().nullable(),
  lastTestedAt: Iso.nullable(),
  syncedAt: Iso.nullable(),
  syncError: z.string().nullable(),
  createdAt: Iso,
});

export const connectionRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db, config },
) => {
  const key = connectionsKey(config.secretKey);
  // Nothing under /api/connections may sit in a cache: a webhook secret passes through here.
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  app.get(
    '/api/connections',
    {
      onRequest: app.requireAdmin,
      schema: {
        summary: 'Every connection to a code host, newest first',
        response: { 200: z.object({ connections: z.array(Connection) }) },
      },
    },
    async () => ({ connections: await listConnections(db) }),
  );

  app.post(
    '/api/connections',
    {
      onRequest: app.requireAdmin,
      schema: {
        summary: 'Connects a project to a code host with a token',
        body: z.object({
          projectId: z.uuid(),
          // Empty: the project's shared token, for every agent on it.
          agentId: z.uuid().optional(),
          config: ConnectionConfig,
          token: Token,
        }),
        response: { 201: Connection },
      },
    },
    async (request, reply) => {
      const view = await createConnection(db, key, request.user.id, request.body);
      return reply.code(201).send(view);
    },
  );

  app.get(
    '/api/connections/:id',
    {
      onRequest: app.requireAdmin,
      schema: { summary: 'One connection', params: IdParams, response: { 200: Connection } },
    },
    (request) => connectionView(db, request.params.id),
  );

  app.patch(
    '/api/connections/:id',
    {
      onRequest: app.requireAdmin,
      schema: {
        summary: 'Changes where a connection reaches, or replaces its token',
        params: IdParams,
        body: z.object({ config: ConnectionConfig.optional(), token: Token.optional() }),
        response: { 200: Connection },
      },
    },
    (request) => updateConnection(db, key, request.params.id, request.body),
  );

  app.delete(
    '/api/connections/:id',
    {
      onRequest: app.requireAdmin,
      schema: { summary: 'Removes a connection and its token', params: IdParams },
    },
    async (request, reply) => {
      await deleteConnection(db, request.params.id);
      return reply.code(204).send();
    },
  );

  app.post(
    '/api/connections/:id/test',
    {
      onRequest: app.requireAdmin,
      schema: {
        summary: 'Asks the host whose token this is',
        params: IdParams,
        response: { 200: z.object({ login: z.string(), testedAt: Iso }) },
      },
    },
    (request) => testConnection(db, key, request.params.id),
  );

  app.post(
    '/api/connections/:id/sync',
    {
      onRequest: app.requireAdmin,
      schema: {
        summary: 'Polls a Jira connection now, without waiting for the interval',
        params: IdParams,
        response: { 200: z.object({ imported: z.number(), updated: z.number() }) },
      },
    },
    (request) =>
      pollConnection(db, key, request.params.id).catch((error: unknown) => {
        throw error instanceof AppError ? error : asApiError(error);
      }),
  );

  app.get(
    '/api/connections/:id/webhook',
    {
      onRequest: app.requireAdmin,
      schema: {
        summary: "The URL and secret for the host's webhook settings",
        params: IdParams,
        response: { 200: z.object({ url: z.url(), secret: z.string() }) },
      },
    },
    (request) => webhookSettings(db, key, request.params.id, config.publicUrl),
  );
};
