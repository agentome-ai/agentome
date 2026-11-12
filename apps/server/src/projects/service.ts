import { environmentView } from './environment.js';
import {
  agents,
  and,
  type Db,
  desc,
  eq,
  inArray,
  knowledgeSources,
  projectAgents,
  projectConnections,
  projects,
  sql,
  tasks,
  teamMembers,
  teams,
} from '@agentome/db';
import type { RunStatus } from '@agentome/shared';
import { grantedTo } from '../agents/service.js';
import { agentsUnder } from '../agents/team.js';
import { projectSpend } from '../budgets/service.js';
import { projectConnectionFor } from '../connections/service.js';
import { AppError, postgresCode } from '../errors.js';

// Projects: what an agent works on, and through which connections. Any
// signed-in person reads them (the agent editor assigns one) and makes them; a project is its
// maker's and the administrators' to change, its connections the administrators' alone.

type Row = typeof projects.$inferSelect;

const summary = (row: Row & { agentCount: number; connectionCount: number }) => ({
  id: row.id,
  name: row.name,
  agentCount: row.agentCount,
  connectionCount: row.connectionCount,
  // Who may change it, with the admins: the web app shows them its controls.
  createdBy: row.createdBy,
  createdAt: row.createdAt.toISOString(),
});

// Spelled out with aliases: drizzle writes a column without its table, and inside the subquery
// "id" is the connection's own, so every project counted none.
const counts = {
  agentCount: sql<number>`(select count(*)::int from project_agents pa where pa.project_id = projects.id)`,
  connectionCount: sql<number>`(select count(*)::int from project_connections pc where pc.project_id = projects.id)`,
};

type ProjectWeek = {
  runs: number;
  ended: number;
  done: number;
  medianSeconds: number | null;
  usd: string | null;
  daily: number[] | null;
};
type ProjectLastRun = {
  id: string;
  status: RunStatus;
  at: string;
  agent: { id: string; name: string };
  task: { id: string; title: string };
};

// The outer row is named in full (projects.id): a select from projects alone would have Drizzle
// write a bare "id", which the subqueries' own tables would take for theirs.
// The dashboard's project card: the week of the runs of the project's tasks, as an
// agent's card has its own (runs, how many ended and were done, the median, the cost, each of
// the seven days, oldest first), and the latest of those runs with who ran it.
const week = sql<ProjectWeek>`(
  select json_build_object(
    'runs', count(*),
    'ended', count(*) filter (where r.status in ('done', 'failed', 'cancelled')),
    'done', count(*) filter (where r.status = 'done'),
    'medianSeconds', percentile_cont(0.5) within group (order by extract(epoch from r.ended_at - r.started_at)),
    'usd', (
      select sum(ce.usd)::text from cost_events ce
      join runs cr on cr.id = ce.run_id join tasks ct on ct.id = cr.task_id
      where ct.project_id = projects.id and ce.created_at > now() - interval '7 days'
    ),
    'daily', (
      select array_agg((
        select count(*) from runs dr join tasks dt on dt.id = dr.task_id
        where dt.project_id = projects.id
          and dr.created_at > now() - (day + 1) * interval '1 day'
          and dr.created_at <= now() - day * interval '1 day'
      ) order by day desc)
      from generate_series(0, 6) as day
    )
  )
  from runs r join tasks t on t.id = r.task_id
  where t.project_id = projects.id and r.created_at > now() - interval '7 days'
)`;
const lastRun = sql<ProjectLastRun | null>`(
  select json_build_object(
    'id', r.id, 'status', r.status, 'at', coalesce(r.ended_at, r.started_at, r.created_at),
    'agent', json_build_object('id', a.id, 'name', a.name),
    'task', json_build_object('id', t.id, 'title', t.title)
  )
  from runs r join tasks t on t.id = r.task_id join agents a on a.id = r.agent_id
  where t.project_id = projects.id
  order by r.created_at desc limit 1
)`;

export async function listProjects(db: Db) {
  const rows = await db
    .select({
      row: projects,
      ...counts,
      teamId: teams.id,
      teamName: teams.name,
      week,
      lastRun,
    })
    .from(projects)
    .leftJoin(teams, eq(teams.id, projects.teamId))
    .orderBy(desc(projects.createdAt));
  return rows.map(({ row, teamId, teamName, week: stats, lastRun: last, ...rest }) => ({
    ...summary({ ...row, ...rest }),
    team: teamId && teamName !== null ? { id: teamId, name: teamName } : null,
    lastRun: last && { ...last, at: new Date(last.at).toISOString() },
    week: weekOf(stats),
  }));
}

const weekOf = (stats: ProjectWeek) => ({
  runs: stats.runs,
  ended: stats.ended,
  done: stats.done,
  medianSeconds: stats.medianSeconds === null ? null : Math.round(stats.medianSeconds),
  usd: stats.usd,
  daily: stats.daily ?? [0, 0, 0, 0, 0, 0, 0],
});

export async function projectView(db: Db, id: string) {
  const [found] = await db
    .select({ row: projects, ...counts, week })
    .from(projects)
    .where(eq(projects.id, id));
  if (!found) throw new AppError('not_found', 'Project not found');
  const [members, connections] = await Promise.all([
    db
      .select({
        id: agents.id,
        name: agents.name,
        roleTitle: agents.roleTitle,
        status: agents.status,
      })
      .from(projectAgents)
      .innerJoin(agents, eq(agents.id, projectAgents.agentId))
      .where(eq(projectAgents.projectId, id))
      .orderBy(agents.name),
    db
      .select({
        id: projectConnections.id,
        kind: projectConnections.kind,
        host: projectConnections.host,
        namespace: projectConnections.namespace,
        accountLogin: projectConnections.accountLogin,
        agentName: agents.name,
      })
      .from(projectConnections)
      .leftJoin(agents, eq(agents.id, projectConnections.agentId))
      .where(eq(projectConnections.projectId, id))
      .orderBy(projectConnections.host, projectConnections.namespace),
  ]);
  const [team] = found.row.teamId
    ? await db
        .select({ id: teams.id, name: teams.name, leadId: agents.id, leadName: agents.name })
        .from(teams)
        .innerJoin(agents, eq(agents.id, teams.leadAgentId))
        .where(eq(teams.id, found.row.teamId))
    : [];
  return {
    ...summary({
      ...found.row,
      agentCount: found.agentCount,
      connectionCount: found.connectionCount,
    }),
    team: team
      ? { id: team.id, name: team.name, lead: { id: team.leadId, name: team.leadName } }
      : null,
    intake: found.row.intake,
    // This calendar month of its tasks' runs against its limit.
    budget: {
      usdPerMonth: found.row.usdPerMonth === null ? null : Number(found.row.usdPerMonth),
      usdThisMonth: Math.round((await projectSpend(db, id)) * 100) / 100,
    },
    triggers: {
      onPipelineFailed: found.row.onPipelineFailed,
      onReview: found.row.onReview,
      reviewer: found.row.reviewerAgentId
        ? ((
            await db
              .select({ id: agents.id, name: agents.name })
              .from(agents)
              .where(eq(agents.id, found.row.reviewerAgentId))
          )[0] ?? null)
        : null,
    },
    description: found.row.description,
    goals: found.row.goals,
    repositories: found.row.repositories,
    allowedHosts: found.row.allowedHosts,
    environment: environmentView(found.row),
    agents: members,
    connections,
    week: weekOf(found.week),
  };
}

export async function createProject(
  db: Db,
  userId: string,
  input: { name: string; description: string; goals: string },
) {
  const [row] = await db
    .insert(projects)
    .values({ ...input, createdBy: userId })
    .returning({ id: projects.id });
  if (!row) throw new Error('The insert returned no project');
  return projectView(db, row.id);
}

export async function updateProject(
  db: Db,
  id: string,
  changes: {
    name?: string;
    description?: string;
    goals?: string;
    repositories?: string[];
    allowedHosts?: string[];
    teamId?: string | null;
    intake?: 'manual' | 'auto';
    usdPerMonth?: number | null;
    onPipelineFailed?: boolean;
    onReview?: boolean;
    reviewerAgentId?: string | null;
  },
) {
  // Only a repository a connection of the project reaches: the runs push to it through that
  // connection, and the knowledge reads it through the same.
  for (const repository of changes.repositories ?? []) {
    if (!(await projectConnectionFor(db, id, repository))) {
      throw new AppError(
        'validation_failed',
        `No GitHub or GitLab connection of this project reaches ${repository}. Connect its owner or group first.`,
      );
    }
  }
  if (changes.teamId) {
    const [team] = await db.select().from(teams).where(eq(teams.id, changes.teamId));
    if (!team) throw new AppError('validation_failed', 'No such team');
    await joinBranch(db, id, team.leadAgentId);
  }
  // The reviewer works on the project, so its runs reach the repositories it reviews.
  if (changes.reviewerAgentId) await assignAgent(db, id, changes.reviewerAgentId);
  if (Object.keys(changes).length > 0) {
    const { usdPerMonth, ...rest } = changes;
    await db
      .update(projects)
      .set({
        ...rest,
        ...(usdPerMonth !== undefined && {
          usdPerMonth: usdPerMonth === null ? null : String(usdPerMonth),
        }),
      })
      .where(eq(projects.id, id));
  }
  return projectView(db, id);
}

/**
 * A project is its creator's and the admins' to change (1 November 2026: every person makes
 * projects). Its connections stay an admin's, so a project a person made reaches no host token
 * until an admin connects it, and only to the agents its creator put on it.
 */
export async function requireProjectEditor(
  db: Db,
  projectId: string,
  user: { id: string; role: string },
): Promise<void> {
  const [project] = await db
    .select({ createdBy: projects.createdBy })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!project) throw new AppError('not_found', 'Project not found');
  if (user.role !== 'admin' && project.createdBy !== user.id) {
    throw new AppError(
      'forbidden',
      'Only the person who made this project, or an admin, changes it',
    );
  }
}

/**
 * A team a person may give a project: their own, or any for an admin. A team is its lead's
 * owner's, not its maker's: it changes hands with the lead.
 */
export async function requireOwnTeam(db: Db, teamId: string, user: { id: string; role: string }) {
  if (user.role === 'admin') return;
  const [team] = await db
    .select({ mine: sql<boolean>`${grantedTo(user.id, teams.leadAgentId)}` })
    .from(teams)
    .where(eq(teams.id, teamId));
  if (team && !team.mine) {
    throw new AppError('forbidden', 'Give the project a team of your own');
  }
}

/**
 * The team works on the project: its lead and everyone under it, through the teams below,
 * join it, so that their runs reach its repositories, connections and documents.
 */
async function joinBranch(db: Db, projectId: string, leadId: string) {
  for (const agentId of [leadId, ...(await agentsUnder(db, [leadId]))]) {
    await assignAgent(db, projectId, agentId);
  }
}

/**
 * After a team's members change: each project worked on by this team, or by a team above it,
 * gets the agents now in its branch. One who leaves stays on the project, with its tasks.
 */
export async function joinTeamProjects(db: Db, teamId: string) {
  const [team] = await db.select().from(teams).where(eq(teams.id, teamId));
  if (!team) return;
  const above = new Set([teamId]);
  let leads = [team.leadAgentId];
  while (leads.length > 0) {
    const rows = await db
      .select({ id: teams.id, leadId: teams.leadAgentId })
      .from(teams)
      .innerJoin(teamMembers, eq(teamMembers.teamId, teams.id))
      .where(inArray(teamMembers.agentId, leads));
    const fresh = rows.filter((row) => !above.has(row.id));
    for (const row of fresh) above.add(row.id);
    leads = fresh.map((row) => row.leadId);
  }
  const worked = await db
    .select({ id: projects.id, leadId: teams.leadAgentId })
    .from(projects)
    .innerJoin(teams, eq(teams.id, projects.teamId))
    .where(inArray(projects.teamId, [...above]));
  for (const project of worked) await joinBranch(db, project.id, project.leadId);
}

/** Puts an agent on a project; already there is fine. */
export async function assignAgent(db: Db, projectId: string, agentId: string): Promise<void> {
  try {
    await db.insert(projectAgents).values({ projectId, agentId }).onConflictDoNothing();
  } catch (error) {
    if (postgresCode(error) === '23503') throw new AppError('not_found', 'Project not found');
    throw error;
  }
}

/**
 * Deletes a project with what only it holds: its connections (their tokens and webhook
 * deliveries go with them), its knowledge and its agents' assignments. Its tasks and their runs
 * are the record of the work, so they stay, filed in no project.
 */
export async function deleteProject(db: Db, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(tasks).set({ projectId: null }).where(eq(tasks.projectId, id));
    await tx.delete(knowledgeSources).where(eq(knowledgeSources.projectId, id));
    await tx.delete(projectConnections).where(eq(projectConnections.projectId, id));
    await tx.delete(projectAgents).where(eq(projectAgents.projectId, id));
    const gone = await tx
      .delete(projects)
      .where(eq(projects.id, id))
      .returning({ id: projects.id });
    if (gone.length === 0) throw new AppError('not_found', 'Project not found');
  });
}

export async function unassignAgent(db: Db, projectId: string, agentId: string): Promise<void> {
  await db
    .delete(projectAgents)
    .where(and(eq(projectAgents.projectId, projectId), eq(projectAgents.agentId, agentId)));
}
