import { setTimeout as sleep } from 'node:timers/promises';
import { agentGrants, agents, and, type Db, eq, inArray, runs, sql, toolCalls } from '@agentome/db';
import { grantInForce } from '../agents/grants.js';
import type { ToolDecision } from '@agentome/shared';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { isWorking, LIVE_RUN_STATUSES } from '../runs/service.js';

// The policy on a tool call: allow runs it, deny refuses it with a reason,
// ask makes it wait for the agent's owner. Not a workflow step: one row and a decision.

export type Policy = 'allow' | 'ask' | 'deny';

/**
 * What every agent gets until its own policy says otherwise: what others read first waits, as
 * whatever the agent writes outside the platform could carry what it read. Inside it (a task's
 * comments, the agent's memory) everything is kept and shown, version by version.
 */
const DEFAULTS: Record<string, Policy> = {
  code_host_open_change_request: 'ask',
  code_host_reply_to_review: 'ask',
  jira_add_comment: 'ask',
};

const Override = z.array(
  z.object({ name: z.string(), policy: z.enum(['allow', 'ask', 'deny']) }).catch(null as never),
);

/**
 * The policy of one tool for an agent: its own entry in `agents.tools`, else the default. A
 * library server's tool (`<server>__<tool>`) asks first: nobody has read what it does.
 */
export function policyFor(agentTools: unknown, tool: string): Policy {
  return ownPolicy(agentTools, tool) ?? DEFAULTS[tool] ?? (tool.includes('__') ? 'ask' : 'allow');
}

/** The agent's own entry for a tool, if its owner set one. */
export function ownPolicy(agentTools: unknown, tool: string): Policy | undefined {
  return Override.catch([])
    .parse(agentTools)
    .find((entry) => entry?.name === tool)?.policy;
}

/** How often a waiting call reads its row, and tells the client it is still alive. */
const POLL_MS = 2_000;
const PROGRESS_MS = 10_000;

type Waiting = {
  readonly id: string;
  readonly runId: string;
  readonly onProgress?: (waitedMs: number) => Promise<void>;
  readonly signal?: AbortSignal;
};

/**
 * Waits for the owner's decision on a pending call. It ends with that decision, or `denied`
 * when the run ends or the client hangs up; the run is waiting for approval meanwhile, and
 * running again after. The run's time limit does not end the wait: the time a run waits for
 * its owner is not the run's own (`runDeadline`), so a question asked on Friday is still open
 * on Monday.
 */
export async function awaitDecision(
  db: Db,
  call: Waiting,
): Promise<{ decision: ToolDecision; reason: string | null }> {
  const started = Date.now();
  let progressed = started;
  try {
    for (;;) {
      const [row] = await db
        .select({
          decision: toolCalls.decision,
          reason: toolCalls.reason,
          status: runs.status,
          cancelRequestedAt: runs.cancelRequestedAt,
        })
        .from(toolCalls)
        .innerJoin(runs, eq(runs.id, toolCalls.runId))
        .where(eq(toolCalls.id, call.id));
      const ended =
        !row ||
        row.cancelRequestedAt !== null ||
        !(LIVE_RUN_STATUSES as readonly string[]).includes(row.status);
      const stopped = ended || call.signal?.aborted === true;
      // A denial stands whenever it came; an approval only while the run can still use it,
      // so an Approve that lands between two polls after the run stopped runs nothing.
      if (row?.decision === 'denied' || (row?.decision === 'approved' && !stopped)) {
        return { decision: row.decision, reason: row.reason };
      }
      if (stopped) {
        const reason = row?.cancelRequestedAt
          ? 'The run was cancelled.'
          : ended
            ? 'The run ended before anyone decided.'
            : 'The agent stopped waiting.';
        return await settle(db, call.id, 'denied', reason, undefined, ['pending', 'approved']);
      }
      if (call.onProgress && Date.now() - progressed >= PROGRESS_MS) {
        progressed = Date.now();
        await call.onProgress(progressed - started).catch(() => undefined);
      }
      await sleep(POLL_MS, undefined, { signal: call.signal }).catch(() => undefined);
    }
  } finally {
    // Back to running, unless another call of the same run still waits.
    await db
      .update(runs)
      .set({ status: 'running' })
      .where(
        and(
          eq(runs.id, call.runId),
          eq(runs.status, 'waiting_approval'),
          sql`not exists (select 1 from ${toolCalls} where ${toolCalls.runId} = ${call.runId} and ${toolCalls.decision} = 'pending')`,
        ),
      );
  }
}

/** Closes a pending call with a decision, if nobody else did first; returns what stands. */
async function settle(
  db: Db,
  id: string,
  decision: 'approved' | 'denied',
  reason: string | null,
  userId?: string,
  from: ('pending' | 'approved')[] = ['pending'],
) {
  const [row] = await db
    .update(toolCalls)
    .set({ decision, reason, decidedBy: userId ?? null, decidedAt: sql`now()` })
    .where(and(eq(toolCalls.id, id), inArray(toolCalls.decision, from)))
    .returning({ decision: toolCalls.decision, reason: toolCalls.reason });
  if (row) return row;
  const [current] = await db
    .select({ decision: toolCalls.decision, reason: toolCalls.reason })
    .from(toolCalls)
    .where(eq(toolCalls.id, id));
  return current ?? { decision, reason };
}

/**
 * The owner's decision on a pending call; Approvals calls it. Only the agent's
 * owner decides, a call already decided keeps its first decision, and only a call
 * whose run is live, not asked to stop and within its time can be decided: nobody waits on
 * any other, so an approval of it could only run a tool for a run that is over.
 */
export async function decideToolCall(
  db: Db,
  input: {
    id: string;
    decision: 'approved' | 'denied';
    userId: string;
    reason?: string;
    /** An answer to ask_owner: only a question takes one, and a question needs one. */
    answer?: boolean;
  },
) {
  // The same owner check as Cancel (runs/service.ts): a grant of level owner on the agent.
  const [owned] = await db
    .select({ id: toolCalls.id, tool: toolCalls.tool })
    .from(toolCalls)
    .innerJoin(
      agentGrants,
      and(
        eq(agentGrants.agentId, toolCalls.agentId),
        eq(agentGrants.userId, input.userId),
        eq(agentGrants.level, 'owner'),
        grantInForce,
      ),
    )
    .where(eq(toolCalls.id, input.id));
  if (!owned) throw new AppError('not_found', 'Tool call not found');
  const question = owned.tool === 'ask_owner';
  if (input.answer && !question) {
    throw new AppError('validation_failed', 'Only a question takes an answer');
  }
  if (question && input.decision === 'approved' && !input.answer) {
    throw new AppError('validation_failed', 'Answer the question, or skip it');
  }
  const [waiting] = await db
    .select({ id: runs.id })
    .from(toolCalls)
    .innerJoin(runs, eq(runs.id, toolCalls.runId))
    .where(and(eq(toolCalls.id, input.id), isWorking()));
  if (!waiting) {
    throw new AppError('not_found', 'This request is no longer waiting: its run has ended');
  }
  return settle(db, input.id, input.decision, input.reason ?? null, input.userId);
}

/**
 * Writes one tool's policy into the agent's list, in one statement, so that two quick changes of
 * different tools cannot drop each other. Whether the agent has such a tool is the caller's to
 * check.
 */
export async function setPolicy(db: Db, agentId: string, name: string, policy: Policy) {
  const entry = JSON.stringify([{ name, policy }]);
  const [row] = await db
    .update(agents)
    .set({
      tools: sql`coalesce((select jsonb_agg(e) from jsonb_array_elements(${agents.tools}) e where e->>'name' is distinct from ${name}), '[]'::jsonb) || ${entry}::jsonb`,
    })
    .where(eq(agents.id, agentId))
    .returning();
  return row;
}

/**
 * Approve, and stop asking: the call runs, and from now on the agent uses that tool
 * without its owner's say. A question is asked each time, whatever its policy.
 */
export async function approveForGood(db: Db, input: { id: string; userId: string }) {
  const [call] = await db
    .select({ agentId: toolCalls.agentId, tool: toolCalls.tool })
    .from(toolCalls)
    .where(eq(toolCalls.id, input.id));
  if (call?.tool === 'ask_owner') {
    throw new AppError('validation_failed', 'A question is asked each time: answer this one');
  }
  const decided = await decideToolCall(db, { ...input, decision: 'approved' });
  // The first decision wins: after someone's Deny the policy stays as it was.
  if (call && decided.decision === 'approved')
    await setPolicy(db, call.agentId, call.tool, 'allow');
  return decided;
}
