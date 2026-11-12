import {
  agents,
  and,
  asc,
  type Db,
  desc,
  eq,
  inArray,
  isNotNull,
  runArtifacts,
  runs,
  sql,
  tasks,
} from '@agentome/db';
import { z } from 'zod';
import { reportsOf } from '../agents/team.js';
import { AppError } from '../errors.js';
import { refusesRun } from '../license/service.js';
import { ASSIGN_TASK, type Tool, ToolRefusal } from '../mcp/tools.js';
import { enqueueRun, LIVE_RUN_STATUSES } from '../runs/service.js';

const isLive = (status: string) => (LIVE_RUN_STATUSES as readonly string[]).includes(status);

// Assigning down: a lead hands a lead under it a task of its own, which runs apart with
// that lead's team; when every task it assigned has ended, the lead runs again with their reports.

/** Root, child, grandchild: no deeper. */
const MAX_DEPTH = 3;
const MAX_SUBTASKS = 10;

export const assignTask: Tool = {
  connector: 'Team',
  name: ASSIGN_TASK,
  title: 'Assign a task to a lead under it',
  description:
    'Hands a task to one of the agents under you that lead teams of their own (the "Teams under you" list). It gets its own task and run with its team; you do not wait for it. When every task you assigned has ended, Agentome runs you again on this task with their reports.',
  input: {
    agent: z.string().trim().min(1).max(200).describe('The agent, by its name in your list'),
    title: z.string().trim().min(1).max(200).describe('The task, as its title'),
    body: z
      .string()
      .max(100_000)
      .describe('Markdown: the goal, what to hand back and the limits. It stands alone.'),
  },
  readOnly: false,
  async run({ db, agentId, runId }, args: { agent: string; title: string; body: string }) {
    const [run] = await db
      .select({ taskId: runs.taskId, agentId: runs.agentId })
      .from(runs)
      .where(eq(runs.id, runId));
    // A member of a team run calls with its own token: only the run's lead assigns.
    if (!run?.taskId || run.agentId !== agentId) {
      throw new ToolRefusal('Only a lead working on a task assigns work down.');
    }
    const reports = await reportsOf(db, agentId);
    const wanted = args.agent.toLowerCase();
    const to = reports.find((report) => report.name.toLowerCase() === wanted);
    if (!to) {
      const names = reports.map((report) => report.name).join(', ');
      throw new ToolRefusal(
        names
          ? `${args.agent} is not a lead under you. You can assign to: ${names}.`
          : 'No agent under you leads a team, so there is nobody to assign to.',
      );
    }
    const parent = await taskOf(db, run.taskId);
    if ((await depthOf(db, parent)) >= MAX_DEPTH) {
      throw new ToolRefusal(
        `This task is already ${MAX_DEPTH} levels down, so it cannot be split further. Do the work in this run, or with your team.`,
      );
    }
    const [{ count } = { count: 0 }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(tasks)
      .where(eq(tasks.parentTaskId, parent.id));
    if (count >= MAX_SUBTASKS) {
      throw new ToolRefusal(`This task already has ${MAX_SUBTASKS} assigned tasks; no more.`);
    }
    const [lead] = await db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, agentId));
    const [task] = await db
      .insert(tasks)
      .values({
        agentId: to.id,
        projectId: parent.projectId,
        parentTaskId: parent.id,
        title: args.title,
        body: args.body,
        repository: parent.repository,
        source: 'agent',
        createdBy: parent.createdBy,
      })
      .returning({ id: tasks.id });
    if (!task) throw new AppError('internal', 'The task was not saved');
    const reason = `${lead?.name ?? 'Your lead'} assigned you this as part of "${parent.title}". When you finish, your summary goes back to them.`;
    // A spent month leaves the task made and waiting for its owner, and the lead is told.
    const queued = await enqueueRun(db, task.id, null, { startedBy: 'agent', reason }).then(
      () => true,
      (error: unknown) => {
        if (refusesRun(error)) return false;
        throw error;
      },
    );
    return {
      text: JSON.stringify({
        taskId: task.id,
        agent: to.name,
        status: queued ? 'queued' : 'not started: its monthly budget is spent',
      }),
      summary: `${to.name}: ${args.title}${queued ? '' : ' (budget spent, not started)'}`,
    };
  },
};

async function taskOf(db: Db, id: string) {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, id));
  if (!task) throw new AppError('not_found', 'Task not found');
  return task;
}

/** How many levels a task is down: 1 for one nobody assigned. */
async function depthOf(db: Db, task: { parentTaskId: string | null }) {
  let depth = 1;
  let parentId = task.parentTaskId;
  while (parentId !== null && depth <= MAX_DEPTH) {
    depth += 1;
    const [parent]: { parentTaskId: string | null }[] = await db
      .select({ parentTaskId: tasks.parentTaskId })
      .from(tasks)
      .where(eq(tasks.id, parentId));
    parentId = parent?.parentTaskId ?? null;
  }
  return depth;
}

/**
 * Runs again each task whose assigned tasks have all ended since its last run, with their reports;
 * pg-boss calls it once a minute. Nothing of the task or under it may still be queued or going.
 * The task's row is locked, so two servers cannot wake it twice. Answers the tasks woken.
 */
export async function wakeParents(db: Db): Promise<string[]> {
  // Only parents with a report from the last day: an old one woken now would be a surprise.
  const candidates = await db
    .selectDistinct({ id: tasks.parentTaskId })
    .from(tasks)
    .innerJoin(runs, eq(runs.taskId, tasks.id))
    .where(and(isNotNull(tasks.parentTaskId), sql`${runs.endedAt} > now() - interval '1 day'`));
  const woken: string[] = [];
  for (const { id } of candidates) {
    if (!id) continue;
    const reason = await db
      .transaction(async (tx) => {
        const [parent] = await tx
          .select({ id: tasks.id, status: agents.status })
          .from(tasks)
          .innerJoin(agents, eq(agents.id, tasks.agentId))
          .where(eq(tasks.id, id))
          .for('update', { of: tasks });
        if (parent?.status !== 'active') return null;
        const children = await tx
          .select({ id: tasks.id, title: tasks.title, agent: agents.name })
          .from(tasks)
          .innerJoin(agents, eq(agents.id, tasks.agentId))
          .where(eq(tasks.parentTaskId, id))
          .orderBy(asc(tasks.createdAt));
        const all = await tx
          .select()
          .from(runs)
          .where(inArray(runs.taskId, [id, ...children.map((child) => child.id)]))
          .orderBy(desc(runs.createdAt));
        if (all.some((run) => run.status === 'queued' || isLive(run.status))) return null;
        const lastOwn = all.find((run) => run.taskId === id)?.createdAt ?? new Date(0);
        const lastReport = all
          .filter((run) => run.taskId !== id && run.endedAt)
          .reduce((latest, run) => Math.max(latest, run.endedAt?.getTime() ?? 0), 0);
        if (lastReport <= lastOwn.getTime()) return null;
        const latest = children.flatMap((child) => {
          const run = all.find((one) => one.taskId === child.id);
          return run ? [{ child, run }] : [];
        });
        const links = await tx
          .select({ runId: runArtifacts.runId, ref: runArtifacts.ref })
          .from(runArtifacts)
          .where(
            and(
              inArray(
                runArtifacts.runId,
                latest.map(({ run }) => run.id),
              ),
              eq(runArtifacts.kind, 'change_request'),
            ),
          );
        const reports = latest.map(({ child, run }) => {
          const own = links.filter((link) => link.runId === run.id).map((link) => link.ref);
          const summary = (run.summary ?? '').trim().slice(0, 2000) || 'No summary.';
          return `### ${child.agent}: ${child.title} (${run.status}${run.errorCode ? `, ${run.errorCode}` : ''})\n\n${summary}${own.length > 0 ? `\n\nChange request: ${own.join(', ')}` : ''}`;
        });
        const text = `The tasks you assigned have ended. Read their reports, check the work they point to, and carry on with this task.\n\n${reports.join('\n\n')}`;
        await enqueueRun(tx, id, null, { startedBy: 'agent', reason: text });
        return text;
      })
      .catch((error: unknown) => {
        // A spent month waits for its owner; the next minute tries again.
        if (refusesRun(error)) return null;
        throw error;
      });
    if (reason) woken.push(id);
  }
  return woken;
}

/** What a task page shows of the tree: who assigned it, and what it assigned. */
export async function treeOf(db: Db, task: { id: string; parentTaskId: string | null }) {
  const [parent] = task.parentTaskId
    ? await db
        .select({ id: tasks.id, title: tasks.title, agent: agents.name })
        .from(tasks)
        .innerJoin(agents, eq(agents.id, tasks.agentId))
        .where(eq(tasks.id, task.parentTaskId))
    : [];
  const children = await db
    .select({ id: tasks.id, title: tasks.title, status: tasks.status, agent: agents.name })
    .from(tasks)
    .innerJoin(agents, eq(agents.id, tasks.agentId))
    .where(eq(tasks.parentTaskId, task.id))
    .orderBy(asc(tasks.createdAt));
  const lastRuns = children.length
    ? await db
        .selectDistinctOn([runs.taskId], { taskId: runs.taskId, status: runs.status })
        .from(runs)
        .where(
          inArray(
            runs.taskId,
            children.map((child) => child.id),
          ),
        )
        .orderBy(runs.taskId, desc(runs.createdAt))
    : [];
  return {
    parent: parent ?? null,
    subtasks: children.map((child) => ({
      ...child,
      runStatus: lastRuns.find((run) => run.taskId === child.id)?.status ?? null,
    })),
  };
}
