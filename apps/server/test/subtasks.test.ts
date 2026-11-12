import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDb,
  type Db,
  desc,
  eq,
  migrate,
  projectAgents,
  runs,
  sql,
  tasks,
} from '@agentome/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { teamForRun } from '../src/agents/team.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { ToolContext } from '../src/mcp/tools.js';
import { assignTask, wakeParents } from '../src/tasks/subtasks.js';
import { licenseEnterprise, projectOfAgent, setupCodeIn } from './app.js';

// Assigning down: CEO leads a team with Head of Engineering in it, who leads a team
// with Backend. CEO hands Head of Engineering a task, which runs apart; when it ends, CEO runs again.

let container: StartedPostgreSqlContainer;
let app: Awaited<ReturnType<typeof buildApp>>;
let db: Db;
let dataDir: string;
let cookie = '';

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  dataDir = mkdtempSync(join(tmpdir(), 'agentome-subtasks-'));
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

const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie }, ...(payload && { payload }) });

const agent = async (name: string) =>
  (await call('POST', '/api/agents', { name })).json<{ id: string }>().id;

const context = (agentId: string, runId: string): ToolContext => ({
  db,
  agentId,
  runId,
  codeHost: () => Promise.reject(new Error('no code host')),
  jiraIssue: () => Promise.reject(new Error('no Jira')),
});

/** The newest run of a task, ended as the seat would end it. */
async function finish(taskId: string, summary: string) {
  const [run] = await db
    .select()
    .from(runs)
    .where(eq(runs.taskId, taskId))
    .orderBy(desc(runs.createdAt));
  await db
    .update(runs)
    .set({ status: 'done', endedAt: sql`now()`, summary })
    .where(eq(runs.id, run?.id ?? ''));
  return run?.id ?? '';
}

describe('assigning down', () => {
  it('hands a lead under the lead its own task, and runs the lead again with the report', async () => {
    const ceo = await agent('CEO');
    const head = await agent('Head of Engineering');
    const backend = await agent('Backend');
    const eng = await call('POST', '/api/teams', { name: 'Eng', leadId: head, members: [backend] });
    expect(eng.statusCode).toBe(201);
    expect(
      (await call('POST', '/api/teams', { name: 'Company', leadId: ceo, members: [head] }))
        .statusCode,
    ).toBe(201);
    // CEO is above Head of Engineering, so it cannot join the team under it.
    const circle = await call('PATCH', `/api/teams/${eng.json<{ id: string }>().id}`, {
      members: [backend, ceo],
    });
    expect(circle.statusCode).toBe(400);
    expect(circle.json<{ error: { message: string } }>().error.message).toContain('under itself');

    // A lead under CEO is no subagent of its run: it is listed to assign to.
    const team = await teamForRun(db, ceo);
    expect(team?.launch).toBeNull();
    expect(team?.section).toContain('## Teams under you');
    expect(team?.section).toContain('**Head of Engineering**');

    const made = await call('POST', '/api/tasks', {
      agentId: ceo,
      projectId: await projectOfAgent(db, ceo),
      title: 'Ship refunds',
      body: 'Customers get their money back.',
    });
    const parentId = made.json<{ task: { id: string } }>().task.id;
    const ceoRun = made.json<{ run: { id: string } }>().run.id;

    await expect(
      assignTask.run(context(ceo, ceoRun), { agent: 'Backend', title: 'x', body: '' }),
    ).rejects.toThrow('You can assign to: Head of Engineering');
    // A member's own token in the lead's run does not assign.
    await expect(
      assignTask.run(context(head, ceoRun), { agent: 'Backend', title: 'x', body: '' }),
    ).rejects.toThrow('Only a lead');

    const assigned = await assignTask.run(context(ceo, ceoRun), {
      agent: 'head of engineering',
      title: 'Build the refund API',
      body: 'POST /refunds, per docs/specs/refunds.md.',
    });
    const { taskId } = JSON.parse(assigned.text) as { taskId: string };
    const [child] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(child).toMatchObject({ agentId: head, parentTaskId: parentId, source: 'agent' });
    const [childRun] = await db.select().from(runs).where(eq(runs.taskId, taskId));
    expect(childRun).toMatchObject({ status: 'queued', startedBy: 'agent' });
    expect(childRun?.reason).toContain('CEO assigned you this as part of "Ship refunds"');

    // Nothing while CEO's own run or the assigned one is going.
    expect(await wakeParents(db)).toEqual([]);
    await finish(parentId, 'Assigned the API to Head of Engineering.');
    expect(await wakeParents(db)).toEqual([]);
    await finish(taskId, 'The refund API is on agent/refunds.');
    expect(await wakeParents(db)).toEqual([parentId]);
    const [again] = await db
      .select()
      .from(runs)
      .where(eq(runs.taskId, parentId))
      .orderBy(desc(runs.createdAt));
    expect(again).toMatchObject({ status: 'queued', startedBy: 'agent' });
    expect(again?.reason).toContain('### Head of Engineering: Build the refund API (done)');
    expect(again?.reason).toContain('The refund API is on agent/refunds.');
    // Woken once: the report is older than the run it woke.
    await finish(parentId, 'Done.');
    expect(await wakeParents(db)).toEqual([]);

    const view = (await call('GET', `/api/tasks/${parentId}`)).json<{
      subtasks: { title: string; agent: string; runStatus: string }[];
    }>();
    expect(view.subtasks).toEqual([
      expect.objectContaining({
        title: 'Build the refund API',
        agent: 'Head of Engineering',
        runStatus: 'done',
      }),
    ]);
    expect((await call('GET', `/api/tasks/${taskId}`)).json()).toMatchObject({
      parent: { id: parentId, title: 'Ship refunds', agent: 'CEO' },
    });

    // Three levels down is the floor.
    const [deep] = await db
      .insert(tasks)
      .values({
        agentId: ceo,
        parentTaskId: taskId,
        title: 'Deep',
        source: 'agent',
        createdBy: child?.createdBy ?? '',
      })
      .returning({ id: tasks.id });
    const [deepRun] = await db
      .insert(runs)
      .values({ agentId: ceo, taskId: deep?.id, startedBy: 'agent' })
      .returning({ id: runs.id });
    await expect(
      assignTask.run(context(ceo, deepRun?.id ?? ''), {
        agent: 'Head of Engineering',
        title: 'x',
        body: '',
      }),
    ).rejects.toThrow('3 levels down');
  });

  it("puts a project's team's whole branch on the project, and who joins a team below later", async () => {
    const vp = await agent('VP');
    const lead = await agent('Platform lead');
    const dev = await agent('Platform developer');
    const ops = await agent('Platform ops');
    const platform = (
      await call('POST', '/api/teams', { name: 'Platform', leadId: lead, members: [dev] })
    ).json<{ id: string }>().id;
    await call('POST', '/api/teams', { name: 'Org', leadId: vp, members: [lead] });
    const project = (await call('POST', '/api/projects', { name: 'Infra' })).json<{ id: string }>()
      .id;
    expect(
      (
        await call('PATCH', `/api/projects/${project}`, {
          teamId: (await call('GET', '/api/teams'))
            .json<{ teams: { id: string; name: string }[] }>()
            .teams.find((team) => team.name === 'Org')?.id,
        })
      ).statusCode,
    ).toBe(200);
    const on = async () =>
      (
        await db
          .select({ agentId: projectAgents.agentId })
          .from(projectAgents)
          .where(eq(projectAgents.projectId, project))
      )
        .map((row) => row.agentId)
        .sort();
    expect(await on()).toEqual([vp, lead, dev].sort());
    await call('PATCH', `/api/teams/${platform}`, { members: [dev, ops] });
    expect(await on()).toEqual([vp, lead, dev, ops].sort());
  });
});
