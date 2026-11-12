import {
  agentGrants,
  agents,
  and,
  asc,
  type Db,
  desc,
  eq,
  notifications,
  runs,
  taskComments,
  tasks,
  users,
} from '@agentome/db';
import { grantInForce } from '../agents/grants.js';
import { z } from 'zod';
import { grantedTo } from '../agents/service.js';
import { AppError } from '../errors.js';
import { runTask } from './service.js';

// A task's thread: what a person and the task's agents wrote in it, oldest first. A
// person may ask for a run with a comment; an agent writes with the gateway's task_comment.

export const CommentBody = z.string().trim().min(1, 'Write something first').max(20_000);

/** The last comments a run reads in its CLAUDE.md, and how much of each. */
const IN_PROMPT = 20;
const IN_PROMPT_CHARS = 2_000;

export async function commentsOf(db: Db, taskId: string) {
  const rows = await db
    .select({
      id: taskComments.id,
      body: taskComments.body,
      runId: taskComments.runId,
      createdAt: taskComments.createdAt,
      userId: users.id,
      userName: users.name,
      agentId: agents.id,
      agentName: agents.name,
    })
    .from(taskComments)
    .leftJoin(users, eq(users.id, taskComments.authorUserId))
    .leftJoin(agents, eq(agents.id, taskComments.authorAgentId))
    .where(eq(taskComments.taskId, taskId))
    .orderBy(asc(taskComments.createdAt), asc(taskComments.id));
  return rows.map((row) => ({
    id: row.id,
    body: row.body,
    runId: row.runId,
    createdAt: row.createdAt.toISOString(),
    author:
      row.agentId !== null
        ? { kind: 'agent' as const, id: row.agentId, name: row.agentName ?? '' }
        : { kind: 'person' as const, id: row.userId ?? '', name: row.userName ?? '' },
  }));
}

/**
 * A person's comment, and with `run` a run of the task queued in the same transaction, so the
 * run cannot start without reading it. Refused as Run again is: while a run is going.
 */
export async function commentAsPerson(
  db: Db,
  taskId: string,
  userId: string,
  input: { body: string; run: boolean },
) {
  const [task] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), grantedTo(userId, tasks.agentId)));
  if (!task) throw new AppError('not_found', 'Task not found');
  return db.transaction(async (tx) => {
    const [comment] = await tx
      .insert(taskComments)
      .values({ taskId, authorUserId: userId, body: input.body })
      .returning({ id: taskComments.id });
    if (!comment) throw new AppError('internal', 'The comment was not saved');
    const run = input.run ? await runTask(tx, taskId, userId) : null;
    return { id: comment.id, run };
  });
}

/**
 * An agent's comment in the task of its run; its owners hear of it. Answers the notifications
 * made, for the gateway to push. Null when the run has no task.
 */
export async function commentAsAgent(db: Db, runId: string, agentId: string, body: string) {
  const [run] = await db.select({ taskId: runs.taskId }).from(runs).where(eq(runs.id, runId));
  if (!run?.taskId) return null;
  const taskId = run.taskId;
  const [comment] = await db
    .insert(taskComments)
    .values({ taskId, authorAgentId: agentId, runId, body })
    .returning({ id: taskComments.id });
  if (!comment) throw new AppError('internal', 'The comment was not saved');
  const owners = await db
    .select({ userId: agentGrants.userId })
    .from(agentGrants)
    .where(and(eq(agentGrants.agentId, agentId), eq(agentGrants.level, 'owner'), grantInForce));
  const made = owners.length
    ? await db
        .insert(notifications)
        .values(
          owners.map(({ userId }) => ({
            userId,
            kind: 'comment' as const,
            payload: { runId, taskId, commentId: comment.id },
          })),
        )
        .returning({ id: notifications.id })
    : [];
  return { id: comment.id, notifications: made.map((row) => row.id) };
}

/** The run's CLAUDE.md section of the thread: the last comments, oldest first. */
export async function threadSection(db: Db, taskId: string): Promise<string> {
  const rows = await db
    .select({
      body: taskComments.body,
      createdAt: taskComments.createdAt,
      person: users.name,
      agent: agents.name,
    })
    .from(taskComments)
    .leftJoin(users, eq(users.id, taskComments.authorUserId))
    .leftJoin(agents, eq(agents.id, taskComments.authorAgentId))
    .where(eq(taskComments.taskId, taskId))
    .orderBy(desc(taskComments.createdAt))
    .limit(IN_PROMPT);
  if (rows.length === 0) return '';
  const lines = rows.reverse().map((row) => {
    const who = row.agent ? `${row.agent} (an agent)` : (row.person ?? 'Someone');
    const when = row.createdAt.toISOString().slice(0, 16).replace('T', ' ');
    const body =
      row.body.length > IN_PROMPT_CHARS
        ? `${row.body.slice(0, IN_PROMPT_CHARS)}\n(Cut here: the rest is on the task's page.)`
        : row.body;
    return `### ${who}, ${when} UTC\n\n${body.trim()}`;
  });
  return `\n## The thread\n\nWhat people and agents wrote on this task, oldest first. A person's latest comment is what they want from this run: answer it. Write back with task_comment when you have something to tell them before your report.\n\n${lines.join('\n\n')}\n`;
}
