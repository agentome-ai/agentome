import {
  and,
  asc,
  type Db,
  desc,
  eq,
  inArray,
  isNotNull,
  projectAgents,
  runs,
  sql,
  taskComments,
} from '@agentome/db';
import { PROPOSE_INSTRUCTIONS } from '@agentome/shared';
import { AppError } from '../errors.js';
import { untrusted } from '../mcp/untrusted.js';
import { createTask } from '../tasks/service.js';
import { lastMonth, type Numbers, perTask, qualityOf, type Window } from './quality.js';

// An agent's review of its own work, started by a person: an ordinary task whose text is what
// the platform kept of the agent's last 30 days, the tasks that came back first. The agent
// writes what it learns into its memory and may propose new instructions, which its owner
// approves or not.

/** The tasks the text tells of, and how much of each kept text it carries. */
const TASKS = 10;
const CHARS = 1_500;
const COMMENTS = 3;

export const REVIEW_TITLE = 'Review your work';

/** Kept text as the brief quotes it, cut to a length. */
function quote(text: string, limit = CHARS): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

const usd = (value: string | null) => (value === null ? 'nothing' : `$${Number(value).toFixed(2)}`);

function numbersSection(numbers: Numbers): string {
  const { returns, changeRequests: cr, runs: r } = numbers;
  return [
    `- Tasks: ${numbers.tasks}; handed over for review: ${numbers.handed}; accepted: ${numbers.accepted}, ${numbers.firstTime} of them the first time.`,
    `- Came back: ${returns.total} times on ${returns.tasks} tasks: ${returns.ci} by a failed pipeline, ${returns.review} by a review, ${returns.person} by a person.`,
    `- Change requests: ${cr.merged} merged, ${cr.closed} closed unmerged, ${cr.open} open.`,
    `- Runs: ${r.ended} ended, ${r.failed} failed, ${r.limited} stopped by a limit. Cost at API prices: ${usd(numbers.usd.total)}.`,
  ].join('\n');
}

type Returned = {
  id: string;
  title: string;
  project_id: string;
  ci: number;
  review: number;
  person: number;
  returns: number;
};

/** What came back, by whom, for the heading of a task. */
function cameBack(task: Returned): string {
  const parts = [
    task.ci && `${task.ci} by a failed pipeline`,
    task.review && `${task.review} by a review`,
    task.person && `${task.person} by a person`,
  ].filter(Boolean);
  return `came back ${task.returns} ${task.returns === 1 ? 'time' : 'times'}: ${parts.join(', ')}`;
}

const STARTED = { user: 'a person', webhook: 'a webhook', cron: 'its schedule', agent: 'its lead' };

/** The tasks of the window that came back most, each with its runs and its people's words. */
async function returnedSection(db: Db, returned: Returned[]): Promise<string> {
  if (returned.length === 0) return 'No task came back in these 30 days.';
  const ids = returned.map((task) => task.id);
  const [taskRuns, comments] = await Promise.all([
    db
      .select({
        taskId: runs.taskId,
        startedBy: runs.startedBy,
        reason: runs.reason,
        summary: runs.summary,
        status: runs.status,
        errorCode: runs.errorCode,
      })
      .from(runs)
      .where(inArray(runs.taskId, ids))
      .orderBy(asc(runs.createdAt)),
    db
      .select({ taskId: taskComments.taskId, body: taskComments.body })
      .from(taskComments)
      .where(and(inArray(taskComments.taskId, ids), isNotNull(taskComments.authorUserId)))
      .orderBy(desc(taskComments.createdAt)),
  ]);
  const section = returned
    .map((task) => {
      const lines = [`### ${task.title} (${cameBack(task)})`, '', 'Its runs, oldest first:'];
      for (const run of taskRuns.filter((one) => one.taskId === task.id)) {
        const by = STARTED[run.startedBy];
        const why = run.reason ? `: ${quote(run.reason)}` : '';
        const ended = run.errorCode ? `${run.status} (${run.errorCode})` : run.status;
        lines.push(`- Started by ${by}${why}. It ended ${ended}.`);
        if (run.summary) lines.push(`  Your report: ${quote(run.summary)}`);
      }
      const said = comments.filter((one) => one.taskId === task.id).slice(0, COMMENTS);
      if (said.length > 0) {
        lines.push('', 'People wrote in its thread, latest first:');
        for (const comment of said) lines.push(`> ${quote(comment.body).replace(/\n/g, '\n> ')}`);
      }
      return lines.join('\n');
    })
    .join('\n\n');
  // Titles from Jira and change requests, the reasons runs were started with, past reports and
  // people's comments: what others wrote, read as data, as the gateway hands over theirs.
  return untrusted('the tasks that came back, their runs and their threads', section);
}

const STEPS = `## What to do

1. For each task above, work out what went wrong: in your work, in your instructions, in the task itself, or outside you (a runner, the infrastructure, access you lack).
2. Read memory/lessons.md if you have it, then write it again with memory_write: one rule per line that would have kept each of your mistakes from happening, merged with the rules already there, at most 30 lines. Keep each rule general enough to help on other tasks.
3. If your instructions miss something or lead you wrong, propose their whole new text with ${PROPOSE_INSTRUCTIONS}, saying why. Change only what the lessons call for: your owner approves or denies it.
4. In your report, list what is not yours to fix (a failing runner, a missing secret, unclear tasks) and what a person must do about each.

Change no code and open no change request in this task.`;

/** The task's text: the numbers, the tasks that came back, what to do. */
export async function reviewBrief(db: Db, agentId: string, window: Window = lastMonth()) {
  const [counted, returned] = await Promise.all([
    qualityOf(db, [agentId], window),
    db.execute<Returned>(sql`
      with ${perTask([agentId], window)}
      select p.id, p.title, t.project_id, p.ci::int as ci, p.review::int as review,
        p.person::int as person, p.returns::int as returns
      from per_task p join tasks t on t.id = p.id
      where p.returns > 0 order by p.returns desc, p.created_at desc limit ${TASKS}
    `),
  ]);
  const numbers = counted.get(agentId);
  if (!numbers) throw new Error('The quality of the agent was not counted');
  const rows = [...returned];
  const since = window.from.toISOString().slice(0, 10);
  const body = [
    `Review your own work since ${since} and find how to do it better. Below is what Agentome kept of it: your numbers, then the tasks that came back to you most, with why.`,
    `## Your numbers\n\n${numbersSection(numbers)}`,
    `## Tasks that came back\n\n${await returnedSection(db, rows)}`,
    STEPS,
  ].join('\n\n');
  return { body, projectId: rows[0]?.project_id ?? null };
}

/**
 * The project the review is filed in: that of the task that came back most, else the one the
 * agent joined last. Every task belongs to a project.
 */
async function projectFor(db: Db, agentId: string, returnedIn: string | null): Promise<string> {
  if (returnedIn) {
    const [still] = await db
      .select({ id: projectAgents.projectId })
      .from(projectAgents)
      .where(and(eq(projectAgents.agentId, agentId), eq(projectAgents.projectId, returnedIn)));
    if (still) return still.id;
  }
  const [latest] = await db
    .select({ id: projectAgents.projectId })
    .from(projectAgents)
    .where(eq(projectAgents.agentId, agentId))
    .orderBy(desc(projectAgents.createdAt))
    .limit(1);
  if (!latest) {
    throw new AppError(
      'validation_failed',
      'This agent is on no project, and a review is a task of a project. Put it on one first.',
    );
  }
  return latest.id;
}

/** Files the review as the person's task for the agent, and runs it. */
export async function startReview(db: Db, agentId: string, userId: string) {
  const { body, projectId } = await reviewBrief(db, agentId);
  return createTask(db, userId, {
    agentId,
    projectId: await projectFor(db, agentId, projectId),
    title: REVIEW_TITLE,
    body,
    repository: null,
    run: true,
  });
}
