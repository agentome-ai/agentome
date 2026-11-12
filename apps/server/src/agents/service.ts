import {
  agentGrants,
  agents,
  and,
  type AnyColumn,
  asc,
  catalogItems,
  costEvents,
  type Db,
  desc,
  eq,
  inArray,
  isNull,
  modelConnections,
  projectAgents,
  projectConnections,
  projects,
  runs,
  seats,
  type SQL,
  sql,
  tasks,
  users,
} from '@agentome/db';
import type { ConnectionKind } from '@agentome/shared';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { grantInForce } from './grants.js';
import type { RunLimits } from '../protocol.js';
import { ownPolicy, policyFor } from '../mcp/policy.js';
import { ASSIGN_TASK } from '../mcp/tools.js';
import { reportsOf, teamOfLead } from './team.js';
import { skillsOf } from '../library/skills.js';
import { currentMemory } from '../memory/service.js';
import { remoteToolName, serversOf } from '../library/mcp.js';
import { TOOLS } from '../mcp/tools.js';
import { ALLOWED_TOOLS } from '../runs/launch.js';
import { agentMonth } from '../budgets/service.js';
import { LIVE_RUN_STATUSES } from '../runs/service.js';
import { Budget, TemplateSpec } from './templates.js';

export type AgentRow = typeof agents.$inferSelect;

// The one access check of every agent route: a grant of this person on the agent,
// inside its validity window. Slice 1 knows only the owner's grant; with deputies and viewers
// a route that changes the agent will also ask for a level. The query it goes into
// has `agents` in its from (the runs a person reads join the agent of each run for it), or
// passes the agent column of its own rows, as tasks do.
export const grantedTo = (userId: string, agentId: AnyColumn = agents.id): SQL =>
  sql`exists (select 1 from ${agentGrants} where ${and(
    eq(agentGrants.agentId, agentId),
    eq(agentGrants.userId, userId),
    grantInForce,
  )})`;

/** The agents that have an item of the library, for the page of that item. */
export const Holders = z.object({
  agents: z.array(z.object({ id: z.uuid(), name: z.string() })),
});

/**
 * The person's active agents whose own row meets `holds`, by name: the Library asks which of
 * them have a skill or a server.
 */
export const agentsThat = (db: Db, userId: string, holds: SQL) =>
  db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(and(grantedTo(userId), eq(agents.status, 'active'), holds))
    .orderBy(agents.name);

/** The agent, if this person holds a grant on it; otherwise 404, as if it did not exist. */
export async function agentFor(db: Db, agentId: string, userId: string): Promise<AgentRow> {
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), grantedTo(userId)));
  if (!agent) throw new AppError('not_found', 'Agent not found');
  return agent;
}

const runFields = {
  id: runs.id,
  taskId: runs.taskId,
  status: runs.status,
  endedAt: runs.endedAt,
  startedAt: runs.startedAt,
  queuedAt: runs.createdAt,
};
type RunFields = { [K in keyof typeof runFields]: (typeof runFields)[K]['_']['data'] | null };

/**
 * "Last run": the latest run, its task, its status, and when it ended, started or was queued.
 * The sidebar opens the task an agent works on from it.
 */
const lastRunOf = (
  run: RunFields | undefined,
  task?: { title: string | null; project: string | null },
) =>
  run?.id && run.status && run.queuedAt
    ? {
        id: run.id,
        taskId: run.taskId,
        status: run.status,
        at: (run.endedAt ?? run.startedAt ?? run.queuedAt).toISOString(),
        // What it is about, for the list to say what an agent at work is doing.
        task: task?.title ? { title: task.title, project: task.project } : null,
      }
    : null;

const iso = (date: Date | null) => date?.toISOString() ?? null;

/** The person's agents, or with `all` every agent; active ones, or with `archived` the rest. */
export async function listAgents(
  db: Db,
  options: { userId: string; all: boolean; archived: boolean },
) {
  const last = db
    .select(runFields)
    .from(runs)
    .where(eq(runs.agentId, agents.id))
    .orderBy(desc(runs.createdAt))
    .limit(1)
    .as('last_run');
  const rows = await db
    .select({
      agent: agents,
      ownerName: users.name,
      id: last.id,
      taskId: last.taskId,
      status: last.status,
      endedAt: last.endedAt,
      startedAt: last.startedAt,
      queuedAt: last.queuedAt,
      taskTitle: sql<
        string | null
      >`(select ${tasks.title} from ${tasks} where ${tasks.id} = ${last.taskId})`,
      taskProject: sql<
        string | null
      >`(select ${projects.name} from ${tasks} join ${projects} on ${projects.id} = ${tasks.projectId} where ${tasks.id} = ${last.taskId})`,
      // The dashboard's week: the runs queued in the last seven days and what they cost.
      weekRuns: sql<number>`(select count(*)::int from ${runs} where ${runs.agentId} = ${agents.id} and ${runs.createdAt} > now() - interval '7 days')`,
      weekUsd: sql<
        string | null
      >`(select sum(${costEvents.usd})::text from ${costEvents} where ${costEvents.agentId} = ${agents.id} and ${costEvents.createdAt} > now() - interval '7 days')`,
      // The agent's card: of the week's runs, how many ended and how many of those were
      // done, the median run, and the runs of each of the seven days, oldest first.
      weekStats: sql<{
        ended: number;
        done: number;
        medianSeconds: number | null;
        daily: number[];
      }>`(
        select json_build_object(
          'ended', count(*) filter (where ${runs.status} in ('done', 'failed', 'cancelled')),
          'done', count(*) filter (where ${runs.status} = 'done'),
          'medianSeconds', percentile_cont(0.5) within group (order by extract(epoch from ${runs.endedAt} - ${runs.startedAt})),
          'daily', (
            select array_agg((
              select count(*) from ${runs} as day_run
              where day_run.agent_id = ${agents.id}
                and day_run.created_at > now() - (day + 1) * interval '1 day'
                and day_run.created_at <= now() - day * interval '1 day'
            ) order by day desc)
            from generate_series(0, 6) as day
          )
        )
        from ${runs}
        where ${runs.agentId} = ${agents.id} and ${runs.createdAt} > now() - interval '7 days'
      )`,
    })
    .from(agents)
    .innerJoin(users, eq(users.id, agents.ownerUserId))
    .leftJoinLateral(last, sql`true`)
    .where(
      and(
        eq(agents.status, options.archived ? 'archived' : 'active'),
        options.all ? undefined : grantedTo(options.userId),
      ),
    )
    .orderBy(sql`lower(${agents.name})`, asc(agents.createdAt));
  return rows.map(
    ({ agent, ownerName, weekRuns, weekUsd, weekStats, taskTitle, taskProject, ...run }) => ({
      ...summary(agent, ownerName),
      modelPref: agent.modelPref,
      lastRun: lastRunOf(run, { title: taskTitle, project: taskProject }),
      week: {
        runs: weekRuns,
        usd: weekUsd,
        ended: weekStats.ended,
        done: weekStats.done,
        medianSeconds:
          weekStats.medianSeconds === null ? null : Math.round(weekStats.medianSeconds),
        daily: weekStats.daily,
      },
    }),
  );
}

const summary = (agent: AgentRow, ownerName: string) => ({
  id: agent.id,
  name: agent.name,
  roleTitle: agent.roleTitle,
  status: agent.status,
  owner: { id: agent.ownerUserId, name: ownerName },
  createdAt: agent.createdAt.toISOString(),
});

// Human names of the platform's tools for the sheet: the editor shows the tool, the sheet
// says what it lets the agent do.
const toolTitles: Record<string, string> = {
  Bash: 'Run commands in the sandbox',
  Glob: 'Find files by name',
  Grep: 'Search inside files',
  Read: 'Read files',
  TodoWrite: 'Keep a to-do list for the task',
};

/** A stored budget as the API shows it: what is not a valid limit is left out. */
export function budgetOf(value: unknown): z.infer<typeof Budget> | null {
  if (!value || typeof value !== 'object') return null;
  const valid = Object.entries(value).filter(
    ([key, item]) => Budget.safeParse({ [key]: item }).success,
  );
  return valid.length ? Object.fromEntries(valid) : null;
}

/** The template the agent was made from, at its current version. */
export async function templateOf(db: Db, agent: AgentRow) {
  if (!agent.templateId) return null;
  const [row] = await db
    .select({ id: catalogItems.id, name: catalogItems.name, version: catalogItems.version })
    .from(catalogItems)
    .where(eq(catalogItems.id, agent.templateId));
  return row ? { ...row, version: Number(row.version) } : null;
}

/** Everything the editor and the sheet show about one agent. */
export async function agentView(db: Db, agent: AgentRow, runDefaults: RunLimits) {
  const [[owner], template, [run], [seat], people, agentProjects, servers, [connection]] =
    await Promise.all([
      db.select({ name: users.name }).from(users).where(eq(users.id, agent.ownerUserId)),
      templateOf(db, agent),
      db
        .select(runFields)
        .from(runs)
        .where(eq(runs.agentId, agent.id))
        .orderBy(desc(runs.createdAt))
        .limit(1),
      // Runs go to the owner's computer: the one seen most recently. A seat runs one
      // run at a time, so the join adds no rows.
      db
        .select({
          id: seats.id,
          name: seats.name,
          lastSeenAt: seats.lastSeenAt,
          busy: sql<boolean>`${runs.id} is not null`,
        })
        .from(seats)
        .leftJoin(
          runs,
          and(eq(runs.seatId, seats.id), inArray(runs.status, [...LIVE_RUN_STATUSES])),
        )
        .where(and(eq(seats.ownerUserId, agent.ownerUserId), eq(seats.status, 'active')))
        .orderBy(sql`${seats.lastSeenAt} desc nulls last`, desc(seats.createdAt))
        .limit(1),
      db
        .select({
          id: users.id,
          name: users.name,
          level: agentGrants.level,
          validFrom: agentGrants.validFrom,
          validUntil: agentGrants.validUntil,
        })
        .from(agentGrants)
        .innerJoin(users, eq(users.id, agentGrants.userId))
        .where(eq(agentGrants.agentId, agent.id))
        .orderBy(asc(agentGrants.createdAt)),
      // What the agent reaches: its projects, each with the hosts it is connected to and the
      // repositories it names, the main one first.
      db
        .select({
          id: projects.id,
          name: projects.name,
          repositories: projects.repositories,
          hosts: sql<
            ConnectionKind[]
          >`coalesce(array_agg(distinct ${projectConnections.kind}) filter (where ${projectConnections.kind} is not null), '{}')`,
        })
        .from(projectAgents)
        .innerJoin(projects, eq(projects.id, projectAgents.projectId))
        .leftJoin(projectConnections, eq(projectConnections.projectId, projects.id))
        .where(eq(projectAgents.agentId, agent.id))
        .groupBy(projects.id)
        .orderBy(projects.name),
      serversOf(db, agent.tools),
      agent.modelConnectionId
        ? db
            .select({ id: modelConnections.id, name: modelConnections.name })
            .from(modelConnections)
            .where(eq(modelConnections.id, agent.modelConnectionId))
        : Promise.resolve([]),
    ]);
  return {
    ...summary(agent, owner?.name ?? ''),
    lastRun: lastRunOf(run),
    instructions: agent.instructions,
    engine: agent.engine,
    modelPref: agent.modelPref,
    runsOn: agent.runsOn,
    modelConnection: connection ?? null,
    serverShell: agent.serverShell,
    budget: budgetOf(agent.budget),
    runDefaults,
    copiedFromAgentId: agent.copiedFromAgentId,
    template,
    seat: seat ? { ...seat, lastSeenAt: iso(seat.lastSeenAt) } : null,
    people: people.map((person) => ({
      ...person,
      validFrom: iso(person.validFrom),
      validUntil: iso(person.validUntil),
    })),
    projects: agentProjects,
    // The workspace tools are always allowed (the CLI runs alone); the gateway's follow the
    // agent's policy, the same one the gateway reads.
    tools: [
      ...ALLOWED_TOOLS.map((name) => ({
        connector: 'Workspace',
        name,
        title: toolTitles[name] ?? name,
        policy: 'allow' as const,
      })),
      ...TOOLS.map((tool) => ({
        connector: tool.connector,
        name: tool.name,
        title: tool.title,
        policy: policyFor(agent.tools, tool.name),
      })),
      ...servers.flatMap((server) =>
        server.tools.map((tool) => {
          const name = remoteToolName(server.name, tool.name);
          return {
            connector: server.name,
            name,
            title: tool.title,
            policy: policyFor(agent.tools, name),
          };
        }),
      ),
      ...teamPolicy(agent, await teamOfLead(db, agent.id)),
      ...((await reportsOf(db, agent.id)).length > 0
        ? [
            {
              connector: 'Team',
              name: ASSIGN_TASK,
              title: 'Assign a task to a lead under it',
              policy: policyFor(agent.tools, ASSIGN_TASK),
            },
          ]
        : []),
    ],
    mcpServers: servers.map((server) => ({
      id: server.id,
      name: server.name,
      privateTo: server.visibility === 'private' ? server.owner?.name : undefined,
    })),
    // Pinned versions; a private one says whose it is, as the sheet marks it.
    skills: (await skillsOf(db, agent.skills)).map((skill) => ({
      id: skill.id,
      name: skill.name,
      version: String(skill.version),
      privateTo: skill.visibility === 'private' ? skill.owner?.name : undefined,
    })),
    memoryDocuments: (await currentMemory(db, agent.id)).length,
    // What its runs cost this month, at API prices.
    spend: await (async () => {
      const month = await agentMonth(db, agent);
      return {
        usdThisMonth: Math.round(month.spent * 100) / 100,
        limit: month.limit,
        reached: month.reached,
        resumed: month.resumed,
      };
    })(),
  };
}

type NewAgent = Omit<typeof agents.$inferInsert, 'id' | 'ownerUserId' | 'status' | 'createdAt'>;

/** Creates the agent and its owner's grant together: the two say one thing. */
export async function insertAgent(
  db: Db,
  ownerUserId: string,
  values: NewAgent,
): Promise<AgentRow> {
  return db.transaction(async (tx) => {
    const [agent] = await tx
      .insert(agents)
      .values({ ...values, ownerUserId })
      .returning();
    if (!agent) throw new Error('The agent was not inserted');
    await tx.insert(agentGrants).values({ agentId: agent.id, userId: ownerUserId, level: 'owner' });
    return agent;
  });
}

/** A blank agent, or one prefilled from a platform role template. */
export async function createAgent(
  db: Db,
  ownerUserId: string,
  input: { name: string; roleTitle?: string; templateId?: string },
) {
  if (!input.templateId) {
    return insertAgent(db, ownerUserId, { name: input.name, roleTitle: input.roleTitle ?? '' });
  }
  const [template] = await db
    .select({ id: catalogItems.id, spec: catalogItems.spec })
    .from(catalogItems)
    .where(
      and(
        eq(catalogItems.id, input.templateId),
        eq(catalogItems.kind, 'template'),
        isNull(catalogItems.ownerUserId),
      ),
    );
  if (!template) throw new AppError('not_found', 'Template not found');
  const spec = TemplateSpec.parse(template.spec);
  return insertAgent(db, ownerUserId, {
    name: input.name,
    roleTitle: input.roleTitle ?? spec.roleTitle,
    instructions: spec.instructions,
    modelPref: spec.modelPref ?? null,
    budget: spec.budget ?? null,
    templateId: template.id,
  });
}

/** A copy of the configuration for this person; grants, runs and tokens stay with the original. */
export function duplicateAgent(db: Db, source: AgentRow, ownerUserId: string) {
  return insertAgent(db, ownerUserId, {
    // Within the 100 characters a name may have.
    name: `${source.name.slice(0, 93)} (copy)`,
    roleTitle: source.roleTitle,
    instructions: source.instructions,
    engine: source.engine,
    modelPref: source.modelPref,
    skills: source.skills,
    tools: source.tools,
    budget: source.budget,
    templateId: source.templateId,
    copiedFromAgentId: source.id,
  });
}

/** The platform's role templates, for the New agent dialog. */
export async function listTemplates(db: Db) {
  const rows = await db
    .select()
    .from(catalogItems)
    .where(and(eq(catalogItems.kind, 'template'), isNull(catalogItems.ownerUserId)))
    .orderBy(asc(catalogItems.name));
  return rows.map(({ id, name, version, spec }) => {
    const { description, roleTitle, modelPref } = TemplateSpec.parse(spec);
    return {
      id,
      name,
      version: Number(version),
      description,
      roleTitle,
      modelPref: modelPref ?? null,
    };
  });
}

/**
 * A lead's assignments as a policy row: ask by default, which in manual is an
 * approval at each step and in auto one per task; the gateway decides `team_step` by it.
 */
export function teamPolicy(agent: AgentRow, team: { mode: 'auto' | 'manual' } | null) {
  if (!team) return [];
  const policy = ownPolicy(agent.tools, 'team_step') ?? 'ask';
  return [{ connector: 'Team', name: 'team_step', title: 'Start a team step', policy }];
}

/**
 * A server agent's model is a Claude model its connection listed: Claude Code runs
 * nothing else. Checked when the agent is saved, so a run never starts on a model it cannot use.
 */
export async function checkServerModel(
  db: Db,
  agent: Pick<AgentRow, 'runsOn' | 'modelConnectionId' | 'modelPref' | 'engine'>,
) {
  if (agent.runsOn !== 'server') return;
  if (!agent.modelConnectionId) {
    throw new AppError('bad_request', 'An agent on the server needs a model connection');
  }
  const [connection] = await db
    .select({
      name: modelConnections.name,
      kind: modelConnections.kind,
      models: modelConnections.models,
    })
    .from(modelConnections)
    .where(eq(modelConnections.id, agent.modelConnectionId));
  if (!connection) throw new AppError('not_found', 'No such model connection');
  const model = agent.modelPref ?? '';
  const claude = /claude/i.test(model);
  if (agent.engine === 'claude-code' && (!claude || !connection.models.includes(model))) {
    throw new AppError(
      'bad_request',
      `Pick a Claude model of ${connection.name}: Claude Code runs Claude models only`,
    );
  }
  // Codex speaks OpenAI's format: an OpenAI connection or a gateway, and not a Claude model.
  if (
    agent.engine === 'codex' &&
    (connection.kind === 'anthropic' || claude || !connection.models.includes(model))
  ) {
    throw new AppError(
      'bad_request',
      `Pick a model of ${connection.name} that is not Claude's: Codex runs the others`,
    );
  }
}
