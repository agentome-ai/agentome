import { and, asc, type Db, eq, projectConnections, runs, tasks } from '@agentome/db';
import { CodeHostError } from '../code-host/errors.js';
import { decryptSecret } from '../connections/crypto.js';
import { ConnectionConfig } from '../connections/service.js';
import { addComment, inProject, linkIssue, moveIssue, type JiraConnection } from './client.js';

// What a task of a Jira issue sends back to it: a run starts, the issue goes to "in
// progress"; a change request opens, it is linked and goes to "in review"; it merges, the issue
// goes to "done"; a run ends, its summary becomes a comment. Each is a job of its own, filed after
// the change it reports is saved, and tried again while Jira is away. What Jira refused stays on
// the task as `external_error` until a later step goes through.

export type JiraJob =
  | { step: 'start' | 'done'; taskId: string }
  | { step: 'review'; taskId: string; url: string; title: string }
  | { step: 'comment'; taskId: string; runId: string };

/** Failures that will not pass on a retry: Jira said no, not "later". */
const FINAL = new Set(['unauthorized', 'forbidden', 'not_found', 'conflict', 'invalid_response']);

/**
 * The issue a task came from and the connection of its project, or null for any other task, and
 * for an issue no Jira connection of the agent's is bound to: the project key is the limit.
 */
export async function issueOf(
  db: Db,
  key: Buffer,
  taskId: string,
  fetchImpl: typeof fetch = fetch,
) {
  const found = await db
    .select({ issue: tasks.externalRef, connection: projectConnections })
    .from(tasks)
    .innerJoin(
      projectConnections,
      and(eq(projectConnections.agentId, tasks.agentId), eq(projectConnections.kind, 'jira')),
    )
    .where(and(eq(tasks.id, taskId), eq(tasks.source, 'jira')))
    .orderBy(asc(projectConnections.createdAt));
  for (const { issue, connection } of found) {
    const config = ConnectionConfig.parse({ kind: 'jira', ...connection.config });
    if (!issue || config.kind !== 'jira' || !inProject(config.projectKey, issue)) continue;
    const jira: JiraConnection = {
      baseUrl: config.baseUrl,
      token: decryptSecret(key, connection.tokenCiphertext),
      request: { fetchImpl },
    };
    return { key: issue, connection: jira, config };
  }
  return null;
}

async function commentOf(db: Db, runId: string, publicUrl: string): Promise<string | null> {
  const [run] = await db
    .select({ status: runs.status, summary: runs.summary, errorCode: runs.errorCode })
    .from(runs)
    .where(eq(runs.id, runId));
  if (!run) return null;
  const said = run.summary?.trim() || (run.errorCode ? `It stopped: ${run.errorCode}.` : '');
  const head = [`Agentome run ${run.status}.`, said].filter(Boolean).join(' ');
  return `${head}\n\n${publicUrl}/runs/${runId}`;
}

/** Does one step; throws only what is worth another try. */
export async function pushToJira(
  db: Db,
  key: Buffer,
  publicUrl: string,
  job: JiraJob,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const issue = await issueOf(db, key, job.taskId, fetchImpl);
  if (!issue) return;
  const { connection, config } = issue;
  try {
    if (job.step === 'start') await moveIssue(connection, issue.key, config.inProgress);
    if (job.step === 'done') await moveIssue(connection, issue.key, config.done);
    if (job.step === 'review') {
      await linkIssue(connection, issue.key, { url: job.url, title: job.title });
      await moveIssue(connection, issue.key, config.inReview);
    }
    if (job.step === 'comment') {
      const text = await commentOf(db, job.runId, publicUrl);
      if (text) await addComment(connection, issue.key, text);
    }
    await db.update(tasks).set({ externalError: null }).where(eq(tasks.id, job.taskId));
  } catch (error) {
    if (!(error instanceof CodeHostError)) throw error;
    await db
      .update(tasks)
      .set({ externalError: `Jira: ${error.message}`.slice(0, 500) })
      .where(eq(tasks.id, job.taskId));
    if (!FINAL.has(error.kind)) throw error;
  }
}

/**
 * Files a step for a task, if the task came from Jira. Never fails the request that changed the
 * task: a step that cannot be filed is logged, and Jira misses that one change.
 */
export async function tellJira(
  db: Db,
  file: (job: JiraJob) => Promise<void>,
  job: JiraJob,
  log: { warn: (fields: object, message: string) => void },
): Promise<void> {
  try {
    const [task] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.id, job.taskId), eq(tasks.source, 'jira')));
    if (task) await file(job);
  } catch (error) {
    log.warn({ err: error, taskId: job.taskId, step: job.step }, 'could not file a Jira step');
  }
}
