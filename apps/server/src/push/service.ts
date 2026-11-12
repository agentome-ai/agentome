import { createECDH } from 'node:crypto';
import {
  agentGrants,
  agents,
  and,
  type Db,
  eq,
  inArray,
  notifications,
  pushSubscriptions,
  runs,
  tasks,
} from '@agentome/db';
import { grantInForce } from '../agents/grants.js';
import webpush from 'web-push';
import { z } from 'zod';
import { deriveKey } from '../auth.js';

// Web push: a notification row, written where the event happens, is sent to every
// browser and phone where its person turned notifications on. Best effort: a push that fails
// is logged, and the page it points to shows the same thing anyway.

export type Vapid = { subject: string; publicKey: string; privateKey: string };

/**
 * The server's VAPID pair, derived from its secret key: nothing to store, the same on every
 * server, and gone with a new secret key, which then needs notifications turned on again.
 * One key in 2^32 is not a valid P-256 key; setPrivateKey throws for it at start.
 */
export function vapidKeys(secretKey: string, publicUrl: string): Vapid {
  const privateKey = Buffer.from(deriveKey(secretKey, 'vapid'), 'hex');
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(privateKey);
  return {
    // Apple wants a contact of https: or mailto:; an http address would be refused.
    subject: publicUrl.startsWith('https:') ? publicUrl : 'mailto:noreply@agentome.ai',
    publicKey: ecdh.getPublicKey().toString('base64url'),
    privateKey: privateKey.toString('base64url'),
  };
}

// The server posts to the endpoint a browser hands it, so only the push services of the
// browsers are allowed: anything else would let a person aim the server at the inside network.
const PUSH_HOSTS = [
  'fcm.googleapis.com',
  'push.apple.com',
  'push.services.mozilla.com',
  'notify.windows.com',
];

/** Whether the server will post to a browser's endpoint: https on a known push service. */
export function isPushEndpoint(endpoint: string): boolean {
  const url = URL.parse(endpoint);
  if (url?.protocol !== 'https:') return false;
  const host = url.hostname;
  return PUSH_HOSTS.some((name) => host === name || host.endsWith(`.${name}`));
}

export type Message = { title: string; body: string; url: string };

/** A notification for each owner of the agent: one of its calls waits for them. */
export async function notifyOwners(
  db: Db,
  call: { id: string; runId: string; agentId: string; tool: string },
): Promise<string[]> {
  const owners = await ownersOf(db, call.agentId);
  if (!owners.length) return [];
  const rows = await db
    .insert(notifications)
    .values(
      owners.map((userId) => ({
        userId,
        kind: 'approval' as const,
        payload: { toolCallId: call.id, runId: call.runId, agentId: call.agentId, tool: call.tool },
      })),
    )
    .returning({ id: notifications.id });
  return rows.map((row) => row.id);
}

/**
 * A run that ended done or failed tells the person who started it, or, when nobody did (Jira,
 * a webhook), the agent's owners. A cancelled run was stopped by a person, who knows.
 */
export async function notifyRunEnded(db: Db, runId: string): Promise<string[]> {
  const [run] = await db
    .select({
      status: runs.status,
      agentId: runs.agentId,
      taskId: runs.taskId,
      userId: runs.startedByUserId,
    })
    .from(runs)
    .where(eq(runs.id, runId));
  if (!run || (run.status !== 'done' && run.status !== 'failed')) return [];
  const people = run.userId ? [run.userId] : await ownersOf(db, run.agentId);
  if (!people.length) return [];
  const rows = await db
    .insert(notifications)
    .values(
      people.map((userId) => ({
        userId,
        kind: 'run_finished' as const,
        payload: { runId, agentId: run.agentId, taskId: run.taskId, status: run.status },
      })),
    )
    .returning({ id: notifications.id });
  return rows.map((row) => row.id);
}

async function ownersOf(db: Db, agentId: string) {
  const rows = await db
    .select({ userId: agentGrants.userId })
    .from(agentGrants)
    .where(and(eq(agentGrants.agentId, agentId), eq(agentGrants.level, 'owner'), grantInForce));
  return rows.map((row) => row.userId);
}

const Payload = z.object({ runId: z.uuid(), tool: z.string().optional() });

const BudgetPayload = z.object({ spent: z.number(), limit: z.number(), agentId: z.string() });

/** What the phone shows for a notification: who, what, and the page that has it. */
async function messageOf(
  db: Db,
  row: { kind: string; payload: unknown },
): Promise<Message | undefined> {
  const payload = Payload.safeParse(row.payload);
  if (!payload.success) return undefined;
  const { runId, tool } = payload.data;
  const [run] = await db
    .select({ agent: agents.name, task: tasks.title, taskId: runs.taskId, status: runs.status })
    .from(runs)
    .innerJoin(agents, eq(agents.id, runs.agentId))
    .leftJoin(tasks, eq(tasks.id, runs.taskId))
    .where(eq(runs.id, runId));
  if (!run) return undefined;
  const task = run.task ?? 'A run without a task';
  if (row.kind === 'approval' && tool === 'ask_owner') {
    return { title: `${run.agent} asks you`, body: `${task}: a question`, url: '/approvals' };
  }
  if (row.kind === 'approval') {
    return {
      title: `${run.agent} needs your approval`,
      body: `${task}: wants to use ${tool ?? 'a tool'}`,
      url: '/approvals',
    };
  }
  if (row.kind === 'budget') {
    const { spent, limit, agentId } = BudgetPayload.parse(row.payload);
    return {
      title: `${run.agent} has used most of its monthly budget`,
      body: `$${spent.toFixed(2)} of $${limit.toFixed(2)} this month; new runs stop at the limit`,
      url: `/agents/${agentId}`,
    };
  }
  if (row.kind === 'comment' && run.taskId) {
    return { title: `${run.agent} commented`, body: task, url: `/tasks/${run.taskId}` };
  }
  if (row.kind === 'run_finished') {
    return {
      title: run.status === 'failed' ? `${run.agent}'s run failed` : `${run.agent} finished`,
      body: task,
      url: `/runs/${runId}`,
    };
  }
  return undefined;
}

type Log = { warn: (fields: object, message: string) => void };

/** Sends the notifications to their people's devices; pg-boss calls it for each batch. */
export async function sendNotifications(db: Db, vapid: Vapid, ids: string[], log: Log) {
  if (!ids.length) return;
  const rows = await db
    .select({
      userId: notifications.userId,
      kind: notifications.kind,
      payload: notifications.payload,
    })
    .from(notifications)
    .where(inArray(notifications.id, ids));
  for (const row of rows) {
    const message = await messageOf(db, row);
    if (message) await sendTo(db, vapid, row.userId, message, log);
  }
}

/** Sends one message to every device of the person; answers how many took it. */
export async function sendTo(db: Db, vapid: Vapid, userId: string, message: Message, log: Log) {
  const devices = await db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId));
  const sent = await Promise.all(
    devices.map(async (device) => {
      try {
        await webpush.sendNotification(
          { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
          JSON.stringify(message),
          // A push that waited half a day is news no longer.
          { vapidDetails: vapid, TTL: 12 * 60 * 60, urgency: 'high', timeout: 10_000 },
        );
        return true;
      } catch (error) {
        // 404 and 410: the browser dropped the subscription, so the row goes too.
        if (error instanceof webpush.WebPushError && [404, 410].includes(error.statusCode)) {
          await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, device.id));
        } else {
          log.warn({ err: error, subscriptionId: device.id }, 'a push was not delivered');
        }
        return false;
      }
    }),
  );
  return sent.filter(Boolean).length;
}
