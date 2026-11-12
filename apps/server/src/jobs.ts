import { createDb } from '@agentome/db';
import type { FastifyBaseLogger } from 'fastify';
import { PgBoss } from 'pg-boss';
import { returnDueAgents } from './agents/ownership.js';
import type { Config } from './config.js';
import { connectionsKey } from './connections/crypto.js';
import { pollDue } from './jira/poll.js';
import { pushToJira, type JiraJob } from './jira/push.js';
import { syncDue } from './knowledge/service.js';
import { pruneLogs } from './logs/service.js';
import { notifyRunEnded, sendNotifications, vapidKeys } from './push/service.js';
import { reapOrphanedRuns } from './runs/service.js';
import { runDueSchedules } from './schedules/service.js';
import { wakeParents } from './tasks/subtasks.js';
import { processWebhook, type WebhookJob } from './webhooks/process.js';
import { licenseState } from './license/service.js';

const REAP = 'reap-orphaned-runs';
const WEBHOOK = 'process-webhook';
const KNOWLEDGE = 'sync-knowledge';
const SCHEDULES = 'run-schedules';
const WAKE = 'wake-parents';
const JIRA = 'poll-jira';
const JIRA_PUSH = 'push-to-jira';
const PUSH = 'send-push';
const PRUNE_LOGS = 'prune-logs';
const RETURN_AGENTS = 'return-agents';

/**
 * The process's one pg-boss: the reaper, the webhook queue, the knowledge sync and the
 * Jira poll and the steps a task reports back to its issue, and web push. Made with the app, so
 * that routes can file jobs; started by main after the migrations, since pg-boss installs its
 * own schema on its first start.
 */
export function createJobs(config: Config) {
  const vapid = vapidKeys(config.secretKey, config.publicUrl);
  const boss = new PgBoss({ connectionString: config.databaseUrl, max: 2 });
  return {
    /** Files a delivery the webhook route has recorded, for the processor to apply. */
    async fileWebhook(job: WebhookJob) {
      const id = await boss.send(WEBHOOK, job);
      if (id === null) throw new Error('pg-boss filed no job for the webhook delivery');
    },

    /** Files a step a Jira task reports back to its issue. */
    async fileJira(job: JiraJob) {
      const id = await boss.send(JIRA_PUSH, job);
      if (id === null) throw new Error('pg-boss filed no job for the Jira step');
    },

    /** Files notifications to be pushed to their people's devices. */
    async filePush(notificationIds: string[]) {
      if (!notificationIds.length) return;
      const id = await boss.send(PUSH, { notificationIds });
      if (id === null) throw new Error('pg-boss filed no job for the notifications');
    },

    /** Starts the queues: the reaper once a minute however many servers are up. */
    async start(log: FastifyBaseLogger) {
      const db = createDb(config.databaseUrl, (notice) => log.warn({ notice }, 'database notice'));
      boss.on('error', (error) => log.error({ err: error }, 'the job queue failed'));
      await boss.start();
      await boss.createQueue(REAP);
      await boss.schedule(REAP, '* * * * *');
      await boss.work(REAP, async () => {
        const reaped = await reapOrphanedRuns(db, config.orphanMinutes);
        if (reaped.length > 0) log.warn({ runIds: reaped }, 'closed runs whose seat fell silent');
        for (const runId of reaped) {
          const notificationIds = await notifyRunEnded(db, runId);
          if (notificationIds.length) await boss.send(PUSH, { notificationIds });
        }
      });
      // Each minute, the agents' schedules whose day and minute have come.
      await boss.createQueue(SCHEDULES);
      await boss.schedule(SCHEDULES, '* * * * *');
      await boss.work(SCHEDULES, async () => {
        // Read-only makes no tasks that could not run; Jira waits likewise.
        if ((await licenseState(db)).status === 'read_only') return;
        const made = await runDueSchedules(db);
        if (made.length > 0) log.info({ taskIds: made }, 'started the tasks of schedules');
      });
      // Each minute, the tasks whose assigned tasks have all ended.
      await boss.createQueue(WAKE);
      await boss.schedule(WAKE, '* * * * *');
      await boss.work(WAKE, async () => {
        const woken = await wakeParents(db);
        if (woken.length > 0) log.info({ taskIds: woken }, 'ran the leads of assigned tasks again');
      });
      // Each minute, the agents whose time with someone else is up.
      await boss.createQueue(RETURN_AGENTS);
      await boss.schedule(RETURN_AGENTS, '* * * * *');
      await boss.work(RETURN_AGENTS, async () => {
        const back = await returnDueAgents(db);
        if (back.length > 0) log.info({ agentIds: back }, 'agents went back to their owners');
      });
      // Each minute, the sources whose interval has passed.
      const key = connectionsKey(config.secretKey);
      await boss.createQueue(KNOWLEDGE);
      await boss.schedule(KNOWLEDGE, '* * * * *');
      await boss.work(KNOWLEDGE, () => syncDue(db, key, config.knowledgeSyncMinutes));
      // Each minute, the Jira connections whose interval has passed.
      await boss.createQueue(JIRA);
      await boss.schedule(JIRA, '* * * * *');
      await boss.work(JIRA, async () => {
        if ((await licenseState(db)).status === 'read_only') return;
        await pollDue(db, key, config.jiraPollMinutes, log);
      });
      // Jira away is tried again for about an hour: 1, 2, 4… minutes apart.
      await boss.createQueue(JIRA_PUSH, { retryLimit: 6, retryDelay: 60, retryBackoff: true });
      await boss.work<JiraJob>(JIRA_PUSH, async (jobs) => {
        for (const job of jobs) await pushToJira(db, key, config.publicUrl, job.data);
      });
      // Each hour, the log lines past their month.
      await boss.createQueue(PRUNE_LOGS);
      await boss.schedule(PRUNE_LOGS, '7 * * * *');
      await boss.work(PRUNE_LOGS, () => pruneLogs(db, config.logRetentionDays));
      // No retries: a second try would push again to the devices the first one reached.
      await boss.createQueue(PUSH);
      await boss.work<{ notificationIds: string[] }>(PUSH, async (jobs) => {
        for (const job of jobs) await sendNotifications(db, vapid, job.data.notificationIds, log);
      });
      await boss.createQueue(WEBHOOK);
      await boss.work<WebhookJob>(WEBHOOK, async (jobs) => {
        for (const job of jobs) {
          const merged = await processWebhook(db, job.data);
          for (const taskId of merged) await boss.send(JIRA_PUSH, { step: 'done', taskId });
        }
      });
      return async () => {
        await boss.stop({ graceful: true });
        await db.$client.end({ timeout: 5 });
      };
    },
  };
}

export type Jobs = ReturnType<typeof createJobs>;
