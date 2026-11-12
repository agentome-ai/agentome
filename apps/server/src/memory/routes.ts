import type { Db } from '@agentome/db';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { agentFor } from '../agents/service.js';
import { AppError } from '../errors.js';
import { IdParams } from '../protocol.js';
import {
  currentMemory,
  MemoryContent,
  MemoryDocument,
  MemoryPath,
  memoryVersions,
  writeMemory,
} from './service.js';

const BaseVersion = z.int().min(0).optional();

// The person's side of an agent's memory: a grant on the agent opens it,
// and another person's agent is a 404, as everywhere.
export const memoryRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.addHook('onRequest', app.requireSession);

  app.get(
    '/api/agents/:id/memory',
    {
      schema: {
        summary: "The agent's memory documents as they are now",
        params: IdParams,
        response: { 200: z.object({ documents: z.array(MemoryDocument) }) },
      },
    },
    async (request) => {
      const agent = await agentFor(db, request.params.id, request.user.id);
      return { documents: await currentMemory(db, agent.id) };
    },
  );

  app.get(
    '/api/agents/:id/memory/versions',
    {
      schema: {
        summary: 'Every version of one memory document, newest first',
        params: IdParams,
        querystring: z.object({ path: MemoryPath }),
        response: { 200: z.object({ path: z.string(), versions: z.array(MemoryDocument) }) },
      },
    },
    async (request) => {
      const agent = await agentFor(db, request.params.id, request.user.id);
      const { path } = request.query;
      return { path, versions: await memoryVersions(db, agent.id, path) };
    },
  );

  app.put(
    '/api/agents/:id/memory',
    {
      schema: {
        summary: 'Writes a new version of a memory document',
        params: IdParams,
        body: z.object({
          path: MemoryPath,
          content: MemoryContent.min(1, 'Write something, or delete the document'),
          baseVersion: BaseVersion,
        }),
        response: { 200: MemoryDocument },
      },
    },
    async (request) => {
      const agent = await agentFor(db, request.params.id, request.user.id);
      return writeMemory(db, {
        agentId: agent.id,
        ...request.body,
        author: { userId: request.user.id },
      });
    },
  );

  app.post(
    '/api/agents/:id/memory/revert',
    {
      schema: {
        summary: 'Brings back an earlier version of a memory document, as a new version',
        params: IdParams,
        body: z.object({ path: MemoryPath, version: z.int().min(1) }),
        response: { 200: MemoryDocument },
      },
    },
    async (request) => {
      const agent = await agentFor(db, request.params.id, request.user.id);
      const { path, version } = request.body;
      const versions = await memoryVersions(db, agent.id, path);
      const old = versions.find((doc) => doc.version === version);
      if (!old) throw new AppError('not_found', `${path} has no version ${version}`);
      return writeMemory(db, {
        agentId: agent.id,
        path,
        content: old.content,
        author: { userId: request.user.id },
        baseVersion: versions[0]?.version,
      });
    },
  );

  app.delete(
    '/api/agents/:id/memory',
    {
      schema: {
        summary: 'Deletes a memory document; its history stays',
        params: IdParams,
        querystring: z.object({
          path: MemoryPath,
          baseVersion: z.coerce.number().int().min(0).optional(),
        }),
      },
    },
    async (request, reply) => {
      const agent = await agentFor(db, request.params.id, request.user.id);
      const { path, baseVersion } = request.query;
      const [latest] = await memoryVersions(db, agent.id, path);
      if (!latest?.content) throw new AppError('not_found', 'Memory document not found');
      await writeMemory(db, {
        agentId: agent.id,
        path,
        content: '',
        author: { userId: request.user.id },
        baseVersion,
      });
      return reply.code(204).send(null);
    },
  );
};
