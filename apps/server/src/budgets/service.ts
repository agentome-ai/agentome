import {
  agentGrants,
  agents,
  and,
  costEvents,
  type Db,
  eq,
  gte,
  notifications,
  projects,
  runs,
  sql,
  tasks,
} from '@agentome/db';
import { grantInForce } from '../agents/grants.js';
import { z } from 'zod';
import { AppError } from '../errors.js';

// Budgets in money: an agent's and a project's limit for a calendar month, against what
// their runs cost by the price table. At 80% the agent's owners hear of it; at the limit new
// runs are refused, until the owner lets the agent go on for the month or someone raises it.
// A run already going finishes: its own limits of minutes, turns and tokens hold it.

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Reader = Db | Tx;

const WARN_AT = 0.8;
/** The start of this calendar month, by the database's clock: every check counts the same way. */
const monthStart = sql<Date>`date_trunc('month', now())`;
const dollars = (usd: number) => `$${usd.toFixed(2)}`;

const AgentLimit = z.object({ usdPerMonth: z.number().positive() }).partial().catch({});

/** What an agent's runs cost this month, in dollars. */
export async function agentSpend(db: Reader, agentId: string): Promise<number> {
  const [row] = await db
    .select({ usd: sql<string>`coalesce(sum(${costEvents.usd}), 0)` })
    .from(costEvents)
    .where(and(eq(costEvents.agentId, agentId), gte(costEvents.createdAt, monthStart)));
  return Number(row?.usd ?? 0);
}

/** What the runs of a project's tasks cost this month, in dollars. */
export async function projectSpend(db: Reader, projectId: string): Promise<number> {
  const [row] = await db
    .select({ usd: sql<string>`coalesce(sum(${costEvents.usd}), 0)` })
    .from(costEvents)
    .innerJoin(runs, eq(runs.id, costEvents.runId))
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .where(and(eq(tasks.projectId, projectId), gte(costEvents.createdAt, monthStart)));
  return Number(row?.usd ?? 0);
}

/** An agent's month: what it spent, its limit, and whether its owner let it go past it. */
export async function agentMonth(
  db: Reader,
  agent: { id: string; budget: unknown; budgetResumedAt: Date | null },
) {
  const limit = AgentLimit.parse(agent.budget ?? {}).usdPerMonth ?? null;
  const spent = await agentSpend(db, agent.id);
  const [month] = await db.execute<{ start: Date }>(sql`select ${monthStart} as start`);
  const resumed =
    agent.budgetResumedAt !== null &&
    month !== undefined &&
    agent.budgetResumedAt >= new Date(month.start);
  return { spent, limit, resumed, reached: limit !== null && spent >= limit };
}

/**
 * Refuses a new run of an agent, or of a task of a project, whose month is spent. Thrown before
 * anything is written, so a caller in a transaction keeps the rest of its work (a Jira issue).
 */
export async function requireBudget(db: Reader, taskId: string): Promise<void> {
  const [row] = await db
    .select({ agent: agents, projectId: tasks.projectId })
    .from(tasks)
    .innerJoin(agents, eq(agents.id, tasks.agentId))
    .where(eq(tasks.id, taskId));
  if (!row) return;
  const month = await agentMonth(db, row.agent);
  if (month.reached && !month.resumed && month.limit !== null) {
    throw new AppError(
      'budget_reached',
      `${row.agent.name} spent ${dollars(month.spent)} of its ${dollars(month.limit)} this month. Its owner can let it go on for the month, or raise its limit.`,
    );
  }
  if (!row.projectId) return;
  const [project] = await db
    .select({ name: projects.name, limit: projects.usdPerMonth })
    .from(projects)
    .where(eq(projects.id, row.projectId));
  if (!project?.limit) return;
  const spent = await projectSpend(db, row.projectId);
  if (spent >= Number(project.limit)) {
    throw new AppError(
      'budget_reached',
      `The project ${project.name} spent ${dollars(spent)} of its ${dollars(Number(project.limit))} this month. Raise its limit to run more of its tasks.`,
    );
  }
}

/**
 * After a run's costs are in: when they took its agent past 80% of its limit this month, its
 * owners get one notification for the month. Answers the notifications' ids, to push.
 */
export async function notifyBudget(db: Db, runId: string): Promise<string[]> {
  const [row] = await db
    .select({ agent: agents })
    .from(runs)
    .innerJoin(agents, eq(agents.id, runs.agentId))
    .where(eq(runs.id, runId));
  if (!row) return [];
  const month = await agentMonth(db, row.agent);
  if (month.limit === null || month.spent < month.limit * WARN_AT) return [];
  const [told] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.kind, 'budget'),
        sql`${notifications.payload}->>'agentId' = ${row.agent.id}`,
        gte(notifications.createdAt, monthStart),
      ),
    )
    .limit(1);
  if (told) return [];
  const owners = await db
    .select({ userId: agentGrants.userId })
    .from(agentGrants)
    .where(
      and(eq(agentGrants.agentId, row.agent.id), eq(agentGrants.level, 'owner'), grantInForce),
    );
  if (!owners.length) return [];
  const payload = {
    runId,
    agentId: row.agent.id,
    spent: Math.round(month.spent * 100) / 100,
    limit: month.limit,
  };
  const inserted = await db
    .insert(notifications)
    .values(owners.map(({ userId }) => ({ userId, kind: 'budget' as const, payload })))
    .returning({ id: notifications.id });
  return inserted.map(({ id }) => id);
}

/** The owner lets the agent go past its limit for the rest of this month. */
export async function resumeBudget(db: Db, agentId: string): Promise<void> {
  await db.update(agents).set({ budgetResumedAt: new Date() }).where(eq(agents.id, agentId));
}
