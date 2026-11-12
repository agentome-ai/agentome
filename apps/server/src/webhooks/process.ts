import {
  and,
  type Db,
  eq,
  gte,
  inArray,
  projectConnections,
  projects,
  runArtifacts,
  runs,
  sql,
  tasks,
  webhookDeliveries,
} from '@agentome/db';
import type { WebhookEvent } from '../code-host/index.js';
import { refusesRun } from '../license/service.js';
import { assignAgent } from '../projects/service.js';
import { enqueueRun, LIVE_RUN_STATUSES } from '../runs/service.js';

// What a webhook delivery does once the route has answered the host: the change
// request artifacts it is about learn their state, and a merge closes the run's task. Then the
// project's triggers: a failed pipeline or a review of an agent's change request runs
// its task again, and a person's new change request goes to the project's reviewer agent.

/** Runs a webhook may start for one task in a day: a pipeline that keeps failing stops there. */
const RUNS_A_DAY = 3;

/** A delivery the route recorded, with the event it read from the body. */
export type WebhookJob = { deliveryId: string; connectionId: string; event: WebhookEvent };

/** Whether an address is inside the host and namespace of the connection that sent it. */
function within(address: string, place: { host: string; namespace: string }) {
  if (!URL.canParse(address)) return false;
  const url = new URL(address);
  return (
    url.host.toLowerCase() === place.host &&
    url.pathname.toLowerCase().startsWith(`/${place.namespace}/`)
  );
}

/** Applies a delivery; answers the tasks it closed by a merge, for Jira to hear of. */
export async function processWebhook(db: Db, job: WebhookJob): Promise<string[]> {
  const [place] = await db
    .select({ host: projectConnections.host, namespace: projectConnections.namespace })
    .from(projectConnections)
    .where(eq(projectConnections.id, job.connectionId));
  // A connection deleted since took its deliveries with it.
  if (!place) return [];
  // A connection's secret speaks for its own namespace only, never for another's change requests.
  const urls = job.event.changeRequests.filter((url) => within(url, place));
  const { update } = job.event;

  const { closed, touched } = await db.transaction(async (tx) => {
    const touched =
      urls.length === 0
        ? []
        : await tx
            .update(runArtifacts)
            .set({
              // Merged is final: hosts promise no order, and an older event must not undo it.
              meta: sql`${runArtifacts.meta} || ${JSON.stringify(update)}::jsonb
                || jsonb_build_object('url', ${runArtifacts.ref})
                || case when ${runArtifacts.meta}->>'state' = 'merged'
                     then '{"state":"merged"}'::jsonb else '{}'::jsonb end`,
            })
            .where(and(eq(runArtifacts.kind, 'change_request'), inArray(runArtifacts.ref, urls)))
            .returning({ runId: runArtifacts.runId });

    let closed: string[] = [];
    if (update.state === 'merged' && touched.length > 0) {
      const runIds = touched.map((artifact) => artifact.runId);
      const merged = tx.select({ id: runs.taskId }).from(runs).where(inArray(runs.id, runIds));
      closed = (
        await tx
          .update(tasks)
          .set({ status: 'done' })
          .where(inArray(tasks.id, merged))
          .returning({ id: tasks.id, source: tasks.source })
      )
        .filter((task) => task.source === 'jira')
        .map((task) => task.id);
    }

    await tx
      .update(webhookDeliveries)
      .set({ status: touched.length > 0 ? 'processed' : 'ignored', processedAt: new Date() })
      .where(eq(webhookDeliveries.id, job.deliveryId));
    return { closed, touched };
  });
  await startTriggers(db, job, place, urls, touched);
  return closed;
}

/** What the project of the delivery's connection starts for it, if anything. */
async function startTriggers(
  db: Db,
  job: WebhookJob,
  place: { host: string; namespace: string },
  urls: string[],
  touched: { runId: string }[],
): Promise<void> {
  const [row] = await db
    .select({ project: projects, account: projectConnections.accountLogin })
    .from(projectConnections)
    .innerJoin(projects, eq(projects.id, projectConnections.projectId))
    .where(eq(projectConnections.id, job.connectionId));
  if (!row) return;
  const { project, account } = row;
  const { update, actor, opened } = job.event;
  // What the connection's own account does is an agent's doing: it starts nothing.
  const byAgent = actor !== undefined && account !== null && actor === account;
  const url = urls[0] ?? '';

  if (touched.length > 0) {
    const reason =
      update.pipeline === 'failed' && project.onPipelineFailed
        ? `The pipeline of your change request ${url} failed. Read its failures with code_host_get_pipeline_failures, fix them on the same branch and push.`
        : (update.review === 'changes_requested' || update.review === 'commented') &&
            project.onReview &&
            !byAgent
          ? `${actor ?? 'A reviewer'} ${update.review === 'changes_requested' ? 'asked for changes on' : 'commented on'} your change request ${url}. Read the review with code_host_get_change_request, address it on the same branch and push, then answer with code_host_reply_to_review.`
          : undefined;
    if (!reason) return;
    const runIds = touched.map((artifact) => artifact.runId);
    const taskIds = await db
      .selectDistinct({ id: runs.taskId })
      .from(runs)
      .where(inArray(runs.id, runIds));
    for (const { id } of taskIds) if (id) await runAgain(db, id, reason);
    return;
  }

  // A person's change request: not an agent's (no run made it), nor its account's.
  const reviewer = project.reviewerAgentId;
  if (!opened || !reviewer || (account !== null && opened.author === account)) return;
  // The repository becomes the task's, which a run clones: like the change request's address,
  // it is the connection's to name only inside its own host and namespace.
  if (url === '' || !within(`${opened.repository}/`, place)) return;
  await assignAgent(db, project.id, reviewer);
  const [task] = await db
    .insert(tasks)
    .values({
      agentId: reviewer,
      projectId: project.id,
      title: `Review: ${opened.title}`.slice(0, 200),
      body: `${opened.author} opened the change request ${url}. Review it: read it with code_host_get_change_request and leave your review as comments with code_host_reply_to_review. Push nothing to its branch.`,
      repository: opened.repository,
      source: 'webhook',
      createdBy: project.createdBy,
    })
    .returning({ id: tasks.id });
  if (task)
    await start(db, task.id, `A person opened the change request ${url} for you to review.`);
}

/**
 * Runs an agent's task again for a webhook, unless a run of it is on its way or it already ran
 * this way three times today.
 */
async function runAgain(db: Db, taskId: string, reason: string): Promise<void> {
  const [busy] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.taskId, taskId), inArray(runs.status, ['queued', ...LIVE_RUN_STATUSES])))
    .limit(1);
  if (busy) return;
  const [today] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(runs)
    .where(
      and(
        eq(runs.taskId, taskId),
        eq(runs.startedBy, 'webhook'),
        gte(runs.createdAt, sql`now() - interval '1 day'`),
      ),
    );
  if ((today?.count ?? 0) >= RUNS_A_DAY) return;
  await start(db, taskId, reason);
}

/** A webhook's run; a spent month leaves the task waiting for its owner. */
async function start(db: Db, taskId: string, reason: string): Promise<void> {
  await enqueueRun(db, taskId, null, { startedBy: 'webhook', reason }).catch((error: unknown) => {
    if (!refusesRun(error)) throw error;
  });
}
