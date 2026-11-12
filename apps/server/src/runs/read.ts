import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  agents,
  and,
  asc,
  costEvents,
  type Db,
  desc,
  eq,
  gt,
  inArray,
  runArtifacts,
  runEvents,
  runs,
  runStartedByEnum,
  seats,
  type SQL,
  sql,
  tasks,
  toolCalls,
  users,
} from '@agentome/db';
import { ArtifactKind, RunEvent, RunStatus, ToolDecision } from '@agentome/shared';
import { z } from 'zod';
import { grantedTo } from '../agents/service.js';
import { RunTeam } from '../agents/team.js';
import type { SessionUser } from '../auth.js';
import { AppError } from '../errors.js';
import { RunLimits } from '../protocol.js';

// What people read about runs: the list, one run, its transcript
// and the transcript live. Nothing here changes a run; that is service.ts.

/** The most events one answer carries. */
export const EVENTS_PAGE = 1000;
const TERMINAL: ReadonlySet<RunStatus> = new Set<RunStatus>(['done', 'failed', 'cancelled']);

const Iso = z.iso.datetime();
// The input the gateway wrote for a team step (mcp/routes.ts); anything else names nobody.
const stepMembers = (input: unknown) =>
  z
    .object({ members: z.array(z.object({ id: z.uuid() })) })
    .catch({ members: [] })
    .parse(input)
    .members.map((member) => member.id);
const Ref = z.object({ id: z.uuid(), name: z.string() });
const Tokens = z.number().int().nonnegative();
// As GET /api/agents takes it: true or false, nothing else.
const AdminAll = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true')
  .describe('An admin reads every run');

export const ReadQuery = z.object({ all: AdminAll });
export const EventsQuery = ReadQuery.extend({
  after: z.coerce.number().int().min(-1).max(2_147_483_647).default(-1),
});
// The runs not yet over: queued, running or waiting for a person. The Runs page opens on them.
const LIVE: RunStatus[] = ['queued', 'running', 'waiting_approval'];

export const ListQuery = ReadQuery.extend({
  agent: z.uuid().optional(),
  task: z.uuid().optional(),
  status: z.union([RunStatus, z.literal('live')]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** The createdAt of the last run of the previous page, as the API wrote it. */
  before: z.iso.datetime({ offset: true }).optional(),
});

const RunSummary = z.object({
  id: z.uuid(),
  status: RunStatus,
  agent: Ref,
  /** With its project, which the dashboard's project cards group runs by. */
  task: z.object({ id: z.uuid(), title: z.string(), projectId: z.uuid().nullable() }).nullable(),
  /** The computer, and whose it is: the pages say the person. */
  seat: Ref.extend({ owner: Ref }).nullable(),
  startedBy: z.object({ kind: z.enum(runStartedByEnum.enumValues), user: Ref.nullable() }),
  startedAt: Iso.nullable(),
  endedAt: Iso.nullable(),
  errorCode: z.string().nullable(),
  /** With microseconds, so that it pages exactly as `before`. */
  createdAt: Iso,
});
export const RunList = z.object({
  runs: z.array(
    RunSummary.extend({ cost: z.object({ usd: z.string().nullable(), tokens: Tokens }) }),
  ),
  nextBefore: Iso.nullable(),
});
export const RunDetail = RunSummary.extend({
  limits: RunLimits.nullable(),
  cancelRequestedAt: Iso.nullable(),
  summary: z.string().nullable(),
  artifacts: z.array(
    z.object({
      id: z.uuid(),
      kind: ArtifactKind,
      ref: z.string(),
      meta: z.record(z.string(), z.unknown()),
      createdAt: Iso,
    }),
  ),
  // The gateway's calls of this run and who decided them: the transcript shows a
  // wait for approval and its decision under the call. Not run events, which the seat numbers.
  toolCalls: z.array(
    z.object({
      tool: z.string(),
      /** The lead's, or in a team run the member's whose tools made the call. */
      agentId: z.uuid(),
      decision: ToolDecision,
      reason: z.string().nullable(),
      decidedBy: z.object({ id: z.string(), name: z.string() }).nullable(),
      createdAt: Iso,
      /** A team step's members (`team_step`): their assignments wait on this decision. */
      members: z.array(z.uuid()).optional(),
    }),
  ),
  /** A team run's members by the key the transcript names them by; empty otherwise. */
  team: z.array(z.object({ key: z.string(), agentId: z.uuid(), name: z.string() })),
  cost: z.object({
    rows: z.array(
      z.object({
        model: z.string(),
        tokensIn: Tokens,
        tokensOut: Tokens,
        tokensCacheRead: Tokens,
        tokensCacheWrite: Tokens,
        usd: z.string().nullable(),
      }),
    ),
    totalUsd: z.string().nullable(),
    /** Some tokens have no price: the model is not in the table, or nobody priced them yet. */
    unpriced: z.boolean(),
  }),
});
export const EventPage = z.object({ events: z.array(RunEvent), nextAfter: z.int().nullable() });

const iso = (date: Date | null) => date?.toISOString() ?? null;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The runs a person may read: those of agents they hold a grant on, by the agents' own check;
 * every run for an admin who asks for all of them. Cancel still needs the owner grant.
 */
export function readableBy(user: SessionUser, all: boolean): SQL | undefined {
  if (!all) return grantedTo(user.id);
  if (user.role !== 'admin') throw new AppError('forbidden', 'Only admins can see every run');
  return undefined;
}

// Someone else's run is not found, rather than forbidden: its id says nothing.
const notFound = () => new AppError('not_found', 'Run not found');

const costOfRun = <T>(aggregate: SQL) =>
  sql<T>`(select ${aggregate} from ${costEvents} where ${costEvents.runId} = ${runs.id})`;
// The four counts of a row in int8, so that their sum cannot overflow.
const allTokens = sql`${costEvents.tokensIn}::int8 + ${costEvents.tokensOut} + ${costEvents.tokensCacheRead} + ${costEvents.tokensCacheWrite}`;

function selectRuns(db: Db, where: SQL | undefined, limit: number) {
  return db
    .select({
      id: runs.id,
      status: runs.status,
      agentId: runs.agentId,
      agentName: agents.name,
      taskId: tasks.id,
      taskTitle: tasks.title,
      taskProjectId: tasks.projectId,
      seatId: seats.id,
      seatName: seats.name,
      seatOwnerId: seats.ownerUserId,
      // The owner's name by subquery: users is already joined for who started the run.
      seatOwnerName: sql<
        string | null
      >`(select ${users.name} from ${users} where ${users.id} = ${seats.ownerUserId})`,
      startedBy: runs.startedBy,
      userId: users.id,
      userName: users.name,
      startedAt: runs.startedAt,
      endedAt: runs.endedAt,
      errorCode: runs.errorCode,
      createdAt: sql<string>`to_char(${runs.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      usd: costOfRun<string | null>(sql`sum(${costEvents.usd})::text`),
      tokens: costOfRun<number>(sql`coalesce(sum(${allTokens}), 0)::float8`),
    })
    .from(runs)
    .innerJoin(agents, eq(agents.id, runs.agentId))
    .leftJoin(tasks, eq(tasks.id, runs.taskId))
    .leftJoin(seats, eq(seats.id, runs.seatId))
    .leftJoin(users, eq(users.id, runs.startedByUserId))
    .where(where)
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(limit);
}

type RunRow = Awaited<ReturnType<typeof selectRuns>>[number];

function toSummary(row: RunRow) {
  return {
    id: row.id,
    status: row.status,
    agent: { id: row.agentId, name: row.agentName },
    task:
      row.taskId && row.taskTitle !== null
        ? { id: row.taskId, title: row.taskTitle, projectId: row.taskProjectId }
        : null,
    seat:
      row.seatId && row.seatName !== null
        ? {
            id: row.seatId,
            name: row.seatName,
            owner: { id: row.seatOwnerId ?? '', name: row.seatOwnerName ?? '' },
          }
        : null,
    startedBy: {
      kind: row.startedBy,
      user: row.userId && row.userName !== null ? { id: row.userId, name: row.userName } : null,
    },
    startedAt: iso(row.startedAt),
    endedAt: iso(row.endedAt),
    errorCode: row.errorCode,
    createdAt: row.createdAt,
  };
}

/** Newest first, one page; `nextBefore` is null on the last page. */
export async function listRuns(
  db: Db,
  user: SessionUser,
  query: z.infer<typeof ListQuery>,
): Promise<z.infer<typeof RunList>> {
  const where = and(
    readableBy(user, query.all),
    query.agent ? eq(runs.agentId, query.agent) : undefined,
    query.task ? eq(runs.taskId, query.task) : undefined,
    query.status === 'live'
      ? inArray(runs.status, LIVE)
      : query.status
        ? eq(runs.status, query.status)
        : undefined,
    query.before ? sql`${runs.createdAt} < ${query.before}::timestamptz` : undefined,
  );
  // One more than the page: whether a next page exists, without a count.
  const rows = await selectRuns(db, where, query.limit + 1);
  const page = rows.slice(0, query.limit);
  return {
    runs: page.map((row) => ({ ...toSummary(row), cost: { usd: row.usd, tokens: row.tokens } })),
    nextBefore: rows.length > query.limit ? (page.at(-1)?.createdAt ?? null) : null,
  };
}

export async function getRun(
  db: Db,
  user: SessionUser,
  runId: string,
  all: boolean,
): Promise<z.infer<typeof RunDetail>> {
  const [row] = await selectRuns(db, and(eq(runs.id, runId), readableBy(user, all)), 1);
  if (!row) throw notFound();
  const [[extra], artifacts, calls, models, [total]] = await Promise.all([
    db
      .select({
        limits: runs.limits,
        cancelRequestedAt: runs.cancelRequestedAt,
        summary: runs.summary,
        team: runs.team,
      })
      .from(runs)
      .where(eq(runs.id, runId)),
    db
      .select()
      .from(runArtifacts)
      .where(eq(runArtifacts.runId, runId))
      // One finish writes them at one time: the kind settles the order.
      .orderBy(asc(runArtifacts.createdAt), asc(runArtifacts.kind), asc(runArtifacts.id)),
    db
      .select({
        tool: toolCalls.tool,
        agentId: toolCalls.agentId,
        decision: toolCalls.decision,
        reason: toolCalls.reason,
        deciderId: users.id,
        deciderName: users.name,
        createdAt: toolCalls.createdAt,
        input: toolCalls.input,
      })
      .from(toolCalls)
      .leftJoin(users, eq(users.id, toolCalls.decidedBy))
      .where(eq(toolCalls.runId, runId))
      .orderBy(asc(toolCalls.createdAt), asc(toolCalls.id)),
    db
      .select({
        model: costEvents.model,
        tokensIn: sql<number>`sum(${costEvents.tokensIn})::float8`,
        tokensOut: sql<number>`sum(${costEvents.tokensOut})::float8`,
        tokensCacheRead: sql<number>`sum(${costEvents.tokensCacheRead})::float8`,
        tokensCacheWrite: sql<number>`sum(${costEvents.tokensCacheWrite})::float8`,
        usd: sql<
          string | null
        >`case when bool_or(${costEvents.usd} is null) then null else sum(${costEvents.usd})::text end`,
      })
      .from(costEvents)
      .where(eq(costEvents.runId, runId))
      .groupBy(costEvents.model)
      .orderBy(costEvents.model),
    db
      .select({
        usd: sql<string | null>`sum(${costEvents.usd})::text`,
        unpriced: sql<boolean>`coalesce(bool_or(${costEvents.usd} is null), false)`,
      })
      .from(costEvents)
      .where(eq(costEvents.runId, runId)),
  ]);
  const members = RunTeam.safeParse(extra?.team).data?.members ?? [];
  const names = members.length
    ? await db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(
          inArray(
            agents.id,
            members.map((member) => member.agentId),
          ),
        )
    : [];
  return {
    ...toSummary(row),
    limits: extra?.limits ?? null,
    cancelRequestedAt: iso(extra?.cancelRequestedAt ?? null),
    summary: extra?.summary ?? null,
    artifacts: artifacts.map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      ref: artifact.ref,
      meta: isRecord(artifact.meta) ? artifact.meta : {},
      createdAt: artifact.createdAt.toISOString(),
    })),
    toolCalls: calls.map((call) => ({
      tool: call.tool,
      agentId: call.agentId,
      decision: call.decision,
      reason: call.reason,
      decidedBy: call.deciderId ? { id: call.deciderId, name: call.deciderName ?? '' } : null,
      createdAt: call.createdAt.toISOString(),
      ...(call.tool === 'team_step' && { members: stepMembers(call.input) }),
    })),
    team: members.map(({ key, agentId }) => ({
      key,
      agentId,
      name: names.find((agent) => agent.id === agentId)?.name ?? key,
    })),
    cost: { rows: models, totalUsd: total?.usd ?? null, unpriced: total?.unpriced ?? false },
  };
}

/** 404 unless the person may read the run. */
export async function assertReadable(db: Db, user: SessionUser, runId: string, all: boolean) {
  const [run] = await db
    .select({ id: runs.id })
    .from(runs)
    .innerJoin(agents, eq(agents.id, runs.agentId))
    .where(and(eq(runs.id, runId), readableBy(user, all)));
  if (!run) throw notFound();
}

/**
 * A stored event as the shared schema reads it: `{ ...payload, seq, type, at }`. A row that is
 * not a valid RunEvent stays in the transcript as `unknown`, with what was stored, rather than
 * vanishing: the server keeps whatever a seat sent.
 */
export function toRunEvent(row: {
  seq: number;
  type: string;
  payload: unknown;
  createdAt: Date;
}): RunEvent {
  const at = row.createdAt.toISOString();
  const payload = isRecord(row.payload) ? row.payload : {};
  const parsed = RunEvent.safeParse({ ...payload, seq: row.seq, type: row.type, at });
  if (parsed.success) return parsed.data;
  const raw = { type: row.type, payload: row.payload };
  return { type: 'unknown', rawType: 'unparsed', raw, seq: row.seq, at };
}

/** The events after `after`, in seq order, at most `limit` of them. */
export async function readEvents(db: Db, runId: string, after: number, limit = EVENTS_PAGE) {
  const rows = await db
    .select({
      seq: runEvents.seq,
      type: runEvents.type,
      payload: runEvents.payload,
      createdAt: runEvents.createdAt,
    })
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, after)))
    .orderBy(asc(runEvents.seq))
    .limit(limit);
  return rows.map(toRunEvent);
}

export const STREAM_TIMING = { pollMs: 1000, keepaliveMs: 15_000 };

/**
 * The transcript of a run as server-sent events: the events after `after`, then the new ones,
 * read once a second; `status` first and whenever runs.status changes; a comment when nothing
 * else was sent for 15 s, so that proxies keep the connection. Returns after the final status
 * of an ended run, or when `signal` aborts (the client left, the server stops).
 */
export async function streamRun(
  db: Db,
  runId: string,
  after: number,
  write: (chunk: string) => Promise<void>,
  signal: AbortSignal,
  timing = STREAM_TIMING,
) {
  let last = after;
  let status: RunStatus | undefined;
  let wrote = Date.now();
  const send = async (chunk: string) => {
    await write(chunk);
    wrote = Date.now();
  };
  while (!signal.aborted) {
    // The status before the events: once it is terminal, every event of the run is in.
    const [run] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId));
    if (!run) return;
    let page: RunEvent[];
    do {
      page = await readEvents(db, runId, last);
      for (const event of page) {
        await send(`event: run\ndata: ${JSON.stringify(event)}\n\n`);
        last = event.seq;
      }
    } while (page.length === EVENTS_PAGE && !signal.aborted);
    if (run.status !== status) {
      status = run.status;
      await send(`event: status\ndata: ${JSON.stringify({ status })}\n\n`);
    }
    if (TERMINAL.has(status)) return;
    if (Date.now() - wrote >= timing.keepaliveMs) await send(': keepalive\n\n');
    await sleep(timing.pollMs, undefined, { signal }).catch(() => undefined);
  }
}

/** What streamRun writes with on a raw response: waits when the client reads slower. */
export function sseWriter(raw: NodeJS.WritableStream, signal: AbortSignal) {
  return async (chunk: string) => {
    if (!raw.write(chunk)) await once(raw, 'drain', { signal });
  };
}
