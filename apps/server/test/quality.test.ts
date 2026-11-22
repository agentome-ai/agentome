import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  costEvents,
  createDb,
  type Db,
  migrate,
  projectAgents,
  projects,
  runArtifacts,
  runs,
  taskComments,
  tasks,
  users,
} from '@agentome/db';
import { eq } from '@agentome/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { licenseEnterprise, secondStepForAdmins, setupCodeIn } from './app.js';

// An agent's quality: four tasks this month and one older. One merged at the
// first go, one merged after a person and a failed pipeline sent it back, one a person closed
// without a change request, as a Jira admin's are, and one whose run hit its time limit.

let container: StartedPostgreSqlContainer;
let app: Awaited<ReturnType<typeof buildApp>>;
let db: Db;
let dataDir: string;
let cookie = '';

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  dataDir = mkdtempSync(join(tmpdir(), 'agentome-quality-'));
  await migrate(container.getConnectionUri());
  const config = loadConfig({
    AGENTOME_DATABASE_URL: container.getConnectionUri(),
    AGENTOME_DATA_DIR: dataDir,
    AGENTOME_LOG_LEVEL: 'silent',
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
  await secondStepForAdmins(container.getConnectionUri());
  await licenseEnterprise(db);
  const setCookie = setup.headers['set-cookie'] ?? [];
  cookie = (Array.isArray(setCookie) ? setCookie : [setCookie])
    .map((value) => value.split(';', 1)[0])
    .join('; ');
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.$client.end();
  await container?.stop();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie } });

const HOUR = 60 * 60 * 1000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR);

describe('an agent quality', () => {
  it('counts accepted tasks, merges, returns, cost, time and failed runs of 30 days', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/agents',
      headers: { cookie },
      payload: { name: 'Backend' },
    });
    const agentId = created.json<{ id: string }>().id;
    const [admin] = await db.select({ id: users.id }).from(users);
    if (!admin) throw new Error('no admin');

    async function task(title: string, hoursAgo: number, status: 'open' | 'done' = 'done') {
      const [row] = await db
        .insert(tasks)
        .values({
          agentId,
          title,
          status,
          source: 'manual',
          createdBy: admin!.id,
          createdAt: ago(hoursAgo),
        })
        .returning({ id: tasks.id });
      return row!.id;
    }
    async function run(
      taskId: string,
      startedHoursAgo: number,
      how: Partial<typeof runs.$inferInsert> & { usd?: string; change?: string } = {},
    ) {
      const { usd, change, ...fields } = how;
      const [row] = await db
        .insert(runs)
        .values({
          agentId,
          taskId,
          startedBy: 'user',
          status: 'done',
          createdAt: ago(startedHoursAgo),
          startedAt: ago(startedHoursAgo),
          endedAt: ago(startedHoursAgo - 1),
          ...fields,
        })
        .returning({ id: runs.id });
      const runId = row!.id;
      if (usd) {
        await db.insert(costEvents).values({
          runId,
          agentId,
          provider: 'anthropic',
          model: 'claude-sonnet-5-5',
          tokensIn: 1,
          tokensOut: 1,
          tokensCacheRead: 0,
          tokensCacheWrite: 0,
          usd,
          source: 'claude-code',
        });
      }
      if (change) {
        await db.insert(runArtifacts).values({
          runId,
          kind: 'change_request',
          ref: `https://github.com/acme/pay/pull/${runId.slice(0, 4)}`,
          meta: { state: change },
        });
      }
    }

    const first = await task('Add a README', 48);
    await run(first, 47, { usd: '1.00', change: 'merged' });
    const returned = await task('Retry webhooks', 30);
    await run(returned, 29, { usd: '2.00', change: 'merged' });
    await run(returned, 20, { usd: '0.50' });
    await run(returned, 10, {
      startedBy: 'webhook',
      reason: 'The pipeline of your change request https://github.com/acme/pay/pull/1 failed.',
      usd: '0.50',
    });
    const closed = await task('Close stale issues in PAY', 12);
    await run(closed, 11, { usd: '0.40' });
    const stuck = await task('Rewrite billing', 5, 'open');
    await run(stuck, 4, { status: 'failed', errorCode: 'timeout' });
    const older = await task('Old work', 24 * 40);
    await run(older, 24 * 40 - 1, { change: 'closed' });

    const response = await get(`/api/agents/${agentId}/quality`);
    expect(response.statusCode).toBe(200);
    const quality = response.json();
    expect(quality).toMatchObject({
      tasks: 4,
      handed: 3,
      accepted: 3,
      firstTime: 2,
      changeRequests: { merged: 2, closed: 0, open: 0 },
      returns: { total: 2, tasks: 1, person: 1, ci: 1, review: 0 },
      usd: { median: '1.00', total: '4.40' },
      seconds: { work: 3600, toReview: 7200 },
      runs: { ended: 6, failed: 1, limited: 1 },
    });
    expect(quality.mostReturned).toEqual([
      { id: returned, title: 'Retry webhooks', returns: 2, usd: '3.00' },
    ]);

    const list = await get('/api/agents');
    const listed = list
      .json<{ agents: { id: string; month: unknown }[] }>()
      .agents.find((agent) => agent.id === agentId);
    expect(listed?.month).toEqual({ accepted: 3, handed: 3, medianUsd: '1.00' });
  });

  it('starts a review: a task of the agent that tells of what came back and why', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/agents',
      headers: { cookie },
      payload: { name: 'Frontend' },
    });
    const agentId = created.json<{ id: string }>().id;
    const [admin] = await db.select({ id: users.id }).from(users);
    if (!admin) throw new Error('no admin');

    // On no project, a review has nowhere to be filed.
    const nowhere = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/review`,
      headers: { cookie },
    });
    expect(nowhere.statusCode).toBe(400);

    const [project] = await db
      .insert(projects)
      .values({ name: 'Shop', createdBy: admin.id })
      .returning({ id: projects.id });
    await db.insert(projectAgents).values({ projectId: project!.id, agentId });
    const [task] = await db
      .insert(tasks)
      .values({
        agentId,
        projectId: project!.id,
        title: 'Fix the cart badge',
        status: 'done',
        source: 'manual',
        createdBy: admin.id,
        createdAt: ago(30),
      })
      .returning({ id: tasks.id });
    await db.insert(runs).values([
      {
        agentId,
        taskId: task!.id,
        startedBy: 'user',
        status: 'done',
        summary: 'Moved the badge into the header.',
        createdAt: ago(29),
        startedAt: ago(29),
        endedAt: ago(28),
      },
      {
        agentId,
        taskId: task!.id,
        startedBy: 'webhook',
        reason: 'The pipeline of your change request https://github.com/acme/shop/pull/7 failed.',
        status: 'done',
        createdAt: ago(10),
        startedAt: ago(10),
        endedAt: ago(9),
      },
    ]);
    await db
      .insert(taskComments)
      .values({ taskId: task!.id, authorUserId: admin.id, body: 'The badge overlaps the logo.' });

    const started = await app.inject({
      method: 'POST',
      url: `/api/agents/${agentId}/review`,
      headers: { cookie },
    });
    expect(started.statusCode).toBe(201);
    const { taskId } = started.json<{ taskId: string }>();
    const [review] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(review).toMatchObject({ agentId, projectId: project!.id, title: 'Review your work' });
    expect(review!.body).toContain(
      '### Fix the cart badge (came back 1 time: 1 by a failed pipeline)',
    );
    expect(review!.body).toContain('pull/7 failed');
    expect(review!.body).toContain('Your report: Moved the badge into the header.');
    expect(review!.body).toContain('> The badge overlaps the logo.');
    // What others wrote is quoted as data; the steps after it are the task's own.
    const body = review!.body;
    expect(body.indexOf('<untrusted_tool_result')).toBeLessThan(body.indexOf('### Fix the cart'));
    expect(body.indexOf('</untrusted_tool_result>')).toBeLessThan(body.indexOf('## What to do'));
    expect(review!.body).toContain('agent_propose_instructions');
    // It runs at once, as a task a person starts.
    const queued = await db.select({ id: runs.id }).from(runs).where(eq(runs.taskId, taskId));
    expect(queued).toHaveLength(1);
  });

  it('is only for those who see the agent', async () => {
    const response = await get('/api/agents/00000000-0000-4000-8000-000000000000/quality');
    expect(response.statusCode).toBe(404);
  });
});
