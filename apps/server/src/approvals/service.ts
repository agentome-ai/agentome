import { agents, and, asc, type Db, eq, inArray, runs, tasks, toolCalls } from '@agentome/db';
import { grantedTo } from '../agents/service.js';
import { LIVE_RUN_STATUSES } from '../runs/service.js';
import { taskRepository } from '../tasks/repository.js';

// Approvals: the pending tool calls of a person's agents, oldest first; the
// notification that tells the owners one is waiting is push/service.ts. The decision itself is decideToolCall
// (mcp/policy.ts): the gateway reads the row, so writing it is what wakes the waiting call.

/** Calls waiting for a decision on agents the person holds a grant on, oldest first. */
export async function listApprovals(db: Db, userId: string) {
  const rows = await db
    .select({
      id: toolCalls.id,
      tool: toolCalls.tool,
      input: toolCalls.input,
      createdAt: toolCalls.createdAt,
      runId: toolCalls.runId,
      agent: { id: agents.id, name: agents.name },
      taskId: tasks.id,
      taskTitle: tasks.title,
      repository: taskRepository,
    })
    .from(toolCalls)
    .innerJoin(agents, eq(agents.id, toolCalls.agentId))
    .innerJoin(runs, eq(runs.id, toolCalls.runId))
    .leftJoin(tasks, eq(tasks.id, runs.taskId))
    .where(
      and(
        eq(toolCalls.decision, 'pending'),
        // A call left pending by a server that went down with its run waits for nobody.
        inArray(runs.status, [...LIVE_RUN_STATUSES]),
        grantedTo(userId, toolCalls.agentId),
      ),
    )
    .orderBy(asc(toolCalls.createdAt), asc(toolCalls.id));
  return rows.map(({ taskId, taskTitle, repository, createdAt, ...call }) => ({
    ...call,
    task: taskId && taskTitle !== null ? { id: taskId, title: taskTitle, repository } : null,
    createdAt: createdAt.toISOString(),
  }));
}
