import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, type Db, migrate } from '@agentome/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { forgetLicense } from '../src/license/service.js';
import { licenseEnterprise, setupCodeIn } from './app.js';

// Free without a key: the server refuses what goes past it, whatever the client says,
// and an Enterprise key lets the same through.

const publicUrl = 'http://localhost:3000';
let container: StartedPostgreSqlContainer;
let app: Awaited<ReturnType<typeof buildApp>>;
let db: Db;
let dataDir: string;
let cookie = '';

function cookieOf(response: LightMyRequestResponse): string {
  const setCookie = response.headers['set-cookie'] ?? [];
  return (Array.isArray(setCookie) ? setCookie : [setCookie])
    .map((value) => value.split(';', 1)[0])
    .join('; ');
}

const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie, origin: publicUrl }, ...(payload && { payload }) });

const refusal = (response: LightMyRequestResponse) => ({
  status: response.statusCode,
  code: response.json<{ error?: { code: string } }>().error?.code,
});
const REQUIRED = { status: 403, code: 'license_required' };

const newAgent = async (name: string) => {
  const response = await call('POST', '/api/agents', { name });
  expect(response.statusCode).toBe(201);
  return response.json<{ id: string }>().id;
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  dataDir = mkdtempSync(join(tmpdir(), 'agentome-free-'));
  await migrate(container.getConnectionUri());
  const config = loadConfig({
    AGENTOME_DATABASE_URL: container.getConnectionUri(),
    AGENTOME_DATA_DIR: dataDir,
    AGENTOME_LOG_LEVEL: 'silent',
    AGENTOME_PUBLIC_URL: publicUrl,
    // Nothing listens there: a sign-in that got past the license would fail on discovery.
    AGENTOME_KEYCLOAK_ISSUER: 'http://127.0.0.1:1/realms/acme/',
    AGENTOME_KEYCLOAK_CLIENT_ID: 'agentome',
    AGENTOME_KEYCLOAK_CLIENT_SECRET: 'the client secret',
  });
  app = await buildApp(config, { workerBundle: join(dataDir, 'no-bundle.mjs') });
  db = createDb(container.getConnectionUri(), () => {});
  const setup = await app.inject({
    method: 'POST',
    url: '/api/setup',
    headers: { origin: publicUrl },
    payload: {
      code: setupCodeIn(dataDir),
      orgName: 'Acme',
      admin: { name: 'Ann Admin', email: 'ann@acme.com', password: 'the admin password' },
    },
  });
  expect(setup.statusCode).toBe(201);
  cookie = cookieOf(setup);
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.$client.end();
  await container?.stop();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

describe('Free without a key', () => {
  let first = '';
  let project = '';

  it('takes five active agents and refuses a sixth, however it comes', async () => {
    first = await newAgent('One');
    for (const name of ['Two', 'Three', 'Four', 'Five']) await newAgent(name);
    expect(refusal(await call('POST', '/api/agents', { name: 'Six' }))).toEqual(REQUIRED);
    expect(refusal(await call('POST', `/api/agents/${first}/duplicate`))).toEqual(REQUIRED);
    // An archived agent makes room, and bringing it back takes the room again.
    await call('POST', `/api/agents/${first}/archive`);
    const sixth = await newAgent('Six');
    expect(refusal(await call('POST', `/api/agents/${first}/unarchive`))).toEqual(REQUIRED);
    await call('POST', `/api/agents/${sixth}/archive`);
    expect((await call('POST', `/api/agents/${first}/unarchive`)).statusCode).toBe(200);
  });

  it('takes one team and refuses a second', async () => {
    const agents = (await call('GET', '/api/agents')).json<{ agents: { id: string }[] }>().agents;
    const [lead, other] = agents;
    expect(
      (await call('POST', '/api/teams', { name: 'Payments', leadId: lead!.id })).statusCode,
    ).toBe(201);
    expect(
      refusal(await call('POST', '/api/teams', { name: 'Ledger', leadId: other!.id })),
    ).toEqual(REQUIRED);
  });

  it('refuses agents on the server, monthly budgets and the quality page', async () => {
    expect(refusal(await call('PATCH', `/api/agents/${first}`, { runsOn: 'server' }))).toEqual(
      REQUIRED,
    );
    expect(
      refusal(await call('PATCH', `/api/agents/${first}`, { budget: { usdPerMonth: 50 } })),
    ).toEqual(REQUIRED);
    // The limits of one run stay Free: they guard, they do not manage.
    expect(
      (await call('PATCH', `/api/agents/${first}`, { budget: { maxMinutes: 30 } })).statusCode,
    ).toBe(200);
    project = (await call('POST', '/api/projects', { name: 'Payments' })).json<{ id: string }>().id;
    expect(refusal(await call('PATCH', `/api/projects/${project}`, { usdPerMonth: 100 }))).toEqual(
      REQUIRED,
    );
    expect(refusal(await call('GET', `/api/agents/${first}/quality`))).toEqual(REQUIRED);
  });

  it('keeps Keycloak off: not offered, and its sign-in refused', async () => {
    expect((await call('GET', '/api/setup')).json()).toEqual({ completed: true, keycloak: false });
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/social',
      headers: { origin: publicUrl },
      payload: { provider: 'keycloak', callbackURL: '/tasks', errorCallbackURL: '/login' },
    });
    expect(refusal(signIn)).toEqual(REQUIRED);
  });

  it('lets all of it through with an Enterprise key', async () => {
    await licenseEnterprise(db);
    forgetLicense();
    await newAgent('Seventh');
    const agents = (await call('GET', '/api/agents')).json<{ agents: { id: string }[] }>().agents;
    expect(
      (await call('POST', '/api/teams', { name: 'Ledger', leadId: agents[1]!.id })).statusCode,
    ).toBe(201);
    expect((await call('PATCH', `/api/projects/${project}`, { usdPerMonth: 100 })).statusCode).toBe(
      200,
    );
    expect((await call('GET', `/api/agents/${first}/quality`)).statusCode).toBe(200);
    expect((await call('GET', '/api/setup')).json()).toEqual({ completed: true, keycloak: true });
  });

  it('turns Keycloak off when the key and its grace end; passwords still sign in', async () => {
    await licenseEnterprise(db, -15);
    expect((await call('GET', '/api/setup')).json()).toEqual({ completed: true, keycloak: false });
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { origin: publicUrl },
      remoteAddress: '10.0.0.7',
      payload: { email: 'ann@acme.com', password: 'the admin password' },
    });
    expect(signIn.statusCode).toBe(200);
  });
});
