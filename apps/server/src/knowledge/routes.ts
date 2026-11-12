import type { Db } from '@agentome/db';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Config } from '../config.js';
import { connectionsKey } from '../connections/crypto.js';
import { IdParams } from '../protocol.js';
import {
  createSource,
  deleteSource,
  listSources,
  SourceConfig,
  sourceView,
  syncSource,
} from './service.js';

const Source = z.object({
  id: z.uuid(),
  repository: z.string(),
  paths: z.array(z.string()),
  lastSyncAt: z.iso.datetime().nullable(),
  // Why the last sync failed, in the host's or our words; null after one that worked.
  lastSyncError: z.string().nullable(),
  documents: z.int(),
});

// A project's knowledge sources: anyone signed in reads them, as they read the
// project; an administrator adds, syncs and removes them, since they read through its tokens.
export const knowledgeRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db, config },
) => {
  const key = connectionsKey(config.secretKey);

  app.get(
    '/api/projects/:id/knowledge',
    {
      onRequest: app.requireSession,
      schema: {
        summary: "A project's knowledge sources, with when each last synced",
        params: IdParams,
        response: { 200: z.object({ sources: z.array(Source) }) },
      },
    },
    async (request) => ({ sources: await listSources(db, request.params.id) }),
  );

  app.post(
    '/api/projects/:id/knowledge',
    {
      onRequest: app.requireAdmin,
      schema: {
        summary: 'Adds markdown of a connected repository to the project, and syncs it',
        params: IdParams,
        body: SourceConfig,
        response: { 201: Source },
      },
    },
    async (request, reply) =>
      reply.code(201).send(await createSource(db, key, request.params.id, request.body)),
  );

  app.post(
    '/api/knowledge/:id/sync',
    {
      onRequest: app.requireAdmin,
      schema: {
        summary: 'Syncs a source now; a failure is in the answer, as lastSyncError',
        params: IdParams,
        response: { 200: Source },
      },
    },
    async (request) => {
      await syncSource(db, key, request.params.id);
      return sourceView(db, request.params.id);
    },
  );

  app.delete(
    '/api/knowledge/:id',
    {
      onRequest: app.requireAdmin,
      schema: { summary: 'Removes a source and its documents', params: IdParams },
    },
    async (request, reply) => {
      await deleteSource(db, request.params.id);
      return reply.code(204).send();
    },
  );
};
