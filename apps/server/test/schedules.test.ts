import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, type Db, eq, migrate, runs, tasks } from '@agentome/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { localNow, runDueSchedules, whenOf } from '../src/schedules/service.js';
import { projectOfAgent, setupCodeIn } from './app.js';

// An agent's recurring tasks: made and run at their day and minute in their zone.

let container: StartedPostgreSqlContainer;
let app: Awaited<ReturnType<typeof buildApp>>;
let db: Db;
let dataDir: string;
let cookie = '';

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  dataDir = mkdtempSync(join(tmpdir(), 'agentome-schedules-'));
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

const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie }, ...(payload && { payload }) });

describe('schedules', () => {
  it('read their days and minute in their own zone', () => {
    // 06:00 UTC on Monday 2 November 2026 is 09:00 in Moscow.
    expect(localNow('Europe/Moscow', new Date('2026-11-02T06:00:00Z'))).toEqual({
      day: 1,
      time: '09:00',
    });
    expect(whenOf({ days: [1, 2, 3, 4, 5], time: '09:00' })).toBe('Every weekday at 09:00');
    expect(whenOf({ days: [1, 3], time: '18:30' })).toBe('Every Mon, Wed at 18:30');
  });

  it('make and run their task at its minute, once, and not when off', async () => {
    const agent = (await call('POST', '/api/agents', { name: 'Release notes writer' })).json<{
      id: string;
    }>();
    const schedule = {
      title: 'Write the weekly release notes',
      body: 'From the merged pull requests of the week.',
      days: [5, 1, 1],
      time: '09:00',
      timeZone: 'Europe/Moscow',
    };
    // Its tasks are filed in a project like any other.
    const unfiled = await call('POST', `/api/agents/${agent.id}/schedules`, schedule);
    expect(unfiled.statusCode).toBe(400);
    expect(unfiled.json()).toMatchObject({
      error: {
        details: [{ path: 'body/projectId', message: 'Pick the project its tasks are filed in' }],
      },
    });
    const projectId = await projectOfAgent(db, agent.id);
    const made = await call('POST', `/api/agents/${agent.id}/schedules`, {
      ...schedule,
      projectId,
    });
    expect(made.statusCode).toBe(201);
    expect(made.json()).toMatchObject({
      days: [1, 5],
      when: 'Every Mon, Fri at 09:00',
      enabled: true,
    });
    expect(
      (
        await call('POST', `/api/agents/${agent.id}/schedules`, {
          title: 'x',
          days: [],
          time: '9am',
          timeZone: 'Mars/Base',
        })
      ).statusCode,
    ).toBe(400);

    // 08:59 in Moscow: nothing yet.
    expect(await runDueSchedules(db, new Date('2026-11-02T05:59:00Z'))).toEqual([]);
    const monday = new Date('2026-11-02T06:00:00Z');
    const [taskId] = await runDueSchedules(db, monday);
    const [task] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, taskId ?? ''));
    expect(task).toMatchObject({
      title: 'Write the weekly release notes',
      source: 'cron',
      agentId: agent.id,
      projectId,
    });
    const [run] = await db
      .select()
      .from(runs)
      .where(eq(runs.taskId, taskId ?? ''));
    expect(run).toMatchObject({ status: 'queued', startedBy: 'cron', startedByUserId: null });
    expect(run?.reason).toContain('every mon, fri at 09:00 (Europe/Moscow)');
    // The same minute checked again, by a late tick or another server, makes nothing more.
    expect(await runDueSchedules(db, new Date('2026-11-02T06:00:30Z'))).toEqual([]);

    const { id } = made.json<{ id: string }>();
    await call('PATCH', `/api/agents/${agent.id}/schedules/${id}`, { enabled: false });
    expect(await runDueSchedules(db, new Date('2026-11-06T06:00:00Z'))).toEqual([]);
    expect((await call('DELETE', `/api/agents/${agent.id}/schedules/${id}`)).statusCode).toBe(204);
    expect((await call('GET', `/api/agents/${agent.id}/schedules`)).json()).toEqual({
      schedules: [],
    });
  });
});
