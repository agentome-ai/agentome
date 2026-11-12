import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDb,
  type Db,
  eq,
  knowledgeSources,
  migrate,
  projectAgents,
  projectConnections,
  runs,
  sql,
  tasks,
} from '@agentome/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { connectionsKey, decryptSecret } from '../src/connections/crypto.js';
import { jqlDate, pollConnection, pollDue } from '../src/jira/poll.js';
import { pushToJira, tellJira } from '../src/jira/push.js';
import { licenseEnterprise, projectOfAgent, setupCodeIn } from './app.js';

// Projects and connections against the real server and database: the
// token is encrypted at rest and never answered, connections are the administrator's, and a
// task's repository finds its connection through the agent's projects.

let container: StartedPostgreSqlContainer;
let app: Awaited<ReturnType<typeof buildApp>>;
let db: Db;
let dataDir: string;
let config: ReturnType<typeof loadConfig>;
let admin: Person;
let maria: Person;

type Person = { id: string; name: string; cookie: string };
type Project = {
  id: string;
  name: string;
  description: string;
  goals: string;
  repositories: string[];
  agentCount: number;
  connectionCount: number;
  agents: { id: string; name: string }[];
  connections: { id: string; kind: string; namespace: string; accountLogin: string | null }[];
};
type Connection = {
  id: string;
  project: { id: string; name: string };
  kind: string;
  config: Record<string, string>;
  host: string;
  namespace: string;
  accountLogin: string | null;
  lastTestedAt: string | null;
};

const TOKEN = 'github_pat_11AAAAAAA0secretsecretsecretsecret';

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  dataDir = mkdtempSync(join(tmpdir(), 'agentome-projects-'));
  await migrate(container.getConnectionUri());
  config = loadConfig({
    AGENTOME_DATABASE_URL: container.getConnectionUri(),
    AGENTOME_DATA_DIR: dataDir,
    AGENTOME_LOG_LEVEL: 'silent',
    AGENTOME_PUBLIC_URL: 'https://agentome.example.com',
  });
  app = await buildApp(config);
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
  maria = await person('maria');
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.$client.end();
  await container?.stop();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => vi.unstubAllGlobals());

function cookieOf(response: LightMyRequestResponse): string {
  const setCookie = response.headers['set-cookie'] ?? [];
  return (Array.isArray(setCookie) ? setCookie : [setCookie])
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');
}

async function person(name: string): Promise<Person> {
  const invitation = await call(admin, 'POST', '/api/invitations', {});
  const token = invitation.json<{ url: string }>().url.split('/invite/')[1];
  const accepted = await app.inject({
    method: 'POST',
    url: `/api/invitations/${token}/accept`,
    payload: { name, email: `${name}@example.com`, password: 'a long enough password' },
  });
  expect(accepted.statusCode).toBe(201);
  return { ...accepted.json<Omit<Person, 'cookie'>>(), cookie: cookieOf(accepted) };
}

const call = (
  who: Person,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
) => app.inject({ method, url, payload, headers: { cookie: who.cookie } });

async function project(name: string): Promise<Project> {
  const response = await call(admin, 'POST', '/api/projects', { name });
  expect(response.statusCode).toBe(201);
  return response.json<Project>();
}

async function agentOf(who: Person, name: string): Promise<string> {
  const response = await call(who, 'POST', '/api/agents', { name, roleTitle: 'Developer' });
  expect(response.statusCode).toBe(201);
  return response.json<{ id: string }>().id;
}

async function connect(projectId: string, config: object, token = TOKEN): Promise<Connection> {
  const response = await call(admin, 'POST', '/api/connections', { projectId, config, token });
  expect(response.statusCode).toBe(201);
  expect(response.body).not.toContain(token);
  return response.json<Connection>();
}

/** A host that answers `GET /user` as GitHub does, or as told. */
function host(answer: { status?: number; body?: unknown; reject?: boolean } = {}) {
  const seen: Request[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: Request) => {
      seen.push(input);
      if (answer.reject) throw new TypeError('fetch failed');
      return Response.json(answer.body ?? { login: 'octocat' }, { status: answer.status ?? 200 });
    }),
  );
  return seen;
}

describe('projects', () => {
  it('are created and changed by an administrator, and read by anyone signed in', async () => {
    const created = await project('Payments');
    expect(created).toMatchObject({
      name: 'Payments',
      description: '',
      goals: '',
      agentCount: 0,
      connectionCount: 0,
      agents: [],
      connections: [],
    });
    expect((await call(maria, 'POST', '/api/projects', { name: 'Mine' })).statusCode).toBe(201);

    const changed = await call(admin, 'PATCH', `/api/projects/${created.id}`, {
      goals: 'Ship the new checkout by Q1.',
    });
    expect(changed.json()).toMatchObject({
      name: 'Payments',
      goals: 'Ship the new checkout by Q1.',
    });

    const listed = await call(maria, 'GET', '/api/projects');
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ projects: Project[] }>().projects).toContainEqual(
      expect.objectContaining({ id: created.id, name: 'Payments' }),
    );
    const read = await call(maria, 'GET', `/api/projects/${created.id}`);
    expect(read.statusCode).toBe(200);
    expect(read.json<Project>().goals).toBe('Ship the new checkout by Q1.');
  });

  it("list each project's week and its latest run, and runs name their task's project", async () => {
    const { id } = await project('Ledger');
    const agentId = await agentOf(maria, 'Ledger dev');
    expect((await call(admin, 'PUT', `/api/projects/${id}/agents/${agentId}`)).statusCode).toBe(
      204,
    );
    const made = await call(maria, 'POST', '/api/tasks', {
      agentId,
      projectId: id,
      title: 'Close the books',
      run: false,
    });
    expect(made.statusCode).toBe(201);
    const taskId = made.json<{ task: { id: string } }>().task.id;
    const at = (minutes: number) => new Date(Date.now() - minutes * 60_000);
    await db.insert(runs).values([
      {
        agentId,
        taskId,
        startedBy: 'user',
        startedByUserId: maria.id,
        status: 'failed',
        startedAt: at(90),
        endedAt: at(80),
        createdAt: at(91),
      },
      {
        agentId,
        taskId,
        startedBy: 'user',
        startedByUserId: maria.id,
        status: 'done',
        startedAt: at(30),
        endedAt: at(10),
        createdAt: at(31),
      },
    ]);

    const listed = (await call(maria, 'GET', '/api/projects')).json<{ projects: object[] }>();
    expect(listed.projects).toContainEqual(
      expect.objectContaining({
        id,
        team: null,
        week: {
          runs: 2,
          ended: 2,
          done: 1,
          medianSeconds: 900,
          usd: null,
          daily: [0, 0, 0, 0, 0, 0, 2],
        },
        lastRun: expect.objectContaining({
          status: 'done',
          agent: { id: agentId, name: 'Ledger dev' },
          task: { id: taskId, title: 'Close the books' },
        }),
      }),
    );
    // The project's own page has the same week.
    const view = (await call(maria, 'GET', `/api/projects/${id}`)).json<{ week: object }>();
    expect(view.week).toEqual({
      runs: 2,
      ended: 2,
      done: 1,
      medianSeconds: 900,
      usd: null,
      daily: [0, 0, 0, 0, 0, 0, 2],
    });
    const listedRuns = (await call(maria, 'GET', `/api/runs?task=${taskId}`)).json<{
      runs: { task: { projectId: string | null } }[];
    }>();
    expect(listedRuns.runs.map((run) => run.task.projectId)).toEqual([id, id]);
  });

  it('take an agent from an administrator only, and once', async () => {
    const { id } = await project('Checkout');
    const own = await agentOf(maria, 'Checkout QA');
    const other = await agentOf(await person('nina'), "Nina's agent");

    // Not even the agent's owner: a project is the way to the installation's host tokens.
    expect((await call(maria, 'PUT', `/api/projects/${id}/agents/${own}`)).statusCode).toBe(403);
    expect((await call(admin, 'PUT', `/api/projects/${id}/agents/${own}`)).statusCode).toBe(204);
    expect((await call(admin, 'PUT', `/api/projects/${id}/agents/${own}`)).statusCode).toBe(204);
    expect((await call(admin, 'PUT', `/api/projects/${id}/agents/${other}`)).statusCode).toBe(204);

    const view = (await call(maria, 'GET', `/api/projects/${id}`)).json<Project>();
    expect(view.agentCount).toBe(2);
    expect(view.agents.map((agent) => agent.name)).toEqual(['Checkout QA', "Nina's agent"]);

    expect((await call(maria, 'DELETE', `/api/projects/${id}/agents/${own}`)).statusCode).toBe(403);
    expect((await call(admin, 'DELETE', `/api/projects/${id}/agents/${own}`)).statusCode).toBe(204);
    expect((await call(maria, 'GET', `/api/projects/${id}`)).json<Project>().agentCount).toBe(1);
  });

  it('are every person’s to make, and their own agents only go on their own', async () => {
    const mine = (await call(maria, 'POST', '/api/projects', { name: 'Maria’s project' })).json<{
      id: string;
    }>();
    const own = await agentOf(maria, 'Maria’s helper');
    const other = await agentOf(await person('olga'), "Olga's agent");
    expect((await call(maria, 'PUT', `/api/projects/${mine.id}/agents/${own}`)).statusCode).toBe(
      204,
    );
    // Another person's agent is not hers to give: as if it did not exist.
    expect((await call(maria, 'PUT', `/api/projects/${mine.id}/agents/${other}`)).statusCode).toBe(
      404,
    );
    expect(
      (await call(maria, 'PATCH', `/api/projects/${mine.id}`, { goals: 'Tidy the board.' }))
        .statusCode,
    ).toBe(200);
    // An admin's project, which may hold the installation's tokens, stays the admin's.
    const { id } = await project('Admin’s');
    expect((await call(maria, 'PUT', `/api/projects/${id}/agents/${own}`)).statusCode).toBe(403);
    expect(
      (await call(maria, 'PATCH', `/api/projects/${id}`, { goals: 'Mine now' })).statusCode,
    ).toBe(403);
    // An admin may change hers; she may delete it.
    expect(
      (await call(admin, 'PATCH', `/api/projects/${mine.id}`, { description: 'Checked.' }))
        .statusCode,
    ).toBe(200);
    expect((await call(maria, 'DELETE', `/api/projects/${mine.id}`)).statusCode).toBe(204);
  });

  it('keep the repositories a connection of theirs reaches, the main one first', async () => {
    const { id } = await project('Repos');
    await connect(id, { kind: 'github', owner: 'Acme' });
    const changed = await call(admin, 'PATCH', `/api/projects/${id}`, {
      repositories: [
        'https://github.com/acme/api/',
        'https://github.com/Acme/web',
        'https://github.com/acme/api',
      ],
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json<Project>().repositories).toEqual([
      'https://github.com/acme/api',
      'https://github.com/Acme/web',
    ]);

    const elsewhere = await call(admin, 'PATCH', `/api/projects/${id}`, {
      repositories: ['https://github.com/octocat/api'],
    });
    expect(elsewhere.statusCode).toBe(400);
    expect(elsewhere.json()).toMatchObject({
      error: { message: expect.stringContaining('https://github.com/octocat/api') },
    });
    const secret = await call(admin, 'PATCH', `/api/projects/${id}`, {
      repositories: ['https://bot:secret@github.com/acme/api'],
    });
    expect(secret.statusCode).toBe(400);
    expect(
      (await call(maria, 'PATCH', `/api/projects/${id}`, { repositories: [] })).statusCode,
    ).toBe(403);
    expect((await call(maria, 'GET', `/api/projects/${id}`)).json<Project>().repositories).toEqual([
      'https://github.com/acme/api',
      'https://github.com/Acme/web',
    ]);
  });

  it('are deleted by an administrator with what only they hold; their tasks stay', async () => {
    const { id } = await project('Doomed');
    host();
    const connection = await connect(id, { kind: 'github', owner: 'Doomed' });
    const agent = await agentOf(maria, 'Doomed agent');
    await call(admin, 'PUT', `/api/projects/${id}/agents/${agent}`);
    await db.insert(knowledgeSources).values({ projectId: id, config: { paths: ['README.md'] } });
    const created = await call(maria, 'POST', '/api/tasks', {
      agentId: agent,
      projectId: id,
      title: 'Outlives its project',
      run: false,
    });
    expect(created.statusCode).toBe(201);
    const taskId = created.json<{ task: { id: string } }>().task.id;

    expect((await call(maria, 'DELETE', `/api/projects/${id}`)).statusCode).toBe(403);
    expect((await call(admin, 'DELETE', `/api/projects/${id}`)).statusCode).toBe(204);
    expect((await call(admin, 'GET', `/api/projects/${id}`)).statusCode).toBe(404);
    expect((await call(admin, 'DELETE', `/api/projects/${id}`)).statusCode).toBe(404);
    const left = async (table: typeof projectAgents | typeof knowledgeSources) =>
      (await db.select().from(table).where(eq(table.projectId, id))).length;
    expect(await left(projectAgents)).toBe(0);
    expect(await left(knowledgeSources)).toBe(0);
    expect(
      await db.select().from(projectConnections).where(eq(projectConnections.id, connection.id)),
    ).toEqual([]);
    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(task?.projectId).toBeNull();
    expect((await call(maria, 'GET', `/api/tasks/${taskId}`)).statusCode).toBe(200);
  });

  it('take a repository that a GitLab connection names as its group', async () => {
    const { id } = await project('One repository');
    // A connection made for one project, with a project access token, names the project.
    await connect(id, {
      kind: 'gitlab',
      baseUrl: 'https://gitlab.example.com',
      group: 'acme/web/app',
    });
    const changed = await call(admin, 'PATCH', `/api/projects/${id}`, {
      repositories: ['https://gitlab.example.com/acme/web/app'],
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json<Project>().repositories).toEqual([
      'https://gitlab.example.com/acme/web/app',
    ]);
    const sibling = await call(admin, 'PATCH', `/api/projects/${id}`, {
      repositories: ['https://gitlab.example.com/acme/web/other'],
    });
    expect(sibling.statusCode).toBe(400);
  });

  it("give their tasks the project's main repository as it is at each run", async () => {
    const { id } = await project('Later repository');
    const agent = await agentOf(maria, 'Later agent');
    await call(admin, 'PUT', `/api/projects/${id}/agents/${agent}`);
    const created = await call(maria, 'POST', '/api/tasks', {
      agentId: agent,
      projectId: id,
      title: 'Made before the repository',
      run: false,
    });
    const taskId = created.json<{ task: { id: string; repository: string | null } }>().task.id;
    expect(created.json<{ task: { repository: string | null } }>().task.repository).toBeNull();

    await connect(id, {
      kind: 'gitlab',
      baseUrl: 'https://gitlab.example.com',
      group: 'later/app',
    });
    await call(admin, 'PATCH', `/api/projects/${id}`, {
      repositories: ['https://gitlab.example.com/later/app'],
    });
    const task = (await call(maria, 'GET', `/api/tasks/${taskId}`)).json<{
      repository: string | null;
      repositoryFromProject: boolean;
    }>();
    expect(task).toMatchObject({
      repository: 'https://gitlab.example.com/later/app',
      repositoryFromProject: true,
    });
    // A repository a person gives the task is its own, and the project no longer decides.
    const own = await call(maria, 'PATCH', `/api/tasks/${taskId}`, {
      repository: '/Users/maria/code/app',
    });
    expect(own.json()).toMatchObject({
      repository: '/Users/maria/code/app',
      repositoryFromProject: false,
    });
  });

  it('answers 404 for a project that does not exist, and 400 for a bad id', async () => {
    const missing = await call(maria, 'GET', '/api/projects/7f3a9c21-0000-4000-8000-000000000009');
    expect(missing.statusCode).toBe(404);
    expect((await call(maria, 'GET', '/api/projects/not-a-uuid')).statusCode).toBe(400);
  });
});

describe('connections', () => {
  it('keep the token encrypted and never answer it', async () => {
    const { id: projectId } = await project('Platform');
    const connection = await connect(projectId, { kind: 'github', owner: 'Acme-Corp' });
    expect(connection).toMatchObject({
      project: { id: projectId, name: 'Platform' },
      kind: 'github',
      config: { owner: 'Acme-Corp' },
      host: 'github.com',
      namespace: 'acme-corp',
      accountLogin: null,
      lastTestedAt: null,
    });
    expect(JSON.stringify(connection)).not.toMatch(/token|secret/i);

    const [row] = await db
      .select()
      .from(projectConnections)
      .where(eq(projectConnections.id, connection.id));
    expect(row?.tokenCiphertext).toMatch(/^v1:/);
    expect(row?.tokenCiphertext).not.toContain(TOKEN);
    expect(JSON.stringify(row)).not.toContain(TOKEN);
    const key = connectionsKey(config.secretKey);
    expect(decryptSecret(key, row?.tokenCiphertext ?? '')).toBe(TOKEN);
    expect(decryptSecret(key, row?.webhookSecretCiphertext ?? '')).toMatch(/^[0-9a-f]{64}$/);
    // Another key reads nothing.
    expect(() => decryptSecret(connectionsKey('other'), row?.tokenCiphertext ?? '')).toThrow();

    // The project counts it, in the list and on its own.
    const listed = (await call(admin, 'GET', '/api/projects')).json<{ projects: Project[] }>();
    expect(listed.projects.find((item) => item.id === projectId)?.connectionCount).toBe(1);
    const own = (await call(admin, 'GET', `/api/projects/${projectId}`)).json<Project>();
    expect(own.connectionCount).toBe(1);

    for (const url of ['/api/connections', `/api/connections/${connection.id}`]) {
      const response = await call(admin, 'GET', url);
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).not.toContain(TOKEN);
    }
  });

  it('are the administrator’s alone', async () => {
    const { id: projectId } = await project('Private');
    const asMember = [
      call(maria, 'GET', '/api/connections'),
      call(maria, 'POST', '/api/connections', {
        projectId,
        config: { kind: 'github', owner: 'acme' },
        token: TOKEN,
      }),
    ];
    for (const response of await Promise.all(asMember)) expect(response.statusCode).toBe(403);
    // Nor through the project page: it names the connection, not its secrets.
    const page = await call(maria, 'GET', `/api/projects/${projectId}`);
    expect(JSON.stringify(page.json())).not.toMatch(/token|secret/i);
  });

  it('allow one per host and namespace in a project, and normalise a GitLab address', async () => {
    const { id: projectId } = await project('Infra');
    const gitlab = await connect(projectId, {
      kind: 'gitlab',
      baseUrl: 'https://GitLab.Example.com/',
      group: 'Acme/Platform',
    });
    // The group keeps the case it was given, for the host's own API and the proxy; the match
    // is on the lower-cased namespace.
    expect(gitlab).toMatchObject({
      config: { baseUrl: 'https://gitlab.example.com', group: 'Acme/Platform' },
      host: 'gitlab.example.com',
      namespace: 'acme/platform',
    });
    const again = await call(admin, 'POST', '/api/connections', {
      projectId,
      config: { kind: 'gitlab', baseUrl: 'https://gitlab.example.com', group: 'acme/platform' },
      token: TOKEN,
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: { code: 'connection_exists' } });
    // The same namespace in another project is another connection.
    const elsewhere = await project('Infra 2');
    await connect(elsewhere.id, {
      kind: 'gitlab',
      baseUrl: 'https://gitlab.example.com',
      group: 'acme/platform',
    });
  });

  it('refuse what is not a token, an owner or an address', async () => {
    const { id: projectId } = await project('Strict');
    const attempts = [
      { config: { kind: 'github', owner: 'acme' }, token: 'has a space' },
      { config: { kind: 'github', owner: '-acme' }, token: TOKEN },
      {
        config: { kind: 'gitlab', baseUrl: 'ftp://gitlab.example.com', group: 'acme' },
        token: TOKEN,
      },
      {
        config: { kind: 'gitlab', baseUrl: 'https://gitlab.example.com', group: 'a b' },
        token: TOKEN,
      },
      { config: { kind: 'jira', owner: 'acme' }, token: TOKEN },
    ];
    for (const attempt of attempts) {
      const response = await call(admin, 'POST', '/api/connections', { projectId, ...attempt });
      expect(response.statusCode, JSON.stringify(attempt)).toBe(400);
    }
    const missing = await call(admin, 'POST', '/api/connections', {
      projectId: '7f3a9c21-0000-4000-8000-000000000009',
      config: { kind: 'github', owner: 'acme' },
      token: TOKEN,
    });
    expect(missing.statusCode).toBe(404);
  });

  it('ask the host whose token it is, and remember the answer until the token changes', async () => {
    const { id: projectId } = await project('Tested');
    const connection = await connect(projectId, { kind: 'github', owner: 'acme' });
    const seen = host({ body: { login: 'acme-bot' } });
    const tested = await call(admin, 'POST', `/api/connections/${connection.id}/test`);
    expect(tested.statusCode).toBe(200);
    expect(tested.json()).toMatchObject({ login: 'acme-bot' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('https://api.github.com/user');
    // octokit sends the token this way; GitHub takes either spelling.
    expect(seen[0]?.headers.get('authorization')).toBe(`token ${TOKEN}`);

    const after = (
      await call(admin, 'GET', `/api/connections/${connection.id}`)
    ).json<Connection>();
    expect(after.accountLogin).toBe('acme-bot');
    expect(after.lastTestedAt).not.toBeNull();

    const replaced = await call(admin, 'PATCH', `/api/connections/${connection.id}`, {
      token: 'github_pat_another_one',
    });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.body).not.toContain('github_pat_another_one');
    expect(replaced.json<Connection>()).toMatchObject({ accountLogin: null, lastTestedAt: null });
  });

  it('name a refused token and a host that does not answer as such', async () => {
    const { id: projectId } = await project('Unlucky');
    const github = await connect(projectId, { kind: 'github', owner: 'acme' });
    host({ status: 401, body: { message: 'Bad credentials' } });
    const refused = await call(admin, 'POST', `/api/connections/${github.id}/test`);
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: { code: 'connection_unauthorized' } });
    expect(refused.body).not.toContain(TOKEN);

    const gitlab = await connect(projectId, {
      kind: 'gitlab',
      baseUrl: 'https://gitlab.example.com',
      group: 'acme',
    });
    const seen = host({ reject: true });
    const down = await call(admin, 'POST', `/api/connections/${gitlab.id}/test`);
    expect(down.statusCode).toBe(502);
    expect(down.json()).toMatchObject({ error: { code: 'connection_unreachable' } });
    expect(seen[0]?.url).toBe('https://gitlab.example.com/api/v4/user');
    expect(seen[0]?.headers.get('private-token')).toBe(TOKEN);
    const untouched = (
      await call(admin, 'GET', `/api/connections/${gitlab.id}`)
    ).json<Connection>();
    expect(untouched.accountLogin).toBeNull();
  });

  it("give the administrator the webhook's address and secret, and keep a connection's kind", async () => {
    const { id: projectId } = await project('Hooked');
    const connection = await connect(projectId, { kind: 'github', owner: 'acme' });
    const webhook = await call(admin, 'GET', `/api/connections/${connection.id}/webhook`);
    expect(webhook.statusCode).toBe(200);
    expect(webhook.headers['cache-control']).toBe('no-store');
    expect(webhook.json()).toEqual({
      url: `https://agentome.example.com/webhooks/github/${connection.id}`,
      secret: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect((await call(maria, 'GET', `/api/connections/${connection.id}/webhook`)).statusCode).toBe(
      403,
    );

    const moved = await call(admin, 'PATCH', `/api/connections/${connection.id}`, {
      config: { kind: 'github', owner: 'acme-labs' },
    });
    expect(moved.json<Connection>()).toMatchObject({ namespace: 'acme-labs' });
    const turned = await call(admin, 'PATCH', `/api/connections/${connection.id}`, {
      config: { kind: 'gitlab', baseUrl: 'https://gitlab.example.com', group: 'acme' },
    });
    expect(turned.statusCode).toBe(400);

    expect((await call(admin, 'DELETE', `/api/connections/${connection.id}`)).statusCode).toBe(204);
    expect((await call(admin, 'GET', `/api/connections/${connection.id}`)).statusCode).toBe(404);
    expect((await call(admin, 'DELETE', `/api/connections/${connection.id}`)).statusCode).toBe(404);
  });
});

describe("an agent's own token", () => {
  it('is used for that agent, and the shared one for every other agent of the project', async () => {
    const { id: projectId } = await project('Own tokens');
    const payments = await agentOf(maria, 'Payments bot');
    const docs = await agentOf(maria, 'Docs bot');
    for (const agent of [payments, docs]) {
      await call(admin, 'PUT', `/api/projects/${projectId}/agents/${agent}`);
    }
    const shared = await connect(projectId, { kind: 'github', owner: 'acme' });
    const own = await call(admin, 'POST', '/api/connections', {
      projectId,
      agentId: payments,
      config: { kind: 'github', owner: 'acme' },
      token: 'github_pat_the_payments_bot',
    });
    expect(own.statusCode).toBe(201);
    expect(own.json<Connection & { agent: unknown }>().agent).toEqual({
      id: payments,
      name: 'Payments bot',
    });
    expect(shared).toMatchObject({ agent: null });

    const resolved = async (agentId: string) => {
      const response = await call(maria, 'POST', '/api/tasks', {
        agentId,
        projectId: await projectOfAgent(db, agentId),
        title: 'Add a README',
        repository: 'https://github.com/acme/api',
        run: false,
      });
      return response.json<{ task: { connection: { id: string } | null } }>().task.connection?.id;
    };
    expect(await resolved(payments)).toBe(own.json<{ id: string }>().id);
    expect(await resolved(docs)).toBe(shared.id);

    // The project page says whose each token is.
    const page = (await call(maria, 'GET', `/api/projects/${projectId}`)).json<{
      connections: { agentName: string | null }[];
    }>();
    expect(page.connections.map((connection) => connection.agentName).sort()).toEqual([
      'Payments bot',
      null,
    ]);
  });

  it("wins over a narrower shared token: it is the agent's own identity", async () => {
    const { id: projectId } = await project('Depth');
    const agent = await agentOf(maria, 'Platform bot');
    await call(admin, 'PUT', `/api/projects/${projectId}/agents/${agent}`);
    const base = 'https://gitlab.example.com';
    await connect(projectId, { kind: 'gitlab', baseUrl: base, group: 'acme/platform' });
    const own = await call(admin, 'POST', '/api/connections', {
      projectId,
      agentId: agent,
      config: { kind: 'gitlab', baseUrl: base, group: 'acme' },
      token: TOKEN,
    });
    const task = await call(maria, 'POST', '/api/tasks', {
      agentId: agent,
      projectId: await projectOfAgent(db, agent),
      title: 'Fix it',
      repository: `${base}/acme/platform/api`,
      run: false,
    });
    expect(task.json<{ task: { connection: { id: string } } }>().task.connection.id).toBe(
      own.json<{ id: string }>().id,
    );
  });

  it('allows one shared token and one per agent for each place, and only for agents on the project', async () => {
    const { id: projectId } = await project('Rules');
    const agent = await agentOf(maria, 'Rules bot');
    const config = { kind: 'github', owner: 'acme' };
    const add = (body: object) =>
      call(admin, 'POST', '/api/connections', { projectId, config, token: TOKEN, ...body });

    // Not on the project yet: its own token would reach nothing.
    const early = await add({ agentId: agent });
    expect(early.statusCode).toBe(400);
    expect(early.json()).toMatchObject({ error: { message: /Put the agent on this project/ } });

    await call(admin, 'PUT', `/api/projects/${projectId}/agents/${agent}`);
    expect((await add({})).statusCode).toBe(201);
    expect((await add({ agentId: agent })).statusCode).toBe(201);
    expect((await add({})).statusCode).toBe(409);
    expect((await add({ agentId: agent })).statusCode).toBe(409);
  });

  it('is not used once the agent is taken off the project', async () => {
    const { id: projectId } = await project('Leaving');
    const agent = await agentOf(maria, 'Leaving bot');
    await call(admin, 'PUT', `/api/projects/${projectId}/agents/${agent}`);
    await call(admin, 'POST', '/api/connections', {
      projectId,
      agentId: agent,
      config: { kind: 'github', owner: 'acme' },
      token: TOKEN,
    });
    await call(admin, 'DELETE', `/api/projects/${projectId}/agents/${agent}`);
    const task = await call(maria, 'POST', '/api/tasks', {
      agentId: agent,
      projectId: await projectOfAgent(db, agent),
      title: 'After',
      repository: 'https://github.com/acme/api',
      run: false,
    });
    expect(task.json<{ task: { connection: unknown } }>().task.connection).toBeNull();
  });
});

describe("a task's connection", () => {
  async function taskWith(agentId: string, repository: string | null) {
    const response = await call(maria, 'POST', '/api/tasks', {
      agentId,
      projectId: await projectOfAgent(db, agentId),
      title: 'Add a README',
      repository,
      run: false,
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ task: { connection: unknown } }>().task.connection;
  }

  it('is the connection of the agent’s project that the repository URL falls under', async () => {
    const agent = await agentOf(maria, 'Resolver');
    const { id: projectId, name } = await project('Resolved');
    const github = await connect(projectId, { kind: 'github', owner: 'Acme' });
    const gitlab = await connect(projectId, {
      kind: 'gitlab',
      baseUrl: 'https://gitlab.example.com',
      group: 'acme/platform',
    });

    // Not on the project yet: the URL matches a connection the agent cannot reach.
    expect(await taskWith(agent, 'https://github.com/acme/api')).toBeNull();
    await call(admin, 'PUT', `/api/projects/${projectId}/agents/${agent}`);

    const expected = (id: string, kind: string) => ({ id, kind, project: { id: projectId, name } });
    expect(await taskWith(agent, 'https://github.com/Acme/api.git')).toEqual(
      expected(github.id, 'github'),
    );
    // A nested group: the deepest namespace the URL starts with.
    expect(await taskWith(agent, 'https://gitlab.example.com/acme/platform/billing/api')).toEqual(
      expected(gitlab.id, 'gitlab'),
    );
    expect(await taskWith(agent, 'https://gitlab.example.com/acme/other/api')).toBeNull();
    // The owner's repositories are not the organization's.
    expect(await taskWith(agent, 'https://github.com/octocat/api')).toBeNull();
    // A path on the computer, no repository, or a URL with no namespace in it.
    expect(await taskWith(agent, '~/code/test-repo')).toBeNull();
    expect(await taskWith(agent, null)).toBeNull();
    expect(await taskWith(agent, 'https://github.com/api')).toBeNull();
  });
});

describe('Jira connections', () => {
  const jira = {
    kind: 'jira',
    baseUrl: 'https://jira.example.com/',
    projectKey: 'pay',
    jql: 'labels = ai-team',
    inProgress: 'In Progress',
    inReview: 'In Review',
    done: 'Done',
  };

  /** A Jira that answers as Data Center of the version given, and refuses a filter as told. */
  function fakeJira(version: number[], badFilter = false) {
    const seen: Request[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Request) => {
        seen.push(input);
        const path = new URL(input.url).pathname;
        if (path.endsWith('/rest/api/2/serverInfo')) {
          return Response.json({ version: version.join('.'), versionNumbers: version });
        }
        if (path.endsWith('/rest/api/2/myself')) {
          return Response.json({ name: 'agentome-bot', timeZone: 'Europe/Moscow' });
        }
        if (badFilter) {
          return Response.json(
            { errorMessages: ["The value 'PAY' does not exist for the field 'project'."] },
            { status: 400 },
          );
        }
        return Response.json({ total: 3, issues: [] });
      }),
    );
    return seen;
  }

  const searched = 'project = "PAY" AND (labels = ai-team)';

  it('go to one agent of the project, reach a filter, and keep no webhook', async () => {
    const { id: projectId } = await project('Payments');
    const missing = await call(admin, 'POST', '/api/connections', {
      projectId,
      config: jira,
      token: TOKEN,
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({
      error: {
        message: 'Pick the agent the issues go to, or give the project a team to take them',
      },
    });

    const agentId = await agentOf(admin, 'Payments backend');
    await call(admin, 'PUT', `/api/projects/${projectId}/agents/${agentId}`);
    const made = await call(admin, 'POST', '/api/connections', {
      projectId,
      agentId,
      config: jira,
      token: TOKEN,
    });
    expect(made.statusCode).toBe(201);
    expect(made.body).not.toContain(TOKEN);
    const connection = made.json<Connection & { config: Record<string, string> }>();
    expect(connection).toMatchObject({
      kind: 'jira',
      host: 'jira.example.com',
      namespace: searched,
      agent: { id: agentId, name: 'Payments backend' },
      config: {
        baseUrl: 'https://jira.example.com',
        projectKey: 'PAY',
        jql: jira.jql,
        done: 'Done',
      },
    });
    // The project is the bound: without its key, or with something else for one, no connection.
    for (const projectKey of [undefined, 'PAY-1', 'project = PAY']) {
      const refused = await call(admin, 'POST', '/api/connections', {
        projectId,
        agentId,
        config: { ...jira, baseUrl: 'https://other.example.com', projectKey },
        token: TOKEN,
      });
      expect(refused.statusCode, String(projectKey)).toBe(400);
    }
    expect((await call(admin, 'GET', `/api/connections/${connection.id}/webhook`)).statusCode).toBe(
      404,
    );
  });

  it('check the version, the account and the filter, and keep the account’s time zone', async () => {
    const { id: projectId } = await project('Checked Jira');
    const agentId = await agentOf(admin, 'Checker');
    await call(admin, 'PUT', `/api/projects/${projectId}/agents/${agentId}`);
    const connection = (
      await call(admin, 'POST', '/api/connections', {
        projectId,
        agentId,
        // Under a path, as Data Center often is: the path stays, the trailing slash goes.
        config: { ...jira, baseUrl: 'https://jira.example.com/jira/' },
        token: TOKEN,
      })
    ).json<Connection>();

    const seen = fakeJira([10, 3, 1]);
    const tested = await call(admin, 'POST', `/api/connections/${connection.id}/test`);
    expect(tested.statusCode).toBe(200);
    expect(tested.json()).toMatchObject({ login: 'agentome-bot' });
    expect(seen.map((request) => new URL(request.url).pathname)).toEqual([
      '/jira/rest/api/2/serverInfo',
      '/jira/rest/api/2/myself',
      '/jira/rest/api/2/search',
    ]);
    expect(seen[0]?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(await seen[2]?.json()).toMatchObject({ jql: searched, maxResults: 0 });
    const after = (await call(admin, 'GET', `/api/connections/${connection.id}`)).json<
      Connection & { config: Record<string, string> }
    >();
    expect(after).toMatchObject({
      accountLogin: 'agentome-bot',
      config: { timeZone: 'Europe/Moscow', jql: jira.jql },
    });

    fakeJira([9, 17, 0]);
    const old = await call(admin, 'POST', `/api/connections/${connection.id}/test`);
    expect(old.statusCode).toBe(400);
    expect(old.json()).toMatchObject({
      error: { message: expect.stringContaining('Jira Data Center 10 or newer') },
    });

    fakeJira([10, 3, 1], true);
    const filter = await call(admin, 'POST', `/api/connections/${connection.id}/test`);
    expect(filter.statusCode).toBe(400);
    expect(filter.json()).toMatchObject({
      error: { message: expect.stringContaining("The value 'PAY' does not exist") },
    });
    expect(filter.body).not.toContain(TOKEN);
  });

  it('never stand for a repository', async () => {
    const { id: projectId } = await project('Same host');
    const agentId = await agentOf(admin, 'Same host agent');
    await call(admin, 'PUT', `/api/projects/${projectId}/agents/${agentId}`);
    await call(admin, 'POST', '/api/connections', {
      projectId,
      agentId,
      config: { ...jira, baseUrl: 'https://git.example.com', jql: 'project' },
      token: TOKEN,
    });
    const task = await call(admin, 'POST', '/api/tasks', {
      agentId,
      projectId: await projectOfAgent(db, agentId),
      title: 'Add a README',
      repository: 'https://git.example.com/project/repo',
      run: false,
    });
    expect(task.statusCode).toBe(201);
    expect(task.json<{ task: { connection: unknown } }>().task.connection).toBeNull();
  });
});

describe('Jira polling', () => {
  const jiraConfig = {
    kind: 'jira',
    baseUrl: 'https://jira.example.com',
    projectKey: 'PAY',
    jql: 'labels = ai-team ORDER BY rank',
    inProgress: 'In Progress',
    inReview: 'In Review',
    done: 'Done',
  };
  type Issue = { key: string; summary: string; description?: string };

  /** A Jira holding `issues`, which answers a search with them, `size` to a page. */
  function fakeJira(issues: Issue[], options: { size?: number; down?: boolean } = {}) {
    const searches: { jql: string; startAt: number }[] = [];
    const requests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Request) => {
        const path = new URL(input.url).pathname;
        requests.push(path);
        if (options.down) return Response.json({}, { status: 503 });
        if (path.endsWith('/serverInfo')) {
          return Response.json({ version: '10.3.1', versionNumbers: [10, 3, 1] });
        }
        if (path.endsWith('/myself')) {
          return Response.json({ name: 'agentome-bot', timeZone: 'Asia/Dubai' });
        }
        const asked = (await input.json()) as { jql: string; startAt: number; maxResults: number };
        if (asked.maxResults === 0) return Response.json({ startAt: 0, total: 0, issues: [] });
        searches.push({ jql: asked.jql, startAt: asked.startAt });
        const size = options.size ?? 50;
        return Response.json({
          startAt: asked.startAt,
          total: issues.length,
          issues: issues.slice(asked.startAt, asked.startAt + size).map((issue) => ({
            id: issue.key.replace(/\D/g, ''),
            key: issue.key,
            fields: {
              summary: issue.summary,
              description: issue.description ?? null,
              status: { name: 'To Do' },
              updated: '2026-10-28T10:15:30.000+0400',
            },
          })),
        });
      }),
    );
    return { searches, requests };
  }

  async function jiraOn(name: string) {
    const { id: projectId } = await project(name);
    const agentId = await agentOf(admin, `${name} agent`);
    await call(admin, 'PUT', `/api/projects/${projectId}/agents/${agentId}`);
    const made = await call(admin, 'POST', '/api/connections', {
      projectId,
      agentId,
      config: jiraConfig,
      token: TOKEN,
    });
    return { projectId, agentId, connectionId: made.json<Connection>().id };
  }

  const tasksOf = async (agentId: string) =>
    (await call(admin, 'GET', `/api/tasks?agent=${agentId}`)).json<{
      tasks: { id: string; title: string; source: string; repository: string | null }[];
    }>().tasks;

  it("put a new issue's task in the project's main repository, and leave one a person changed", async () => {
    const { projectId, agentId, connectionId } = await jiraOn('Placed');
    await connect(projectId, { kind: 'github', owner: 'acme' });
    await call(admin, 'PATCH', `/api/projects/${projectId}`, {
      repositories: ['https://github.com/acme/api', 'https://github.com/acme/web'],
    });
    fakeJira([{ key: 'PAY-7', summary: 'Retry payouts' }]);
    await call(admin, 'POST', `/api/connections/${connectionId}/sync`);
    const [task] = await tasksOf(agentId);
    expect(task?.repository).toBe('https://github.com/acme/api');

    await call(admin, 'PATCH', `/api/tasks/${task?.id}`, {
      repository: 'https://github.com/acme/web',
    });
    fakeJira([{ key: 'PAY-7', summary: 'Retry failed payouts' }]);
    await call(admin, 'POST', `/api/connections/${connectionId}/sync`);
    expect(await tasksOf(agentId)).toMatchObject([
      { title: 'PAY-7: Retry failed payouts', repository: 'https://github.com/acme/web' },
    ]);
  });

  it('turn each issue under the filter into one task, however often it is found', async () => {
    const { agentId, connectionId } = await jiraOn('Polled');
    const issues: Issue[] = [
      { key: 'PAY-1', summary: 'Retry failed payouts', description: 'h2. Why\nThey fail.' },
      { key: 'PAY-2', summary: 'Round the totals' },
      { key: 'PAY-3', summary: 'Drop the old endpoint' },
    ];
    const jira = fakeJira(issues, { size: 2 });
    const first = await call(admin, 'POST', `/api/connections/${connectionId}/sync`);
    expect(first.json()).toEqual({ imported: 3, updated: 0 });
    // The first poll takes everything under the filter, a page at a time, the filter's own order
    // giving way to ours; the account's time zone was asked for once, as no check had run.
    expect(jira.searches).toEqual([
      { jql: 'project = "PAY" AND (labels = ai-team) ORDER BY updated ASC', startAt: 0 },
      { jql: 'project = "PAY" AND (labels = ai-team) ORDER BY updated ASC', startAt: 2 },
    ]);
    const after = (await call(admin, 'GET', `/api/connections/${connectionId}`)).json<
      Connection & { syncedAt: string; syncError: string | null }
    >();
    expect(after).toMatchObject({ syncError: null, config: { timeZone: 'Asia/Dubai' } });

    issues[1] = { key: 'PAY-2', summary: 'Round the totals to cents' };
    const again = fakeJira(issues);
    expect((await call(admin, 'POST', `/api/connections/${connectionId}/sync`)).json()).toEqual({
      imported: 0,
      updated: 1,
    });
    // Only what changed since the last poll started, less two minutes, in the account's zone.
    const since = jqlDate(new Date(Date.parse(after.syncedAt) - 2 * 60_000), 'Asia/Dubai');
    expect(again.searches[0]?.jql).toBe(
      `(project = "PAY" AND (labels = ai-team)) AND updated >= "${since}" ORDER BY updated ASC`,
    );
    expect(again.requests.every((path) => path.endsWith('/search'))).toBe(true);

    const titles = (await tasksOf(agentId)).map((task) => [task.title, task.source]).sort();
    expect(titles).toEqual([
      ['PAY-1: Retry failed payouts', 'jira'],
      ['PAY-2: Round the totals to cents', 'jira'],
      ['PAY-3: Drop the old endpoint', 'jira'],
    ]);
    const [row] = await db
      .select({ config: projectConnections.config })
      .from(projectConnections)
      .where(eq(projectConnections.id, connectionId));
    expect(JSON.stringify(row)).not.toContain(TOKEN);
  });

  it("take only the project's issues, whatever Jira answers", async () => {
    const { agentId, connectionId } = await jiraOn('Bounded');
    fakeJira([
      { key: 'PAY-4', summary: 'Ours' },
      { key: 'OPS-1', summary: 'Not ours' },
    ]);
    expect((await call(admin, 'POST', `/api/connections/${connectionId}/sync`)).json()).toEqual({
      imported: 1,
      updated: 0,
    });
    expect((await tasksOf(agentId)).map((task) => task.title)).toEqual(['PAY-4: Ours']);
  });

  it('keep why a poll failed, and ask again for what it missed', async () => {
    const { connectionId } = await jiraOn('Flaky Jira');
    fakeJira([{ key: 'PAY-9', summary: 'One' }]);
    await call(admin, 'POST', `/api/connections/${connectionId}/sync`);
    const before = (await call(admin, 'GET', `/api/connections/${connectionId}`)).json<{
      syncedAt: string;
    }>();

    fakeJira([], { down: true });
    const failed = await call(admin, 'POST', `/api/connections/${connectionId}/sync`);
    expect(failed.statusCode).toBe(502);
    expect(failed.body).not.toContain(TOKEN);
    const after = (await call(admin, 'GET', `/api/connections/${connectionId}`)).json<{
      syncedAt: string;
      syncError: string;
    }>();
    expect(after.syncedAt).toBe(before.syncedAt);
    expect(after.syncError).toContain('503');
  });

  it('poll each connection once an interval, however many servers ask', async () => {
    const { connectionId } = await jiraOn('Scheduled');
    // Only this connection is due: the others were polled a moment ago.
    await db.execute(
      sql`update project_connections set config = config || jsonb_build_object('pollStartedAt', now()::text) where id <> ${connectionId}`,
    );
    const jira = fakeJira([{ key: 'PAY-5', summary: 'Scheduled' }]);
    const log = { warn: vi.fn() };
    const key = connectionsKey(config.secretKey);
    await Promise.all([pollDue(db, key, 5, log), pollDue(db, key, 5, log)]);
    expect(jira.searches).toHaveLength(1);
    await pollDue(db, key, 5, log);
    expect(jira.searches).toHaveLength(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("give issues to the project's team when the connection names no agent, its lead starting in auto", async () => {
    const { id: projectId } = await project('Team intake');
    const lead = await agentOf(admin, 'Team intake lead');
    const team = (
      await call(admin, 'POST', '/api/teams', { name: 'Team intake', leadId: lead })
    ).json<{ id: string }>();
    await call(admin, 'PATCH', `/api/projects/${projectId}`, { teamId: team.id, intake: 'auto' });
    const made = await call(admin, 'POST', '/api/connections', {
      projectId,
      config: jiraConfig,
      token: TOKEN,
    });
    expect(made.statusCode, made.body).toBe(201);
    fakeJira([{ key: 'PAY-9', summary: 'Export refunds' }]);
    await call(admin, 'POST', `/api/connections/${made.json<Connection>().id}/sync`);
    const [task] = await tasksOf(lead);
    expect(task).toMatchObject({ title: 'PAY-9: Export refunds', source: 'jira' });
    const view = (await call(admin, 'GET', `/api/tasks/${task?.id}`)).json<{
      project: { id: string };
      runs: { status: string }[];
    }>();
    expect(view.project.id).toBe(projectId);
    expect(view.runs).toMatchObject([{ status: 'queued' }]);
  });
});

describe('Reporting back to Jira', () => {
  type Call = { method: string; path: string; body: unknown };

  /** A Jira with one issue, PAY-7, whose workflow offers the statuses in `offers`. */
  function fakeJira(offers: string[], options: { down?: boolean } = {}) {
    const calls: Call[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Request) => {
        const path = new URL(input.url).pathname.replace('/rest/api/2/', '');
        const text = await input.text();
        calls.push({ method: input.method, path, body: text ? JSON.parse(text) : undefined });
        if (options.down) return Response.json({}, { status: 503 });
        if (path === 'serverInfo') return Response.json({ versionNumbers: [10, 3, 1] });
        if (path === 'myself') return Response.json({ name: 'bot', timeZone: 'UTC' });
        if (path === 'search') {
          const fields = { summary: 'Fix it', status: { name: 'To Do' }, updated: 'x' };
          return Response.json({
            startAt: 0,
            total: 1,
            issues: [{ id: '7', key: 'PAY-7', fields }],
          });
        }
        if (path === 'issue/PAY-7/transitions' && input.method === 'GET') {
          return Response.json({
            transitions: offers.map((name, i) => ({ id: String(i), name, to: { name } })),
          });
        }
        if (path === 'issue/PAY-7') {
          return Response.json({
            id: '7',
            key: 'PAY-7',
            fields: { summary: 'Fix it', status: { name: 'To Do' }, updated: 'x' },
          });
        }
        if (input.method === 'POST' && path.endsWith('/transitions'))
          return new Response(null, { status: 204 });
        return Response.json({ id: '1' }, { status: 201 });
      }),
    );
    return calls;
  }

  async function jiraTask() {
    const { id: projectId } = await project(`Reported ${Math.random()}`);
    const agentId = await agentOf(admin, `Reporter ${Math.random()}`);
    await call(admin, 'PUT', `/api/projects/${projectId}/agents/${agentId}`);
    const made = await call(admin, 'POST', '/api/connections', {
      projectId,
      agentId,
      config: {
        kind: 'jira',
        baseUrl: 'https://jira.example.com',
        projectKey: 'PAY',
        inProgress: 'In Progress',
        inReview: 'In Review',
        done: 'Done',
      },
      token: TOKEN,
    });
    fakeJira([]);
    await pollConnection(db, key(), made.json<Connection>().id);
    const [task] = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.agentId, agentId));
    if (!task) throw new Error('No task imported');
    return task.id;
  }
  const key = () => connectionsKey(config.secretKey);
  const push = (job: Parameters<typeof pushToJira>[3]) =>
    pushToJira(db, key(), 'https://agentome.example.com', job);

  it('move the issue, link the pull request and comment with what the run did', async () => {
    const taskId = await jiraTask();
    const [run] = await db
      .insert(runs)
      .values({
        agentId: (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.agentId,
        taskId,
        startedBy: 'user',
        startedByUserId: admin.id,
        status: 'done',
        summary: 'Added the retry and a test.',
      })
      .returning({ id: runs.id });
    const calls = fakeJira(['In Progress', 'In Review', 'Done']);
    await push({ step: 'start', taskId });
    const url = 'https://github.com/acme/api/pull/42';
    await push({ step: 'review', taskId, url, title: 'Retry failed payouts' });
    await push({ step: 'comment', taskId, runId: run!.id });
    await push({ step: 'done', taskId });
    expect(calls.filter((c) => c.method === 'POST')).toEqual([
      { method: 'POST', path: 'issue/PAY-7/transitions', body: { transition: { id: '0' } } },
      {
        method: 'POST',
        path: 'issue/PAY-7/remotelink',
        body: { globalId: `agentome:${url}`, object: { url, title: 'Retry failed payouts' } },
      },
      { method: 'POST', path: 'issue/PAY-7/transitions', body: { transition: { id: '1' } } },
      {
        method: 'POST',
        path: 'issue/PAY-7/comment',
        body: {
          body: `Agentome run done. Added the retry and a test.\n\nhttps://agentome.example.com/runs/${run!.id}`,
        },
      },
      { method: 'POST', path: 'issue/PAY-7/transitions', body: { transition: { id: '2' } } },
    ]);
  });

  it('show on the task what Jira refused, and try again only while Jira is away', async () => {
    const taskId = await jiraTask();
    fakeJira(['In Progress']);
    await push({ step: 'done', taskId });
    const refused = (await call(admin, 'GET', `/api/tasks/${taskId}`)).json<{
      externalError: string;
    }>();
    expect(refused.externalError).toBe('Jira: Jira can move PAY-7 to "In Progress", not to "Done"');

    fakeJira([], { down: true });
    await expect(push({ step: 'start', taskId })).rejects.toThrow('503');

    fakeJira(['In Progress']);
    await push({ step: 'start', taskId });
    const cleared = (await call(admin, 'GET', `/api/tasks/${taskId}`)).json<{
      externalError: string | null;
    }>();
    expect(cleared.externalError).toBeNull();
  });

  it('file a step only for a task from Jira', async () => {
    const taskId = await jiraTask();
    const [jira] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    const manual = await call(admin, 'POST', '/api/tasks', {
      agentId: jira!.agentId,
      projectId: jira!.projectId,
      title: 'By hand',
      run: false,
    });
    const file = vi.fn(async () => {});
    const log = { warn: vi.fn() };
    await tellJira(db, file, { step: 'start', taskId }, log);
    await tellJira(
      db,
      file,
      { step: 'start', taskId: manual.json<{ task: { id: string } }>().task.id },
      log,
    );
    expect(file).toHaveBeenCalledTimes(1);
    await tellJira(
      db,
      async () => {
        throw new Error('queue down');
      },
      { step: 'done', taskId },
      log,
    );
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});

describe("a project's team", () => {
  it('takes the tasks filed in the project: to its lead, and at once in auto', async () => {
    const payments = await project('Intake');
    const lead = await agentOf(admin, 'Intake lead');
    const member = await agentOf(admin, 'Intake member');
    const filed = (body: object = {}) =>
      call(admin, 'POST', '/api/tasks', { projectId: payments.id, title: 'Add a README', ...body });

    const nobody = await filed();
    expect(nobody.statusCode).toBe(400);
    expect(nobody.body).toContain('no team to take its tasks');

    const team = (
      await call(admin, 'POST', '/api/teams', { name: 'Intake', leadId: lead, members: [member] })
    ).json<{ id: string }>();
    const given = await call(admin, 'PATCH', `/api/projects/${payments.id}`, { teamId: team.id });
    expect(given.json()).toMatchObject({
      team: { id: team.id, name: 'Intake', lead: { id: lead, name: 'Intake lead' } },
      intake: 'manual',
    });
    // Its agents join the project, so their runs reach its connections.
    const onIt = given.json<{ agents: { id: string }[] }>().agents.map((agent) => agent.id);
    expect(onIt).toEqual(expect.arrayContaining([lead, member]));

    const waiting = (await filed()).json<{
      task: { agent: { id: string }; project: object };
      run: unknown;
    }>();
    expect(waiting.task.agent.id).toBe(lead);
    expect(waiting.task.project).toEqual({ id: payments.id, name: 'Intake' });
    expect(waiting.run).toBeNull();

    await call(admin, 'PATCH', `/api/projects/${payments.id}`, { intake: 'auto' });
    const taken = (await filed()).json<{ run: { status: string } | null }>();
    expect(taken.run).toMatchObject({ status: 'queued' });
    // Asked not to run, it waits whatever the intake.
    expect((await filed({ run: false })).json<{ run: unknown }>().run).toBeNull();

    const listed = await call(admin, 'GET', `/api/tasks?project=${payments.id}`);
    expect(listed.json<{ tasks: unknown[] }>().tasks).toHaveLength(3);
  });
});
