import { and, type Db, desc, eq, inArray, ne, runArtifacts, runs, toolCalls } from '@agentome/db';
import { z } from 'zod';
import { threadSection } from '../tasks/thread.js';

// What a run of a task knows of the task's earlier runs: their reports, the owner's
// answers to their questions, and the branch they left on the code host. Each run is a new
// session of Claude Code on whatever computer takes it, so the task's history goes with the
// launch, in the run's CLAUDE.md, rather than living in a session on a computer.

/** Enough reports to go on from, few enough to keep the CLAUDE.md short. */
const RUNS = 3;
const REPORT = 2_000;
const ANSWERS = 10;

const Question = z.object({ question: z.string() }).catch({ question: '' });
const Branch = z.object({ pushedTo: z.string().nullable().catch(null) }).catch({ pushedTo: null });

const cut = (text: string, limit: number) =>
  text.length <= limit
    ? text
    : `${text.slice(0, limit)}\n(Cut here: the rest is on the run's page.)`;

/** The section of the run's CLAUDE.md about the task so far; empty for a task's first run. */
export async function taskHistory(db: Db, taskId: string, runId: string): Promise<string> {
  // Why this run began, when no person started it: the agent starts from there.
  const [own] = await db.select({ reason: runs.reason }).from(runs).where(eq(runs.id, runId));
  const why = own?.reason ? `\n## Why this run\n\n${own.reason}\n` : '';
  return why + (await threadSection(db, taskId)) + (await earlierRuns(db, taskId, runId));
}

async function earlierRuns(db: Db, taskId: string, runId: string): Promise<string> {
  const earlier = await db
    .select({ id: runs.id, status: runs.status, endedAt: runs.endedAt, summary: runs.summary })
    .from(runs)
    .where(
      and(eq(runs.taskId, taskId), ne(runs.id, runId), inArray(runs.status, ['done', 'failed'])),
    )
    .orderBy(desc(runs.createdAt))
    .limit(RUNS);
  if (earlier.length === 0) return '';

  const [answers, branches] = await Promise.all([
    db
      .select({ input: toolCalls.input, decision: toolCalls.decision, reason: toolCalls.reason })
      .from(toolCalls)
      .innerJoin(runs, eq(runs.id, toolCalls.runId))
      .where(
        and(
          eq(runs.taskId, taskId),
          eq(toolCalls.tool, 'ask_owner'),
          ne(toolCalls.decision, 'pending'),
        ),
      )
      .orderBy(desc(toolCalls.createdAt))
      .limit(ANSWERS),
    db
      .select({ ref: runArtifacts.ref, meta: runArtifacts.meta })
      .from(runArtifacts)
      .innerJoin(runs, eq(runs.id, runArtifacts.runId))
      .where(and(eq(runs.taskId, taskId), eq(runArtifacts.kind, 'branch')))
      .orderBy(desc(runArtifacts.createdAt)),
  ]);

  const parts = [
    '\n## This task so far\n',
    'Runs of this task came before this one. Read what they did and go on from where they stopped, rather than starting over: the task is not new.',
  ];
  const branch = branches.find((row) => Branch.parse(row.meta ?? {}).pushedTo?.startsWith('http'));
  if (branch) {
    parts.push(
      `\n### The task's branch\n\n\`${branch.ref}\` is on the code host with the earlier runs' commits. Work on it: \`git fetch origin ${branch.ref} && git switch ${branch.ref}\`.`,
    );
  }
  if (answers.length > 0) {
    const lines = answers.reverse().map((row) => {
      const { question } = Question.parse(row.input);
      const answer =
        row.decision === 'approved'
          ? (row.reason ?? '')
          : `not answered${row.reason ? ` (${row.reason})` : ''}`;
      return `- ${question.replace(/\s+/g, ' ').trim()}\n  ${answer.replace(/\n+/g, ' ').trim()}`;
    });
    parts.push(`\n### Your owner's answers\n\n${lines.join('\n')}`);
  }
  for (const run of earlier) {
    const when = run.endedAt?.toISOString().slice(0, 16).replace('T', ' ') ?? '';
    parts.push(
      `\n### Run of ${when} UTC, ${run.status}\n\n${run.summary?.trim() ? cut(run.summary.trim(), REPORT) : 'It left no report.'}`,
    );
  }
  return `${parts.join('\n')}\n`;
}
