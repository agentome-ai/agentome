import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDb,
  type Db,
  eq,
  migrate,
  notifications,
  pushSubscriptions,
  runs,
} from '@agentome/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { LightMyRequestResponse } from 'fastify';
import webpush from 'web-push';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import {
  isPushEndpoint,
  notifyRunEnded,
  sendNotifications,
  vapidKeys,
} from '../src/push/service.js';
import { setupCode } from '../src/setup-code.js';
import { projectOfAgent } from './app.js';

// Web push against the real server and database; the push services themselves are
// web-push's sendNotification, replaced where a test sends.

let container: StartedPostgreSqlContainer;
let app: Awaited<ReturnType<typeof buildApp>>;
let db: Db;
let dataDir: string;
let admin: { id: string; cookie: string };

const SECRET = 'a secret key of at least thirty-two characters';
const vapid = vapidKeys(SECRET, 'http://localhost:3000');
const log = { warn: vi.fn() };
// What a browser hands over: an uncompressed P-256 point and 16 bytes of auth secret.
const keys = {
  p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url'),
  auth: Buffer.alloc(16, 1).toString('base64url'),
};
let devices = 0;
const endpoint = () => `https://web.push.apple.com/device-${(devices += 1)}`;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  dataDir = mkdtempSync(join(tmpdir(), 'agentome-push-'));
  await migrate(container.getConnectionUri());
  app = await buildApp(
    loadConfig({
      AGENTOME_DATABASE_URL: container.getConnectionUri(),
      AGENTOME_DATA_DIR: dataDir,
      AGENTOME_LOG_LEVEL: 'silent',
      AGENTOME_SECRET_KEY: SECRET,
    }),
  );
  db = createDb(container.getConnectionUri(), () => {});
  const setup = await app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: {
      code: setupCode(SECRET),
      orgName: 'Acme',
      admin: { name: 'Ann Admin', email: 'admin@example.com', password: 'the admin password' },
    },
  });
  admin = { id: setup.json<{ id: string }>().id, cookie: cookieOf(setup) };
}, 120_000);

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await app?.close();
  await db?.$client.end();
  await container?.stop();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

function cookieOf(response: LightMyRequestResponse): string {
  const setCookie = response.headers['set-cookie'] ?? [];
  return (Array.isArray(setCookie) ? setCookie : [setCookie])
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');
}

const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, payload, headers: { cookie: admin.cookie } });

/** A run of a new agent of the admin's, started by the admin, ended with `status`. */
async function endedRun(status: 'done' | 'failed' | 'cancelled') {
  const agentId = (await call('POST', '/api/agents', { name: 'Backend developer' })).json<{
    id: string;
  }>().id;
  const created = await call('POST', '/api/tasks', {
    agentId,
    projectId: await projectOfAgent(db, agentId),
    title: 'Add a README',
  });
  const runId = created.json<{ run: { id: string } }>().run.id;
  await db.update(runs).set({ status }).where(eq(runs.id, runId));
  return runId;
}

describe('the VAPID keys', () => {
  it('come from the secret key: the same each time, another for another key', () => {
    expect(vapidKeys(SECRET, 'http://x').publicKey).toBe(vapid.publicKey);
    expect(Buffer.from(vapid.publicKey, 'base64url')).toHaveLength(65);
    expect(vapidKeys(`${SECRET}!`, 'http://x').publicKey).not.toBe(vapid.publicKey);
  });

  it('name the public address as contact only when it is https', () => {
    expect(vapidKeys(SECRET, 'https://192.168.1.20').subject).toBe('https://192.168.1.20');
    expect(vapid.subject).toMatch(/^mailto:/);
  });
});

describe('an endpoint', () => {
  it("is posted to only on a browser's push service, over https", () => {
    expect(isPushEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
    expect(isPushEndpoint('https://web.push.apple.com/QH8')).toBe(true);
    expect(isPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x')).toBe(true);
    expect(isPushEndpoint('https://wns2-par02p.notify.windows.com/w/?token=x')).toBe(true);
    expect(isPushEndpoint('http://fcm.googleapis.com/fcm/send/abc')).toBe(false);
    expect(isPushEndpoint('https://10.0.0.5/admin')).toBe(false);
    expect(isPushEndpoint('https://evilpush.apple.com.example.com/x')).toBe(false);
    expect(isPushEndpoint('not a url')).toBe(false);
  });
});

describe('subscriptions', () => {
  it('are kept per device, taken over by whoever subscribes it last, and removed', async () => {
    expect((await call('GET', '/api/me/push')).json()).toEqual({ publicKey: vapid.publicKey });
    const device = endpoint();
    expect(
      (await call('PUT', '/api/me/push/subscriptions', { endpoint: device, keys })).statusCode,
    ).toBe(204);
    expect(
      (await call('PUT', '/api/me/push/subscriptions', { endpoint: device, keys })).statusCode,
    ).toBe(204);
    const rows = await db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, device));
    expect(rows).toMatchObject([{ userId: admin.id, ...keys }]);

    const removed = await call('DELETE', '/api/me/push/subscriptions', { endpoint: device });
    expect(removed.statusCode).toBe(204);
    expect(
      await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, device)),
    ).toEqual([]);
  });

  it('refuse an endpoint off the push services, and keys of the wrong length', async () => {
    const inside = await call('PUT', '/api/me/push/subscriptions', {
      endpoint: 'https://10.0.0.5/admin',
      keys,
    });
    expect(inside.statusCode).toBe(400);
    expect(inside.body).toContain("browser's push service");
    const short = await call('PUT', '/api/me/push/subscriptions', {
      endpoint: endpoint(),
      keys: { ...keys, auth: 'AAAA' },
    });
    expect(short.statusCode).toBe(400);
  });
});

describe('a run that ended', () => {
  it('tells the person who started it when it is done or failed', async () => {
    for (const status of ['done', 'failed'] as const) {
      const runId = await endedRun(status);
      const [id] = await notifyRunEnded(db, runId);
      const [row] = await db
        .select()
        .from(notifications)
        .where(eq(notifications.id, id ?? ''));
      expect(row).toMatchObject({
        userId: admin.id,
        kind: 'run_finished',
        payload: { runId, status },
      });
    }
  });

  it('tells nobody when a person cancelled it, and the owners when nobody started it', async () => {
    expect(await notifyRunEnded(db, await endedRun('cancelled'))).toEqual([]);
    const runId = await endedRun('done');
    await db
      .update(runs)
      .set({ startedByUserId: null, startedBy: 'webhook' })
      .where(eq(runs.id, runId));
    const ids = await notifyRunEnded(db, runId);
    const rows = await db
      .select()
      .from(notifications)
      .where(eq(notifications.id, ids[0] ?? ''));
    expect(rows).toMatchObject([{ userId: admin.id }]);
  });
});

describe('sending', () => {
  it('pushes the agent and the task to every device, and forgets one its browser dropped', async () => {
    const kept = endpoint();
    const dropped = endpoint();
    for (const device of [kept, dropped]) {
      await call('PUT', '/api/me/push/subscriptions', { endpoint: device, keys });
    }
    const sent = vi.spyOn(webpush, 'sendNotification').mockImplementation(async (subscription) => {
      if (subscription.endpoint === dropped) {
        throw new webpush.WebPushError('Gone', 410, {}, '', dropped);
      }
      return { statusCode: 201, body: '', headers: {} };
    });
    const runId = await endedRun('failed');
    await sendNotifications(db, vapid, await notifyRunEnded(db, runId), log);

    const pushed = sent.mock.calls.find(([subscription]) => subscription.endpoint === kept);
    expect(JSON.parse(String(pushed?.[1]))).toEqual({
      title: "Backend developer's run failed",
      body: 'Add a README',
      url: `/runs/${runId}`,
    });
    expect(pushed?.[2]).toMatchObject({ vapidDetails: vapid, urgency: 'high' });
    const left = await db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, dropped));
    expect(left).toEqual([]);
  });

  it('sends a test to the devices of the person and says how many took it', async () => {
    vi.spyOn(webpush, 'sendNotification').mockResolvedValue({
      statusCode: 201,
      body: '',
      headers: {},
    });
    const test = await call('POST', '/api/me/push/test');
    expect(test.statusCode).toBe(200);
    expect(test.json<{ sent: number }>().sent).toBeGreaterThan(0);
  });
});
