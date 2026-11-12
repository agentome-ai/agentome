import { priceUsage } from '@agentome/costs';
import {
  agentGrants,
  agents,
  costEvents,
  type Db,
  modelConnections,
  projectAgents,
  projects,
  runArtifacts,
  runEvents,
  runs,
  seats,
  tasks,
  toolCalls,
  getTableColumns,
} from '@agentome/db';
import { grantInForce } from '../agents/grants.js';
import type { RunEventDraft } from '@agentome/shared';
import { and, asc, eq, inArray, isNotNull, isNull, or, type SQL, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { AppError } from '../errors.js';
import { gitAccess } from '../git/credential.js';
import { connectionFor } from '../connections/service.js';
import { connectionsKey, decryptSecret } from '../connections/crypto.js';
import { skillsOf } from '../library/skills.js';
import { currentMemory } from '../memory/service.js';
import type { EventsBody, FinishBody, LaunchPackage, RunLimits } from '../protocol.js';
import { newToken } from '../tokens.js';
import { memberServer, teamForRun } from '../agents/team.js';
import { buildLaunchPackage, projectMd, runLimits, skillsSection } from './launch.js';
import { taskRepository } from '../tasks/repository.js';
import { taskHistory } from './history.js';
import { requireBudget } from '../budgets/service.js';
import { licenseState, requireWritable } from '../license/service.js';

/**
 * A run that has a seat and has not ended: running, or waiting for its owner to decide a tool
 * call. Heartbeats, events, finish, Cancel, the reaper and "this seat is busy" treat
 * both alike; otherwise a run waiting for approval would look ended to its own seat.
 */
export const LIVE_RUN_STATUSES = ['running', 'waiting_approval'] as const;
const isLive = () => inArray(runs.status, [...LIVE_RUN_STATUSES]);

/**
 * How long a run has stood waiting for a person, in seconds: its calls that had to be decided,
 * each from when it was asked to when it was decided, or to now while it still waits. Calls that
 * waited at the same time, as a team's members do, count once (`range_agg`). A call its policy
 * refused at once never waited: it has no `decided_at`.
 */
export const waitedSeconds = () =>
  // Written out with its own names: in a query of one table drizzle leaves the table off a
  // column, and `id` inside the subquery would then be the call's, not the run's.
  sql<number>`coalesce((
    select extract(epoch from sum(upper(wait) - lower(wait)))
    from unnest((
      select range_agg(tstzrange(tc.created_at, coalesce(tc.decided_at, now())))
      from tool_calls tc
      where tc.run_id = "runs"."id"
        and (tc.decision = 'pending'
          or (tc.decision in ('approved', 'denied') and tc.decided_at is not null))
    )) as wait
  ), 0)::float8`;

/**
 * When a running run's own time limit is up. The limit is for an agent that works too long, not
 * for a person who answers late: the time it waited is not its own.
 */
export const runDeadline = () =>
  sql<Date>`${runs.startedAt} + make_interval(mins => (${runs.limits}->>'maxMinutes')::int, secs => ${waitedSeconds()})`;

/**
 * A live run that may still act: not asked to stop and within its time. The gateway and the
 * git proxy open only these, so Cancel, a revoked seat, a disabled person or the time limit
 * close the run's tokens at once, whatever its computer does; heartbeats, events and finish
 * still pass, for the seat to hear it and report. `graceMinutes` past the time limit is for the
 * git proxy: the seat pushes a done run's commits after its CLI has ended.
 */
export const isWorking = (graceMinutes = 0) =>
  and(
    isLive(),
    isNull(runs.cancelRequestedAt),
    sql`${runDeadline()} + make_interval(mins => ${graceMinutes}) > now()`,
  );

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

// Every change of runs.status lives in this file: claim, finish, cancel and the reaper.
// Events never change it.

/**
 * Puts a task's run in the queue, for the first seat of the agent's owner to claim. In the
 * caller's transaction, when the task is created in it.
 */
export async function enqueueRun(
  db: Db | Tx,
  taskId: string,
  startedByUserId: string | null,
  // A webhook's run: nobody started it, and the agent is told why it runs.
  by?: { startedBy: 'webhook' | 'cron' | 'agent'; reason: string },
) {
  // A month spent refuses the run before anything is written, and so does a license
  // that has ended.
  await requireWritable(db);
  await requireBudget(db, taskId);
  const [task] = await db
    .select({ agentId: tasks.agentId })
    .from(tasks)
    .where(eq(tasks.id, taskId));
  if (!task) throw new AppError('not_found', 'Task not found');
  const [run] = await db
    .insert(runs)
    .values({
      agentId: task.agentId,
      taskId,
      startedBy: by?.startedBy ?? 'user',
      startedByUserId,
      reason: by?.reason ?? null,
    })
    .returning();
  if (!run) throw new Error('The run was not inserted');
  return run;
}

/**
 * Hands the oldest run this seat may take to it, or null. The queue is read with skip locked,
 * so two seats cannot take one run; the seat row is locked only once there is a run to take,
 * so a waiting seat costs one plain read a second, and two claims of one seat queue up there:
 * the second finds the first one's run and takes nothing.
 */
export async function claimRun(
  db: Db,
  seat: Pick<typeof seats.$inferSelect, 'id' | 'ownerUserId' | 'engines' | 'kind'>,
  options: { limits: RunLimits; publicUrl: string; secretKey: string },
): Promise<LaunchPackage | null> {
  // Runs queued before the license ended do not start after it either.
  if ((await licenseState(db)).status === 'read_only') return null;
  const onServer = seat.kind === 'api-server';
  const launch = await db.transaction(async (tx) => {
    // A computer takes its owner's computer agents; a server seat takes the server agents of anyone
    // that have a model connection.
    const whose = onServer
      ? and(eq(agents.runsOn, 'server'), isNotNull(agents.modelConnectionId))
      : and(eq(agents.ownerUserId, seat.ownerUserId), eq(agents.runsOn, 'laptop'));
    const [next] = await tx
      .select({ id: runs.id, taskId: runs.taskId, agent: agents })
      .from(runs)
      .innerJoin(agents, eq(agents.id, runs.agentId))
      .where(
        and(
          eq(runs.status, 'queued'),
          eq(agents.status, 'active'),
          whose,
          inArray(agents.engine, seat.engines),
        ),
      )
      .orderBy(asc(runs.createdAt), asc(runs.id))
      .limit(1)
      .for('update', { of: runs, skipLocked: true });
    if (!next) return null;
    // Read under the seat's lock, which taking back a Windows computer's waiver takes too: a
    // claim that was already waiting gets nothing once the admin has taken it back.
    const [active] = await tx
      .select({
        id: seats.id,
        kind: seats.kind,
        platform: sql<string | null>`${seats.capabilities}->>'platform'`,
        sandboxWaivedAt: seats.sandboxWaivedAt,
      })
      .from(seats)
      .where(and(eq(seats.id, seat.id), eq(seats.status, 'active')))
      .for('update');
    const [busy] = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.seatId, seat.id), isLive()))
      .limit(1);
    if (!active || busy) return null;
    const unsandboxed = active.kind === 'subscription-laptop' && active.platform === 'win32';
    if (unsandboxed && active.sandboxWaivedAt === null) return null;

    const { token, hash } = newToken();
    const limits = runLimits(options.limits, next.agent.budget);
    await tx
      .update(runs)
      .set({
        status: 'running',
        seatId: seat.id,
        startedAt: sql`now()`,
        lastHeartbeatAt: sql`now()`,
        tokenHash: hash,
        limits,
      })
      .where(eq(runs.id, next.id));
    const [task] = next.taskId
      ? await tx
          .select({ ...getTableColumns(tasks), repository: taskRepository })
          .from(tasks)
          .where(eq(tasks.id, next.taskId))
      : [];
    return buildLaunchPackage({
      run: { id: next.id, limits },
      token,
      agent: next.agent,
      task: task ?? null,
      publicUrl: options.publicUrl,
      onServer,
    });
  });
  if (!launch) return launch;
  // After the claim's transaction: the memory is read as it is now, by the run that got it.
  const memoryDocuments = (await currentMemory(db, launch.agent.id)).map(
    ({ path, version, content }) => ({ path, version, content }),
  );
  const project = await projectOf(db, launch.agent.id, launch.task);
  const [agent] = await db
    .select({ skills: agents.skills })
    .from(agents)
    .where(eq(agents.id, launch.agent.id));
  const skills = (await skillsOf(db, agent?.skills)).map(({ name, version, content }) => ({
    name,
    version,
    content,
  }));
  // A team runs as Claude Code's subagents: a Codex agent leads none.
  const team = launch.agent.engine === 'claude-code' ? await teamForRun(db, launch.agent.id) : null;
  const history = launch.task ? await taskHistory(db, launch.task.id, launch.run.id) : '';
  // The member tokens open the gateway once the run holds their hashes.
  if (team?.record) {
    await db.update(runs).set({ team: team.record }).where(eq(runs.id, launch.run.id));
  }
  const { settings } = launch.workspace.profile;
  const profile = {
    ...launch.workspace.profile,
    claudeMd:
      launch.workspace.profile.claudeMd + skillsSection(skills) + (team?.section ?? '') + history,
    ...(project && { projectMd: projectMd(project) }),
    settings: team?.launch
      ? {
          ...settings,
          allowedTools: [
            ...settings.allowedTools,
            'Agent',
            ...team.launch.members.map((member) => `mcp__${memberServer(member.key)}`),
          ],
        }
      : settings,
  };
  const model = onServer ? await modelOf(db, launch.agent.id, options.secretKey) : undefined;
  const withContext: LaunchPackage = {
    ...launch,
    ...(model && { model }),
    agent: { ...launch.agent, memoryDocuments, skills },
    ...(team?.launch && { team: team.launch }),
    workspace: { ...launch.workspace, profile },
  };
  return withGit(db, withContext, options);
}

/**
 * A server run's model connection, its key decrypted for the seat. A connection deleted
 * after the claim leaves the run without one, and the worker fails it with that reason.
 */
async function modelOf(db: Db, agentId: string, secretKey: string) {
  const [row] = await db
    .select({
      kind: modelConnections.kind,
      baseUrl: modelConnections.baseUrl,
      keyCiphertext: modelConnections.keyCiphertext,
    })
    .from(agents)
    .innerJoin(modelConnections, eq(modelConnections.id, agents.modelConnectionId))
    .where(eq(agents.id, agentId));
  if (!row) return undefined;
  const key = decryptSecret(connectionsKey(secretKey), row.keyCiphertext);
  return { kind: row.kind, baseUrl: row.baseUrl, key };
}

/**
 * The project of a run's task: the one it was filed in, else the one whose connection covers its
 * repository, else the agent's only project. Filed first: a folder on the computer is no
 * connection's, and the task is still its project's. An agent on several projects with nothing
 * to tell them apart gets none.
 */
async function projectOf(
  db: Db,
  agentId: string,
  task: { id: string; repository: string | null } | null,
) {
  const fields = {
    name: projects.name,
    description: projects.description,
    goals: projects.goals,
    repositories: projects.repositories,
  };
  if (task) {
    // Only while the agent is still on it: one taken off its project no longer reads it.
    const [filed] = await db
      .select(fields)
      .from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .innerJoin(
        projectAgents,
        and(eq(projectAgents.projectId, projects.id), eq(projectAgents.agentId, agentId)),
      )
      .where(eq(tasks.id, task.id));
    if (filed) return filed;
  }
  const connection = await connectionFor(db, agentId, task?.repository ?? null);
  if (connection) {
    const [project] = await db
      .select(fields)
      .from(projects)
      .where(eq(projects.id, connection.project.id));
    return project;
  }
  const mine = await db
    .select(fields)
    .from(projects)
    .innerJoin(projectAgents, eq(projectAgents.projectId, projects.id))
    .where(eq(projectAgents.agentId, agentId))
    .limit(2);
  return mine.length === 1 ? mine[0] : undefined;
}

async function withGit(
  db: Db,
  launch: LaunchPackage,
  options: { publicUrl: string; secretKey: string },
): Promise<LaunchPackage> {
  if (!launch.task) return launch;
  const git = await gitAccess(db, {
    runId: launch.run.id,
    agentId: launch.agent.id,
    repository: launch.task.repository,
    publicUrl: options.publicUrl,
    secretKey: options.secretKey,
  });
  return git ? { ...launch, workspace: { ...launch.workspace, git } } : launch;
}

/** What a run token opens: its own run, and only while the run is running. */
const live = (runId: string, tokenHash: string) =>
  and(eq(runs.id, runId), eq(runs.tokenHash, tokenHash), isLive());

/**
 * A sign of life from a running run: locks its row, so the reaper and finish wait for the
 * batch instead of racing it. Undefined when the token does not open the run (any more).
 */
async function touchRun(tx: Db | Tx, runId: string, tokenHash: string) {
  const [run] = await tx
    .update(runs)
    .set({ lastHeartbeatAt: sql`now()` })
    .where(live(runId, tokenHash))
    .returning({ seatId: runs.seatId, cancelRequestedAt: runs.cancelRequestedAt });
  return run;
}

export async function recordEvents(
  db: Db,
  runId: string,
  tokenHash: string,
  events: z.infer<typeof EventsBody>,
) {
  return db.transaction(async (tx) => {
    const run = await touchRun(tx, runId, tokenHash);
    if (!run) return null;
    // A batch sent again, whole or in part, adds nothing: seq is unique within a run.
    const inserted = events.length
      ? await tx
          .insert(runEvents)
          .values(
            events.map((event) => ({
              runId,
              seq: event.seq,
              type: event.type,
              payload: event.payload,
              createdAt: new Date(event.at),
            })),
          )
          .onConflictDoNothing({ target: [runEvents.runId, runEvents.seq] })
          .returning({ id: runEvents.id })
      : [];
    return { accepted: inserted.length, cancelRequested: run.cancelRequestedAt !== null };
  });
}

export async function heartbeat(db: Db, runId: string, tokenHash: string) {
  const run = await touchRun(db, runId, tokenHash);
  if (!run) return null;
  // A seat busy with a long run claims nothing, so its heartbeat is what keeps it "seen".
  // Not in one transaction with the run: revoking a seat locks the seat before its run.
  if (run.seatId) {
    await db
      .update(seats)
      .set({ lastSeenAt: sql`now()` })
      .where(eq(seats.id, run.seatId));
  }
  // What the worker's own timer moves by: it stops the CLI at the limit whatever the server says.
  const [waited] = await db
    .select({ seconds: waitedSeconds() })
    .from(runs)
    .where(eq(runs.id, runId));
  return {
    cancelRequested: run.cancelRequestedAt !== null,
    waitedMs: Math.round((waited?.seconds ?? 0) * 1000),
  };
}

/** Ends a running run with what the seat reports; the run token dies with it. */
export async function finishRun(
  db: Db,
  runId: string,
  tokenHash: string,
  body: z.infer<typeof FinishBody>,
) {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .update(runs)
      .set({
        status: body.status,
        endedAt: sql`now()`,
        summary: body.summary ?? null,
        errorCode: body.errorCode ?? null,
        tokenHash: null,
      })
      .where(live(runId, tokenHash))
      .returning({ agentId: runs.agentId, status: runs.status, taskId: runs.taskId });
    if (!run) return null;
    if (body.artifacts.length) {
      await tx.insert(runArtifacts).values(body.artifacts.map((item) => ({ runId, ...item })));
    }
    // A run that is done hands its work over: the task waits for a person to review it, who marks
    // it done or runs it again. One closed or reopened by hand stays as it is.
    if (run.status === 'done' && run.taskId) {
      await tx
        .update(tasks)
        .set({ status: 'review' })
        .where(and(eq(tasks.id, run.taskId), eq(tasks.status, 'open')));
    }
    // The seat reports tokens, never dollars: the server prices them from LiteLLM's table, and a
    // model the table does not know stays unpriced (usd null) rather than guessed. priceUsage
    // throws only for counts the finish schema already refuses, so pricing cannot veto a finish.
    if (body.usage.length) {
      await tx.insert(costEvents).values(
        body.usage.map((usage) => ({
          runId,
          agentId: run.agentId,
          ...usage,
          usd: priceUsage(usage).usd,
        })),
      );
    }
    return { status: run.status, taskId: run.taskId };
  });
}

/**
 * A queued run is cancelled at once; a running one is asked to stop, and its seat finishes
 * it as cancelled after the next heartbeat. Only the agent's owner may cancel.
 */
export async function cancelRun(db: Db, runId: string, userId: string) {
  const owner = and(
    eq(agentGrants.agentId, runs.agentId),
    eq(agentGrants.userId, userId),
    eq(agentGrants.level, 'owner'),
    grantInForce,
  );
  const state = { status: runs.status, cancelRequestedAt: runs.cancelRequestedAt };
  const [owned] = await db
    .select(state)
    .from(runs)
    .innerJoin(agentGrants, owner)
    .where(eq(runs.id, runId));
  if (!owned) throw new AppError('not_found', 'Run not found');
  // Two guarded updates: a claim that takes the run in between turns the first into a no-op
  // and the second into the stop request. A finished run stays as it is.
  await db
    .update(runs)
    .set({ status: 'cancelled', cancelRequestedAt: sql`now()`, endedAt: sql`now()` })
    .where(and(eq(runs.id, runId), eq(runs.status, 'queued')));
  await requestStop(db, eq(runs.id, runId));
  // A call waiting for approval would hold the run until its time ran out: Cancel answers it.
  await db
    .update(toolCalls)
    .set({
      decision: 'denied',
      reason: 'The run was cancelled.',
      decidedBy: userId,
      decidedAt: sql`now()`,
    })
    .where(and(eq(toolCalls.runId, runId), eq(toolCalls.decision, 'pending')));
  const [run = owned] = await db.select(state).from(runs).where(eq(runs.id, runId));
  return { status: run.status, cancelRequested: run.cancelRequestedAt !== null };
}

/**
 * Cancels the queued runs of an agent that is archived: claim skips an archived agent, so a
 * run left waiting would start whenever the agent came back. A run already going finishes.
 */
export async function cancelQueuedRuns(db: Db | Tx, agentId: string) {
  await db
    .update(runs)
    .set({ status: 'cancelled', cancelRequestedAt: sql`now()`, endedAt: sql`now()` })
    .where(and(eq(runs.agentId, agentId), eq(runs.status, 'queued')));
}

/**
 * Closes running runs whose seat fell silent, and those whose seat goes on sending heartbeats
 * the same minutes past a stop request or the run's time limit: a seat that ignores both would
 * otherwise keep its run open. pg-boss calls it once a minute.
 */
export async function reapOrphanedRuns(db: Db, orphanMinutes: number): Promise<string[]> {
  const grace = sql`make_interval(mins => ${orphanMinutes})`;
  return db.transaction(async (tx) => {
    const silent = await tx
      .update(runs)
      .set({ status: 'failed', endedAt: sql`now()`, errorCode: 'orphaned', tokenHash: null })
      .where(
        and(isLive(), sql`coalesce(${runs.lastHeartbeatAt}, ${runs.startedAt}) < now() - ${grace}`),
      )
      .returning({ id: runs.id });
    const asked = sql`${runs.cancelRequestedAt} is not null`;
    const overstayed = await tx
      .update(runs)
      .set({
        status: sql`case when ${asked} then 'cancelled' else 'failed' end::run_status`,
        endedAt: sql`now()`,
        errorCode: sql`case when ${asked} then null else 'timeout' end`,
        tokenHash: null,
      })
      .where(
        and(
          isLive(),
          or(
            sql`${runs.cancelRequestedAt} < now() - ${grace}`,
            sql`${runDeadline()} < now() - ${grace}`,
          ),
        ),
      )
      .returning({ id: runs.id, cancelled: sql<boolean>`${runs.status} = 'cancelled'` });
    const notes = [
      ...silent.map(({ id }) => ({ id, note: orphaned(orphanMinutes) })),
      ...overstayed.map(({ id, cancelled }) => ({ id, note: overstay(cancelled) })),
    ];
    for (const { id, note } of notes) {
      // After the run's last event: the row lock above made any batch in flight finish first.
      // A transcript already at the largest seq gets no note rather than stopping the reaper.
      const last = sql`(select coalesce(max(${runEvents.seq}), -1)::bigint from ${runEvents} where ${runEvents.runId} = ${id})`;
      await tx
        .insert(runEvents)
        .values({
          runId: id,
          seq: sql`least(${last} + 1, 2147483647)::int`,
          type: 'error',
          payload: note,
        })
        .onConflictDoNothing();
    }
    return notes.map((item) => item.id);
  });
}

// The fields of the shared `error` event: the run page folds the server's events with the
// seat's, so this one has to read as a fatal error like any other.
type ErrorFields = Omit<Extract<RunEventDraft, { type: 'error' }>, 'type'>;
const orphaned = (minutes: number): ErrorFields => ({
  code: 'orphaned',
  message: `The computer sent no heartbeat for ${minutes} minutes.`,
  fatal: true,
});
const overstay = (cancelled: boolean): ErrorFields =>
  cancelled
    ? {
        code: 'cancelled',
        message: 'The run was asked to stop, and its computer did not stop it.',
        fatal: true,
      }
    : {
        code: 'timeout',
        message: 'The run went past its time limit, and its computer did not stop it.',
        fatal: true,
      };

/**
 * Asks the running runs that `which` picks to stop: Cancel picks one run, revoking a seat its
 * run. The seat hears it in its next heartbeat; an earlier request keeps its time.
 */
export async function requestStop(db: Db | Tx, which: SQL) {
  await db
    .update(runs)
    .set({ cancelRequestedAt: sql`coalesce(${runs.cancelRequestedAt}, now())` })
    .where(and(which, isLive()));
}
