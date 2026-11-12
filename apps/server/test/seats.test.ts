import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { priceUsage } from '@agentome/costs';
import {
  agentGrants,
  agents,
  costEvents,
  createDb,
  type Db,
  migrate,
  pairingCodes,
  runArtifacts,
  runEvents,
  runs,
  seats,
  tasks,
  toolCalls,
  users,
} from '@agentome/db';
import { foldRunStatus, RunEvent } from '@agentome/shared';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { LaunchPackage } from '../src/protocol.js';
import { createJobs } from '../src/jobs.js';
import { claimRun, enqueueRun, isWorking, reapOrphanedRuns } from '../src/runs/service.js';
import { hashSecret } from '../src/tokens.js';
import { setupCodeIn } from './app.js';

// The seat protocol from the seat's side: a fake seat pairs, claims, reports
// and finishes against the real server and database.

let container: StartedPostgreSqlContainer;
let app: Awaited<ReturnType<typeof buildApp>>;
let db: Db;
let dataDir: string;
let config: ReturnType<typeof loadConfig>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  dataDir = mkdtempSync(join(tmpdir(), 'agentome-seats-'));
  await migrate(container.getConnectionUri());
  config = loadConfig({
    AGENTOME_DATABASE_URL: container.getConnectionUri(),
    AGENTOME_DATA_DIR: dataDir,
    AGENTOME_LOG_LEVEL: 'silent',
    AGENTOME_PUBLIC_URL: 'https://agentome.example.com',
  });
  // A server run from a checkout has no worker bundle to hand out.
  app = await buildApp(config, { workerBundle: join(dataDir, 'no-bundle.mjs') });
  db = createDb(container.getConnectionUri(), () => {});
  // People sign in: the setup makes an admin, who invites everyone else.
  const setup = await app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: {
      code: setupCodeIn(dataDir),
      orgName: 'Acme',
      admin: { name: 'Admin', email: 'admin@example.com', password: 'the admin password' },
    },
  });
  adminCookie = cookieOf(setup);
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.$client.end();
  await container?.stop();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

/** The Cookie header a browser would send back after this response. */
function cookieOf(response: LightMyRequestResponse): string {
  const setCookie = response.headers['set-cookie'] ?? [];
  return (Array.isArray(setCookie) ? setCookie : [setCookie])
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');
}

let adminCookie = '';
const sessions = new Map<string, string>();
let people = 0;

/** A person who joined by invitation, signed in: asUser(email) sends their session. */
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
      email: `person${people}@example.com`,
      password: 'a long enough password',
    },
  });
  if (accepted.statusCode !== 201) throw new Error(`no person: ${accepted.body}`);
  const user = accepted.json<{ id: string; email: string; name: string }>();
  sessions.set(user.email, cookieOf(accepted));
  return user;
}

/** An agent with its owner grant, and a task for it, the way the app makes them. */
async function agentWithTask(ownerId: string, budget: unknown = null) {
  const [agent] = await db
    .insert(agents)
    .values({ ownerUserId: ownerId, name: 'Backend developer', roleTitle: 'Engineer', budget })
    .returning();
  if (!agent) throw new Error('no agent');
  await db.insert(agentGrants).values({ agentId: agent.id, userId: ownerId, level: 'owner' });
  const [task] = await db
    .insert(tasks)
    .values({
      agentId: agent.id,
      title: 'Add a README',
      source: 'manual',
      createdBy: ownerId,
      repository: 'https://example.com/test.git',
    })
    .returning();
  if (!task) throw new Error('no task');
  return { agent, task };
}

/** What a seat reports for a model in these tests: the same four counts each time. */
const TOKENS = { tokensIn: 1200, tokensOut: 300, tokensCacheRead: 5000, tokensCacheWrite: 800 };

/**
 * What the price table says these tokens cost on a model. The arithmetic is tested in
 * packages/costs; what is tested here is that finish prices the rows it was sent. A model gone
 * from the table would make both sides null and the test pass for nothing, hence the throw.
 */
function priceOf(model: string, tokensCacheWrite1h = 0): string {
  const { usd } = priceUsage({ model, ...TOKENS, tokensCacheWrite1h });
  if (usd === null) throw new Error(`${model} has no price in packages/costs/prices.json`);
  return usd;
}

const asUser = (email: string) => ({ cookie: sessions.get(email) ?? '' });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const seatBody = {
  name: 'maria-mbp',
  kind: 'subscription-laptop',
  engines: ['claude-code'],
  capabilities: { sandbox: true },
};

async function newCode(email: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/seats/pairing-codes',
    headers: asUser(email),
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ code: string; expiresAt: string; command: string; checkout: boolean }>();
}

async function pairSeat(email: string) {
  const { code } = await newCode(email);
  const response = await app.inject({
    method: 'POST',
    url: '/api/seats/pair',
    payload: { ...seatBody, code },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ seatId: string; token: string }>();
}

async function claim(seatToken: string, wait = 0) {
  return app.inject({
    method: 'GET',
    url: `/api/seats/claim?wait=${wait}`,
    headers: bearer(seatToken),
  });
}

/** A seat that has claimed a run of its owner's agent. */
async function runningRun() {
  const owner = await person();
  const { agent, task } = await agentWithTask(owner.id);
  const run = await enqueueRun(db, task.id, owner.id);
  const seat = await pairSeat(owner.email);
  const response = await claim(seat.token);
  expect(response.statusCode).toBe(200);
  const launch = LaunchPackage.parse(response.json());
  return { owner, agent, task, seat, runId: run.id, runToken: launch.run.token };
}

const runPost = (runId: string, action: string, token: string, payload?: object) =>
  app.inject({
    method: 'POST',
    url: `/api/runs/${runId}/${action}`,
    headers: bearer(token),
    payload,
  });

const event = (seq: number, type = 'assistant_message') => ({
  seq,
  type,
  payload: { text: `event ${seq}` },
  at: new Date(Date.UTC(2026, 9, 21, 10, 0, seq)).toISOString(),
});

async function runRow(runId: string) {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!run) throw new Error('no run');
  return run;
}

describe('pairing', () => {
  it('turns a code into a seat of the code owner, keeping only hashes', async () => {
    const owner = await person();
    const { code, expiresAt, command, checkout } = await newCode(owner.email);
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(new Date(expiresAt).getTime() - Date.now()).toBeGreaterThan(9 * 60_000);
    // Without a bundle to serve at /connect, the command runs the worker from a checkout.
    expect(command).toBe(
      `pnpm --filter @agentome/worker connect ${code} --server https://agentome.example.com`,
    );
    expect(checkout).toBe(true);

    // Typed by hand: lower case, a space instead of the dash.
    const typed = code.toLowerCase().replace('-', ' ');
    const response = await app.inject({
      method: 'POST',
      url: '/api/seats/pair',
      payload: { ...seatBody, code: typed },
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    const { seatId, token } = response.json<{ seatId: string; token: string }>();
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);

    const [seat] = await db.select().from(seats).where(eq(seats.id, seatId));
    expect(seat).toMatchObject({
      ownerUserId: owner.id,
      name: 'maria-mbp',
      kind: 'subscription-laptop',
      engines: ['claude-code'],
      capabilities: { sandbox: true },
      tokenHash: hashSecret(token),
      status: 'active',
    });
    const [stored] = await db
      .select()
      .from(pairingCodes)
      .where(eq(pairingCodes.codeHash, hashSecret(code)));
    expect(stored?.usedAt).toBeInstanceOf(Date);
  });

  it('refuses a code that was used, never existed or expired', async () => {
    const owner = await person();
    const { code } = await newCode(owner.email);
    const pair = (value: string) =>
      app.inject({ method: 'POST', url: '/api/seats/pair', payload: { ...seatBody, code: value } });
    expect((await pair(code)).statusCode).toBe(201);

    const again = await pair(code);
    expect(again.statusCode).toBe(400);
    expect(again.json()).toMatchObject({ error: { code: 'pairing_code_invalid' } });
    expect((await pair('AAAA-AAAA')).json()).toMatchObject({
      error: { code: 'pairing_code_invalid' },
    });

    const late = await newCode(owner.email);
    await db
      .update(pairingCodes)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(pairingCodes.codeHash, hashSecret(late.code)));
    const expired = await pair(late.code);
    expect(expired.statusCode).toBe(400);
    expect(expired.json()).toMatchObject({ error: { code: 'pairing_code_expired' } });
  });

  it('makes codes only for a signed-in person', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/seats/pairing-codes' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'unauthorized' } });
    const stranger = await app.inject({
      method: 'POST',
      url: '/api/seats/pairing-codes',
      headers: asUser('nobody@example.com'),
    });
    expect(stranger.statusCode).toBe(401);
    // The stand-in's development header is gone: only a session counts, from anywhere.
    const forged = await app.inject({
      method: 'POST',
      url: '/api/seats/pairing-codes',
      headers: { 'x-agentome-dev-user': (await person()).email },
      remoteAddress: '127.0.0.1',
    });
    expect(forged.statusCode).toBe(401);
  });
});

describe('claim', () => {
  it('answers 204 when the wait passes with nothing to run', async () => {
    const seat = await pairSeat((await person()).email);
    const started = Date.now();
    const response = await claim(seat.token, 1);
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it('hands the oldest queued run of the owner to the seat with a launch package', async () => {
    const owner = await person();
    const { agent, task } = await agentWithTask(owner.id, { maxTurns: 80 });
    const first = await enqueueRun(db, task.id, owner.id);
    await enqueueRun(db, task.id, owner.id);
    const seat = await pairSeat(owner.email);

    const response = await claim(seat.token);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const launch = LaunchPackage.parse(response.json());
    expect(launch.run).toEqual({
      id: first.id,
      token: expect.any(String),
      limits: { maxMinutes: 60, maxTurns: 80, maxTokens: 2_000_000 },
    });
    expect(launch.agent).toMatchObject({ id: agent.id, name: 'Backend developer', skills: [] });
    expect(launch.task).toEqual({
      id: task.id,
      title: 'Add a README',
      body: '',
      repository: 'https://example.com/test.git',
    });
    expect(launch.workspace.profile.claudeMd).toContain('# Backend developer');
    expect(launch.workspace.profile.settings.sandbox.network.allowedDomains).toEqual([
      'agentome.example.com',
    ]);

    const run = await runRow(first.id);
    expect(run).toMatchObject({
      status: 'running',
      seatId: seat.seatId,
      tokenHash: hashSecret(launch.run.token),
      limits: launch.run.limits,
    });
    expect(run.startedAt).toBeInstanceOf(Date);
    expect(run.lastHeartbeatAt).toBeInstanceOf(Date);
  });

  it('gives a seat one run at a time', async () => {
    const { seat, task, owner } = await runningRun();
    const waiting = await enqueueRun(db, task.id, owner.id);
    expect((await claim(seat.token)).statusCode).toBe(204);
    expect((await runRow(waiting.id)).status).toBe('queued');
  });

  it("never hands a seat the run of someone else's agent", async () => {
    const owner = await person();
    const { task } = await agentWithTask(owner.id);
    const run = await enqueueRun(db, task.id, owner.id);
    const otherSeat = await pairSeat((await person()).email);
    expect((await claim(otherSeat.token)).statusCode).toBe(204);
    expect((await runRow(run.id)).status).toBe('queued');
  });

  it('leaves the runs of an archived agent in the queue', async () => {
    const owner = await person();
    const { agent, task } = await agentWithTask(owner.id);
    const run = await enqueueRun(db, task.id, owner.id);
    await db.update(agents).set({ status: 'archived' }).where(eq(agents.id, agent.id));
    expect((await claim((await pairSeat(owner.email)).token)).statusCode).toBe(204);
    expect((await runRow(run.id)).status).toBe('queued');
  });

  it('stops serving the computers of a disabled person', async () => {
    const owner = await person();
    const seat = await pairSeat(owner.email);
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, owner.id));
    expect((await claim(seat.token)).statusCode).toBe(401);
  });

  it('gives one seat claiming twice at once a single run', async () => {
    const owner = await person();
    const { task } = await agentWithTask(owner.id);
    await enqueueRun(db, task.id, owner.id);
    await enqueueRun(db, task.id, owner.id);
    const seat = await pairSeat(owner.email);
    const answers = await Promise.all([claim(seat.token), claim(seat.token)]);
    expect(answers.map((answer) => answer.statusCode).sort()).toEqual([200, 204]);
    const taken = await db.select().from(runs).where(eq(runs.seatId, seat.seatId));
    expect(taken).toHaveLength(1);
  });

  it('lets two seats racing for one run take it once', async () => {
    const owner = await person();
    const { task } = await agentWithTask(owner.id);
    await enqueueRun(db, task.id, owner.id);
    const [a, b] = [await pairSeat(owner.email), await pairSeat(owner.email)];
    const answers = await Promise.all([claim(a.token), claim(b.token)]);
    expect(answers.map((answer) => answer.statusCode).sort()).toEqual([200, 204]);
  });

  it('gives the one-line installer as the command of a server that has the bundle', async () => {
    const bundle = join(dataDir, 'agentome-worker.mjs');
    writeFileSync(bundle, 'export {};\n');
    const server = await buildApp(config, { workerBundle: bundle });
    const owner = await person();
    const response = await server.inject({
      method: 'POST',
      url: '/api/seats/pairing-codes',
      headers: asUser(owner.email),
    });
    const { code, command, checkout } = response.json<{
      code: string;
      command: string;
      checkout: boolean;
    }>();
    expect(command).toBe(`curl -fsSL https://agentome.example.com/connect | sh -s -- ${code}`);
    expect(checkout).toBe(false);
    await server.close();
  });

  it('says which computers run another worker than the one it hands out', async () => {
    const bundle = join(dataDir, 'agentome-worker.mjs');
    writeFileSync(bundle, 'export {};\n');
    const build = createHash('sha256').update('export {};\n').digest('hex');
    const server = await buildApp(config, { workerBundle: bundle });
    const owner = await person();
    const seat = await pairSeat(owner.email);
    const claimAs = (worker?: string) =>
      server.inject({
        method: 'GET',
        url: `/api/seats/claim?wait=0${worker === undefined ? '' : `&worker=${worker}`}`,
        headers: bearer(seat.token),
      });
    const command = async (from = server) => {
      const listed = await from.inject({
        method: 'GET',
        url: '/api/seats',
        headers: asUser(owner.email),
      });
      const views = listed.json<{ id: string; updateCommand: string | null }[]>();
      return views.find((view) => view.id === seat.seatId)?.updateCommand;
    };
    const update = 'curl -fsSL https://agentome.example.com/connect | sh -s -- update';

    // Nothing is known of a computer that has not claimed yet.
    expect(await command()).toBeNull();
    // A worker from before #548 names no build: it is older than any the server hands out.
    expect((await claimAs()).statusCode).toBe(204);
    expect(await command()).toBe(update);
    expect((await claimAs('f'.repeat(64))).statusCode).toBe(204);
    expect(await command()).toBe(update);
    // A server without the bundle has nothing to compare with.
    expect(await command(app)).toBeNull();
    // A server seat's worker comes in its image.
    await db.update(seats).set({ kind: 'api-server' }).where(eq(seats.id, seat.seatId));
    expect(await command()).toBe('docker compose --profile server-seat up -d');
    await db.update(seats).set({ kind: 'subscription-laptop' }).where(eq(seats.id, seat.seatId));

    expect((await claimAs(build)).statusCode).toBe(204);
    expect(await command()).toBeNull();
    // The worker went back to one that names no build.
    expect((await claimAs()).statusCode).toBe(204);
    expect(await command()).toBe(update);

    expect((await claimAs('not-a-build')).statusCode).toBe(400);
    await server.close();
  });

  it('keeps the runs of an engine that is not signed in on the seat in the queue', async () => {
    const owner = await person();
    const { agent, task } = await agentWithTask(owner.id);
    const run = await enqueueRun(db, task.id, owner.id);
    const seat = await pairSeat(owner.email);
    const claimAs = (signedOut?: string) =>
      app.inject({
        method: 'GET',
        url: `/api/seats/claim?wait=0${signedOut === undefined ? '' : `&signedOut=${signedOut}`}`,
        headers: bearer(seat.token),
      });
    const listed = async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/seats',
        headers: asUser(owner.email),
      });
      const views = response.json<{ id: string; signedOut: string[] }[]>();
      return views.find((view) => view.id === seat.seatId)?.signedOut;
    };

    expect(await listed()).toEqual([]);
    // Claude Code says it is signed out: its run stays queued, and the list says why.
    expect((await claimAs('claude-code')).statusCode).toBe(204);
    expect(await listed()).toEqual(['claude-code']);
    const [waiting] = await db
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, run.id));
    expect(waiting?.status).toBe('queued');
    // Signed in again: the worker names nothing, and the run goes out.
    const claimed = await claimAs();
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json<{ run: { id: string } }>().run.id).toBe(run.id);
    expect(await listed()).toEqual([]);

    expect((await claimAs('emacs')).statusCode).toBe(400);
    // These tests share one installation, which is Free: its agent does not stay to be counted.
    await db.update(agents).set({ status: 'archived' }).where(eq(agents.id, agent.id));
  });

  it('hands a Windows computer no run until an admin allows it to run without a sandbox', async () => {
    const owner = await person();
    const { agent, task } = await agentWithTask(owner.id);
    const run = await enqueueRun(db, task.id, owner.id);
    const seat = await pairSeat(owner.email);
    const claimOn = (platform: string) =>
      app.inject({
        method: 'GET',
        url: `/api/seats/claim?wait=0&platform=${platform}`,
        headers: bearer(seat.token),
      });
    type View = {
      id: string;
      platform: string | null;
      sandbox: { none: boolean; allowedAt: string | null };
    };
    const listed = async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/seats',
        headers: asUser(owner.email),
      });
      return response.json<View[]>().find((view) => view.id === seat.seatId);
    };
    const allow = (allowed: boolean, headers = { cookie: adminCookie }) =>
      app.inject({
        method: 'PUT',
        url: `/api/seats/${seat.seatId}/sandbox`,
        headers,
        payload: { allowed },
      });

    expect(await listed()).toMatchObject({
      platform: null,
      sandbox: { none: false, allowedAt: null },
    });
    // On Windows the run stays queued, and the worker is told why.
    const waiting = await claimOn('win32');
    expect(waiting.statusCode).toBe(204);
    expect(waiting.headers['x-agentome-waiting']).toBe('sandbox');
    expect(await listed()).toMatchObject({
      platform: 'win32',
      sandbox: { none: true, allowedAt: null },
    });
    expect((await runRow(run.id)).status).toBe('queued');

    // Only an admin decides; the owner of the computer cannot.
    expect((await allow(true, asUser(owner.email))).statusCode).toBe(403);
    const allowed = await allow(true);
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json<View>().sandbox.allowedAt).not.toBeNull();
    const claimed = await claimOn('win32');
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json<{ run: { id: string } }>().run.id).toBe(run.id);

    // Taken back: the run in progress is asked to stop, and nothing more is handed out.
    expect((await allow(false)).json<View>().sandbox.allowedAt).toBeNull();
    expect((await runRow(run.id)).cancelRequestedAt).not.toBeNull();
    expect((await claimOn('win32')).headers['x-agentome-waiting']).toBe('sandbox');
    // A claim that was waiting when the waiver went back gets no new run either.
    await db
      .update(runs)
      .set({ status: 'cancelled', endedAt: new Date() })
      .where(eq(runs.id, run.id));
    await enqueueRun(db, task.id, owner.id);
    const stale = await claimRun(
      db,
      {
        id: seat.seatId,
        ownerUserId: owner.id,
        kind: 'subscription-laptop',
        engines: ['claude-code'],
        idleMinutes: 15,
      },
      { limits: config.runLimits, publicUrl: config.publicUrl, secretKey: config.secretKey },
    );
    expect(stale).toBeNull();
    expect((await claimOn('linux')).headers['x-agentome-waiting']).toBeUndefined();
    expect((await claimOn('Windows NT')).statusCode).toBe(400);
    await db.update(agents).set({ status: 'archived' }).where(eq(agents.id, agent.id));
  });

  it('claims nothing for a seat that hung up, and lets the server stop mid-wait', async () => {
    const server = await buildApp(config);
    const address = await server.listen({ host: '127.0.0.1', port: 0 });
    const owner = await person();
    const seat = await pairSeat(owner.email);
    const hangUp = new AbortController();
    const gone = fetch(`${address}/api/seats/claim?wait=25`, {
      headers: bearer(seat.token),
      signal: hangUp.signal,
    }).catch(() => 'hung up');
    await new Promise((resolve) => setTimeout(resolve, 300));
    hangUp.abort();
    expect(await gone).toBe('hung up');
    const { task } = await agentWithTask(owner.id);
    const run = await enqueueRun(db, task.id, owner.id);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect((await runRow(run.id)).status).toBe('queued');

    await db.update(runs).set({ status: 'cancelled' }).where(eq(runs.id, run.id));
    const waiting = fetch(`${address}/api/seats/claim?wait=25`, { headers: bearer(seat.token) });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const started = Date.now();
    await server.close();
    expect(Date.now() - started).toBeLessThan(3000);
    expect((await waiting).status).toBe(204);
  }, 20_000);

  it('refuses a token that is not a seat', async () => {
    const response = await claim('x'.repeat(43));
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'unauthorized' } });
  });
});

describe('a running run', () => {
  it('stores events as they come and ignores a batch sent again', async () => {
    const { runId, runToken } = await runningRun();
    const first = await runPost(runId, 'events', runToken, [event(0), event(1)]);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ accepted: 2, cancelRequested: false });
    expect((await runPost(runId, 'events', runToken, [event(0), event(1)])).json()).toEqual({
      accepted: 0,
      cancelRequested: false,
    });
    expect(
      (await runPost(runId, 'events', runToken, [event(1), event(2, 'result')])).json(),
    ).toMatchObject({
      accepted: 1,
    });

    const stored = await db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .orderBy(asc(runEvents.seq));
    expect(stored.map(({ seq, type, payload }) => ({ seq, type, payload }))).toEqual([
      { seq: 0, type: 'assistant_message', payload: { text: 'event 0' } },
      { seq: 1, type: 'assistant_message', payload: { text: 'event 1' } },
      { seq: 2, type: 'result', payload: { text: 'event 2' } },
    ]);
    expect(stored[2]?.createdAt.toISOString()).toBe(event(2).at);
  });

  it('refuses an event that is not one', async () => {
    const { runId, runToken } = await runningRun();
    const response = await runPost(runId, 'events', runToken, [{ ...event(0), payload: [] }]);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'validation_failed' } });
  });

  it('learns about a cancel from its heartbeat and its events, then finishes as cancelled', async () => {
    const { runId, runToken, owner, seat } = await runningRun();
    const beat = await runPost(runId, 'heartbeat', runToken);
    expect(beat.statusCode).toBe(200);
    expect(beat.json()).toEqual({ cancelRequested: false, waitedMs: 0 });

    const stranger = await person();
    const refused = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/cancel`,
      headers: asUser(stranger.email),
    });
    expect(refused.statusCode).toBe(404);

    const cancel = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/cancel`,
      headers: asUser(owner.email),
    });
    expect(cancel.json()).toEqual({ status: 'running', cancelRequested: true });
    expect((await runPost(runId, 'heartbeat', runToken)).json()).toEqual({
      cancelRequested: true,
      waitedMs: 0,
    });
    expect((await runPost(runId, 'events', runToken, [event(0)])).json()).toEqual({
      accepted: 1,
      cancelRequested: true,
    });

    const finish = await runPost(runId, 'finish', runToken, { status: 'cancelled' });
    expect(finish.json()).toEqual({ status: 'cancelled' });
    const [seatRow] = await db.select().from(seats).where(eq(seats.id, seat.seatId));
    expect(seatRow?.lastSeenAt).toBeInstanceOf(Date);
  });

  it('is cancelled at once while it still waits in the queue', async () => {
    const owner = await person();
    const { task } = await agentWithTask(owner.id);
    const run = await enqueueRun(db, task.id, owner.id);
    const response = await app.inject({
      method: 'POST',
      url: `/api/runs/${run.id}/cancel`,
      headers: asUser(owner.email),
    });
    expect(response.json()).toEqual({ status: 'cancelled', cancelRequested: true });
    expect((await runRow(run.id)).endedAt).toBeInstanceOf(Date);
  });

  it('finishes with its artifacts and usage, and its token dies', async () => {
    const { runId, runToken, agent } = await runningRun();
    const response = await runPost(runId, 'finish', runToken, {
      status: 'done',
      summary: 'Added README.md',
      artifacts: [{ kind: 'branch', ref: 'agent/readme', meta: { commits: 1 } }],
      usage: [
        {
          provider: 'anthropic',
          model: 'claude-sonnet-5-5',
          ...TOKENS,
          source: 'stream-json',
        },
      ],
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'done' });

    const run = await runRow(runId);
    expect(run).toMatchObject({ status: 'done', summary: 'Added README.md', tokenHash: null });
    expect(run.endedAt).toBeInstanceOf(Date);
    const artifacts = await db.select().from(runArtifacts).where(eq(runArtifacts.runId, runId));
    expect(artifacts).toMatchObject([
      { kind: 'branch', ref: 'agent/readme', meta: { commits: 1 } },
    ]);
    const usage = await db.select().from(costEvents).where(eq(costEvents.runId, runId));
    expect(usage).toMatchObject([
      {
        agentId: agent.id,
        model: 'claude-sonnet-5-5',
        provider: 'anthropic',
        tokensIn: 1200,
        tokensCacheRead: 5000,
        source: 'stream-json',
        usd: priceOf('claude-sonnet-5-5'),
      },
    ]);

    for (const action of ['heartbeat', 'events', 'finish']) {
      const late = await runPost(
        runId,
        action,
        runToken,
        action === 'events' ? [] : { status: 'done' },
      );
      expect(late.statusCode).toBe(401);
    }
  });

  it('prices the usage it is sent, and leaves a model it cannot price without a price', async () => {
    const { runId, runToken } = await runningRun();
    const row = (model: string) => ({
      provider: 'anthropic',
      model,
      ...TOKENS,
      source: 'stream-json',
    });
    const response = await runPost(runId, 'finish', runToken, {
      status: 'done',
      usage: [
        // A seat reports tokens, not dollars: what it adds beyond them is dropped.
        { ...row('claude-sonnet-5-5'), usd: '999.000000' },
        row('claude-opus-5-5'),
        row('claude-made-up'),
      ],
    });
    expect(response.statusCode).toBe(200);

    const rows = await db.select().from(costEvents).where(eq(costEvents.runId, runId));
    const priced = Object.fromEntries(rows.map((item) => [item.model, item.usd]));
    expect(priced).toEqual({
      'claude-sonnet-5-5': priceOf('claude-sonnet-5-5'),
      'claude-opus-5-5': priceOf('claude-opus-5-5'),
      'claude-made-up': null,
    });
    // Each model at its own rates: one row cannot have borrowed the price of another.
    expect(priceOf('claude-opus-5-5')).not.toBe(priceOf('claude-sonnet-5-5'));
  });

  it('keeps and prices the hour-long cache writes, and takes a seat that sends none', async () => {
    const { runId, runToken } = await runningRun();
    const row = (model: string, extra: object) => ({
      provider: 'anthropic',
      model,
      ...TOKENS,
      ...extra,
      source: 'stream-json',
    });
    const response = await runPost(runId, 'finish', runToken, {
      status: 'done',
      usage: [row('claude-sonnet-5-5', { tokensCacheWrite1h: 800 }), row('claude-opus-5-5', {})],
    });
    expect(response.statusCode).toBe(200);

    const rows = await db.select().from(costEvents).where(eq(costEvents.runId, runId));
    const byModel = Object.fromEntries(rows.map((item) => [item.model, item]));
    expect(byModel['claude-sonnet-5-5']).toMatchObject({
      tokensCacheWrite1h: 800,
      usd: priceOf('claude-sonnet-5-5', 800),
    });
    // An older seat sends no split: its writes are priced for five minutes.
    expect(byModel['claude-opus-5-5']).toMatchObject({
      tokensCacheWrite1h: 0,
      usd: priceOf('claude-opus-5-5'),
    });
    expect(priceOf('claude-sonnet-5-5', 800)).not.toBe(priceOf('claude-sonnet-5-5'));
  });

  it('refuses more hour-long cache writes than cache writes', async () => {
    const { runId, runToken } = await runningRun();
    const response = await runPost(runId, 'finish', runToken, {
      status: 'done',
      usage: [
        {
          provider: 'anthropic',
          model: 'claude-sonnet-5-5',
          ...TOKENS,
          tokensCacheWrite1h: 801,
          source: 'stream-json',
        },
      ],
    });
    expect(response.statusCode).toBe(400);
    expect(await runRow(runId)).toMatchObject({ status: 'running' });
  });

  it('opens nothing with a token of another run', async () => {
    const one = await runningRun();
    const other = await runningRun();
    expect((await runPost(other.runId, 'heartbeat', one.runToken)).statusCode).toBe(401);
    expect((await runPost(one.runId, 'heartbeat', one.seat.token)).statusCode).toBe(401);
  });
});

describe('the reaper', () => {
  it('fails a run whose seat fell silent, after its last event', async () => {
    const quiet = await runningRun();
    const alive = await runningRun();
    await runPost(quiet.runId, 'events', quiet.runToken, [event(0), event(7)]);
    await db
      .update(runs)
      .set({ lastHeartbeatAt: sql`now() - interval '4 minutes'` })
      .where(eq(runs.id, quiet.runId));

    expect(await reapOrphanedRuns(db, 3)).toEqual([quiet.runId]);
    expect(await runRow(quiet.runId)).toMatchObject({
      status: 'failed',
      errorCode: 'orphaned',
      tokenHash: null,
    });
    expect((await runRow(alive.runId)).status).toBe('running');
    const [last] = await db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, quiet.runId))
      .orderBy(sql`${runEvents.seq} desc`)
      .limit(1);
    expect(last).toMatchObject({ seq: 8, type: 'error', payload: { code: 'orphaned' } });
    // Read back the way the run page reads events, it is a fatal error of the shared schema.
    const stored = RunEvent.parse({
      ...(last?.payload as object),
      seq: last?.seq,
      type: last?.type,
      at: last?.createdAt.toISOString(),
    });
    expect(foldRunStatus([stored])).toBe('failed');
    expect((await runPost(quiet.runId, 'heartbeat', quiet.runToken)).statusCode).toBe(401);
  });

  it('closes a run whose seat goes on past a stop request or its time limit', async () => {
    const asked = await runningRun();
    const late = await runningRun();
    const fresh = await runningRun();
    await db
      .update(runs)
      .set({ cancelRequestedAt: sql`now() - interval '4 minutes'` })
      .where(eq(runs.id, asked.runId));
    await db
      .update(runs)
      .set({ startedAt: sql`now() - interval '1 day'` })
      .where(eq(runs.id, late.runId));
    await db
      .update(runs)
      .set({ cancelRequestedAt: sql`now()` })
      .where(eq(runs.id, fresh.runId));
    // Each still sends heartbeats: only the reaper ends them.
    for (const run of [asked, late, fresh]) {
      expect((await runPost(run.runId, 'heartbeat', run.runToken)).statusCode).toBe(200);
    }

    expect((await reapOrphanedRuns(db, 3)).sort()).toEqual([asked.runId, late.runId].sort());
    expect(await runRow(asked.runId)).toMatchObject({ status: 'cancelled', tokenHash: null });
    expect(await runRow(late.runId)).toMatchObject({
      status: 'failed',
      errorCode: 'timeout',
      tokenHash: null,
    });
    expect((await runRow(fresh.runId)).status).toBe('running');
    const notes = await db
      .select({ payload: runEvents.payload })
      .from(runEvents)
      .where(eq(runEvents.runId, late.runId));
    expect(notes.at(-1)?.payload).toMatchObject({ code: 'timeout', fatal: true });
  });

  it('does not count the time a run waited for its owner against its time limit', async () => {
    const { agent, runId, runToken } = await runningRun();
    const [row] = await db.select({ limits: runs.limits }).from(runs).where(eq(runs.id, runId));
    const minutes = (row?.limits as { maxMinutes: number }).maxMinutes;
    // Started the whole limit and ten minutes ago: past its time, were all of it its own.
    await db
      .update(runs)
      .set({ startedAt: sql`now() - make_interval(mins => ${minutes + 10})` })
      .where(eq(runs.id, runId));
    const working = async () =>
      (
        await db
          .select({ id: runs.id })
          .from(runs)
          .where(and(eq(runs.id, runId), isWorking()))
      ).length === 1;
    expect(await working()).toBe(false);

    // Two calls that waited for the owner at the same time, twenty minutes together, and one
    // the policy refused at once, which never waited.
    const ago = (minutes: number) => sql<Date>`now() - make_interval(mins => ${minutes})`;
    const call = { runId, agentId: agent.id, tool: 'jira_add_comment', input: {} };
    await db.insert(toolCalls).values([
      { ...call, decision: 'approved', createdAt: ago(40), decidedAt: ago(25) },
      { ...call, decision: 'denied', createdAt: ago(35), decidedAt: ago(20) },
      { ...call, decision: 'denied', createdAt: ago(60), reason: 'Its policy is never' },
    ]);
    expect(await working()).toBe(true);
    const beat = await runPost(runId, 'heartbeat', runToken);
    expect(beat.json<{ waitedMs: number }>().waitedMs / 60_000).toBeCloseTo(20, 1);
    expect(await reapOrphanedRuns(db, 3)).not.toContain(runId);

    // Ten of the twenty minutes were what it had left; once those are worked off too, it is late.
    await db
      .update(runs)
      .set({ startedAt: sql`now() - make_interval(mins => ${minutes + 30})` })
      .where(eq(runs.id, runId));
    expect(await working()).toBe(false);
    // A call that waits now moves the deadline as long as it waits.
    await db.insert(toolCalls).values({ ...call, decision: 'pending', createdAt: ago(15) });
    expect(await working()).toBe(true);
  });

  it("asks a disabled person's computer to stop its run", async () => {
    const { owner, runId, runToken } = await runningRun();
    const disabled = await app.inject({
      method: 'PATCH',
      url: `/api/users/${owner.id}`,
      headers: { cookie: adminCookie },
      payload: { disabled: true },
    });
    expect(disabled.statusCode).toBe(200);
    expect((await runRow(runId)).cancelRequestedAt).not.toBeNull();
    const beat = await runPost(runId, 'heartbeat', runToken);
    expect(beat.json()).toEqual({ cancelRequested: true, waitedMs: 0 });
  });

  it('keeps going when a transcript already ends at the largest seq', async () => {
    const full = await runningRun();
    await runPost(full.runId, 'events', full.runToken, [event(2_147_483_647)]);
    await db
      .update(runs)
      .set({ lastHeartbeatAt: sql`now() - interval '4 minutes'` })
      .where(eq(runs.id, full.runId));
    expect(await reapOrphanedRuns(db, 3)).toEqual([full.runId]);
    expect((await runRow(full.runId)).status).toBe('failed');
  });

  it('is scheduled through pg-boss once a minute', async () => {
    const stop = await createJobs(config).start(app.log);
    try {
      const [schedule] = await db.execute<{ name: string; cron: string }>(
        sql`select name, cron from pgboss.schedule`,
      );
      expect(schedule).toMatchObject({ name: 'reap-orphaned-runs', cron: '* * * * *' });
    } finally {
      await stop();
    }
  });
});

describe("a person's seats", () => {
  it('lists them with the run each is busy with, renames and revokes them', async () => {
    const { owner, seat, runId, runToken } = await runningRun();
    const idle = await pairSeat(owner.email);

    const listed = await app.inject({
      method: 'GET',
      url: '/api/seats',
      headers: asUser(owner.email),
    });
    expect(listed.statusCode).toBe(200);
    const views =
      listed.json<{ id: string; activeRun: { id: string; agentName: string } | null }[]>();
    expect(views.map((view) => view.id).sort()).toEqual([seat.seatId, idle.seatId].sort());
    expect(views.find((view) => view.id === seat.seatId)?.activeRun).toMatchObject({
      id: runId,
      agentName: 'Backend developer',
    });
    expect(views.find((view) => view.id === idle.seatId)?.activeRun).toBeNull();

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/seats/${idle.seatId}`,
      headers: asUser(owner.email),
      payload: { name: '  Maria’s MacBook  ' },
    });
    expect(renamed.json()).toMatchObject({
      id: idle.seatId,
      name: 'Maria’s MacBook',
      idleMinutes: 15,
    });
    // The idle time, set here and handed to the worker with every claim answer.
    const rested = await app.inject({
      method: 'PATCH',
      url: `/api/seats/${idle.seatId}`,
      headers: asUser(owner.email),
      payload: { idleMinutes: 45 },
    });
    expect(rested.json()).toMatchObject({ name: 'Maria’s MacBook', idleMinutes: 45 });
    const tooLong = await app.inject({
      method: 'PATCH',
      url: `/api/seats/${idle.seatId}`,
      headers: asUser(owner.email),
      payload: { idleMinutes: 600 },
    });
    expect(tooLong.statusCode).toBe(400);
    const claimed = await claim(idle.token);
    expect(claimed.statusCode).toBe(204);
    expect(claimed.headers['x-agentome-idle-minutes']).toBe('45');

    const stranger = await person();
    const foreign = await app.inject({
      method: 'DELETE',
      url: `/api/seats/${seat.seatId}`,
      headers: asUser(stranger.email),
    });
    expect(foreign.statusCode).toBe(404);

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/api/seats/${seat.seatId}`,
      headers: asUser(owner.email),
    });
    expect(revoked.statusCode).toBe(204);
    expect((await claim(seat.token)).statusCode).toBe(401);
    // The run is asked to stop and may still report how it ended.
    expect((await runPost(runId, 'heartbeat', runToken)).json()).toEqual({
      cancelRequested: true,
      waitedMs: 0,
    });
    const after = await app.inject({
      method: 'GET',
      url: '/api/seats',
      headers: asUser(owner.email),
    });
    expect(after.json<{ id: string; status: string }[]>().at(-1)).toMatchObject({
      id: seat.seatId,
      status: 'revoked',
    });

    // Off the list only once revoked; its runs still name it.
    const tooSoon = await app.inject({
      method: 'POST',
      url: `/api/seats/${idle.seatId}/remove`,
      headers: asUser(owner.email),
    });
    expect(tooSoon.statusCode).toBe(400);
    const removed = await app.inject({
      method: 'POST',
      url: `/api/seats/${seat.seatId}/remove`,
      headers: asUser(owner.email),
    });
    expect(removed.statusCode).toBe(204);
    const left = await app.inject({
      method: 'GET',
      url: '/api/seats',
      headers: asUser(owner.email),
    });
    expect(left.json<{ id: string }[]>().map((view) => view.id)).toEqual([idle.seatId]);
    const run = await app.inject({
      method: 'GET',
      url: `/api/runs/${runId}`,
      headers: asUser(owner.email),
    });
    expect(run.json()).toMatchObject({ seat: { id: seat.seatId } });
  });
});

describe('enqueueRun', () => {
  it("queues a run of the task's agent, started by the person", async () => {
    const owner = await person();
    const { agent, task } = await agentWithTask(owner.id);
    const run = await enqueueRun(db, task.id, owner.id);
    expect(run).toMatchObject({
      agentId: agent.id,
      taskId: task.id,
      status: 'queued',
      startedBy: 'user',
      startedByUserId: owner.id,
      seatId: null,
    });
    await expect(enqueueRun(db, agent.id, owner.id)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('the OpenAPI document', () => {
  it('describes the seat protocol and the seat routes of people', async () => {
    const response = await app.inject({ method: 'GET', url: '/openapi.json' });
    const document = response.json<{ paths: Record<string, unknown> }>();
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining([
        '/api/seats/pairing-codes',
        '/api/seats/pair',
        '/api/seats/claim',
        '/api/seats',
        '/api/seats/{id}',
        '/api/runs/{id}/events',
        '/api/runs/{id}/heartbeat',
        '/api/runs/{id}/finish',
        '/api/runs/{id}/cancel',
      ]),
    );
  });
});
