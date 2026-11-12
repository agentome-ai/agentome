import { agents, agentStatusEnum, type Db, engineEnum, eq, sql } from '@agentome/db';
import { ConnectionKind, GrantLevel, RunStatus } from '@agentome/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { resumeBudget } from '../budgets/service.js';
import {
  agentFor,
  agentView,
  type AgentRow,
  checkServerModel,
  createAgent,
  duplicateAgent,
  listAgents,
  listTemplates,
} from '../agents/service.js';
import { transferAgent } from '../agents/ownership.js';
import { lastMonth, mostReturned, qualityOf } from '../agents/quality.js';
import {
  AgentFile,
  AgentFileV2,
  exportAgent,
  ImportResult,
  importAgent,
} from '../agents/transfer.js';
import { Budget } from '../agents/templates.js';
import { reportsOf, teamForRun, teamOfLead } from '../agents/team.js';
import type { Config } from '../config.js';
import { AppError } from '../errors.js';
import { requireEnterprise, requireRoomFor } from '../license/service.js';
import { remoteToolName, serversOf } from '../library/mcp.js';
import { skillsOf } from '../library/skills.js';
import { setPolicy } from '../mcp/policy.js';
import { ASSIGN_TASK, TOOLS } from '../mcp/tools.js';
import { IdParams, LaunchPackage, RunLimits } from '../protocol.js';
import { profileFor, skillsSection } from '../runs/launch.js';
import { cancelQueuedRuns, type Tx } from '../runs/service.js';
import { Name } from './users.js';

const Handed = z.object({ id: z.uuid(), name: z.string() });
/** What a transfer moved, and to whom. */
export const Transferred = z.object({ transferred: z.array(Handed), to: Handed });

const Iso = z.iso.datetime();
const RoleTitle = z.string().trim().max(200);
// It reaches Claude Code as the value of --model, so it can never look like a flag. A gateway
// names a model with its provider in front: anthropic/claude-sonnet-4.5.
const ModelPref = z
  .string()
  .trim()
  .max(100)
  .regex(/^[a-z0-9][\w.:/[\]-]*$/i, 'Use a model name such as claude-sonnet-5-5');
const Flag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const Policy = z.enum(['allow', 'ask', 'deny']);

const AgentSummary = z.object({
  id: z.uuid(),
  name: z.string(),
  roleTitle: z.string(),
  status: z.enum(agentStatusEnum.enumValues),
  owner: z.object({ id: z.uuid(), name: z.string() }),
  lastRun: z
    .object({
      id: z.uuid(),
      taskId: z.uuid().nullable(),
      status: RunStatus,
      at: Iso,
      /** The run's task and its project's name, in the list; null on an agent's own page. */
      task: z.object({ title: z.string(), project: z.string().nullable() }).nullable(),
    })
    .nullable(),
  createdAt: Iso,
});

// The list only: what each agent did in the last seven days, priced runs only.
const AgentListItem = AgentSummary.extend({
  modelPref: z.string().nullable(),
  week: z.object({
    runs: z.number().int(),
    usd: z.string().nullable(),
    ended: z.number().int(),
    done: z.number().int(),
    medianSeconds: z.number().int().nullable(),
    daily: z.array(z.number().int()).length(7),
  }),
  // The last 30 days, to compare agents: accepted of the tasks handed over, and the
  // median cost of a task handed over.
  month: z.object({
    accepted: z.number().int(),
    handed: z.number().int(),
    medianUsd: z.string().nullable(),
  }),
});

const Count = z.number().int();
const QualityNumbers = z.object({
  tasks: Count,
  handed: Count,
  accepted: Count,
  firstTime: Count,
  changeRequests: z.object({ merged: Count, closed: Count, open: Count }),
  returns: z.object({ total: Count, tasks: Count, person: Count, ci: Count, review: Count }),
  usd: z.object({ median: z.string().nullable(), total: z.string().nullable() }),
  seconds: z.object({ work: Count.nullable(), toReview: Count.nullable() }),
  runs: z.object({ ended: Count, failed: Count, limited: Count }),
});
const Quality = QualityNumbers.extend({
  since: Iso,
  mostReturned: z.array(
    z.object({ id: z.uuid(), title: z.string(), returns: Count, usd: z.string().nullable() }),
  ),
});

const AgentView = AgentSummary.extend({
  instructions: z.string(),
  engine: z.enum(engineEnum.enumValues),
  modelPref: z.string().nullable(),
  // Where its runs go; on a server, the connection its model and key come from.
  runsOn: z.enum(['laptop', 'server']),
  modelConnection: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  serverShell: z.boolean(),
  budget: Budget.nullable(),
  // What a run gets where the budget sets no limit of its own.
  runDefaults: RunLimits,
  copiedFromAgentId: z.uuid().nullable(),
  template: z.object({ id: z.uuid(), name: z.string(), version: z.int() }).nullable(),
  seat: z
    .object({ id: z.uuid(), name: z.string(), busy: z.boolean(), lastSeenAt: Iso.nullable() })
    .nullable(),
  people: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      level: GrantLevel,
      /** Set on the owner whose agent is with someone for a time: the day it comes back. */
      validFrom: Iso.nullable(),
      /** Set on the person who has the agent until a day. */
      validUntil: Iso.nullable(),
    }),
  ),
  projects: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      hosts: z.array(ConnectionKind),
      repositories: z.array(z.string()),
    }),
  ),
  tools: z.array(
    z.object({
      connector: z.string(),
      name: z.string(),
      title: z.string(),
      policy: Policy,
    }),
  ),
  skills: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      version: z.string(),
      privateTo: z.string().optional(),
    }),
  ),
  // The library's MCP servers the agent was given; their tools are in `tools` under each name.
  mcpServers: z.array(
    z.object({ id: z.uuid(), name: z.string(), privateTo: z.string().optional() }),
  ),
  memoryDocuments: z.int(),
  // This calendar month against the monthly limit: new runs stop once it is reached,
  // unless the owner let the agent go on for the month.
  spend: z.object({
    usdThisMonth: z.number(),
    limit: z.number().nullable(),
    reached: z.boolean(),
    resumed: z.boolean(),
  }),
});

const Template = z.object({
  id: z.uuid(),
  name: z.string(),
  version: z.int(),
  description: z.string(),
  roleTitle: z.string(),
  modelPref: z.string().nullable(),
});

const Changes = z
  .object({
    name: Name,
    roleTitle: RoleTitle,
    instructions: z.string().max(100_000),
    modelPref: ModelPref.nullable(),
    engine: z.enum(engineEnum.enumValues),
    // Replaces the whole budget; an empty one means the platform defaults.
    budget: Budget.nullable(),
    runsOn: z.enum(['laptop', 'server']),
    modelConnectionId: z.uuid().nullable(),
    // An admin's to allow: with a shell, a server run could read its connection's key.
    serverShell: z.boolean(),
  })
  .partial();

/** A file name for the export: the agent's name in plain letters. */
const fileName = (name: string) =>
  `${
    name
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'agent'
  }.agent.json`;

// Every route needs a session and a grant on the agent; another person's agent is a 404.
export const agentRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db, config },
) => {
  const view = (agent: AgentRow) => agentView(db, agent, config.runLimits);
  const anyAgent = async (id: string) => {
    const [row] = await db.select().from(agents).where(eq(agents.id, id));
    if (!row) throw new AppError('not_found', 'Agent not found');
    return row;
  };
  // Changes the agent, and with `also` whatever goes with the change, in one transaction.
  const update = async (id: string, set: Partial<AgentRow>, also?: (tx: Tx) => Promise<void>) => {
    const agent = await db.transaction(async (tx) => {
      const [row] = await tx.update(agents).set(set).where(eq(agents.id, id)).returning();
      if (row && also) await also(tx);
      return row;
    });
    if (!agent) throw new AppError('not_found', 'Agent not found');
    return view(agent);
  };
  app.addHook('onRequest', app.requireSession);

  app.get(
    '/api/templates',
    {
      schema: {
        summary: "The platform's role templates",
        response: { 200: z.object({ templates: z.array(Template) }) },
      },
    },
    async () => ({ templates: await listTemplates(db) }),
  );

  app.get(
    '/api/agents',
    {
      schema: {
        summary: 'Agents the person has a grant on; every agent with all=true, for admins',
        querystring: z.object({ archived: Flag, all: Flag }),
        response: { 200: z.object({ agents: z.array(AgentListItem) }) },
      },
    },
    async (request) => {
      const { archived, all } = request.query;
      if (all && request.user.role !== 'admin') {
        throw new AppError('forbidden', 'Only admins can list every agent');
      }
      const list = await listAgents(db, { userId: request.user.id, archived, all });
      const month = await qualityOf(
        db,
        list.map((agent) => agent.id),
        lastMonth(),
      );
      return {
        agents: list.map((agent) => {
          const numbers = month.get(agent.id);
          return {
            ...agent,
            month: {
              accepted: numbers?.accepted ?? 0,
              handed: numbers?.handed ?? 0,
              medianUsd: numbers?.usd.median ?? null,
            },
          };
        }),
      };
    },
  );

  app.post(
    '/api/agents',
    {
      schema: {
        summary: 'Creates an agent, blank or from a role template, owned by the person',
        body: z.object({
          name: Name,
          roleTitle: RoleTitle.optional(),
          templateId: z.uuid().optional(),
        }),
        response: { 201: AgentView },
      },
    },
    async (request, reply) => {
      await requireRoomFor(db, 'agents');
      return reply.code(201).send(await view(await createAgent(db, request.user.id, request.body)));
    },
  );

  app.get(
    '/api/agents/:id',
    {
      schema: {
        summary: 'Everything the editor and the agent sheet show',
        params: IdParams,
        response: { 200: AgentView },
      },
    },
    async (request) => view(await agentFor(db, request.params.id, request.user.id)),
  );

  app.get(
    '/api/agents/:id/quality',
    {
      schema: {
        summary:
          "The agent's last 30 days: tasks accepted, tasks that came back, merged change requests, cost and time per task, failed runs",
        params: IdParams,
        response: { 200: Quality },
      },
    },
    async (request) => {
      const agent = await agentFor(db, request.params.id, request.user.id);
      await requireEnterprise(db, 'analytics');
      const month = lastMonth();
      const [counted, returned] = await Promise.all([
        qualityOf(db, [agent.id], month),
        mostReturned(db, agent.id, month),
      ]);
      const numbers = counted.get(agent.id);
      if (!numbers) throw new AppError('internal', 'The quality of the agent was not counted');
      return { ...numbers, since: month.from.toISOString(), mostReturned: returned };
    },
  );

  app.patch(
    '/api/agents/:id',
    {
      schema: {
        summary: 'Changes the identity, instructions, model or budget',
        params: IdParams,
        body: Changes,
        response: { 200: AgentView },
      },
    },
    async (request) => {
      const { budget, ...changes } = request.body;
      const admin = request.user.role === 'admin';
      if (changes.serverShell !== undefined && !admin) {
        throw new AppError('forbidden', 'Only an admin allows a shell on the server');
      }
      // The shell is an admin's to allow on anyone's agent, as the server seats are an admin's.
      const onlyShell = Object.keys(request.body).every((key) => key === 'serverShell');
      const agent =
        admin && onlyShell
          ? await anyAgent(request.params.id)
          : await agentFor(db, request.params.id, request.user.id);
      if (changes.runsOn === 'server' && agent.runsOn !== 'server') {
        await requireEnterprise(db, 'server_agents');
      }
      if (budget?.usdPerMonth != null) await requireEnterprise(db, 'budgets');
      await checkServerModel(db, { ...agent, ...changes });
      // An admin allowed the shell knowing which key it exposes: another connection,
      // or another place to run, needs an admin's say again.
      const moved =
        (changes.modelConnectionId !== undefined &&
          changes.modelConnectionId !== agent.modelConnectionId) ||
        (changes.runsOn !== undefined && changes.runsOn !== agent.runsOn);
      const shell = moved && !admin && agent.serverShell ? { serverShell: false } : {};
      // An empty budget is no budget: the platform defaults apply.
      const set =
        budget === undefined
          ? { ...changes, ...shell }
          : { ...changes, ...shell, budget: budget && Object.keys(budget).length ? budget : null };
      return Object.keys(set).length ? update(agent.id, set) : view(agent);
    },
  );

  app.post(
    '/api/agents/:id/budget/resume',
    {
      schema: {
        summary: 'Lets the agent go on past its monthly limit until the month ends',
        params: IdParams,
        response: { 200: AgentView },
      },
    },
    async (request) => {
      const agent = await agentFor(db, request.params.id, request.user.id);
      await resumeBudget(db, agent.id);
      return view(await agentFor(db, agent.id, request.user.id));
    },
  );

  app.post(
    '/api/agents/:id/duplicate',
    {
      schema: {
        summary: 'Copies the configuration into a new agent of the person; grants stay behind',
        params: IdParams,
        response: { 201: AgentView },
      },
    },
    async (request, reply) => {
      const source = await agentFor(db, request.params.id, request.user.id);
      await requireRoomFor(db, 'agents');
      return reply.code(201).send(await view(await duplicateAgent(db, source, request.user.id)));
    },
  );

  app.post(
    '/api/agents/:id/transfer',
    {
      schema: {
        summary:
          "Transfers the agent, and a lead's whole team with it, to another person: for good, or until a day it comes back; its owner or an admin",
        params: IdParams,
        body: z.object({ to: z.uuid(), until: z.iso.datetime({ offset: true }).optional() }),
        response: { 200: Transferred.extend({ until: Iso.nullable() }) },
      },
    },
    async (request) => {
      const { id } = request.params;
      // An admin holds no grant on another person's agent, and transfers it all the same: that
      // is how an agent leaves someone who is away or gone.
      const [any] =
        request.user.role === 'admin'
          ? await db.select().from(agents).where(eq(agents.id, id))
          : [];
      const agent = any ?? (await agentFor(db, id, request.user.id));
      const { to, until } = request.body;
      const done = await transferAgent(db, agent, {
        to,
        until: until ? new Date(until) : undefined,
      });
      return { ...done, until: done.until?.toISOString() ?? null };
    },
  );

  app.get(
    '/api/agents/:id/export',
    {
      schema: {
        summary: 'The configuration as a JSON file, without ids, grants or secrets',
        params: IdParams,
        response: { 200: AgentFileV2 },
      },
    },
    async (request, reply) => {
      const agent = await agentFor(db, request.params.id, request.user.id);
      reply.header('content-disposition', `attachment; filename="${fileName(agent.name)}"`);
      return exportAgent(db, agent);
    },
  );

  app.post(
    '/api/agents/import',
    {
      // Fifty skills of up to 100 000 characters each fit.
      bodyLimit: 6 * 1024 * 1024,
      schema: {
        summary: 'A new agent of the person from an agent file; its skills join their library',
        body: AgentFile,
        response: { 201: ImportResult },
      },
    },
    async (request, reply) => {
      await requireRoomFor(db, 'agents');
      if (request.body.agent.budget?.usdPerMonth != null) await requireEnterprise(db, 'budgets');
      return reply.code(201).send(await importAgent(db, request.user.id, request.body));
    },
  );

  for (const [action, status] of [
    ['archive', 'archived'],
    ['unarchive', 'active'],
  ] as const) {
    app.post(
      `/api/agents/:id/${action}`,
      {
        schema: {
          summary:
            status === 'archived'
              ? 'Archives the agent: its queued runs are cancelled and it takes no more'
              : 'Brings an archived agent back',
          params: IdParams,
          response: { 200: AgentView },
        },
      },
      async (request) => {
        const agent = await agentFor(db, request.params.id, request.user.id);
        if (status === 'active' && agent.status !== 'active') await requireRoomFor(db, 'agents');
        const cancel = (tx: Tx) => cancelQueuedRuns(tx, agent.id);
        return update(agent.id, { status }, status === 'archived' ? cancel : undefined);
      },
    );
  }

  app.put(
    '/api/agents/:id/tools/:name',
    {
      schema: {
        summary: 'Sets the policy of one gateway tool: allow, ask the owner, or deny',
        params: IdParams.extend({ name: z.string().max(200) }),
        body: z.object({ policy: Policy }),
        response: { 200: AgentView },
      },
    },
    async (request) => {
      const agent = await agentFor(db, request.params.id, request.user.id);
      const { name } = request.params;
      // A built-in tool, or one of the agent's library servers' as it listed them.
      const known = [
        ...TOOLS.map((tool) => tool.name),
        ...(await serversOf(db, agent.tools)).flatMap((server) =>
          server.tools.map((tool) => remoteToolName(server.name, tool.name)),
        ),
      ];
      if (await teamOfLead(db, agent.id)) known.push('team_step');
      if ((await reportsOf(db, agent.id)).length > 0) known.push(ASSIGN_TASK);
      if (!known.includes(name))
        throw new AppError('validation_failed', `This agent has no tool ${name}`);
      const row = await setPolicy(db, agent.id, name, request.body.policy);
      if (!row) throw new AppError('not_found', 'Agent not found');
      return view(row);
    },
  );

  app.put(
    '/api/agents/:id/tools',
    {
      schema: {
        summary:
          'Auto or manual: every gateway tool of the agent allowed, or asking its owner; the ones denied stay denied',
        params: IdParams,
        body: z.object({ policy: z.enum(['allow', 'ask']) }),
        response: { 200: AgentView },
      },
    },
    async (request) => {
      const agent = await agentFor(db, request.params.id, request.user.id);
      // The team's assignment is the team's mode, not a tool of the agent's own.
      const names = [
        ...TOOLS.map((tool) => tool.name),
        ...(await serversOf(db, agent.tools)).flatMap((server) =>
          server.tools.map((tool) => remoteToolName(server.name, tool.name)),
        ),
      ];
      const entries = JSON.stringify(names.map((name) => ({ name, policy: request.body.policy })));
      // One statement: the server entries and the denials stay, every other policy is replaced.
      const [row] = await db
        .update(agents)
        .set({
          tools: sql`(select coalesce(jsonb_agg(e), '[]'::jsonb) from jsonb_array_elements(${agents.tools}) e where e->>'name' is null or e->>'policy' = 'deny' or e->>'name' = 'team_step')
            || (select coalesce(jsonb_agg(n), '[]'::jsonb) from jsonb_array_elements(${entries}::jsonb) n
                where not exists (select 1 from jsonb_array_elements(${agents.tools}) d where d->>'name' = n->>'name' and d->>'policy' = 'deny'))`,
        })
        .where(eq(agents.id, agent.id))
        .returning();
      if (!row) throw new AppError('not_found', 'Agent not found');
      return view(row);
    },
  );

  app.get(
    '/api/agents/:id/workspace-preview',
    {
      schema: {
        summary: 'The CLAUDE.md and settings a run of the agent gets, as it is saved',
        params: IdParams,
        response: { 200: LaunchPackage.shape.workspace.shape.profile },
      },
    },
    async (request) => {
      const agent = await agentFor(db, request.params.id, request.user.id);
      const profile = profileFor(agent, config.publicUrl, agent.runsOn === 'server');
      // As the claim adds them (runs/service.ts); the team's tokens are made and dropped here.
      const team = await teamForRun(db, agent.id);
      const skills = await skillsOf(db, agent.skills);
      return {
        ...profile,
        claudeMd: profile.claudeMd + skillsSection(skills) + (team?.section ?? ''),
      };
    },
  );
};
