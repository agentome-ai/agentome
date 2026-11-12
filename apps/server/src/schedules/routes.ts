import type { Db } from '@agentome/db';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { agentFor } from '../agents/service.js';
import {
  createSchedule,
  deleteSchedule,
  listSchedules,
  ScheduleInput,
  updateSchedule,
} from './service.js';

// An agent's schedules, for whoever may edit the agent.

const Schedule = z.object({
  id: z.uuid(),
  title: z.string(),
  body: z.string(),
  projectId: z.uuid().nullable(),
  repository: z.string().nullable(),
  days: z.array(z.int()),
  time: z.string(),
  timeZone: z.string(),
  enabled: z.boolean(),
  when: z.string(),
  lastRunAt: z.iso.datetime().nullable(),
});
const AgentParams = z.object({ id: z.uuid() });
const ScheduleParams = z.object({ id: z.uuid(), scheduleId: z.uuid() });

export const scheduleRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.addHook('onRequest', app.requireSession);

  app.get(
    '/api/agents/:id/schedules',
    {
      schema: {
        summary: "The agent's recurring tasks",
        params: AgentParams,
        response: { 200: z.object({ schedules: z.array(Schedule) }) },
      },
    },
    async (request) => {
      const agent = await agentFor(db, request.params.id, request.user.id);
      return { schedules: await listSchedules(db, agent.id) };
    },
  );

  app.post(
    '/api/agents/:id/schedules',
    {
      schema: {
        summary:
          'Adds a recurring task: on these days (0 is Sunday) at this HH:MM in this time zone, a task is made and run',
        params: AgentParams,
        body: ScheduleInput,
        response: { 201: Schedule },
      },
    },
    async (request, reply) => {
      const agent = await agentFor(db, request.params.id, request.user.id);
      return reply
        .code(201)
        .send(await createSchedule(db, agent.id, request.user.id, request.body));
    },
  );

  app.patch(
    '/api/agents/:id/schedules/:scheduleId',
    {
      schema: {
        summary: 'Changes a recurring task, or turns it off and on',
        params: ScheduleParams,
        body: ScheduleInput.partial(),
        response: { 200: Schedule },
      },
    },
    async (request) => {
      const agent = await agentFor(db, request.params.id, request.user.id);
      return updateSchedule(db, agent.id, request.params.scheduleId, request.body);
    },
  );

  app.delete(
    '/api/agents/:id/schedules/:scheduleId',
    {
      schema: { summary: 'Removes a recurring task', params: ScheduleParams },
    },
    async (request, reply) => {
      const agent = await agentFor(db, request.params.id, request.user.id);
      await deleteSchedule(db, agent.id, request.params.scheduleId);
      return reply.code(204).send();
    },
  );
};
