import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  agents,
  createDb,
  type Db,
  eq,
  migrate,
  projectConnections,
  runArtifacts,
  runs,
  tasks,
  webhookDeliveries,
} from '@agentome/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { codeHostFor } from '../src/code-host/index.js';
import { loadConfig } from '../src/config.js';
import { createJobs } from '../src/jobs.js';
import { licenseEnterprise, setupCodeIn } from './app.js';

// The webhook endpoints against the real server, database and pg-boss: a delivery
// is checked against its connection's secret, recorded once, and applied by the queue to the
// change request artifacts of its namespace. The bodies are the hosts' own shapes, from
// test/fixtures/webhooks.

let container: StartedPostgreSqlContainer;
let app: Awaited<ReturnType<typeof buildApp>>;
let db: Db;
let dataDir: string;
let stopJobs: () => Promise<void>;
let cookie: string;
let projectId = '';
const github = { id: '', secret: '' };
const gitlab = { id: '', secret: '' };

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(new URL(`fixtures/webhooks/${name}.json`, import.meta.url), 'utf8'),
  ) as Record<string, unknown>;

function cookieOf(response: LightMyRequestResponse): string {
  const setCookie = response.headers['set-cookie'] ?? [];
  return (Array.isArray(setCookie) ? setCookie : [setCookie])
    .map((value) => value.split(';', 1)[0])
    .join('; ');
}

const asAdmin = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
  app.inject({ method, url, payload, headers: { cookie } });

async function connect(projectId: string, config: object) {
  const made = await asAdmin('POST', '/api/connections', {
    projectId,
    config,
    token: 'host-token-nobody-sees',
  });
  const { id } = made.json<{ id: string }>();
  const settings = (await asAdmin('GET', `/api/connections/${id}/webhook`)).json<{
    secret: string;
  }>();
  return { id, secret: settings.secret };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  dataDir = mkdtempSync(join(tmpdir(), 'agentome-webhooks-'));
  await migrate(container.getConnectionUri());
  const config = loadConfig({
    AGENTOME_DATABASE_URL: container.getConnectionUri(),
    AGENTOME_DATA_DIR: dataDir,
    AGENTOME_LOG_LEVEL: 'silent',
  });
  const jobs = createJobs(config);
  app = await buildApp(config, { jobs });
  stopJobs = await jobs.start(app.log);
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
  cookie = cookieOf(setup);
  const project = (await asAdmin('POST', '/api/projects', { name: 'Payments' })).json<{
    id: string;
  }>();
  projectId = project.id;
  Object.assign(github, await connect(project.id, { kind: 'github', owner: 'acme' }));
  Object.assign(
    gitlab,
    await connect(project.id, {
      kind: 'gitlab',
      baseUrl: 'https://gitlab.example.com',
      group: 'platform',
    }),
  );
}, 120_000);

afterAll(async () => {
  await stopJobs?.();
  await app?.close();
  await db?.$client.end();
  await container?.stop();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

/** A task with a run that opened `url`, as the gateway records it. */
async function changeRequest(url: string) {
  const agent = (await asAdmin('POST', '/api/agents', { name: 'Backend developer' })).json<{
    id: string;
  }>();
  const [owner] = await db.select({ id: agents.ownerUserId }).from(agents).limit(1);
  const [task] = await db
    .insert(tasks)
    .values({ agentId: agent.id, title: 'Add a README', source: 'manual', createdBy: owner!.id })
    .returning({ id: tasks.id });
  const [run] = await db
    .insert(runs)
    .values({ agentId: agent.id, taskId: task!.id, startedBy: 'user', status: 'done' })
    .returning({ id: runs.id });
  const [artifact] = await db
    .insert(runArtifacts)
    .values({ runId: run!.id, kind: 'change_request', ref: url, meta: { state: 'open' } })
    .returning({ id: runArtifacts.id });
  return { taskId: task!.id, runId: run!.id, artifactId: artifact!.id };
}

let deliveries = 0;
const nextDelivery = () => `00000000-0000-4000-8000-${String(++deliveries).padStart(12, '0')}`;

function fromGithub(
  event: string,
  body: object,
  options: { delivery?: string; secret?: string; id?: string } = {},
) {
  const payload = JSON.stringify(body);
  const signature = createHmac('sha256', options.secret ?? github.secret)
    .update(payload)
    .digest('hex');
  return app.inject({
    method: 'POST',
    url: `/webhooks/github/${options.id ?? github.id}`,
    payload,
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': options.delivery ?? nextDelivery(),
      'x-hub-signature-256': `sha256=${signature}`,
    },
  });
}

function fromGitlab(body: object, options: { token?: string; delivery?: string } = {}) {
  return app.inject({
    method: 'POST',
    url: `/webhooks/gitlab/${gitlab.id}`,
    payload: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      'x-gitlab-event': 'Merge Request Hook',
      'x-gitlab-event-uuid': options.delivery ?? nextDelivery(),
      'x-gitlab-token': options.token ?? gitlab.secret,
    },
  });
}

const rowsOf = (connectionId: string, delivery: string) =>
  db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.connectionId, connectionId))
    .then((rows) => rows.filter((row) => row.externalEventId === delivery));

/** The delivery's row once the queue is through with it. */
async function settled(connectionId: string, delivery: string) {
  for (let waited = 0; waited < 20_000; waited += 100) {
    const [row] = await rowsOf(connectionId, delivery);
    if (row && row.status !== 'received') return row;
    await sleep(100);
  }
  throw new Error(`Delivery ${delivery} was not processed`);
}

const metaOf = async (artifactId: string) => {
  const [row] = await db
    .select({ meta: runArtifacts.meta })
    .from(runArtifacts)
    .where(eq(runArtifacts.id, artifactId));
  return row?.meta as Record<string, unknown>;
};
const taskStatus = async (taskId: string) =>
  (await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)))[0]?.status;

describe('GitHub webhooks', { timeout: 30_000 }, () => {
  it('turns down a bad signature, another connection or no connection with 401 and no row', async () => {
    const delivery = nextDelivery();
    const forged = await fromGithub('pull_request', fixture('github-pull_request'), {
      delivery,
      secret: 'not-the-secret',
    });
    expect(forged.statusCode).toBe(401);
    expect(forged.json()).toMatchObject({ error: { code: 'unauthorized' } });
    expect(forged.body).not.toContain(github.secret);
    expect(await rowsOf(github.id, delivery)).toHaveLength(0);

    // GitLab's id under /webhooks/github, and an id nobody has, answer the same.
    for (const id of [gitlab.id, '7d0c5f43-3a5e-4c55-9a43-2d1d0f2c9b11']) {
      expect((await fromGithub('ping', {}, { id })).statusCode).toBe(401);
    }
  });

  it('marks a merged pull request merged and its task done, once per delivery', async () => {
    const { taskId, artifactId } = await changeRequest('https://github.com/acme/api/pull/42');
    const delivery = nextDelivery();
    const first = await fromGithub('pull_request', fixture('github-pull_request'), { delivery });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ status: 'received' });
    expect(await settled(github.id, delivery)).toMatchObject({
      status: 'processed',
      kind: 'github',
      event: 'pull_request',
    });
    expect(await metaOf(artifactId)).toMatchObject({
      state: 'merged',
      url: 'https://github.com/acme/api/pull/42',
    });
    expect(await taskStatus(taskId)).toBe('done');

    const again = await fromGithub('pull_request', fixture('github-pull_request'), { delivery });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ status: 'duplicate' });
    expect(await rowsOf(github.id, delivery)).toHaveLength(1);

    // An older event that arrives late does not reopen it.
    const open = fixture('github-pull_request_review');
    const late = nextDelivery();
    await fromGithub('pull_request_review', open, { delivery: late });
    await settled(github.id, late);
    expect(await metaOf(artifactId)).toMatchObject({
      state: 'merged',
      review: 'changes_requested',
    });
  });

  it('records a failed check suite on the pull request', async () => {
    const { artifactId, taskId } = await changeRequest('https://github.com/acme/web/pull/7');
    const body = fixture('github-check_suite');
    body.repository = { id: 761044210, html_url: 'https://github.com/acme/web' };
    const suite = body.check_suite as { pull_requests: { number: number }[] };
    suite.pull_requests[0]!.number = 7;
    const delivery = nextDelivery();
    expect((await fromGithub('check_suite', body, { delivery })).statusCode).toBe(200);
    expect((await settled(github.id, delivery)).status).toBe('processed');
    expect(await metaOf(artifactId)).toMatchObject({ state: 'open', pipeline: 'failed' });
    expect(await taskStatus(taskId)).toBe('open');
  });

  it('answers an event it does nothing with 202 and an ignored row', async () => {
    const delivery = nextDelivery();
    const push = await fromGithub('push', { ref: 'refs/heads/main' }, { delivery });
    expect(push.statusCode).toBe(202);
    expect(push.json()).toEqual({ status: 'ignored' });
    const [row] = await rowsOf(github.id, delivery);
    expect(row).toMatchObject({ status: 'ignored', event: 'push' });
    expect(row?.processedAt).toBeInstanceOf(Date);
  });

  it('leaves alone a change request outside the connection’s namespace', async () => {
    const { artifactId } = await changeRequest('https://github.com/other/api/pull/42');
    const body = fixture('github-pull_request');
    (body.pull_request as { html_url: string }).html_url = 'https://github.com/other/api/pull/42';
    const delivery = nextDelivery();
    await fromGithub('pull_request', body, { delivery });
    expect((await settled(github.id, delivery)).status).toBe('ignored');
    expect(await metaOf(artifactId)).toEqual({ state: 'open' });
  });

  it('wants a delivery id, JSON, and a body under 256 KiB', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/webhooks/github/${github.id}`,
      payload: '{}',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'ping',
        'x-hub-signature-256': `sha256=${createHmac('sha256', github.secret).update('{}').digest('hex')}`,
      },
    });
    expect(response.statusCode).toBe(400);

    const big = await fromGithub('pull_request', { padding: 'x'.repeat(300 * 1024) });
    expect(big.statusCode).toBe(413);

    const form = await app.inject({
      method: 'POST',
      url: `/webhooks/github/${github.id}`,
      payload: 'payload=%7B%7D',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(form.statusCode).toBe(415);
  });
});

/** The task's runs once the queue has had time to start what a delivery triggers. */
async function runsOf(taskId: string, expected: number) {
  for (let waited = 0; waited < 10_000; waited += 100) {
    const rows = await db.select().from(runs).where(eq(runs.taskId, taskId));
    if (rows.length >= expected) return rows;
    await sleep(100);
  }
  return db.select().from(runs).where(eq(runs.taskId, taskId));
}

const patchProject = (payload: object) =>
  app.inject({ method: 'PATCH', url: `/api/projects/${projectId}`, headers: { cookie }, payload });

describe('triggers', { timeout: 30_000 }, () => {
  it('run an agent’s task again on a failed pipeline, once while a run is on its way', async () => {
    expect((await patchProject({ onPipelineFailed: true })).statusCode).toBe(200);
    const { taskId } = await changeRequest('https://github.com/acme/web/pull/21');
    const body = fixture('github-check_suite');
    body.repository = { id: 761044210, html_url: 'https://github.com/acme/web' };
    (body.check_suite as { pull_requests: { number: number }[] }).pull_requests[0]!.number = 21;
    const first = nextDelivery();
    await fromGithub('check_suite', body, { delivery: first });
    await settled(github.id, first);
    const again = (await runsOf(taskId, 2)).filter((run) => run.startedBy === 'webhook');
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ status: 'queued', startedByUserId: null });
    expect(again[0]?.reason).toContain(
      'pipeline of your change request https://github.com/acme/web/pull/21 failed',
    );
    // The same failure again while that run waits starts nothing more.
    const second = nextDelivery();
    await fromGithub('check_suite', body, { delivery: second });
    await settled(github.id, second);
    expect((await runsOf(taskId, 3)).filter((run) => run.startedBy === 'webhook')).toHaveLength(1);
  });

  it('address a review that asks for changes, but not one by the connection’s own account', async () => {
    expect((await patchProject({ onReview: true })).statusCode).toBe(200);
    await db
      .update(projectConnections)
      .set({ accountLogin: 'acme-agent' })
      .where(eq(projectConnections.id, github.id));
    const review = (login: string, number: number) => ({
      action: 'submitted',
      pull_request: { html_url: `https://github.com/acme/web/pull/${number}`, state: 'open' },
      review: { state: 'changes_requested', user: { login } },
    });
    const own = await changeRequest('https://github.com/acme/web/pull/22');
    const delivered = nextDelivery();
    await fromGithub('pull_request_review', review('acme-agent', 22), { delivery: delivered });
    await settled(github.id, delivered);
    expect((await runsOf(own.taskId, 2)).length).toBe(1);

    const theirs = await changeRequest('https://github.com/acme/web/pull/23');
    const reviewed = nextDelivery();
    await fromGithub('pull_request_review', review('carol', 23), { delivery: reviewed });
    await settled(github.id, reviewed);
    const [again] = (await runsOf(theirs.taskId, 2)).filter((run) => run.startedBy === 'webhook');
    expect(again?.reason).toContain('carol asked for changes on your change request');
  });

  it('give a person’s new pull request to the project’s reviewer agent', async () => {
    const reviewer = (await asAdmin('POST', '/api/agents', { name: 'Code reviewer' })).json<{
      id: string;
    }>();
    expect((await patchProject({ reviewerAgentId: reviewer.id })).json().triggers.reviewer).toEqual(
      {
        id: reviewer.id,
        name: 'Code reviewer',
      },
    );
    // A delivery that names a repository outside the connection's owner starts nothing: the
    // repository would become the task's, and a run would clone it.
    const stray = nextDelivery();
    await fromGithub(
      'pull_request',
      {
        action: 'opened',
        pull_request: {
          html_url: 'https://github.com/acme/web/pull/29',
          state: 'open',
          draft: false,
          title: 'From elsewhere',
          user: { login: 'dave' },
        },
        repository: { html_url: 'https://github.com/someone-else/web' },
      },
      { delivery: stray },
    );
    await settled(github.id, stray);
    const opened = nextDelivery();
    await fromGithub(
      'pull_request',
      {
        action: 'opened',
        pull_request: {
          html_url: 'https://github.com/acme/web/pull/30',
          state: 'open',
          draft: false,
          title: 'Fix the login page',
          user: { login: 'dave' },
        },
        repository: { html_url: 'https://github.com/acme/web' },
      },
      { delivery: opened },
    );
    await settled(github.id, opened);
    // The delivery is settled before its triggers run: wait for the task they make.
    await vi.waitFor(
      async () =>
        expect(await db.select().from(tasks).where(eq(tasks.agentId, reviewer.id))).toHaveLength(1),
      { timeout: 10_000 },
    );
    const [task] = await db.select().from(tasks).where(eq(tasks.agentId, reviewer.id));
    expect(task).toMatchObject({
      title: 'Review: Fix the login page',
      source: 'webhook',
      projectId,
      repository: 'https://github.com/acme/web',
    });
    expect((await runsOf(task?.id ?? '', 1))[0]?.reason).toContain('pull/30 for you to review');
    expect(await db.select().from(tasks).where(eq(tasks.agentId, reviewer.id))).toHaveLength(1);
  });
});

describe('GitLab webhooks', { timeout: 30_000 }, () => {
  it('checks the token, then follows a merge request, its pipeline and its notes', async () => {
    const { artifactId, taskId } = await changeRequest(
      'https://gitlab.example.com/platform/payments/-/merge_requests/7',
    );
    const refused = nextDelivery();
    const wrong = await fromGitlab(fixture('gitlab-merge_request'), {
      token: `${gitlab.secret}x`,
      delivery: refused,
    });
    expect(wrong.statusCode).toBe(401);
    expect(await rowsOf(gitlab.id, refused)).toHaveLength(0);

    const pipeline = nextDelivery();
    expect((await fromGitlab(fixture('gitlab-pipeline'), { delivery: pipeline })).statusCode).toBe(
      200,
    );
    await settled(gitlab.id, pipeline);
    expect(await metaOf(artifactId)).toMatchObject({ state: 'open', pipeline: 'failed' });

    const note = nextDelivery();
    await fromGitlab(fixture('gitlab-note'), { delivery: note });
    await settled(gitlab.id, note);
    expect(await metaOf(artifactId)).toMatchObject({ review: 'commented' });

    const merged = fixture('gitlab-merge_request');
    Object.assign(merged.object_attributes as object, { state: 'merged', action: 'merge' });
    const merge = nextDelivery();
    await fromGitlab(merged, { delivery: merge });
    expect((await settled(gitlab.id, merge)).status).toBe('processed');
    expect(await metaOf(artifactId)).toMatchObject({ state: 'merged' });
    expect(await taskStatus(taskId)).toBe('done');
  });

  it('ignores a pipeline of a branch without a merge request', async () => {
    const body = fixture('gitlab-pipeline');
    delete body.merge_request;
    const delivery = nextDelivery();
    expect((await fromGitlab(body, { delivery })).statusCode).toBe(202);
    expect((await rowsOf(gitlab.id, delivery))[0]?.status).toBe('ignored');
  });
});

describe('parseWebhook', () => {
  const gh = codeHostFor({ kind: 'github' }, 'token');
  const gl = codeHostFor({ kind: 'gitlab', baseUrl: 'https://gitlab.example.com' }, 'token');

  it('reads a workflow run, a draft and a closed pull request on GitHub', () => {
    const run = (status: string, conclusion: string | null) => ({
      repository: { id: 1, html_url: 'https://github.com/acme/api' },
      workflow_run: {
        status,
        conclusion,
        pull_requests: [{ number: 3, base: { repo: { id: 1 } } }],
      },
    });
    expect(gh.parseWebhook('workflow_run', run('in_progress', null))).toEqual({
      changeRequests: ['https://github.com/acme/api/pull/3'],
      update: { pipeline: 'running' },
    });
    const verdict = (conclusion: string) =>
      gh.parseWebhook('workflow_run', run('completed', conclusion))?.update.pipeline;
    expect(['success', 'neutral', 'skipped'].map(verdict)).toEqual([
      'success',
      'success',
      'success',
    ]);
    expect(['failure', 'cancelled', 'something_new'].map(verdict)).toEqual([
      'failed',
      'failed',
      'failed',
    ]);
    expect(verdict('stale')).toBe('none');
    const pull = (fields: object) => ({
      pull_request: { html_url: 'https://github.com/acme/api/pull/3', state: 'open', ...fields },
    });
    expect(gh.parseWebhook('pull_request', pull({ draft: true }))?.update).toEqual({
      state: 'draft',
    });
    expect(
      gh.parseWebhook('pull_request', pull({ state: 'closed', merged_at: null }))?.update,
    ).toEqual({ state: 'closed' });
    expect(gh.parseWebhook('pull_request', { pull_request: { state: 'open' } })).toBeNull();
    expect(gl.parseWebhook('Push Hook', { object_kind: 'push' })).toBeNull();
  });

  it('leaves out a pull request of another repository that a check suite lists', () => {
    // A fork's suite names the upstream's pull request: its base is not this repository, and
    // the same number here is someone else's.
    const body = fixture('github-check_suite');
    const suite = body.check_suite as { pull_requests: { base: { repo: { id: number } } }[] };
    const upstream = structuredClone(suite.pull_requests[0]!);
    upstream.base.repo.id = 5550001;
    suite.pull_requests.push(upstream);
    expect(gh.parseWebhook('check_suite', body)?.changeRequests).toEqual([
      'https://github.com/acme/api/pull/42',
    ]);
    suite.pull_requests.splice(0, 1);
    expect(gh.parseWebhook('check_suite', body)).toBeNull();
  });

  it('reads an approval on GitLab', () => {
    const body = fixture('gitlab-merge_request');
    Object.assign(body.object_attributes as object, { action: 'approved' });
    expect(gl.parseWebhook('Merge Request Hook', body)).toEqual({
      changeRequests: ['https://gitlab.example.com/platform/payments/-/merge_requests/7'],
      update: { state: 'open', review: 'approved' },
      // Who approved: the connection's own account would start nothing.
      actor: 'agent-bot',
    });
  });
});
