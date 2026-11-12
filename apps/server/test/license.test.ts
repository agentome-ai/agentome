import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, type Db, installation, migrate, tasks, users } from '@agentome/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { forgetLicense, installationIdOf, signLicense } from '../src/license/service.js';
import { enqueueRun } from '../src/runs/service.js';
import { setupCodeIn } from './app.js';

// The license, signed with a pair of the test's own: Free without a key, a key,
// grace, back to Free or read-only over it, cutting back, the installation a key is made out to,
// a clock put back, and the soft limit of agents.

const DAY = 86_400_000;
const owner = generateKeyPairSync('ed25519');
const stranger = generateKeyPairSync('ed25519');

let container: StartedPostgreSqlContainer;
let app: Awaited<ReturnType<typeof buildApp>>;
let db: Db;
let dataDir: string;
let cookie = '';

const keyFor = (
  days: number,
  agents: number | null = null,
  privateKey = owner.privateKey,
  installation?: string,
): string =>
  signLicense(privateKey, {
    id: `l-${days}`,
    company: 'Acme',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + days * DAY).toISOString(),
    agents,
    ...(installation && { installation }),
  });

function cookieOf(response: LightMyRequestResponse): string {
  const setCookie = response.headers['set-cookie'] ?? [];
  return (Array.isArray(setCookie) ? setCookie : [setCookie])
    .map((value) => value.split(';', 1)[0])
    .join('; ');
}

const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie }, ...(payload && { payload }) });

const license = async () => (await call('GET', '/api/license')).json();

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  dataDir = mkdtempSync(join(tmpdir(), 'agentome-license-'));
  await migrate(container.getConnectionUri());
  const config = loadConfig({
    AGENTOME_DATABASE_URL: container.getConnectionUri(),
    AGENTOME_DATA_DIR: dataDir,
    AGENTOME_LOG_LEVEL: 'silent',
  });
  app = await buildApp(config, {
    workerBundle: join(dataDir, 'no-bundle.mjs'),
    licenseKey: owner.publicKey,
  });
  db = createDb(container.getConnectionUri(), () => {});
  const setup = await app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: {
      code: setupCodeIn(dataDir),
      orgName: 'Acme',
      admin: { name: 'Admin', email: 'admin@example.com', password: 'the admin password' },
    },
  });
  cookie = cookieOf(setup);
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.$client.end();
  await container?.stop();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

const thisInstallation = () =>
  installationIdOf(readFileSync(join(dataDir, 'secrets', 'secret.key'), 'utf8').trim());

const agentIds = async () =>
  (await call('GET', '/api/agents')).json<{ agents: { id: string }[] }>().agents.map((a) => a.id);

describe('the version', () => {
  it('names a development build to an admin, and to nobody signed out', async () => {
    expect((await call('GET', '/api/admin/version')).json()).toEqual({
      version: null,
      commit: null,
      updateCheck: true,
    });
    const signedOut = await app.inject({ method: 'GET', url: '/api/admin/version' });
    expect(signedOut.statusCode).toBe(401);
  });
});

describe('the license', () => {
  it('is Free without a key, with no end', async () => {
    expect(await license()).toMatchObject({
      status: 'free',
      enterprise: false,
      installationId: thisInstallation(),
      company: null,
      expiresAt: null,
      graceEndsAt: null,
      over: [],
    });
    expect(thisInstallation()).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
  });

  it('refuses a key that is not ours, or was changed', async () => {
    for (const key of [
      'not a key',
      keyFor(365, null, stranger.privateKey),
      keyFor(365).replace(/\.([^.]+)\./, (_, body: string) => `.${body.slice(0, -2)}xx.`),
    ]) {
      const response = await call('PUT', '/api/admin/license', { key });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'invalid_license' } });
    }
  });

  it('refuses a key made out to another installation, and takes one made out to this', async () => {
    const other = await call('PUT', '/api/admin/license', {
      key: keyFor(365, null, owner.privateKey, '0000-0000-0000-0000'),
    });
    expect(other.statusCode).toBe(400);
    expect(other.json().error.message).toContain(thisInstallation());
    const ours = await call('PUT', '/api/admin/license', {
      key: keyFor(365, null, owner.privateKey, thisInstallation()),
    });
    expect(ours.json()).toMatchObject({ status: 'valid', enterprise: true });
  });

  it('takes a key at once, and says whom it is for', async () => {
    const response = await call('PUT', '/api/admin/license', { key: keyFor(365, 2) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'valid',
      enterprise: true,
      company: 'Acme',
      agents: { limit: 2 },
    });
  });

  it('counts agents over the limit and blocks none of them', async () => {
    for (const name of ['One', 'Two', 'Three']) {
      expect((await call('POST', '/api/agents', { name })).statusCode).toBe(201);
    }
    forgetLicense();
    expect((await license()).agents).toEqual({ limit: 2, active: 3, peak: 3 });
  });

  it('keeps working in the grace after the end, and says so', async () => {
    await call('PUT', '/api/admin/license', { key: keyFor(-1) });
    expect(await license()).toMatchObject({ status: 'grace', enterprise: true });
    expect((await call('POST', '/api/agents', { name: 'In grace' })).statusCode).toBe(201);
  });

  it('goes back to Free after the grace while the installation is within Free', async () => {
    const put = await call('PUT', '/api/admin/license', { key: keyFor(-15) });
    expect(put.json()).toMatchObject({ status: 'free', enterprise: false, over: [] });
    expect((await call('POST', '/api/agents', { name: 'Fifth' })).statusCode).toBe(201);
  });

  it('turns read-only over Free without a key: viewing works, nothing changes or runs', async () => {
    // Free refuses a sixth agent; one made under a key stays when the key lapses.
    expect((await call('POST', '/api/agents', { name: 'Sixth' })).statusCode).toBe(403);
    await call('PUT', '/api/admin/license', { key: keyFor(365) });
    expect((await call('POST', '/api/agents', { name: 'Sixth' })).statusCode).toBe(201);
    const lapsed = await call('PUT', '/api/admin/license', { key: keyFor(-15) });
    expect(lapsed.json()).toMatchObject({ status: 'read_only', over: ['agents'] });

    expect((await call('GET', '/api/agents')).statusCode).toBe(200);
    const refused = await call('POST', '/api/agents', { name: 'Seventh' });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: { code: 'read_only' } });
    expect((await call('PATCH', '/api/me', { name: 'Renamed' })).statusCode).toBe(403);
    const [first] = await agentIds();
    expect((await call('PATCH', `/api/agents/${first}`, { name: 'Renamed' })).statusCode).toBe(403);

    // Nothing queues a run, whoever asks: a person, a schedule, a webhook.
    const [admin] = await db.select({ id: users.id }).from(users);
    const [task] = await db
      .insert(tasks)
      .values({ agentId: first!, title: 'A task', source: 'manual', createdBy: admin!.id })
      .returning({ id: tasks.id });
    expect((await call('POST', `/api/tasks/${task!.id}/run`)).statusCode).toBe(403);
    await expect(enqueueRun(db, task!.id, null)).rejects.toMatchObject({ code: 'read_only' });

    // An admin can still sign in and put a key in.
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      remoteAddress: '10.0.0.9',
      payload: { email: 'admin@example.com', password: 'the admin password' },
    });
    expect(signIn.statusCode).toBe(200);
  });

  it('lets a read-only installation cut back to Free, and then works again', async () => {
    const [first] = await agentIds();
    const archived = await call('POST', `/api/agents/${first}/archive`);
    expect(archived.statusCode).toBe(200);
    expect(await license()).toMatchObject({ status: 'free', over: [] });
    // Bringing it back would go over Free again: Free refuses it.
    const back = await call('POST', `/api/agents/${first}/unarchive`);
    expect(back.json()).toMatchObject({ error: { code: 'license_required' } });
  });

  it('works over Free again with a new key', async () => {
    const renewed = await call('PUT', '/api/admin/license', { key: keyFor(365) });
    expect(renewed.json()).toMatchObject({ status: 'valid' });
    expect((await call('POST', '/api/agents', { name: 'Renewed' })).statusCode).toBe(201);
  });

  it('does not bring a key back when the clock is put back', async () => {
    await call('PUT', '/api/admin/license', { key: keyFor(10) });
    // The server has seen a time 12 days on: the key's end is behind it, whatever the clock says.
    await db.update(installation).set({ licenseSeenAt: new Date(Date.now() + 12 * DAY) });
    forgetLicense();
    expect((await license()).status).toBe('grace');
    await db.update(installation).set({ licenseSeenAt: new Date() });
  });

  it('is Free, not on a trial, when the key is taken out of the database', async () => {
    await db.update(installation).set({ license: null });
    forgetLicense();
    const state = await license();
    expect(state).toMatchObject({ enterprise: false, company: null, expiresAt: null });
    expect(state.status).toBe(state.over.length > 0 ? 'read_only' : 'free');
    await call('PUT', '/api/admin/license', { key: keyFor(365) });
  });

  it('lets only an admin put a key in', async () => {
    const invited = await call('POST', '/api/invitations', {
      role: 'member',
      email: 'm@example.com',
    });
    const token = invited.json<{ url: string }>().url.split('/invite/')[1];
    const member = await app.inject({
      method: 'POST',
      url: `/api/invitations/${token}/accept`,
      payload: { name: 'Member', email: 'm@example.com', password: 'the member password' },
    });
    const response = await app.inject({
      method: 'PUT',
      url: '/api/admin/license',
      headers: { cookie: cookieOf(member) },
      payload: { key: keyFor(365) },
    });
    expect(response.statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/license',
          headers: { cookie: cookieOf(member) },
        })
      ).statusCode,
    ).toBe(200);
  });
});
