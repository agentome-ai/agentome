import { type Db, sql } from '@agentome/db';

// An agent's quality, from what is already kept: its tasks, their runs, the change
// requests the runs opened (their state comes from the code host's webhooks) and the cost. A
// window takes the tasks and runs created in it. A task is handed over with its first done run
// and accepted once closed, by a person or by a merge: so an agent that opens no change
// request, a Jira admin, is measured too. It comes back when a run of it is queued after it was
// handed over: by a person (Run again, Comment and run) or by a webhook, a failed pipeline or a
// review. Money is at API prices, as everywhere.

export type Window = { from: Date; to: Date };

const DAY_MS = 24 * 60 * 60 * 1000;

/** The last 30 days. */
export const lastMonth = (now = new Date()): Window => ({
  from: new Date(now.getTime() - 30 * DAY_MS),
  to: now,
});

/** A limit the run hit, as the seat reports it. */
const LIMITS = ['timeout', 'max_turns', 'token_limit'];
/** The words a failed pipeline's run starts with (webhooks/process.ts). */
const PIPELINE = 'The pipeline of%';

/** Each task of the agents in the window, with how it went: the `per_task` relation. */
const perTask = (agentIds: string[], window: Window) => sql`
  t as (
    select id, agent_id, title, status, created_at from tasks
    where agent_id in (${sql.join(
      agentIds.map((id) => sql`${id}`),
      sql`, `,
    )})
      and created_at >= ${window.from.toISOString()} and created_at < ${window.to.toISOString()}
  ),
  r as (select runs.* from runs join t on t.id = runs.task_id),
  handed as (select task_id, min(ended_at) as at from r where status = 'done' group by task_id),
  cr as (
    select r.task_id,
      case when bool_or(a.meta->>'state' = 'merged') then 'merged'
           when bool_or(coalesce(a.meta->>'state', 'open') <> 'closed') then 'open'
           else 'closed' end as state
    from r join run_artifacts a on a.run_id = r.id and a.kind = 'change_request'
    group by r.task_id
  ),
  back as (
    select r.task_id,
      count(*) filter (where r.started_by = 'user') as person,
      count(*) filter (where r.started_by = 'webhook' and r.reason like ${PIPELINE}) as ci,
      count(*) filter (where r.started_by = 'webhook' and r.reason not like ${PIPELINE}) as review
    from r join handed h on h.task_id = r.task_id and r.created_at > h.at
    where r.started_by in ('user', 'webhook')
    group by r.task_id
  ),
  spent as (
    select r.task_id, sum(c.usd) as usd from r join cost_events c on c.run_id = r.id
    group by r.task_id
  ),
  work as (
    select task_id, sum(extract(epoch from ended_at - started_at)) as seconds from r
    where started_at is not null and ended_at is not null group by task_id
  ),
  per_task as (
    select t.id, t.agent_id, t.title, t.status, t.created_at, h.at as handed_at, cr.state,
      coalesce(b.person, 0) as person, coalesce(b.ci, 0) as ci, coalesce(b.review, 0) as review,
      coalesce(b.person, 0) + coalesce(b.ci, 0) + coalesce(b.review, 0) as returns,
      s.usd, w.seconds
    from t
    left join handed h on h.task_id = t.id
    left join cr on cr.task_id = t.id
    left join back b on b.task_id = t.id
    left join spent s on s.task_id = t.id
    left join work w on w.task_id = t.id
  )`;

type Row = {
  agent_id: string;
  tasks: number;
  handed: number;
  accepted: number;
  merged: number;
  closed: number;
  open: number;
  first_time: number;
  returns: number;
  returned_tasks: number;
  person: number;
  ci: number;
  review: number;
  median_usd: number | null;
  usd: string | null;
  work_seconds: number | null;
  review_seconds: number | null;
  ended: number;
  failed: number;
  limited: number;
};

export type Numbers = {
  tasks: number;
  /** Tasks handed over for review, and those of them closed by a person or a merge. */
  handed: number;
  accepted: number;
  /** Accepted without coming back once. */
  firstTime: number;
  /** Of the tasks with a change request, by its state: merged, closed unmerged, still open. */
  changeRequests: { merged: number; closed: number; open: number };
  returns: { total: number; tasks: number; person: number; ci: number; review: number };
  /** The median of the tasks handed over, and what all of the window's tasks cost. */
  usd: { median: string | null; total: string | null };
  /** Medians of the tasks handed over: the agent's own run time, and creation to review. */
  seconds: { work: number | null; toReview: number | null };
  runs: { ended: number; failed: number; limited: number };
};

const none: Numbers = {
  tasks: 0,
  handed: 0,
  accepted: 0,
  firstTime: 0,
  changeRequests: { merged: 0, closed: 0, open: 0 },
  returns: { total: 0, tasks: 0, person: 0, ci: 0, review: 0 },
  usd: { median: null, total: null },
  seconds: { work: null, toReview: null },
  runs: { ended: 0, failed: 0, limited: 0 },
};

const round = (value: number | null) => (value === null ? null : Math.round(Number(value)));

/** The numbers of each agent in the window; an agent with nothing in it has zeros. */
export async function qualityOf(
  db: Db,
  agentIds: string[],
  window: Window,
): Promise<Map<string, Numbers>> {
  const result = new Map(agentIds.map((id) => [id, none]));
  if (agentIds.length === 0) return result;
  const ids = sql.join(
    agentIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = await db.execute<Row>(sql`
    with ${perTask(agentIds, window)},
    by_task as (
      select agent_id,
        count(*)::int as tasks,
        count(*) filter (where handed_at is not null)::int as handed,
        count(*) filter (where handed_at is not null and status = 'done')::int as accepted,
        count(*) filter (where state = 'merged')::int as merged,
        count(*) filter (where state = 'closed')::int as closed,
        count(*) filter (where state = 'open')::int as open,
        count(*) filter (where handed_at is not null and status = 'done' and returns = 0)::int as first_time,
        sum(returns)::int as returns,
        count(*) filter (where returns > 0)::int as returned_tasks,
        sum(person)::int as person, sum(ci)::int as ci, sum(review)::int as review,
        percentile_cont(0.5) within group (order by usd) filter (where handed_at is not null) as median_usd,
        sum(usd)::text as usd,
        percentile_cont(0.5) within group (order by seconds) filter (where handed_at is not null) as work_seconds,
        percentile_cont(0.5) within group (order by extract(epoch from handed_at - created_at)) as review_seconds
      from per_task group by agent_id
    ),
    by_run as (
      select agent_id,
        count(*) filter (where status in ('done', 'failed', 'cancelled'))::int as ended,
        count(*) filter (where status = 'failed')::int as failed,
        count(*) filter (where status = 'failed' and error_code in (${sql.join(
          LIMITS.map((code) => sql`${code}`),
          sql`, `,
        )}))::int as limited
      from runs
      where agent_id in (${ids})
        and created_at >= ${window.from.toISOString()} and created_at < ${window.to.toISOString()}
      group by agent_id
    )
    select coalesce(k.agent_id, n.agent_id) as agent_id, k.tasks, k.handed, k.accepted, k.merged, k.closed, k.open,
      k.first_time, k.returns, k.returned_tasks, k.person, k.ci, k.review, k.median_usd, k.usd,
      k.work_seconds, k.review_seconds, n.ended, n.failed, n.limited
    from by_task k full join by_run n on n.agent_id = k.agent_id
  `);
  for (const row of rows) {
    result.set(row.agent_id, {
      tasks: row.tasks ?? 0,
      handed: row.handed ?? 0,
      accepted: row.accepted ?? 0,
      firstTime: row.first_time ?? 0,
      changeRequests: { merged: row.merged ?? 0, closed: row.closed ?? 0, open: row.open ?? 0 },
      returns: {
        total: row.returns ?? 0,
        tasks: row.returned_tasks ?? 0,
        person: row.person ?? 0,
        ci: row.ci ?? 0,
        review: row.review ?? 0,
      },
      usd: {
        median: row.median_usd === null ? null : Number(row.median_usd).toFixed(2),
        total: row.usd,
      },
      seconds: { work: round(row.work_seconds), toReview: round(row.review_seconds) },
      runs: { ended: row.ended ?? 0, failed: row.failed ?? 0, limited: row.limited ?? 0 },
    });
  }
  return result;
}

/** The agent's tasks of the window that came back most, for a person to read first. */
export async function mostReturned(db: Db, agentId: string, window: Window) {
  const rows = await db.execute<{
    id: string;
    title: string;
    returns: number;
    usd: string | null;
  }>(sql`
    with ${perTask([agentId], window)}
    select id, title, returns::int as returns, usd::text as usd from per_task
    where returns > 0 order by returns desc, created_at desc limit 5
  `);
  return rows.map((row) => ({ ...row }));
}
