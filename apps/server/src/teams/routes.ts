import type { Db } from '@agentome/db';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { IdParams } from '../protocol.js';
import {
  createTeam,
  deleteTeam,
  duplicateTeam,
  listTeams,
  NewTeam,
  TeamChanges,
  teamFor,
  TeamSummary,
  updateTeam,
} from './service.js';
import { requireRoomFor } from '../license/service.js';

/** /api/teams: teams of agents, put together, changed and copied whole. */
export const teamRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.addHook('onRequest', app.requireSession);

  app.get(
    '/api/teams',
    {
      schema: {
        summary: 'Lists the teams whose leads the person may see',
        response: { 200: z.object({ teams: z.array(TeamSummary) }) },
      },
    },
    async (request) => ({ teams: await listTeams(db, request.user.id) }),
  );

  app.post(
    '/api/teams',
    {
      schema: {
        summary:
          "Creates a team: its lead, whose runs it works in, and members from the lead's owner's active agents; an agent leads one team at most",
        body: NewTeam,
        response: { 201: TeamSummary },
      },
    },
    async (request, reply) => {
      await requireRoomFor(db, 'teams');
      return reply.code(201).send(await createTeam(db, request.user.id, request.body));
    },
  );

  app.get(
    '/api/teams/:id',
    { schema: { summary: 'One team', params: IdParams, response: { 200: TeamSummary } } },
    async (request) => teamFor(db, request.params.id, request.user.id),
  );

  app.patch(
    '/api/teams/:id',
    {
      schema: {
        summary:
          'Renames a team, or gives it another lead, mode, steps or members (all of them, in order: add an agent by sending the list with it)',
        params: IdParams,
        body: TeamChanges,
        response: { 200: TeamSummary },
      },
    },
    async (request) => updateTeam(db, request.params.id, request.user.id, request.body),
  );

  app.delete(
    '/api/teams/:id',
    {
      schema: {
        summary: 'Removes a team; its agents stay',
        params: IdParams,
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      await deleteTeam(db, request.params.id, request.user.id);
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/api/teams/:id/duplicate',
    {
      schema: {
        summary:
          'Copies a team, named "<name> (copy)", with copies of its agents owned by the person copying: their configuration, not their memory, tasks or runs',
        params: IdParams,
        response: { 201: TeamSummary },
      },
    },
    async (request, reply) => {
      await requireRoomFor(db, 'teams');
      return reply.code(201).send(await duplicateTeam(db, request.params.id, request.user));
    },
  );
};
