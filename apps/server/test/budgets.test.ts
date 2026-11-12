import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentGrants,
  agents,
  costEvents,
  createDb,
  type Db,
  eq,
  migrate,
  notifications,
  projectAgents,
  projects,
  runs,
  tasks,
} from '@agentome/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { notifyBudget } from '../src/budgets/service.js';
import { licenseEnterprise, projectOfAgent, setupCodeIn } from './app.js';

// Budgets in money: a month spent refuses new runs, the owner may let the agent go on,
// and the owners hear of it at 80%.

let container: StartedPostgreSqlContainer;
let app: Awaited<ReturnType<typeof buildApp>>;
let db: Db;
let dataDir: string;
let cookie = '';
let adminId = '';

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  dataDir = mkdtempSync(join(tmpdir(), 'agentome-budgets-'));
  await migrate(container.getConnectionUri());
  const config = loadConfig({
    AGENTOME_DATABASE_URL: container.getConnectionUri(),
    AGENTOME_DATA_DIR: dataDir,
    AGENTOME_LOG_LEVEL: 'silent',
  });
  app = await buildApp(config, { workerBundle: join(dataDir, 'no-bundle.mjs') });
  db = createDb(container.getConnectionUri(), () => {});
  const setup: LightMyRequestResponse = await app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: {
      code: setupCodeIn(dataDir),
      orgName: 'Acme',
      admin: { name: 'Admin', email: 'admin@example.com', password: 'the admin password' },
    },
  });
  await licenseEnterprise(db);
  const setCookie = setup.headers['set-cookie'] ?? [];
  cookie = (Array.isArray(setCookie) ? setCookie : [setCookie])
    .map((value) => value.split(';', 1)[0])
    .join('; ');
  adminId = (await app.inject({ url: '/api/me', headers: { cookie } })).json().id;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.$client.end();
  await container?.stop();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

/** An agent with a monthly limit, and a past run of it that cost `usd` this month. */
async function agentThatSpent(usd: number, limit: number, projectId: string | null = null) {
  const [agent] = await db
    .insert(agents)
    .values({
      ownerUserId: adminId,
      name: 'Jira admin',
      roleTitle: 'Admin',
      budget: { usdPerMonth: limit },
    })
    .returning();
  if (!agent) throw new Error('no agent');
  await db.insert(agentGrants).values({ agentId: agent.id, userId: adminId, level: 'owner' });
  const [task] = await db
    .insert(tasks)
    .values({
      agentId: agent.id,
      projectId,
      title: 'Earlier',
      source: 'manual',
      createdBy: adminId,
    })
    .returning();
  const [run] = await db
    .insert(runs)
    .values({
      agentId: agent.id,
      taskId: task?.id,
      status: 'done',
      startedBy: 'user',
      startedByUserId: adminId,
    })
    .returning();
  await db.insert(costEvents).values({
    runId: run?.id ?? '',
    agentId: agent.id,
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    tokensIn: 1,
    tokensOut: 1,
    tokensCacheRead: 0,
    tokensCacheWrite: 0,
    usd: String(usd),
    source: 'test',
  });
  return { agent, runId: run?.id ?? '' };
}

const newTask = async (agentId: string, projectId?: string) =>
  app.inject({
    method: 'POST',
    url: '/api/tasks',
    headers: { cookie },
    payload: {
      agentId,
      projectId: projectId ?? (await projectOfAgent(db, agentId)),
      title: 'Tidy the board',
      body: '',
      repository: null,
      run: true,
    },
  });

describe('budgets', () => {
  it('refuse a run once the month is spent, until the owner lets the agent go on', async () => {
    const { agent } = await agentThatSpent(10.5, 10);
    const refused = await newTask(agent.id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({ code: 'budget_reached' });
    expect(refused.json().error.message).toContain('$10.50 of its $10.00');

    const view = await app.inject({ url: `/api/agents/${agent.id}`, headers: { cookie } });
    expect(view.json().spend).toEqual({
      usdThisMonth: 10.5,
      limit: 10,
      reached: true,
      resumed: false,
    });
    const resumed = await app.inject({
      method: 'POST',
      url: `/api/agents/${agent.id}/budget/resume`,
      headers: { cookie },
    });
    expect(resumed.json().spend.resumed).toBe(true);
    expect((await newTask(agent.id)).statusCode).toBe(201);
  });

  it('refuse a run of a project whose month is spent', async () => {
    const [project] = await db
      .insert(projects)
      .values({ name: 'Payments', createdBy: adminId, usdPerMonth: '5' })
      .returning();
    const { agent } = await agentThatSpent(6, 100, project?.id ?? null);
    await db
      .insert(agentGrants)
      .values({ agentId: agent.id, userId: adminId, level: 'owner' })
      .onConflictDoNothing();
    await db.insert(projectAgents).values({ projectId: project?.id ?? '', agentId: agent.id });
    const refused = await newTask(agent.id, project?.id);
    expect(refused.json().error.message).toContain('The project Payments spent $6.00 of its $5.00');
    const view = await app.inject({ url: `/api/projects/${project?.id}`, headers: { cookie } });
    expect(view.json().budget).toEqual({ usdPerMonth: 5, usdThisMonth: 6 });
  });

  it('tell the owners once a month when a run takes the agent past 80%', async () => {
    const low = await agentThatSpent(7, 10);
    expect(await notifyBudget(db, low.runId)).toEqual([]);
    const { agent, runId } = await agentThatSpent(8.5, 10);
    const told = await notifyBudget(db, runId);
    expect(told).toHaveLength(1);
    const [row] = await db
      .select()
      .from(notifications)
      .where(eq(notifications.id, told[0] ?? ''));
    expect(row).toMatchObject({
      kind: 'budget',
      userId: adminId,
      payload: { agentId: agent.id, spent: 8.5, limit: 10 },
    });
    expect(await notifyBudget(db, runId)).toEqual([]);
  });
});
