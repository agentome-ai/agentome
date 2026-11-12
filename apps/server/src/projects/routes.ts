import { agentStatusEnum, type Db, projectIntakeEnum } from '@agentome/db';
import { ConnectionKind, RunStatus } from '@agentome/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { IdParams } from '../protocol.js';
import { repositoryProblem } from '../routes/tasks.js';
import { Name, Text } from '../routes/validators.js';
import { agentFor } from '../agents/service.js';
import {
  assignAgent,
  createProject,
  deleteProject,
  listProjects,
  projectView,
  requireOwnTeam,
  requireProjectEditor,
  unassignAgent,
  updateProject,
} from './service.js';
import { requireEnterprise } from '../license/service.js';

const Iso = z.iso.datetime();
const Markdown = Text(100_000);
// The same URL twice, or once with a slash at the end, is one repository.
const Repositories = z
  .array(
    z
      .url({ protocol: /^https?$/ })
      .max(500)
      .transform((url) => url.replace(/\/+$/, ''))
      .refine((url) => !repositoryProblem(url), {
        message: 'Remove the user name and password from the URL',
      }),
  )
  .max(20)
  .transform((urls) => [...new Set(urls)]);
const ProjectSummary = z.object({
  id: z.uuid(),
  name: z.string(),
  agentCount: z.int(),
  connectionCount: z.int(),
  createdBy: z.uuid(),
  createdAt: Iso,
});
// The week of the runs of the project's tasks: the dashboard's card and the project's page.
const ProjectWeek = z.object({
  runs: z.int(),
  ended: z.int(),
  done: z.int(),
  medianSeconds: z.int().nullable(),
  usd: z.string().nullable(),
  daily: z.array(z.int()),
});
const ProjectListItem = ProjectSummary.extend({
  team: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  week: ProjectWeek,
  lastRun: z
    .object({
      id: z.uuid(),
      status: RunStatus,
      at: Iso,
      agent: z.object({ id: z.uuid(), name: z.string() }),
      task: z.object({ id: z.uuid(), title: z.string() }),
    })
    .nullable(),
});
const ProjectView = ProjectSummary.extend({
  // Who takes the project's tasks, and whether its lead takes a new one at once.
  team: z
    .object({ id: z.uuid(), name: z.string(), lead: z.object({ id: z.uuid(), name: z.string() }) })
    .nullable(),
  intake: z.enum(projectIntakeEnum.enumValues),
  budget: z.object({ usdPerMonth: z.number().nullable(), usdThisMonth: z.number() }),
  // What its code hosts' webhooks start.
  triggers: z.object({
    onPipelineFailed: z.boolean(),
    onReview: z.boolean(),
    reviewer: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  }),
  description: z.string(),
  goals: z.string(),
  // The first is the main one: what a task gets when nobody names another.
  repositories: z.array(z.string()),
  agents: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      roleTitle: z.string(),
      status: z.enum(agentStatusEnum.enumValues),
    }),
  ),
  connections: z.array(
    z.object({
      id: z.uuid(),
      kind: ConnectionKind,
      host: z.string(),
      namespace: z.string(),
      accountLogin: z.string().nullable(),
      // Whose token it is: one agent's, or every agent's of the project (null).
      agentName: z.string().nullable(),
    }),
  ),
  week: ProjectWeek,
});
const Membership = z.object({ id: z.uuid(), agentId: z.uuid() });

export const projectRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.get(
    '/api/projects',
    {
      onRequest: app.requireSession,
      schema: {
        summary: 'Every project, newest first',
        response: { 200: z.object({ projects: z.array(ProjectListItem) }) },
      },
    },
    async () => ({ projects: await listProjects(db) }),
  );

  app.post(
    '/api/projects',
    {
      onRequest: app.requireSession,
      schema: {
        summary: 'Creates a project',
        body: z.object({
          name: Name,
          description: Markdown.default(''),
          goals: Markdown.default(''),
        }),
        response: { 201: ProjectView },
      },
    },
    async (request, reply) => {
      const view = await createProject(db, request.user.id, request.body);
      return reply.code(201).send(view);
    },
  );

  app.get(
    '/api/projects/:id',
    {
      onRequest: app.requireSession,
      schema: {
        summary: 'A project with its agents and connections',
        params: IdParams,
        response: { 200: ProjectView },
      },
    },
    (request) => projectView(db, request.params.id),
  );

  app.patch(
    '/api/projects/:id',
    {
      onRequest: app.requireSession,
      schema: {
        summary:
          "Changes a project. repositories replaces the list, main one first; each must fall under a code-host connection of the project. teamId names the team that takes the project's tasks (its agents join the project); intake auto has its lead take a new task at once",
        params: IdParams,
        body: z.object({
          name: Name.optional(),
          description: Markdown.optional(),
          goals: Markdown.optional(),
          repositories: Repositories.optional(),
          teamId: z.uuid().nullable().optional(),
          intake: z.enum(projectIntakeEnum.enumValues).optional(),
          // What the runs of its tasks may cost in a calendar month; null is no limit.
          usdPerMonth: z.number().positive().max(1_000_000).nullable().optional(),
          // A failed pipeline or a review of an agent's change request runs its task again;
          // reviewerAgentId reviews the change requests people open.
          onPipelineFailed: z.boolean().optional(),
          onReview: z.boolean().optional(),
          reviewerAgentId: z.uuid().nullable().optional(),
        }),
        response: { 200: ProjectView },
      },
    },
    async (request) => {
      await requireProjectEditor(db, request.params.id, request.user);
      if (request.body.usdPerMonth != null) await requireEnterprise(db, 'budgets');
      if (request.body.teamId) await requireOwnTeam(db, request.body.teamId, request.user);
      // A person names only their own agent as the reviewer, as they put only their own on it.
      if (request.body.reviewerAgentId && request.user.role !== 'admin') {
        await agentFor(db, request.body.reviewerAgentId, request.user.id);
      }
      return updateProject(db, request.params.id, request.body);
    },
  );

  // A project is how an agent reaches the installation's host tokens: a person puts
  // only their own agents, and only on a project of their own, whose connections an admin made.
  app.delete(
    '/api/projects/:id',
    {
      onRequest: app.requireSession,
      schema: {
        summary:
          'Deletes a project with its connections, knowledge and assignments; its tasks stay',
        params: IdParams,
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      await requireProjectEditor(db, request.params.id, request.user);
      await deleteProject(db, request.params.id);
      return reply.code(204).send(null);
    },
  );

  app.put(
    '/api/projects/:id/agents/:agentId',
    {
      onRequest: app.requireSession,
      schema: { summary: 'Assigns an agent to a project', params: Membership },
    },
    async (request, reply) => {
      const { id, agentId } = request.params;
      await requireProjectEditor(db, id, request.user);
      if (request.user.role !== 'admin') await agentFor(db, agentId, request.user.id);
      await assignAgent(db, id, agentId);
      return reply.code(204).send();
    },
  );

  app.delete(
    '/api/projects/:id/agents/:agentId',
    {
      onRequest: app.requireSession,
      schema: { summary: 'Takes an agent off a project', params: Membership },
    },
    async (request, reply) => {
      const { id, agentId } = request.params;
      await requireProjectEditor(db, id, request.user);
      await unassignAgent(db, id, agentId);
      return reply.code(204).send();
    },
  );
};
