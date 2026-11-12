import { agents, and, type Db, eq, isNull, lt, or, schedules, sql, tasks } from '@agentome/db';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { refusesRun } from '../license/service.js';
import { assertOnProject } from '../tasks/service.js';
import { enqueueRun } from '../runs/service.js';

// An agent's recurring tasks: on the days and at the minute a schedule names, in its time
// zone, a task is made and run, as a person would have filed it. Checked each minute by pg-boss;
// a minute missed while the server was down is skipped, not caught up.

type Row = typeof schedules.$inferSelect;

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const ScheduleInput = z.object({
  title: z.string().trim().min(1, 'Name the task').max(200),
  body: z.string().max(100_000).default(''),
  // Filed in a project like any new task; a schedule from before keeps having none.
  projectId: z.uuid({ error: 'Pick the project its tasks are filed in' }),
  repository: z.string().trim().max(2000).nullable().default(null),
  days: z
    .array(z.int().min(0).max(6))
    .min(1, 'Pick a day at least')
    .max(7)
    .transform((days) => [...new Set(days)].sort()),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'A time such as 09:00'),
  timeZone: z.string().refine((zone) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  }, 'A time zone such as Europe/Moscow'),
  enabled: z.boolean().default(true),
});
export type ScheduleInput = z.infer<typeof ScheduleInput>;

/** "Every weekday at 09:00": how a schedule reads on the page and to the agent. */
export function whenOf(schedule: Pick<Row, 'days' | 'time'>): string {
  const days = [...schedule.days].sort();
  const set = days.join(',');
  const when =
    set === '0,1,2,3,4,5,6'
      ? 'Every day'
      : set === '1,2,3,4,5'
        ? 'Every weekday'
        : set === '0,6'
          ? 'Every weekend day'
          : `Every ${days.map((day) => DAY_NAMES[day]).join(', ')}`;
  return `${when} at ${schedule.time}`;
}

/** The day of the week and the minute it is now in a time zone. */
export function localNow(timeZone: string, now: Date): { day: number; time: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { day: DAY_NAMES.indexOf(part('weekday')), time: `${part('hour')}:${part('minute')}` };
}

export const viewOf = (row: Row) => ({
  id: row.id,
  title: row.title,
  body: row.body,
  projectId: row.projectId,
  repository: row.repository,
  days: row.days,
  time: row.time,
  timeZone: row.timeZone,
  enabled: row.enabled,
  when: whenOf(row),
  lastRunAt: row.lastRunAt?.toISOString() ?? null,
});

export async function listSchedules(db: Db, agentId: string) {
  const rows = await db
    .select()
    .from(schedules)
    .where(eq(schedules.agentId, agentId))
    .orderBy(schedules.createdAt);
  return rows.map(viewOf);
}

export async function createSchedule(
  db: Db,
  agentId: string,
  userId: string,
  input: ScheduleInput,
) {
  await assertOnProject(db, input.projectId, agentId);
  const [row] = await db
    .insert(schedules)
    .values({ ...input, agentId, createdBy: userId })
    .returning();
  if (!row) throw new AppError('internal', 'The schedule was not saved');
  return viewOf(row);
}

export async function updateSchedule(
  db: Db,
  agentId: string,
  id: string,
  input: Partial<ScheduleInput>,
) {
  if (input.projectId) await assertOnProject(db, input.projectId, agentId);
  const [row] = await db
    .update(schedules)
    .set(input)
    .where(and(eq(schedules.id, id), eq(schedules.agentId, agentId)))
    .returning();
  if (!row) throw new AppError('not_found', 'No such schedule');
  return viewOf(row);
}

export async function deleteSchedule(db: Db, agentId: string, id: string) {
  const gone = await db
    .delete(schedules)
    .where(and(eq(schedules.id, id), eq(schedules.agentId, agentId)))
    .returning({ id: schedules.id });
  if (gone.length === 0) throw new AppError('not_found', 'No such schedule');
}

/**
 * Makes and runs the task of every schedule whose day and minute have come; answers the tasks
 * made. A schedule is claimed by moving its last run in the same statement that checks it, so
 * two servers, or a check that ran late, never make its task twice in a minute.
 */
export async function runDueSchedules(db: Db, now = new Date()): Promise<string[]> {
  const due = await db
    .select({ schedule: schedules })
    .from(schedules)
    .innerJoin(agents, eq(agents.id, schedules.agentId))
    .where(and(eq(schedules.enabled, true), eq(agents.status, 'active')));
  const made: string[] = [];
  for (const { schedule } of due) {
    const local = localNow(schedule.timeZone, now);
    if (!schedule.days.includes(local.day) || schedule.time !== local.time) continue;
    const [claimed] = await db
      .update(schedules)
      .set({ lastRunAt: now })
      .where(
        and(
          eq(schedules.id, schedule.id),
          or(
            isNull(schedules.lastRunAt),
            lt(schedules.lastRunAt, sql`${now.toISOString()}::timestamptz - interval '90 seconds'`),
          ),
        ),
      )
      .returning({ id: schedules.id });
    if (!claimed) continue;
    const [task] = await db
      .insert(tasks)
      .values({
        agentId: schedule.agentId,
        projectId: schedule.projectId,
        title: schedule.title,
        body: schedule.body,
        repository: schedule.repository,
        source: 'cron',
        createdBy: schedule.createdBy,
      })
      .returning({ id: tasks.id });
    if (!task) continue;
    made.push(task.id);
    const reason = `Your schedule "${schedule.title}" runs ${whenOf(schedule).toLowerCase()} (${schedule.timeZone}); this is today's run.`;
    // A spent month leaves the task made and waiting for its owner.
    await enqueueRun(db, task.id, null, { startedBy: 'cron', reason }).catch((error: unknown) => {
      if (!refusesRun(error)) throw error;
    });
  }
  return made;
}
