import type { Db } from '@agentome/db';
import { ModelConnectionKind } from '@agentome/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Config } from '../config.js';
import { connectionsKey } from '../connections/crypto.js';
import type { FetchLike } from '../mcp/remote.js';
import { IdParams } from '../protocol.js';
import {
  ApiKey,
  BaseUrl,
  checkModelConnection,
  createModelConnection,
  deleteModelConnection,
  listModelConnections,
  Name,
  updateModelConnection,
} from './connections.js';

// Admin → Models: an admin's, as code-host connections are; no answer carries the key.

const Iso = z.iso.datetime();
export const ModelConnection = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: ModelConnectionKind,
  baseUrl: z.string(),
  models: z.array(z.object({ id: z.string(), engine: z.enum(['claude-code', 'codex']) })),
  checkedAt: Iso.nullable(),
  createdAt: Iso,
});

export const modelConnectionRoutes: FastifyPluginAsyncZod<{
  db: Db;
  config: Config;
  fetchImpl?: FetchLike;
}> = async (app, { db, config, fetchImpl }) => {
  const key = connectionsKey(config.secretKey);
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  app.get(
    '/api/model-connections',
    {
      onRequest: app.requireAdmin,
      schema: {
        summary: 'Every model connection, by name, with the models of its last check',
        response: { 200: z.object({ connections: z.array(ModelConnection) }) },
      },
    },
    async () => ({ connections: await listModelConnections(db) }),
  );

  // For everyone who sets an agent to work on the server: names and models, never an address or
  // a key, which stay an admin's.
  app.get(
    '/api/models',
    {
      onRequest: app.requireSession,
      schema: {
        summary: 'The models agents may work with on the server, by connection',
        response: {
          200: z.object({
            connections: z.array(ModelConnection.pick({ id: true, name: true, models: true })),
          }),
        },
      },
    },
    async () => ({
      connections: (await listModelConnections(db)).map(({ id, name, models }) => ({
        id,
        name,
        models,
      })),
    }),
  );

  app.post(
    '/api/model-connections',
    {
      onRequest: app.requireAdmin,
      schema: {
        summary: 'Adds a model connection once its key lists its models',
        body: z.object({
          name: Name,
          kind: ModelConnectionKind,
          // Anthropic's and OpenAI's own unless given; a gateway's is always given.
          baseUrl: BaseUrl.optional(),
          key: ApiKey,
        }),
        response: { 201: ModelConnection },
      },
    },
    async (request, reply) => {
      const view = await createModelConnection(db, key, request.user.id, request.body, fetchImpl);
      return reply.code(201).send(view);
    },
  );

  app.patch(
    '/api/model-connections/:id',
    {
      onRequest: app.requireAdmin,
      schema: {
        summary: 'Renames a model connection, or changes its address or key',
        params: IdParams,
        body: z.object({
          name: Name.optional(),
          baseUrl: BaseUrl.optional(),
          key: ApiKey.optional(),
        }),
        response: { 200: ModelConnection },
      },
    },
    (request) => updateModelConnection(db, key, request.params.id, request.body, fetchImpl),
  );

  app.post(
    '/api/model-connections/:id/check',
    {
      onRequest: app.requireAdmin,
      schema: {
        summary: 'Reads the models of a connection again',
        params: IdParams,
        response: { 200: ModelConnection },
      },
    },
    (request) => checkModelConnection(db, key, request.params.id, fetchImpl),
  );

  app.delete(
    '/api/model-connections/:id',
    {
      onRequest: app.requireAdmin,
      schema: { summary: 'Removes a model connection and its key', params: IdParams },
    },
    async (request, reply) => {
      await deleteModelConnection(db, request.params.id);
      return reply.code(204).send();
    },
  );
};
