import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, type Db, eq, migrate, notifications, runs, sql } from '@agentome/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { TOOLS, type ToolContext } from '../src/mcp/tools.js';
import { taskHistory } from '../src/runs/history.js';
import { projectOfAgent, setupCodeIn } from './app.js';

// A task's thread: a person comments, with or without a run; the agent comments with
// task_comment and its owner hears of it; the next run reads the thread.

let container: StartedPostgreSqlContainer;
let app: Awaited<ReturnType<typeof buildApp>>;
let db: Db;
let dataDir: string;
let cookie = '';

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  dataDir = mkdtempSync(join(tmpdir(), 'agentome-thread-'));
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

const call = (method: 'GET' | 'POST', url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie }, ...(payload && { payload }) });

type View = {
  comments: { body: string; author: { kind: string; name: string }; runId: string | null }[];
  runs: { id: string; summary: string | null }[];
};

describe('the thread of a task', () => {
  it('takes comments from people and agents, and the next run reads them', async () => {
    const agentId = (await call('POST', '/api/agents', { name: 'Checkout frontend' })).json<{
      id: string;
    }>().id;
    const made = await call('POST', '/api/tasks', {
      agentId,
      projectId: await projectOfAgent(db, agentId),
      title: 'Build the refund screen',
    });
    const taskId = made.json<{ task: { id: string } }>().task.id;
    const first = made.json<{ run: { id: string } }>().run.id;

    // While the first run is queued, a comment with a run is refused, and nothing is kept.
    const busy = await call('POST', `/api/tasks/${taskId}/comments`, { body: 'x', run: true });
    expect(busy.statusCode).toBe(409);
    expect((await call('POST', `/api/tasks/${taskId}/comments`, { body: '  ' })).statusCode).toBe(
      400,
    );

    // The agent writes in its run's task; its owner gets a notification.
    const tool = TOOLS.find((one) => one.name === 'task_comment');
    const context: ToolContext = {
      db,
      agentId,
      runId: first,
      codeHost: () => Promise.reject(new Error('no code host')),
      jiraIssue: () => Promise.reject(new Error('no Jira')),
    };
    const posted = await tool?.run(context, { body: 'The screen is on agent/refunds.' });
    expect(posted?.notify).toHaveLength(1);
    const [note] = await db.select().from(notifications).where(eq(notifications.kind, 'comment'));
    expect(note?.payload).toMatchObject({ runId: first, taskId });
    await db
      .update(runs)
      .set({ status: 'done', endedAt: sql`now()`, summary: 'Built the refund screen.' })
      .where(eq(runs.id, first));

    const asked = await call('POST', `/api/tasks/${taskId}/comments`, {
      body: 'The padding is off on a phone. Fix it.',
      run: true,
    });
    expect(asked.statusCode).toBe(201);
    const next = asked.json<{ run: { id: string; status: string } }>().run;
    expect(next.status).toBe('queued');

    const view = (await call('GET', `/api/tasks/${taskId}`)).json<View>();
    expect(view.comments).toEqual([
      expect.objectContaining({
        body: 'The screen is on agent/refunds.',
        author: expect.objectContaining({ kind: 'agent', name: 'Checkout frontend' }),
        runId: first,
      }),
      expect.objectContaining({
        body: 'The padding is off on a phone. Fix it.',
        author: expect.objectContaining({ kind: 'person', name: 'Admin' }),
        runId: null,
      }),
    ]);
    expect(view.runs.find((run) => run.id === first)?.summary).toBe('Built the refund screen.');

    const history = await taskHistory(db, taskId, next.id);
    expect(history).toContain('## The thread');
    expect(history).toContain('Checkout frontend (an agent)');
    expect(history.indexOf('The screen is on agent/refunds.')).toBeLessThan(
      history.indexOf('The padding is off on a phone. Fix it.'),
    );
  });
});
