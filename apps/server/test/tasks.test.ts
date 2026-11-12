import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, type Db, eq, migrate, runArtifacts, runs, sql, tasks } from '@agentome/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { licenseEnterprise, projectOfAgent, setupCodeIn } from './app.js';

// The tasks API against the real server and database: a task is seen
// and changed only through a grant on its agent, and a run is queued only for an active agent
// and a task without a run going.

let container: StartedPostgreSqlContainer;
let app: Awaited<ReturnType<typeof buildApp>>;
let db: Db;
let dataDir: string;
let admin: Person;

type Person = { id: string; name: string; cookie: string };
type Run = { id: string; status: string; startedAt: string | null; seat: { name: string } | null };
type Task = {
  id: string;
  title: string;
  body: string;
  status: 'open' | 'done';
  source: string;
  repository: string | null;
  agent: { id: string; name: string; status?: string };
  createdBy: { id: string; name: string };
  createdAt: string;
  latestRun: { id: string; status: string; at: string } | null;
  changeRequest: { url: string; state: string | null; pipeline: string | null } | null;
  runs: Run[];
};
type Page = { tasks: Task[]; nextBefore: string | null };

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  dataDir = mkdtempSync(join(tmpdir(), 'agentome-tasks-'));
  await migrate(container.getConnectionUri());
  app = await buildApp(
    loadConfig({
      AGENTOME_DATABASE_URL: container.getConnectionUri(),
      AGENTOME_DATA_DIR: dataDir,
      AGENTOME_LOG_LEVEL: 'silent',
    }),
  );
  db = createDb(container.getConnectionUri(), () => {});
  const setup = await app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: {
      code: setupCodeIn(dataDir),
      orgName: 'Acme',
      admin: { name: 'Ann Admin', email: 'admin@example.com', password: 'the admin password' },
    },
  });
  await licenseEnterprise(db);
  admin = { ...setup.json<Omit<Person, 'cookie'>>(), cookie: cookieOf(setup) };
}, 120_000);

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

const call = (
  who: Person,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  url: string,
  payload?: object,
) => app.inject({ method, url, payload, headers: { cookie: who.cookie } });

let people = 0;
/** A member who joined by invitation, signed in. */
async function person(): Promise<Person> {
  people += 1;
  const invitation = await call(admin, 'POST', '/api/invitations', {});
  const token = invitation.json<{ url: string }>().url.split('/invite/')[1];
  const accepted = await app.inject({
    method: 'POST',
    url: `/api/invitations/${token}/accept`,
    payload: {
      name: `Person ${people}`,
      email: `person${people}@example.com`,
      password: 'a long enough password',
    },
  });
  expect(accepted.statusCode).toBe(201);
  return { ...accepted.json<Omit<Person, 'cookie'>>(), cookie: cookieOf(accepted) };
}

async function agentOf(who: Person, name = 'Backend developer') {
  const response = await call(who, 'POST', '/api/agents', { name });
  expect(response.statusCode).toBe(201);
  return response.json<{ id: string; name: string }>();
}

/** Files the task in a project of its agent's unless the body names one. */
async function create(
  who: Person,
  body: { agentId?: string; projectId?: string } & Record<string, unknown>,
) {
  const projectId = body.projectId ?? (body.agentId && (await projectOfAgent(db, body.agentId)));
  const response = await call(who, 'POST', '/api/tasks', { ...body, projectId });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ task: Task; run: { id: string; status: string } | null }>();
}

const list = async (who: Person, query = '') => {
  const response = await call(who, 'GET', `/api/tasks${query}`);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<Page>();
};

/** Ends a run as a seat would, without one: the task API only reads the outcome. */
const finish = (runId: string, status: 'done' | 'failed' | 'cancelled') =>
  db
    .update(runs)
    .set({ status, startedAt: sql`now()`, endedAt: sql`now()` })
    .where(eq(runs.id, runId));

describe('creating a task', () => {
  it('queues its first run in the same step, and the list shows it', async () => {
    const maria = await person();
    const agent = await agentOf(maria);
    const { task, run } = await create(maria, {
      agentId: agent.id,
      title: '  Add a README  ',
      body: 'Describe **how to run** the tests.',
      repository: ' ~/code/test-repo ',
    });
    expect(run).toEqual({ id: expect.any(String), status: 'queued' });
    expect(task).toMatchObject({
      title: 'Add a README',
      body: 'Describe **how to run** the tests.',
      repository: '~/code/test-repo',
      status: 'open',
      source: 'manual',
      agent: { id: agent.id, name: agent.name, status: 'active' },
      createdBy: { id: maria.id, name: maria.name },
      latestRun: { id: run?.id, status: 'queued' },
      runs: [{ id: run?.id, status: 'queued', startedAt: null, seat: null }],
    });
    const [row] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, run?.id ?? ''));
    expect(row).toMatchObject({
      taskId: task.id,
      agentId: agent.id,
      startedBy: 'user',
      startedByUserId: maria.id,
    });
    expect((await list(maria)).tasks).toEqual([
      expect.objectContaining({ id: task.id, latestRun: expect.objectContaining({ id: run?.id }) }),
    ]);
  });

  it('runs nothing when asked not to, and an empty repository means none', async () => {
    const maria = await person();
    const agent = await agentOf(maria);
    const { task, run } = await create(maria, {
      agentId: agent.id,
      title: 'Later',
      repository: '',
      run: false,
    });
    expect(run).toBeNull();
    expect(task).toMatchObject({ body: '', repository: null, latestRun: null, runs: [] });
    expect(await db.select().from(runs).where(eq(runs.taskId, task.id))).toEqual([]);
  });

  it('takes the repositories a seat can clone without credentials, and only those', async () => {
    const maria = await person();
    const agent = await agentOf(maria);
    for (const repository of [
      'https://github.com/acme/repo.git',
      'http://git.internal/team/repo',
      '/Users/maria/code/repo',
      '~/code/repo',
    ]) {
      const { task } = await create(maria, { agentId: agent.id, title: 'Clone', repository });
      expect(task.repository).toBe(repository);
    }
    for (const [repository, message] of [
      ['code/repo', /absolute path/],
      ['git@github.com:acme/repo.git', /absolute path/],
      ['ssh://git@github.com/acme/repo.git', /absolute path/],
      ['https://', /absolute path/],
      ['/Users/maria/repo\nrm -rf', /absolute path/],
      // git matches its allowed transports in lower case: this one could never be cloned.
      ['HTTPS://github.com/acme/repo.git', /absolute path/],
      ['https://maria:secret@github.com/acme/repo.git', /without credentials/],
      // The URL parser sees a host named "maria" here; git sees a token for github.com.
      ['https://maria\\:secret@github.com/acme/repo.git', /without credentials/],
    ] as const) {
      const response = await call(maria, 'POST', '/api/tasks', {
        agentId: agent.id,
        projectId: await projectOfAgent(db, agent.id),
        title: 'Clone',
        repository,
      });
      expect(response.statusCode, repository).toBe(400);
      expect(response.json()).toMatchObject({
        error: {
          code: 'validation_failed',
          details: [{ path: 'body/repository', message: expect.stringMatching(message) }],
        },
      });
    }
    for (const body of [{ title: ' ' }, { title: 'Nul\0' }, { title: 'Ok', body: 'Nul\0' }]) {
      const refused = await call(maria, 'POST', '/api/tasks', {
        agentId: agent.id,
        projectId: await projectOfAgent(db, agent.id),
        ...body,
      });
      expect(refused.statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it("is refused for an archived agent and for someone else's", async () => {
    const maria = await person();
    const ilya = await person();
    const agent = await agentOf(maria);
    const projectId = await projectOfAgent(db, agent.id);
    const theirs = await call(ilya, 'POST', '/api/tasks', {
      agentId: agent.id,
      projectId,
      title: 'Mine now',
    });
    expect(theirs.statusCode).toBe(404);
    await call(maria, 'POST', `/api/agents/${agent.id}/archive`);
    const archived = await call(maria, 'POST', '/api/tasks', {
      agentId: agent.id,
      projectId,
      title: 'Wake up',
    });
    expect(archived.statusCode).toBe(409);
    expect(archived.json()).toMatchObject({ error: { code: 'agent_archived' } });
    expect(await db.select().from(tasks).where(eq(tasks.agentId, agent.id))).toEqual([]);
  });

  it('needs a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/tasks' });
    expect(response.statusCode).toBe(401);
  });
});

describe('access', () => {
  it("shows a task to the agent's grant holders only; to others it is not found", async () => {
    const maria = await person();
    const ilya = await person();
    const { task } = await create(maria, { agentId: (await agentOf(maria)).id, title: 'Private' });
    expect((await list(ilya)).tasks).toEqual([]);
    expect((await list(admin)).tasks.map((item) => item.id)).not.toContain(task.id);
    for (const [method, path, body] of [
      ['GET', '', undefined],
      ['PATCH', '', { status: 'done' }],
      ['POST', '/run', undefined],
    ] as const) {
      const response = await call(ilya, method, `/api/tasks/${task.id}${path}`, body);
      expect(response.statusCode, `${method} ${path}`).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'not_found' } });
    }
    const [unchanged] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(unchanged?.status).toBe('open');
    expect(await db.select().from(runs).where(eq(runs.taskId, task.id))).toHaveLength(1);
  });

  it('files a task or a schedule only in a project its agent is on', async () => {
    const maria = await person();
    const agent = await agentOf(maria);
    const theirs = (await call(admin, 'POST', '/api/projects', { name: 'Payments' })).json<{
      id: string;
    }>();
    const refused = await call(maria, 'POST', '/api/tasks', {
      agentId: agent.id,
      projectId: theirs.id,
      title: 'Spend their budget',
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({
      error: { code: 'validation_failed', details: [{ path: 'body/projectId' }] },
    });
    expect(await db.select().from(tasks).where(eq(tasks.agentId, agent.id))).toEqual([]);
    const schedule = {
      title: 'Every morning',
      projectId: theirs.id,
      days: [1],
      time: '09:00',
      timeZone: 'Europe/Moscow',
    };
    const scheduled = await call(maria, 'POST', `/api/agents/${agent.id}/schedules`, schedule);
    expect(scheduled.statusCode).toBe(400);

    const mine = (await call(maria, 'POST', '/api/projects', { name: 'Mine' })).json<{
      id: string;
    }>();
    await call(maria, 'PUT', `/api/projects/${mine.id}/agents/${agent.id}`);
    const { task } = await create(maria, { agentId: agent.id, projectId: mine.id, title: 'Ours' });
    const [saved] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(saved?.projectId).toBe(mine.id);
    // A folder on the computer in place of the project's repository.
    const { task: inFolder } = await create(maria, {
      agentId: agent.id,
      projectId: mine.id,
      title: 'Here',
      repository: '~/code/mine',
      run: false,
    });
    expect(inFolder).toMatchObject({ repository: '~/code/mine', repositoryFromProject: false });
    const ours = { ...schedule, projectId: mine.id };
    expect((await call(maria, 'POST', `/api/agents/${agent.id}/schedules`, ours)).statusCode).toBe(
      201,
    );
  });

  it('lists every task for an admin who asks, and only for an admin', async () => {
    const maria = await person();
    const { task } = await create(maria, { agentId: (await agentOf(maria)).id, title: 'Audit' });
    expect((await list(admin, '?all=true&limit=100')).tasks.map((item) => item.id)).toContain(
      task.id,
    );
    const refused = await call(maria, 'GET', '/api/tasks?all=true');
    expect(refused.statusCode).toBe(403);
  });
});

describe('the list', () => {
  it('filters by agent and status, and pages newest first', async () => {
    const maria = await person();
    const [backend, writer] = [await agentOf(maria), await agentOf(maria, 'Docs writer')];
    const made: Task[] = [];
    for (const title of ['One', 'Two', 'Three', 'Four', 'Five']) {
      made.push((await create(maria, { agentId: backend.id, title, run: false })).task);
    }
    const { task: docs } = await create(maria, { agentId: writer.id, title: 'Docs', run: false });
    await call(maria, 'PATCH', `/api/tasks/${made[0]?.id}`, { status: 'done' });

    const titles = (page: Page) => page.tasks.map((task) => task.title);
    expect(titles(await list(maria))).toEqual(['Docs', 'Five', 'Four', 'Three', 'Two', 'One']);
    expect(titles(await list(maria, `?agent=${writer.id}`))).toEqual(['Docs']);
    expect(titles(await list(maria, '?status=done'))).toEqual(['One']);
    expect(titles(await list(maria, `?agent=${backend.id}&status=open`))).toEqual([
      'Five',
      'Four',
      'Three',
      'Two',
    ]);

    const first = await list(maria, '?limit=4');
    expect(titles(first)).toEqual(['Docs', 'Five', 'Four', 'Three']);
    expect(first.nextBefore).toBe(`${first.tasks[3]?.createdAt}_${first.tasks[3]?.id}`);
    const second = await list(
      maria,
      `?limit=4&before=${encodeURIComponent(first.nextBefore ?? '')}`,
    );
    expect(titles(second)).toEqual(['Two', 'One']);
    expect(second.nextBefore).toBeNull();
    expect(docs.agent.name).toBe('Docs writer');
    for (const before of [
      'yesterday',
      '2026-10-21T10:00:00Z',
      `2026-10-21T10:00:00Z_${docs.id}x`,
    ]) {
      const refused = await call(maria, 'GET', `/api/tasks?before=${before}`);
      expect(refused.statusCode, before).toBe(400);
    }
  });

  it('pages through tasks created at the same moment without skipping one', async () => {
    const maria = await person();
    const agent = await agentOf(maria);
    // One transaction: now() is its start, so the three share a createdAt.
    await db.transaction(async (tx) => {
      for (const title of ['A', 'B', 'C']) {
        await tx
          .insert(tasks)
          .values({ agentId: agent.id, title, source: 'manual', createdBy: maria.id });
      }
    });
    const seen: string[] = [];
    let before: string | null = '';
    while (before !== null) {
      const query = `?agent=${agent.id}&limit=1${before ? `&before=${encodeURIComponent(before)}` : ''}`;
      const page: Page = await list(maria, query);
      seen.push(...page.tasks.map((task) => task.title));
      before = page.nextBefore;
    }
    expect(seen.sort()).toEqual(['A', 'B', 'C']);
  });

  it("shows each task's latest run: its status, and when it ended", async () => {
    const maria = await person();
    const { task, run } = await create(maria, { agentId: (await agentOf(maria)).id, title: 'Go' });
    await finish(run?.id ?? '', 'failed');
    const [row] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, run?.id ?? ''));
    const [listed] = (await list(maria)).tasks;
    expect(listed).toMatchObject({
      id: task.id,
      latestRun: { id: run?.id, status: 'failed', at: row?.endedAt?.toISOString() },
      changeRequest: null,
    });
  });

  it('shows the newest change request of its runs, with its pipeline', async () => {
    const maria = await person();
    const { task, run } = await create(maria, { agentId: (await agentOf(maria)).id, title: 'MR' });
    const mr = (n: number, meta: object) => ({
      runId: run?.id ?? '',
      kind: 'change_request' as const,
      ref: `https://gitlab.example.com/acme/api/-/merge_requests/${n}`,
      meta,
    });
    await db.insert(runArtifacts).values(mr(1, { state: 'closed' }));
    await db.insert(runArtifacts).values(mr(2, { state: 'draft', pipeline: 'success' }));
    const [listed] = (await list(maria)).tasks;
    expect(listed).toMatchObject({
      id: task.id,
      changeRequest: {
        url: 'https://gitlab.example.com/acme/api/-/merge_requests/2',
        state: 'draft',
        pipeline: 'success',
      },
    });
  });
});

describe('changing a task', () => {
  it('saves the title, description and repository, marks it done and reopens it', async () => {
    const maria = await person();
    const { task } = await create(maria, {
      agentId: (await agentOf(maria)).id,
      title: 'Draft',
      repository: '/srv/repo',
      run: false,
    });
    const url = `/api/tasks/${task.id}`;
    const edited = await call(maria, 'PATCH', url, {
      title: 'Add a README',
      body: '## Done when\n\nThe README explains setup.',
      repository: 'https://github.com/acme/repo.git',
      status: 'done',
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({
      title: 'Add a README',
      body: '## Done when\n\nThe README explains setup.',
      repository: 'https://github.com/acme/repo.git',
      status: 'done',
    });
    const reopened = await call(maria, 'PATCH', url, { status: 'open', repository: null });
    expect(reopened.json()).toMatchObject({
      title: 'Add a README',
      status: 'open',
      repository: null,
    });
    expect((await call(maria, 'PATCH', url, {})).json()).toMatchObject({ status: 'open' });
    for (const body of [{ status: 'closed' }, { title: '' }, { repository: 'repo' }]) {
      const refused = await call(maria, 'PATCH', url, body);
      expect(refused.statusCode, JSON.stringify(body)).toBe(400);
    }
  });
});

describe('recent folders', () => {
  it("offers the folders of the person's own tasks, the most recent first", async () => {
    const maria = await person();
    const agentId = (await agentOf(maria)).id;
    for (const repository of ['/srv/old', '~/code/app', 'https://github.com/acme/api', null]) {
      await create(maria, { agentId, title: 'Work', repository, run: false });
    }
    await create(maria, { agentId, title: 'Again', repository: '/srv/old', run: false });
    const ivan = await person();
    await create(ivan, {
      agentId: (await agentOf(ivan)).id,
      title: 'Elsewhere',
      repository: '/home/ivan/secret',
      run: false,
    });
    const folders = await call(maria, 'GET', '/api/tasks/folders');
    expect(folders.statusCode, folders.body).toBe(200);
    expect(folders.json()).toEqual({ folders: ['/srv/old', '~/code/app'] });
  });
});

describe('running a task again', () => {
  it('waits for the run going, then queues the next one, newest first', async () => {
    const maria = await person();
    const { task, run } = await create(maria, {
      agentId: (await agentOf(maria)).id,
      title: 'Loop',
    });
    const url = `/api/tasks/${task.id}/run`;
    const busy = await call(maria, 'POST', url);
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toMatchObject({ error: { code: 'run_in_progress' } });

    await finish(run?.id ?? '', 'done');
    const again = await call(maria, 'POST', url);
    expect(again.statusCode).toBe(201);
    const next = again.json<{ id: string; status: string }>();
    expect(next).toEqual({ id: expect.any(String), status: 'queued' });
    const view = (await call(maria, 'GET', `/api/tasks/${task.id}`)).json<Task>();
    expect(view.runs.map((item) => [item.id, item.status])).toEqual([
      [next.id, 'queued'],
      [run?.id, 'done'],
    ]);
    expect(view.latestRun).toMatchObject({ id: next.id, status: 'queued' });
  });

  it('queues one run when two requests come at once', async () => {
    const maria = await person();
    const agent = await agentOf(maria);
    const { task } = await create(maria, { agentId: agent.id, title: 'Twice', run: false });
    const answers = await Promise.all(
      [1, 2, 3].map(() => call(maria, 'POST', `/api/tasks/${task.id}/run`)),
    );
    expect(answers.map((answer) => answer.statusCode).sort()).toEqual([201, 409, 409]);
    expect(await db.select().from(runs).where(eq(runs.taskId, task.id))).toHaveLength(1);
  });

  it('is refused for an archived agent, whose queued run archiving cancelled', async () => {
    const maria = await person();
    const agent = await agentOf(maria);
    const { task, run } = await create(maria, { agentId: agent.id, title: 'Shelved' });
    await call(maria, 'POST', `/api/agents/${agent.id}/archive`);
    const refused = await call(maria, 'POST', `/api/tasks/${task.id}/run`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: { code: 'agent_archived' } });
    const view = (await call(maria, 'GET', `/api/tasks/${task.id}`)).json<Task>();
    expect(view).toMatchObject({
      agent: { status: 'archived' },
      runs: [{ id: run?.id, status: 'cancelled' }],
    });
  });
});
