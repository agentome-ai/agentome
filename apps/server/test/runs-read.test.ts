import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { priceUsage } from '@agentome/costs';
import {
  agentGrants,
  agents,
  createDb,
  type Db,
  eq,
  migrate,
  runEvents,
  runs,
  sessions,
  sql,
  tasks,
} from '@agentome/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { LaunchPackage } from '../src/protocol.js';
import { streamRun } from '../src/runs/read.js';
import { enqueueRun } from '../src/runs/service.js';
import { licenseEnterprise, setupCodeIn } from './app.js';

// The runs from the side of the people who read them: the
// list, one run, its transcript and the stream, against the real server and database. Runs
// get their events, artifacts and usage through the seat protocol, as on a computer.

let container: StartedPostgreSqlContainer;
let app: Awaited<ReturnType<typeof buildApp>>;
let db: Db;
let dataDir: string;
let config: ReturnType<typeof loadConfig>;
let adminCookie = '';

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  dataDir = mkdtempSync(join(tmpdir(), 'agentome-runs-'));
  await migrate(container.getConnectionUri());
  config = loadConfig({
    AGENTOME_DATABASE_URL: container.getConnectionUri(),
    AGENTOME_DATA_DIR: dataDir,
    AGENTOME_LOG_LEVEL: 'silent',
  });
  app = await buildApp(config);
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

let people = 0;

/** A member who joined by invitation, with the cookie of their session. */
async function person() {
  people += 1;
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
    payload: {
      name: `Person ${people}`,
      email: `reader${people}@example.com`,
      password: 'a long enough password',
    },
  });
  if (accepted.statusCode !== 201) throw new Error(`no person: ${accepted.body}`);
  const user = accepted.json<{ id: string; email: string; name: string }>();
  return { ...user, cookie: cookieOf(accepted) };
}

/** An agent with its owner grant and a task, the way tasks 6 and 7 make them. */
async function agentWithTask(ownerId: string, name = 'Backend developer') {
  const [agent] = await db
    .insert(agents)
    .values({ ownerUserId: ownerId, name, roleTitle: 'Engineer' })
    .returning();
  if (!agent) throw new Error('no agent');
  await db.insert(agentGrants).values({ agentId: agent.id, userId: ownerId, level: 'owner' });
  const [task] = await db
    .insert(tasks)
    .values({ agentId: agent.id, title: 'Add a README', source: 'manual', createdBy: ownerId })
    .returning();
  if (!task) throw new Error('no task');
  return { agent, task };
}

type Owner = Awaited<ReturnType<typeof person>>;

/** A run of the owner's agent, claimed by a computer of theirs: its id and run token. */
async function runningRun(owner: Owner, taskId: string) {
  const run = await enqueueRun(db, taskId, owner.id);
  const code = await app.inject({
    method: 'POST',
    url: '/api/seats/pairing-codes',
    headers: { cookie: owner.cookie },
  });
  const pair = await app.inject({
    method: 'POST',
    url: '/api/seats/pair',
    payload: {
      code: code.json<{ code: string }>().code,
      name: 'maria-mbp',
      kind: 'subscription-laptop',
      engines: ['claude-code'],
    },
  });
  const seatToken = pair.json<{ token: string }>().token;
  const claim = await app.inject({
    method: 'GET',
    url: '/api/seats/claim?wait=0',
    headers: { authorization: `Bearer ${seatToken}` },
  });
  const launch = LaunchPackage.parse(claim.json());
  expect(launch.run.id).toBe(run.id);
  return { runId: run.id, token: launch.run.token };
}

const seatPost = (runId: string, action: string, token: string, payload?: unknown) =>
  app.inject({
    method: 'POST',
    url: `/api/runs/${runId}/${action}`,
    headers: { authorization: `Bearer ${token}` },
    payload: payload as object,
  });

/** A row of the usage a seat sends with finish: the same 300 out, 5000 and 800 cache each time. */
const usageRow = (model: string, tokensIn: number) => ({
  provider: 'anthropic',
  model,
  tokensIn,
  tokensOut: 300,
  tokensCacheRead: 5000,
  tokensCacheWrite: 800,
  source: 'stream-json',
});

/**
 * What the price table says a row costs. The arithmetic is tested in packages/costs; what is
 * tested here is that finish prices the row it was sent. A model gone from the table would make
 * both sides null and the test pass for nothing, hence the throw.
 */
function priceOf(row: ReturnType<typeof usageRow>): string {
  const { usd } = priceUsage({ ...row, tokensCacheWrite1h: 0 });
  if (usd === null) throw new Error(`${row.model} has no price in packages/costs/prices.json`);
  return usd;
}

/** Amounts of dollars with six places added up in whole microdollars, as a string again. */
function addUsd(...amounts: string[]): string {
  const micros = amounts.reduce((sum, usd) => sum + BigInt(usd.replace('.', '')), 0n);
  return `${micros / 1_000_000n}.${String(micros % 1_000_000n).padStart(6, '0')}`;
}

/** A RunEvent on the wire: the envelope apart, the rest in payload. */
const wire = (seq: number, type: string, payload: object) => ({
  seq,
  type,
  payload,
  at: new Date(Date.UTC(2026, 9, 21, 10, 0, seq)).toISOString(),
});

const get = (url: string, cookie: string) =>
  app.inject({ method: 'GET', url, headers: { cookie } });

describe('GET /api/runs', () => {
  it("lists the runs of one's own agents, newest first, and every run to an admin who asks", async () => {
    const owner = await person();
    const other = await person();
    const { agent, task } = await agentWithTask(owner.id);
    const theirs = await agentWithTask(other.id, 'Reviewer');
    // Claimed first: a claim takes the oldest queued run.
    const { runId } = await runningRun(owner, task.id);
    const queued = await enqueueRun(db, task.id, owner.id);
    const foreign = await enqueueRun(db, theirs.task.id, other.id);

    const response = await get('/api/runs', owner.cookie);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const list = response.json<{ runs: { id: string }[]; nextBefore: string | null }>();
    expect(list.runs.map((run) => run.id)).toEqual([queued.id, runId]);
    expect(list.nextBefore).toBeNull();
    expect(list.runs[1]).toMatchObject({
      status: 'running',
      agent: { id: agent.id, name: 'Backend developer' },
      task: { id: task.id, title: 'Add a README' },
      seat: { name: 'maria-mbp' },
      startedBy: { kind: 'user', user: { id: owner.id, name: owner.name } },
      endedAt: null,
      errorCode: null,
      cost: { usd: null, tokens: 0 },
    });
    expect(list.runs[0]).toMatchObject({ status: 'queued', seat: null, startedAt: null });

    const ids = async (url: string, cookie: string) =>
      (await get(url, cookie)).json<{ runs: { id: string }[] }>().runs.map((run) => run.id);
    expect(await ids('/api/runs', other.cookie)).toEqual([foreign.id]);
    // An admin holds no grant on these agents: only all=true shows them.
    expect(await ids('/api/runs', adminCookie)).toEqual([]);
    expect(await ids('/api/runs?all=true', adminCookie)).toEqual(
      expect.arrayContaining([runId, queued.id, foreign.id]),
    );
    const refused = await get('/api/runs?all=true', owner.cookie);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: { code: 'forbidden' } });
    expect((await app.inject({ method: 'GET', url: '/api/runs' })).statusCode).toBe(401);
  });

  it('filters by agent, task and status, and pages by createdAt', async () => {
    const owner = await person();
    const one = await agentWithTask(owner.id);
    const two = await agentWithTask(owner.id, 'Analyst');
    const made = [];
    for (let i = 0; i < 4; i += 1) made.push((await enqueueRun(db, one.task.id, owner.id)).id);
    const analyst = await enqueueRun(db, two.task.id, owner.id);
    await db
      .update(runs)
      .set({ status: 'failed' })
      .where(eq(runs.id, made[0] ?? ''));

    type Page = { runs: { id: string; createdAt: string }[]; nextBefore: string | null };
    const page = async (url: string) => (await get(url, owner.cookie)).json<Page>();
    expect((await page(`/api/runs?agent=${two.agent.id}`)).runs.map((run) => run.id)).toEqual([
      analyst.id,
    ]);
    expect((await page(`/api/runs?task=${one.task.id}&status=failed`)).runs).toMatchObject([
      { id: made[0] },
    ]);
    // Live is every run not over yet: the queued ones here, not the failed one.
    expect(
      (await page(`/api/runs?task=${one.task.id}&status=live`)).runs.map((run) => run.id),
    ).toEqual([made[3], made[2], made[1]]);

    const first = await page(`/api/runs?agent=${one.agent.id}&limit=3`);
    expect(first.runs.map((run) => run.id)).toEqual([made[3], made[2], made[1]]);
    // Microseconds, so that runs made within one millisecond still page apart.
    expect(first.nextBefore).toMatch(/\.\d{6}Z$/);
    expect(first.nextBefore).toBe(first.runs[2]?.createdAt);
    const rest = await page(
      `/api/runs?agent=${one.agent.id}&limit=3&before=${encodeURIComponent(first.nextBefore ?? '')}`,
    );
    expect(rest).toEqual({ runs: [expect.objectContaining({ id: made[0] })], nextBefore: null });

    const invalid = await get('/api/runs?status=paused&limit=500', owner.cookie);
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { code: 'validation_failed' } });
  });
});

describe('GET /api/runs/:id', () => {
  it('describes a finished run with its artifacts and its cost by model', async () => {
    const owner = await person();
    const { agent, task } = await agentWithTask(owner.id);
    const { runId, token } = await runningRun(owner, task.id);
    const finish = await seatPost(runId, 'finish', token, {
      status: 'done',
      summary: 'Added README.md',
      artifacts: [
        { kind: 'report', ref: 'result', meta: { text: 'Added **README.md**' } },
        {
          kind: 'branch',
          ref: 'agent/readme',
          meta: { commits: [{ sha: 'a1b2c3d', subject: 'Add' }] },
        },
      ],
      // Finish prices what the table knows; the made-up model stays without a price.
      usage: [usageRow('claude-sonnet-5-5', 1200), usageRow('claude-made-up', 100)],
    });
    expect(finish.statusCode).toBe(200);

    const response = await get(`/api/runs/${runId}`, owner.cookie);
    expect(response.statusCode).toBe(200);
    const run = response.json();
    expect(run).toMatchObject({
      id: runId,
      status: 'done',
      agent: { id: agent.id, name: 'Backend developer' },
      task: { id: task.id, title: 'Add a README' },
      seat: { name: 'maria-mbp' },
      limits: { maxMinutes: 60, maxTurns: 50, maxTokens: 2_000_000 },
      cancelRequestedAt: null,
      summary: 'Added README.md',
      // In the order of their kinds: they came in one finish.
      artifacts: [
        { kind: 'branch', ref: 'agent/readme', meta: { commits: [{ sha: 'a1b2c3d' }] } },
        { kind: 'report', ref: 'result', meta: { text: 'Added **README.md**' } },
      ],
      cost: {
        rows: [
          { model: 'claude-made-up', tokensIn: 100, tokensOut: 300, usd: null },
          {
            model: 'claude-sonnet-5-5',
            tokensIn: 1200,
            tokensOut: 300,
            tokensCacheRead: 5000,
            tokensCacheWrite: 800,
            usd: priceOf(usageRow('claude-sonnet-5-5', 1200)),
          },
        ],
        totalUsd: priceOf(usageRow('claude-sonnet-5-5', 1200)),
        unpriced: true,
      },
    });
    expect(run.startedAt).toEqual(expect.any(String));
    expect(run.endedAt).toEqual(expect.any(String));

    const listed = (await get(`/api/runs?task=${task.id}`, owner.cookie)).json();
    expect(listed.runs[0].cost).toEqual({
      usd: priceOf(usageRow('claude-sonnet-5-5', 1200)),
      tokens: 1200 + 100 + 2 * 6100,
    });
  });

  it('totals the models of a run, and has no total for a run that nothing could price', async () => {
    const owner = await person();
    const { task } = await agentWithTask(owner.id);
    const finishWith = async (...rows: ReturnType<typeof usageRow>[]) => {
      const { runId, token } = await runningRun(owner, task.id);
      await seatPost(runId, 'finish', token, { status: 'done', usage: rows });
      return (await get(`/api/runs/${runId}`, owner.cookie)).json();
    };

    const [sonnet, opus] = [usageRow('claude-sonnet-5-5', 1200), usageRow('claude-opus-5-5', 1000)];
    const total = addUsd(priceOf(sonnet), priceOf(opus));
    const run = await finishWith(sonnet, opus);
    // Listed by model name, opus first.
    const usds = run.cost.rows.map((row: { usd: string }) => row.usd);
    expect(usds).toEqual([priceOf(opus), priceOf(sonnet)]);
    expect(run.cost).toMatchObject({ totalUsd: total, unpriced: false });

    const unpriced = await finishWith(usageRow('claude-made-up', 100));
    expect(unpriced.cost).toMatchObject({ totalUsd: null, unpriced: true });
    const listed = (await get(`/api/runs?task=${task.id}`, owner.cookie)).json();
    expect(listed.runs.map((item: { cost: object }) => item.cost)).toEqual([
      { usd: null, tokens: 100 + 6100 },
      { usd: total, tokens: 1200 + 1000 + 2 * 6100 },
    ]);
  });

  it("is not found for someone else's run, unless an admin asks for all", async () => {
    const owner = await person();
    const { task } = await agentWithTask(owner.id);
    const run = await enqueueRun(db, task.id, owner.id);
    const stranger = await person();
    for (const path of ['', '/events', '/stream']) {
      const response = await get(`/api/runs/${run.id}${path}`, stranger.cookie);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'not_found' } });
    }
    expect((await get(`/api/runs/${run.id}`, adminCookie)).statusCode).toBe(404);
    const admin = await get(`/api/runs/${run.id}?all=true`, adminCookie);
    expect(admin.json()).toMatchObject({ id: run.id, status: 'queued', cost: { rows: [] } });
    expect((await get(`/api/runs/${run.id}?all=true`, stranger.cookie)).statusCode).toBe(403);
  });
});

describe('GET /api/runs/:id/events', () => {
  it('reads the transcript after a seq and keeps an event that is not one', async () => {
    const owner = await person();
    const { task } = await agentWithTask(owner.id);
    const { runId, token } = await runningRun(owner, task.id);
    await seatPost(runId, 'events', token, [
      wire(0, 'started', { model: 'claude-sonnet-5' }),
      wire(1, 'assistant_message', { text: 'Reading the repository.' }),
      wire(2, 'tool_use', { name: 'Read', input: { file_path: 'README.md' } }),
      wire(3, 'tool_result', { toolUseId: 'toolu_1', output: 'No such file', isError: true }),
    ]);

    const response = await get(`/api/runs/${runId}/events?after=0`, owner.cookie);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      events: [
        {
          seq: 1,
          type: 'assistant_message',
          text: 'Reading the repository.',
          at: wire(1, '', {}).at,
        },
        {
          // A tool_use without its id: kept as it was stored, not dropped.
          seq: 2,
          type: 'unknown',
          rawType: 'unparsed',
          raw: { type: 'tool_use', payload: { name: 'Read', input: { file_path: 'README.md' } } },
          at: wire(2, '', {}).at,
        },
        {
          seq: 3,
          type: 'tool_result',
          toolUseId: 'toolu_1',
          output: 'No such file',
          isError: true,
          at: wire(3, '', {}).at,
        },
      ],
      nextAfter: null,
    });
    const all = (await get(`/api/runs/${runId}/events`, owner.cookie)).json();
    expect(all.events[0]).toMatchObject({ seq: 0, type: 'started', model: 'claude-sonnet-5' });
  });

  it('answers at most 1000 events, with the seq to continue after', async () => {
    const owner = await person();
    const { task } = await agentWithTask(owner.id);
    const run = await enqueueRun(db, task.id, owner.id);
    await db.insert(runEvents).values(
      Array.from({ length: 1001 }, (_, seq) => ({
        runId: run.id,
        seq,
        type: 'assistant_message',
        payload: { text: `line ${seq}` },
      })),
    );
    const first = (await get(`/api/runs/${run.id}/events`, owner.cookie)).json();
    expect(first.events).toHaveLength(1000);
    expect(first.nextAfter).toBe(999);
    const second = (await get(`/api/runs/${run.id}/events?after=999`, owner.cookie)).json();
    expect(second).toMatchObject({ events: [{ seq: 1000, text: 'line 1000' }], nextAfter: null });
  });
});

/** The events of an SSE body, as `[event name, parsed data]`. */
function parseSse(body: string): [string, unknown][] {
  return body
    .split('\n\n')
    .filter((block) => block.startsWith('event: '))
    .map((block) => {
      const [name = '', data = ''] = block.split('\n').map((line) => line.replace(/^\w+: /, ''));
      return [name, JSON.parse(data)];
    });
}

describe('GET /api/runs/:id/stream', () => {
  it('sends the transcript of an ended run, its final status, and closes', async () => {
    const owner = await person();
    const { task } = await agentWithTask(owner.id);
    const { runId, token } = await runningRun(owner, task.id);
    await seatPost(runId, 'events', token, [
      wire(0, 'assistant_message', { text: 'Done.' }),
      wire(1, 'result', { text: 'Done.', isError: false }),
    ]);
    await seatPost(runId, 'finish', token, { status: 'done' });

    const response = await get(`/api/runs/${runId}/stream?after=0`, owner.cookie);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(parseSse(response.body)).toEqual([
      ['run', { seq: 1, type: 'result', text: 'Done.', isError: false, at: wire(1, '', {}).at }],
      ['status', { status: 'done' }],
    ]);

    // A session past half its life is extended on the stream too, and its new cookie arrives.
    await db
      .update(sessions)
      .set({ expiresAt: sql`now() + interval '2 days'` })
      .where(eq(sessions.userId, owner.id));
    const refreshed = await get(`/api/runs/${runId}/stream?after=1`, owner.cookie);
    expect(String(refreshed.headers['set-cookie'])).toMatch(/^agentome\.session_token=/);
    expect(parseSse(refreshed.body)).toEqual([['status', { status: 'done' }]]);
  });

  it('follows a live run until it ends', async () => {
    const owner = await person();
    const { task } = await agentWithTask(owner.id);
    const { runId, token } = await runningRun(owner, task.id);
    await seatPost(runId, 'events', token, [wire(0, 'started', {})]);
    const server = await buildApp(config);
    const address = await server.listen({ host: '127.0.0.1', port: 0 });
    try {
      const response = await fetch(`${address}/api/runs/${runId}/stream`, {
        headers: { cookie: owner.cookie },
      });
      expect(response.status).toBe(200);
      const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();
      if (!reader) throw new Error('no body');
      let body = '';
      const readUntil = async (text: string) => {
        while (!body.includes(text)) {
          const { value, done } = await reader.read();
          if (done) throw new Error(`the stream ended before ${text}: ${body}`);
          body += value;
        }
      };
      await readUntil('"status":"running"');
      expect(parseSse(body).map(([name]) => name)).toEqual(['run', 'status']);

      await seatPost(runId, 'events', token, [wire(1, 'assistant_message', { text: 'Live.' })]);
      await readUntil('Live.');
      await seatPost(runId, 'finish', token, { status: 'failed', errorCode: 'time_limit' });
      await readUntil('"status":"failed"');
      const { done } = await reader.read();
      expect(done).toBe(true);
      expect(parseSse(body).map(([name, data]) => [name, (data as { seq?: number }).seq])).toEqual([
        ['run', 0],
        ['status', undefined],
        ['run', 1],
        ['status', undefined],
      ]);
    } finally {
      await server.close();
    }
  }, 20_000);

  it('keeps a quiet stream alive with comments, and stops when told to', async () => {
    const owner = await person();
    const { task } = await agentWithTask(owner.id);
    const { runId } = await runningRun(owner, task.id);
    const chunks: string[] = [];
    const stop = new AbortController();
    const streaming = streamRun(
      db,
      runId,
      -1,
      async (chunk) => {
        chunks.push(chunk);
      },
      stop.signal,
      { pollMs: 10, keepaliveMs: 50 },
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    stop.abort();
    await streaming;
    expect(chunks[0]).toBe('event: status\ndata: {"status":"running"}\n\n');
    expect(chunks.filter((chunk) => chunk === ': keepalive\n\n').length).toBeGreaterThanOrEqual(2);
  });

  it('lets the server stop while a stream is open', async () => {
    const owner = await person();
    const { task } = await agentWithTask(owner.id);
    const run = await enqueueRun(db, task.id, owner.id);
    const server = await buildApp(config);
    const address = await server.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${address}/api/runs/${run.id}/stream`, {
      headers: { cookie: owner.cookie },
    });
    const reader = response.body?.getReader();
    await reader?.read();
    const started = Date.now();
    await server.close();
    expect(Date.now() - started).toBeLessThan(3000);
    // Drained to the end: the server closed the stream rather than leaving it open.
    while (!(await reader?.read())?.done);
  }, 20_000);
});

describe('the OpenAPI document', () => {
  it('describes the routes that read runs', async () => {
    const document = (await app.inject({ method: 'GET', url: '/openapi.json' })).json<{
      paths: Record<string, Record<string, unknown>>;
    }>();
    expect(Object.keys(document.paths['/api/runs'] ?? {})).toEqual(['get']);
    for (const path of ['/api/runs/{id}', '/api/runs/{id}/stream']) {
      expect(document.paths[path]).toHaveProperty('get');
    }
    expect(Object.keys(document.paths['/api/runs/{id}/events'] ?? {}).sort()).toEqual([
      'get',
      'post',
    ]);
  });
});
