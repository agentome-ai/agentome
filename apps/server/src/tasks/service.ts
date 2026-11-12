import {
  agents,
  and,
  asc,
  costEvents,
  type Db,
  desc,
  eq,
  inArray,
  projectAgents,
  projects,
  runArtifacts,
  runs,
  seats,
  type SQL,
  sql,
  tasks,
  teams,
  toolCalls,
  users,
} from '@agentome/db';
import type { RunStatus } from '@agentome/shared';
import { z } from 'zod';
import { grantedTo } from '../agents/service.js';
import { connectionFor } from '../connections/service.js';
import { AppError } from '../errors.js';
import { enqueueRun, type Tx } from '../runs/service.js';
import { taskRepository } from './repository.js';
import { treeOf } from './subtasks.js';
import { commentsOf } from './thread.js';

// Tasks: a person sees and changes the tasks of the agents they hold a
// grant on, through the same check as the agent routes; someone else's task is not found.

type TaskStatus = (typeof tasks.$inferSelect)['status'];

// A run still going: the task gets another one only after it ends.
const LIVE: RunStatus[] = ['queued', 'running', 'waiting_approval'];

const notFound = () => new AppError('not_found', 'Task not found');

// What the gateway and the webhooks wrote in a change request's meta; a word this
// version does not know reads as not known.
const known = <T extends [string, ...string[]]>(values: T) => z.enum(values).nullable().catch(null);
export const ChangeRequestStatus = z.object({
  state: known(['open', 'draft', 'merged', 'closed']),
  pipeline: known(['none', 'running', 'success', 'failed']),
  review: known(['approved', 'changes_requested', 'commented']),
});
const iso = (date: Date | null) => date?.toISOString() ?? null;

function selectTasks(db: Db, where: SQL | undefined, limit: number) {
  const latest = db
    .select({
      id: runs.id,
      status: runs.status,
      endedAt: runs.endedAt,
      startedAt: runs.startedAt,
      queuedAt: runs.createdAt,
    })
    .from(runs)
    .where(eq(runs.taskId, tasks.id))
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(1)
    .as('latest_run');
  // The newest merge or pull request a run of the task opened, for a list that says where the
  // work is to review.
  const change = db
    .select({ url: runArtifacts.ref, meta: runArtifacts.meta })
    .from(runArtifacts)
    .innerJoin(runs, eq(runs.id, runArtifacts.runId))
    .where(and(eq(runs.taskId, tasks.id), eq(runArtifacts.kind, 'change_request')))
    .orderBy(desc(runArtifacts.createdAt), desc(runArtifacts.id))
    .limit(1)
    .as('latest_change');
  // Not the description: a list does not show it, and it may be long.
  return db
    .select({
      id: tasks.id,
      title: tasks.title,
      agentId: tasks.agentId,
      status: tasks.status,
      source: tasks.source,
      repository: taskRepository,
      // Whether the repository is the project's: the task page says so instead of offering it.
      repositoryFromProject: sql<boolean>`"tasks"."repository" is null and "tasks"."project_id" is not null`,
      createdById: tasks.createdBy,
      // With microseconds: with the id, it is where the next page starts, and toISOString keeps
      // only milliseconds.
      createdAt: sql<string>`to_char(${tasks.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      agentName: agents.name,
      agentStatus: agents.status,
      creatorName: users.name,
      projectId: tasks.projectId,
      projectName: projects.name,
      // Flat: Drizzle would turn a nested object of a left join's columns into null itself.
      runId: latest.id,
      runStatus: latest.status,
      runEndedAt: latest.endedAt,
      runStartedAt: latest.startedAt,
      runQueuedAt: latest.queuedAt,
      changeUrl: change.url,
      changeMeta: change.meta,
    })
    .from(tasks)
    .innerJoin(agents, eq(agents.id, tasks.agentId))
    .innerJoin(users, eq(users.id, tasks.createdBy))
    .leftJoin(projects, eq(projects.id, tasks.projectId))
    .leftJoinLateral(latest, sql`true`)
    .leftJoinLateral(change, sql`true`)
    .where(where)
    .orderBy(desc(tasks.createdAt), desc(tasks.id))
    .limit(limit);
}

type TaskRow = Awaited<ReturnType<typeof selectTasks>>[number];

const summary = (row: TaskRow) => ({
  id: row.id,
  title: row.title,
  agent: { id: row.agentId, name: row.agentName },
  status: row.status,
  source: row.source,
  repository: row.repository,
  repositoryFromProject: row.repositoryFromProject,
  createdBy: { id: row.createdById, name: row.creatorName },
  createdAt: row.createdAt,
  project: row.projectId && row.projectName ? { id: row.projectId, name: row.projectName } : null,
  // When the latest run ended, else started, else was queued: as the agents' "Last run".
  latestRun:
    row.runId && row.runStatus && row.runQueuedAt
      ? {
          id: row.runId,
          status: row.runStatus,
          at: (row.runEndedAt ?? row.runStartedAt ?? row.runQueuedAt).toISOString(),
        }
      : null,
  changeRequest: row.changeUrl ? changeRequestOf(row.changeUrl, row.changeMeta) : null,
});

const changeRequestOf = (url: string, meta: unknown) => {
  const { state, pipeline } = ChangeRequestStatus.parse(
    typeof meta === 'object' && meta !== null ? meta : {},
  );
  return { url, state, pipeline };
};

/**
 * The tasks a person may see, newest first, a page at a time. A page starts after the last
 * task of the previous one, by its createdAt and then its id: tasks created in one transaction
 * share a createdAt, and the time alone would skip those after the first.
 */
export async function listTasks(
  db: Db,
  userId: string,
  query: {
    all: boolean;
    agent?: string;
    project?: string;
    status?: TaskStatus;
    limit: number;
    before?: { at: string; id: string };
  },
) {
  const { before } = query;
  const rows = await selectTasks(
    db,
    and(
      query.all ? undefined : grantedTo(userId, tasks.agentId),
      query.agent ? eq(tasks.agentId, query.agent) : undefined,
      query.project ? eq(tasks.projectId, query.project) : undefined,
      query.status ? eq(tasks.status, query.status) : undefined,
      before &&
        sql`(${tasks.createdAt}, ${tasks.id}) < (${before.at}::timestamptz, ${before.id}::uuid)`,
    ),
    // One more than the page: whether a next page exists, without a count.
    query.limit + 1,
  );
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    tasks: page.map(summary),
    nextBefore: rows.length > query.limit && last ? `${last.createdAt}_${last.id}` : null,
  };
}

/** Where a question stands: answered (approved), skipped (denied), waiting, or let go. */
function questionState(decision: string) {
  if (decision === 'approved') return 'answered' as const;
  if (decision === 'denied') return 'skipped' as const;
  return decision === 'pending' ? ('waiting' as const) : ('unanswered' as const);
}

/** One task with its description and its runs, newest first; 404 without a grant. */
export async function taskView(db: Db, taskId: string, userId: string) {
  const [row] = await selectTasks(
    db,
    and(eq(tasks.id, taskId), grantedTo(userId, tasks.agentId)),
    1,
  );
  if (!row) throw notFound();
  const [[text], connection, history, changeRequests, questions] = await Promise.all([
    db
      .select({
        body: tasks.body,
        externalError: tasks.externalError,
        parentTaskId: tasks.parentTaskId,
      })
      .from(tasks)
      .where(eq(tasks.id, taskId)),
    connectionFor(db, row.agentId, row.repository),
    db
      .select({
        id: runs.id,
        status: runs.status,
        startedAt: runs.startedAt,
        endedAt: runs.endedAt,
        errorCode: runs.errorCode,
        summary: runs.summary,
        seatName: seats.name,
        createdAt: runs.createdAt,
        usd: sql<
          string | null
        >`(select sum(${costEvents.usd})::text from ${costEvents} where ${costEvents.runId} = ${runs.id})`,
      })
      .from(runs)
      .leftJoin(seats, eq(seats.id, runs.seatId))
      .where(eq(runs.taskId, taskId))
      .orderBy(desc(runs.createdAt), desc(runs.id)),
    db
      .select({
        url: runArtifacts.ref,
        runId: runArtifacts.runId,
        meta: runArtifacts.meta,
        createdAt: runArtifacts.createdAt,
      })
      .from(runArtifacts)
      .innerJoin(runs, eq(runs.id, runArtifacts.runId))
      .where(and(eq(runs.taskId, taskId), eq(runArtifacts.kind, 'change_request')))
      .orderBy(desc(runArtifacts.createdAt), desc(runArtifacts.id)),
    // The agents' questions to the person and the answers, for the task's activity.
    db
      .select({
        id: toolCalls.id,
        runId: toolCalls.runId,
        input: toolCalls.input,
        decision: toolCalls.decision,
        reason: toolCalls.reason,
        askedAt: toolCalls.createdAt,
        answeredAt: toolCalls.decidedAt,
        answeredBy: users.name,
      })
      .from(toolCalls)
      .innerJoin(runs, eq(runs.id, toolCalls.runId))
      .leftJoin(users, eq(users.id, toolCalls.decidedBy))
      .where(and(eq(runs.taskId, taskId), eq(toolCalls.tool, 'ask_owner')))
      .orderBy(asc(toolCalls.createdAt)),
  ]);
  return {
    ...summary(row),
    agent: { id: row.agentId, name: row.agentName, status: row.agentStatus },
    body: text?.body ?? '',
    externalError: text?.externalError ?? null,
    ...(await treeOf(db, { id: taskId, parentTaskId: text?.parentTaskId ?? null })),
    comments: await commentsOf(db, taskId),
    connection,
    runs: history.map(({ seatName, ...run }) => ({
      ...run,
      startedAt: iso(run.startedAt),
      endedAt: iso(run.endedAt),
      createdAt: run.createdAt.toISOString(),
      seat: seatName === null ? null : { name: seatName },
    })),
    changeRequests: changeRequests.map(({ url, runId, meta, createdAt }) => ({
      url,
      runId,
      ...ChangeRequestStatus.parse(typeof meta === 'object' && meta !== null ? meta : {}),
      createdAt: createdAt.toISOString(),
    })),
    questions: questions.map((asked) => {
      const question = (asked.input as { question?: unknown } | null)?.question;
      return {
        id: asked.id,
        runId: asked.runId,
        question: typeof question === 'string' ? question : '',
        // An answered question is approved with its answer as the reason; a skipped one denied.
        answer: asked.decision === 'approved' ? asked.reason : null,
        state: questionState(asked.decision),
        askedAt: asked.askedAt.toISOString(),
        answeredAt: iso(asked.answeredAt),
        answeredBy: asked.answeredBy,
      };
    }),
  };
}

/**
 * Reads the agent's status under a share lock, held until the transaction ends: an archive
 * that came first is seen here, and one that comes later waits, then cancels the run this
 * transaction queues along with the agent's other queued runs.
 */
async function assertActive(tx: Tx, agentId: string, userId: string) {
  const [agent] = await tx
    .select({ status: agents.status })
    .from(agents)
    .where(and(eq(agents.id, agentId), grantedTo(userId)))
    .for('share');
  if (!agent) throw new AppError('not_found', 'Agent not found');
  if (agent.status === 'archived') {
    throw new AppError('agent_archived', 'This agent is archived. Unarchive it first.');
  }
}

/**
 * Where a task filed in a project goes: to its team's lead, in its main repository,
 * and at once when the project's intake is auto. Without a team nobody takes it.
 */
/**
 * A task or schedule names a project only of its agent's: its runs count against that project's
 * budget and show on its page, which another person's agent must not reach.
 */
export async function assertOnProject(db: Db | Tx, projectId: string, agentId: string) {
  const [member] = await db
    .select({ agentId: projectAgents.agentId })
    .from(projectAgents)
    .where(and(eq(projectAgents.projectId, projectId), eq(projectAgents.agentId, agentId)));
  if (!member) {
    const message = 'This agent is not on the project. Put it on the project first.';
    throw new AppError('validation_failed', message, [{ path: 'body/projectId', message }]);
  }
}

export async function projectIntake(db: Db | Tx, projectId: string) {
  const [project] = await db
    .select({
      leadId: teams.leadAgentId,
      intake: projects.intake,
      repositories: projects.repositories,
    })
    .from(projects)
    .leftJoin(teams, eq(teams.id, projects.teamId))
    .where(eq(projects.id, projectId));
  if (!project) throw new AppError('not_found', 'Project not found');
  return {
    leadId: project.leadId,
    auto: project.intake === 'auto',
    repository: project.repositories[0] ?? null,
  };
}

/**
 * A manual task in a project for an agent of the person's, and with `run` its first run, in one
 * step. Every new task is filed in a project, so that its work stays with the company's; one
 * without an agent goes to the project's team lead (projectIntake).
 */
export async function createTask(
  db: Db,
  userId: string,
  input: {
    agentId?: string;
    projectId: string;
    title: string;
    body: string;
    repository: string | null;
    run?: boolean;
  },
) {
  const created = await db.transaction(async (tx) => {
    const { repository } = input;
    let { agentId, run: wanted } = input;
    const intake = await projectIntake(tx, input.projectId);
    if (!agentId) {
      if (!intake.leadId) {
        throw new AppError(
          'validation_failed',
          'This project has no team to take its tasks. Give it one on its page, or pick an agent.',
        );
      }
      agentId = intake.leadId;
      wanted ??= intake.auto;
    }
    await assertActive(tx, agentId, userId);
    await assertOnProject(tx, input.projectId, agentId);
    const [task] = await tx
      .insert(tasks)
      .values({
        agentId,
        projectId: input.projectId,
        title: input.title,
        body: input.body,
        repository,
        source: 'manual',
        createdBy: userId,
      })
      .returning({ id: tasks.id });
    if (!task) throw new Error('The task was not inserted');
    const run = (wanted ?? true) ? await enqueueRun(tx, task.id, userId) : null;
    return { taskId: task.id, run: run && { id: run.id, status: run.status } };
  });
  return { task: await taskView(db, created.taskId, userId), run: created.run };
}

/**
 * The folders on a computer the person's own tasks named, the most recent first. Only the
 * person's: a path is read on the computer of whoever filed the task, and another's means nothing.
 */
export async function recentFolders(db: Db, userId: string) {
  const rows = await db
    .select({ folder: tasks.repository })
    .from(tasks)
    .where(
      and(
        eq(tasks.createdBy, userId),
        sql`(${tasks.repository} like '/%' or ${tasks.repository} like '~/%')`,
      ),
    )
    .groupBy(tasks.repository)
    .orderBy(sql`max(${tasks.createdAt}) desc`)
    .limit(6);
  return rows.flatMap((row) => (row.folder ? [row.folder] : []));
}

/** Changes what the request names; nothing else of the task can change. */
export async function updateTask(
  db: Db,
  taskId: string,
  userId: string,
  changes: { title?: string; body?: string; repository?: string | null; status?: TaskStatus },
) {
  if (Object.keys(changes).length > 0) {
    const [task] = await db
      .update(tasks)
      .set(changes)
      .where(and(eq(tasks.id, taskId), grantedTo(userId, tasks.agentId)))
      .returning({ id: tasks.id });
    if (!task) throw notFound();
  }
  return taskView(db, taskId, userId);
}

/** Queues another run of the task, unless its agent is archived or a run of it is going. */
export async function runTask(db: Db | Tx, taskId: string, userId: string) {
  return db.transaction(async (tx) => {
    // Locked, so that two requests at once cannot both find the task without a run going.
    const [task] = await tx
      .select({ agentId: tasks.agentId })
      .from(tasks)
      .where(and(eq(tasks.id, taskId), grantedTo(userId, tasks.agentId)))
      .for('update');
    if (!task) throw notFound();
    await assertActive(tx, task.agentId, userId);
    const [going] = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.taskId, taskId), inArray(runs.status, LIVE)))
      .limit(1);
    if (going) {
      throw new AppError(
        'run_in_progress',
        'A run of this task is in progress. Wait for it to end, or cancel it.',
      );
    }
    const run = await enqueueRun(tx, taskId, userId);
    // Run again from review: the task is back in work. A done one stays done.
    await tx
      .update(tasks)
      .set({ status: 'open' })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, 'review')));
    return { id: run.id, status: run.status };
  });
}
