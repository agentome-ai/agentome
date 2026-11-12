import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentGrants,
  agents,
  createDb,
  type Db,
  migrate,
  modelConnections,
  tasks,
} from '@agentome/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { type Config, loadConfig } from '../src/config.js';
import { connectionsKey, encryptSecret } from '../src/connections/crypto.js';
import { LaunchPackage } from '../src/protocol.js';
import { enqueueRun } from '../src/runs/service.js';
import { licenseEnterprise, setupCodeIn } from './app.js';

// Server seats: a server seat takes anyone's server agents with a model connection
// and gets the connection's key; a computer takes its owner's computer agents and never a key.

let container: StartedPostgreSqlContainer;
let app: Awaited<ReturnType<typeof buildApp>>;
let db: Db;
let config: Config;
let dataDir: string;
let adminCookie = '';
let adminId = '';
let memberCookie = '';
let memberId = '';
let connectionId = '';

const cookieOf = (response: LightMyRequestResponse) => {
  const setCookie = response.headers['set-cookie'] ?? [];
  return (Array.isArray(setCookie) ? setCookie : [setCookie])
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  dataDir = mkdtempSync(join(tmpdir(), 'agentome-server-seat-'));
  await migrate(container.getConnectionUri());
  config = loadConfig({
    AGENTOME_DATABASE_URL: container.getConnectionUri(),
    AGENTOME_DATA_DIR: dataDir,
    AGENTOME_LOG_LEVEL: 'silent',
    AGENTOME_PUBLIC_URL: 'https://agentome.example.com',
  });
  app = await buildApp(config, { workerBundle: join(dataDir, 'no-bundle.mjs') });
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
  await licenseEnterprise(db);
  adminCookie = cookieOf(setup);
  adminId = (await app.inject({ url: '/api/me', headers: { cookie: adminCookie } })).json().id;
  const invitation = await app.inject({
    method: 'POST',
    url: '/api/invitations',
    headers: { cookie: adminCookie },
    payload: {},
  });
  const token = invitation.json<{ url: string }>().url.split('/invite/')[1];
  const accepted = await app.inject({
    method: 'POST',
    url: `/api/invitations/${token}/accept`,
    payload: { name: 'Maria', email: 'maria@example.com', password: 'a long enough password' },
  });
  memberCookie = cookieOf(accepted);
  memberId = accepted.json().id;
  const [connection] = await db
    .insert(modelConnections)
    .values({
      name: 'OpenRouter',
      kind: 'gateway',
      baseUrl: 'https://openrouter.ai/api',
      keyCiphertext: encryptSecret(connectionsKey(config.secretKey), 'sk-or-agents'),
      models: ['anthropic/claude-sonnet-4.5', 'openai/gpt-5'],
      createdBy: adminId,
    })
    .returning();
  connectionId = connection?.id ?? '';
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.$client.end();
  await container?.stop();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

async function pair(cookie: string, kind: string) {
  const code = (
    await app.inject({ method: 'POST', url: '/api/seats/pairing-codes', headers: { cookie } })
  ).json<{ code: string }>().code;
  return app.inject({
    method: 'POST',
    url: '/api/seats/pair',
    payload: { code, name: `${kind}-seat`, kind, engines: ['claude-code'] },
  });
}

async function agentWithRun(ownerId: string, set: Partial<typeof agents.$inferInsert> = {}) {
  const [agent] = await db
    .insert(agents)
    .values({ ownerUserId: ownerId, name: 'Jira admin', roleTitle: 'Admin', ...set })
    .returning();
  if (!agent) throw new Error('no agent');
  await db.insert(agentGrants).values({ agentId: agent.id, userId: ownerId, level: 'owner' });
  const [task] = await db
    .insert(tasks)
    .values({ agentId: agent.id, title: 'Tidy the board', source: 'manual', createdBy: ownerId })
    .returning();
  if (!task) throw new Error('no task');
  const run = await enqueueRun(db, task.id, ownerId);
  return { agent, run };
}

const claim = (token: string) =>
  app.inject({
    url: '/api/seats/claim?wait=0',
    headers: { authorization: `Bearer ${token}` },
  });

describe('server seats', () => {
  it('take Codex agents once the worker says it has Codex, on a model that is not Claude', async () => {
    const seat = (await pair(adminCookie, 'api-server')).json<{ token: string }>();
    const { agent, run } = await agentWithRun(memberId, {
      engine: 'codex',
      runsOn: 'server',
      modelConnectionId: connectionId,
      modelPref: 'openai/gpt-5',
    });
    // Paired with Claude Code only: the Codex run waits.
    expect((await claim(seat.token)).statusCode).toBe(204);
    const withCodex = await app.inject({
      url: '/api/seats/claim?wait=0&engines=claude-code,codex',
      headers: { authorization: `Bearer ${seat.token}` },
    });
    const launch = LaunchPackage.parse(withCodex.json());
    expect(launch.run.id).toBe(run.id);
    expect(launch.agent.engine).toBe('codex');
    expect(launch.model?.key).toBe('sk-or-agents');

    const patch = (payload: object) =>
      app.inject({
        method: 'PATCH',
        url: `/api/agents/${agent.id}`,
        headers: { cookie: memberCookie },
        payload,
      });
    expect(
      (await patch({ modelPref: 'anthropic/claude-sonnet-4.5' })).json().error.message,
    ).toContain('Codex runs the others');
    expect((await patch({ modelPref: 'openai/gpt-5' })).statusCode).toBe(200);
  });

  it('are connected by an admin’s code only', async () => {
    const refused = await pair(memberCookie, 'api-server');
    expect(refused.statusCode).toBe(403);
    expect((await pair(adminCookie, 'local-model')).statusCode).toBe(403);
    expect((await pair(adminCookie, 'api-server')).statusCode).toBe(201);
  });

  it('take server agents of anyone, with the key and without a shell; computers never do', async () => {
    const server = (await pair(adminCookie, 'api-server')).json<{ token: string }>();
    const laptop = (await pair(memberCookie, 'subscription-laptop')).json<{ token: string }>();
    // A server agent without a connection waits: no seat may take it.
    await agentWithRun(memberId, { runsOn: 'server' });
    const { run } = await agentWithRun(memberId, {
      runsOn: 'server',
      modelConnectionId: connectionId,
      modelPref: 'anthropic/claude-sonnet-4.5',
    });
    expect((await claim(laptop.token)).statusCode).toBe(204);

    const answer = await claim(server.token);
    expect(answer.statusCode).toBe(200);
    const launch = LaunchPackage.parse(answer.json());
    expect(launch.run.id).toBe(run.id);
    expect(launch.model).toEqual({
      kind: 'gateway',
      baseUrl: 'https://openrouter.ai/api',
      key: 'sk-or-agents',
    });
    const { settings, claudeMd } = launch.workspace.profile;
    expect(settings.allowedTools).not.toContain('Bash');
    expect(settings.sandbox.enabled).toBe(false);
    expect(claudeMd).toContain('You have no shell here');

    // The owner's computer agent goes to the computer, without a key; the server seat leaves it.
    const own = await agentWithRun(memberId);
    expect((await claim(server.token)).statusCode).toBe(204);
    const onLaptop = LaunchPackage.parse((await claim(laptop.token)).json());
    expect(onLaptop.run.id).toBe(own.run.id);
    expect(onLaptop.model).toBeUndefined();
    expect(onLaptop.workspace.profile.settings.allowedTools).toContain('Bash');
  });

  it('let an owner set an agent to the server with a Claude model; the shell is an admin’s', async () => {
    const { agent } = await agentWithRun(memberId);
    const patch = (cookie: string, payload: object) =>
      app.inject({ method: 'PATCH', url: `/api/agents/${agent.id}`, headers: { cookie }, payload });
    expect((await patch(memberCookie, { runsOn: 'server' })).statusCode).toBe(400);
    const gpt = await patch(memberCookie, {
      runsOn: 'server',
      modelConnectionId: connectionId,
      modelPref: 'openai/gpt-5',
    });
    expect(gpt.json().error.message).toContain('Claude models only');
    const set = await patch(memberCookie, {
      runsOn: 'server',
      modelConnectionId: connectionId,
      modelPref: 'anthropic/claude-sonnet-4.5',
    });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({
      runsOn: 'server',
      modelConnection: { id: connectionId, name: 'OpenRouter' },
      serverShell: false,
    });
    expect((await patch(memberCookie, { serverShell: true })).statusCode).toBe(403);
    expect((await patch(adminCookie, { serverShell: true })).json().serverShell).toBe(true);
    // Another model of the same connection keeps it; another place to run takes it away.
    const other = await patch(memberCookie, { modelPref: 'anthropic/claude-sonnet-4.5' });
    expect(other.json().serverShell).toBe(true);
    expect((await patch(memberCookie, { runsOn: 'laptop' })).json().serverShell).toBe(false);
    const back = await patch(memberCookie, { runsOn: 'server', modelConnectionId: connectionId });
    expect(back.json().serverShell).toBe(false);

    // Every person sees the connections' names and models, never an address or a key.
    const models = await app.inject({ url: '/api/models', headers: { cookie: memberCookie } });
    expect(models.json()).toEqual({
      connections: [
        {
          id: connectionId,
          name: 'OpenRouter',
          models: [
            { id: 'anthropic/claude-sonnet-4.5', engine: 'claude-code' },
            { id: 'openai/gpt-5', engine: 'codex' },
          ],
        },
      ],
    });
  });
});
