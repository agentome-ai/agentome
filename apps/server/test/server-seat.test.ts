import { mkdtempSync, rmSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentGrants,
  agents,
  createDb,
  type Db,
  migrate,
  eq,
  modelConnections,
  projects,
  and,
  runs,
  seats,
  tasks,
  users,
} from '@agentome/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { type Config, loadConfig } from '../src/config.js';
import { connectionsKey, encryptSecret } from '../src/connections/crypto.js';
import { LaunchPackage } from '../src/protocol.js';
import { enqueueRun } from '../src/runs/service.js';
import type { Launcher } from '../src/places/client.js';
import { tendPlaces } from '../src/places/tend.js';
import { placeEgressToken } from '../src/places/egress.js';
import { servicesHash } from '../src/projects/environment.js';
import { licenseEnterprise, setupCodeIn } from './app.js';

// Server seats: a server seat takes anyone's server agents with a model connection and gets
// the server's model relay with the run's token, never the connection's key; a computer takes its
// owner's computer agents and gets neither. The relay passes a run's calls on with the key.

let container: StartedPostgreSqlContainer;
let app: Awaited<ReturnType<typeof buildApp>>;
let db: Db;
let config: Config;
let dataDir: string;
let adminCookie = '';
let adminId = '';
let memberCookie = '';
let memberId = '';
let connectionId = '';

const cookieOf = (response: LightMyRequestResponse) => {
  const setCookie = response.headers['set-cookie'] ?? [];
  return (Array.isArray(setCookie) ? setCookie : [setCookie])
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  dataDir = mkdtempSync(join(tmpdir(), 'agentome-server-seat-'));
  await migrate(container.getConnectionUri());
  config = loadConfig({
    AGENTOME_DATABASE_URL: container.getConnectionUri(),
    AGENTOME_DATA_DIR: dataDir,
    AGENTOME_LOG_LEVEL: 'silent',
    AGENTOME_PUBLIC_URL: 'https://agentome.example.com',
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
  adminCookie = cookieOf(setup);
  adminId = (await app.inject({ url: '/api/me', headers: { cookie: adminCookie } })).json().id;
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
    payload: { name: 'Maria', email: 'maria@example.com', password: 'a long enough password' },
  });
  memberCookie = cookieOf(accepted);
  memberId = accepted.json().id;
  const [connection] = await db
    .insert(modelConnections)
    .values({
      name: 'OpenRouter',
      kind: 'gateway',
      baseUrl: 'https://openrouter.ai/api',
      keyCiphertext: encryptSecret(connectionsKey(config.secretKey), 'sk-or-agents'),
      models: ['anthropic/claude-sonnet-4.5', 'openai/gpt-5'],
      createdBy: adminId,
    })
    .returning();
  connectionId = connection?.id ?? '';
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.$client.end();
  await container?.stop();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

async function pair(cookie: string, kind: string) {
  const code = (
    await app.inject({ method: 'POST', url: '/api/seats/pairing-codes', headers: { cookie } })
  ).json<{ code: string }>().code;
  return app.inject({
    method: 'POST',
    url: '/api/seats/pair',
    payload: { code, name: `${kind}-seat`, kind, engines: ['claude-code'] },
  });
}

async function agentWithRun(ownerId: string, set: Partial<typeof agents.$inferInsert> = {}) {
  const [agent] = await db
    .insert(agents)
    .values({ ownerUserId: ownerId, name: 'Jira admin', roleTitle: 'Admin', ...set })
    .returning();
  if (!agent) throw new Error('no agent');
  await db.insert(agentGrants).values({ agentId: agent.id, userId: ownerId, level: 'owner' });
  const [task] = await db
    .insert(tasks)
    .values({ agentId: agent.id, title: 'Tidy the board', source: 'manual', createdBy: ownerId })
    .returning();
  if (!task) throw new Error('no task');
  const run = await enqueueRun(db, task.id, ownerId);
  return { agent, run };
}

const claim = (token: string) =>
  app.inject({
    url: '/api/seats/claim?wait=0',
    headers: { authorization: `Bearer ${token}` },
  });

describe('server seats', () => {
  it('take Codex agents once the worker says it has Codex, on a model that is not Claude', async () => {
    const seat = (await pair(adminCookie, 'api-server')).json<{ token: string }>();
    const { agent, run } = await agentWithRun(memberId, {
      engine: 'codex',
      runsOn: 'server',
      modelConnectionId: connectionId,
      modelPref: 'openai/gpt-5',
    });
    // Paired with Claude Code only: the Codex run waits.
    expect((await claim(seat.token)).statusCode).toBe(204);
    const withCodex = await app.inject({
      url: '/api/seats/claim?wait=0&engines=claude-code,codex',
      headers: { authorization: `Bearer ${seat.token}` },
    });
    const launch = LaunchPackage.parse(withCodex.json());
    expect(launch.run.id).toBe(run.id);
    expect(launch.agent.engine).toBe('codex');
    expect(launch.model).toEqual({
      kind: 'gateway',
      baseUrl: 'https://agentome.example.com/model',
      key: launch.run.token,
    });
    expect(JSON.stringify(launch)).not.toContain('sk-or-agents');

    const patch = (payload: object) =>
      app.inject({
        method: 'PATCH',
        url: `/api/agents/${agent.id}`,
        headers: { cookie: memberCookie },
        payload,
      });
    expect(
      (await patch({ modelPref: 'anthropic/claude-sonnet-4.5' })).json().error.message,
    ).toContain('Codex runs the others');
    expect((await patch({ modelPref: 'openai/gpt-5' })).statusCode).toBe(200);
  });

  it('are connected by an admin’s code only', async () => {
    const refused = await pair(memberCookie, 'api-server');
    expect(refused.statusCode).toBe(403);
    expect((await pair(adminCookie, 'local-model')).statusCode).toBe(403);
    expect((await pair(adminCookie, 'api-server')).statusCode).toBe(201);
  });

  it('take server agents of anyone, with the relay and without a shell; computers never do', async () => {
    const server = (await pair(adminCookie, 'api-server')).json<{ token: string }>();
    const laptop = (await pair(memberCookie, 'subscription-laptop')).json<{ token: string }>();
    // A server agent without a connection waits: no seat may take it.
    await agentWithRun(memberId, { runsOn: 'server' });
    const { run } = await agentWithRun(memberId, {
      runsOn: 'server',
      modelConnectionId: connectionId,
      modelPref: 'anthropic/claude-sonnet-4.5',
    });
    expect((await claim(laptop.token)).statusCode).toBe(204);

    const answer = await claim(server.token);
    expect(answer.statusCode).toBe(200);
    const launch = LaunchPackage.parse(answer.json());
    expect(launch.run.id).toBe(run.id);
    expect(launch.model).toEqual({
      kind: 'gateway',
      baseUrl: 'https://agentome.example.com/model',
      key: launch.run.token,
    });
    expect(JSON.stringify(launch)).not.toContain('sk-or-agents');
    const { settings, claudeMd } = launch.workspace.profile;
    expect(settings.allowedTools).not.toContain('Bash');
    expect(settings.sandbox.enabled).toBe(false);
    expect(claudeMd).toContain('You have no shell here');

    // The owner's computer agent goes to the computer, without a key; the server seat leaves it.
    const own = await agentWithRun(memberId);
    expect((await claim(server.token)).statusCode).toBe(204);
    const onLaptop = LaunchPackage.parse((await claim(laptop.token)).json());
    expect(onLaptop.run.id).toBe(own.run.id);
    expect(onLaptop.model).toBeUndefined();
    expect(onLaptop.workspace.profile.settings.allowedTools).toContain('Bash');
  });

  it('let an owner set an agent to the server with a Claude model; the shell is an admin’s', async () => {
    const { agent } = await agentWithRun(memberId);
    const patch = (cookie: string, payload: object) =>
      app.inject({ method: 'PATCH', url: `/api/agents/${agent.id}`, headers: { cookie }, payload });
    expect((await patch(memberCookie, { runsOn: 'server' })).statusCode).toBe(400);
    const gpt = await patch(memberCookie, {
      runsOn: 'server',
      modelConnectionId: connectionId,
      modelPref: 'openai/gpt-5',
    });
    expect(gpt.json().error.message).toContain('Claude models only');
    const set = await patch(memberCookie, {
      runsOn: 'server',
      modelConnectionId: connectionId,
      modelPref: 'anthropic/claude-sonnet-4.5',
    });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({
      runsOn: 'server',
      modelConnection: { id: connectionId, name: 'OpenRouter' },
      serverShell: false,
    });
    expect((await patch(memberCookie, { serverShell: true })).statusCode).toBe(403);
    expect((await patch(adminCookie, { serverShell: true })).json().serverShell).toBe(true);
    // Another model of the same connection keeps it; another place to run takes it away.
    const other = await patch(memberCookie, { modelPref: 'anthropic/claude-sonnet-4.5' });
    expect(other.json().serverShell).toBe(true);
    expect((await patch(memberCookie, { runsOn: 'laptop' })).json().serverShell).toBe(false);
    const back = await patch(memberCookie, { runsOn: 'server', modelConnectionId: connectionId });
    expect(back.json().serverShell).toBe(false);

    // Every person sees the connections' names and models, never an address or a key.
    const models = await app.inject({ url: '/api/models', headers: { cookie: memberCookie } });
    expect(models.json()).toEqual({
      connections: [
        {
          id: connectionId,
          name: 'OpenRouter',
          models: [
            { id: 'anthropic/claude-sonnet-4.5', engine: 'claude-code' },
            { id: 'openai/gpt-5', engine: 'codex' },
          ],
        },
      ],
    });
  });
});

describe('the model relay', () => {
  // A provider on this machine: it writes down what it was sent and answers as a stream.
  const heard: { method: string; url: string; headers: IncomingHttpHeaders; body: string }[] = [];
  const provider = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      heard.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body,
      });
      response.writeHead(200, { 'content-type': 'text/event-stream', 'retry-after': '3' });
      response.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      setTimeout(() => response.end('event: message_stop\ndata: {"type":"message_stop"}\n\n'), 20);
    });
  });
  let relayApp: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
    // The library's fetch, told to let a test reach this machine, as for the connections.
    relayApp = await buildApp(config, {
      workerBundle: join(dataDir, 'no-bundle.mjs'),
      mcpFetch: (url, init) => fetch(url, init),
    });
  });

  afterAll(async () => {
    await relayApp?.close();
    await new Promise((resolve) => provider.close(resolve));
  });

  /** A working server run on a connection of `kind` to the provider; its token, as a seat has it. */
  async function serverRun(kind: 'anthropic' | 'gateway') {
    const { port } = provider.address() as AddressInfo;
    const [connection] = await db
      .insert(modelConnections)
      .values({
        name: `Here ${kind} ${Math.random()}`,
        kind,
        baseUrl: `http://127.0.0.1:${port}/`,
        keyCiphertext: encryptSecret(connectionsKey(config.secretKey), `the ${kind} key`),
        models: ['claude-sonnet-4.5'],
        createdBy: adminId,
      })
      .returning();
    const { run } = await agentWithRun(memberId, {
      runsOn: 'server',
      modelConnectionId: connection?.id,
      modelPref: 'claude-sonnet-4.5',
    });
    // Runs the tests above left queued come first, and a seat holds one run: a seat of its own
    // takes each, until one reaches this run.
    for (let taken = 0; taken < 20; taken++) {
      const seat = (await pair(adminCookie, 'api-server')).json<{ token: string }>();
      const answer = await claim(seat.token);
      if (answer.statusCode !== 200) break;
      const launch = LaunchPackage.parse(answer.json());
      if (launch.run.id === run.id) return { token: launch.run.token, runId: run.id };
    }
    throw new Error('the seat never took the run');
  }

  it("passes a Claude Code call on with the connection's key and streams the answer back", async () => {
    heard.length = 0;
    const { token } = await serverRun('anthropic');
    const answer = await relayApp.inject({
      method: 'POST',
      url: '/model/v1/messages?beta=true',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching',
      },
      payload: '{"model":"claude-sonnet-4.5","stream":true}',
    });
    expect(answer.statusCode).toBe(200);
    expect(answer.headers['content-type']).toBe('text/event-stream');
    expect(answer.headers['retry-after']).toBe('3');
    expect(answer.body).toContain('message_start');
    expect(answer.body).toContain('message_stop');
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({
      method: 'POST',
      url: '/v1/messages?beta=true',
      body: '{"model":"claude-sonnet-4.5","stream":true}',
    });
    expect(heard[0]?.headers['x-api-key']).toBe('the anthropic key');
    expect(heard[0]?.headers['anthropic-beta']).toBe('prompt-caching');
    // The run's token goes no further than the server.
    expect(heard[0]?.headers.authorization).toBeUndefined();
    expect(JSON.stringify(heard[0]?.headers)).not.toContain(token);
    expect(answer.body).not.toContain('the anthropic key');
  });

  it("passes a Codex call on to a gateway as a bearer token, and the models' list", async () => {
    heard.length = 0;
    const { token } = await serverRun('gateway');
    const asked = await relayApp.inject({
      method: 'POST',
      url: '/model/v1/responses',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: '{"model":"gpt-5"}',
    });
    expect(asked.statusCode).toBe(200);
    const listed = await relayApp.inject({
      url: '/model/v1/models',
      headers: { 'x-api-key': token },
    });
    expect(listed.statusCode).toBe(200);
    expect(heard.map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST /v1/responses',
      'GET /v1/models',
    ]);
    expect(heard.every((call) => call.headers.authorization === 'Bearer the gateway key')).toBe(
      true,
    );
    expect(heard.every((call) => call.headers['x-api-key'] === undefined)).toBe(true);
  });

  it('opens nothing for a stopped run, a computer, no token, or a call an engine does not make', async () => {
    const { token, runId } = await serverRun('anthropic');
    heard.length = 0;
    const call = (url: string, headers: Record<string, string>, method: 'GET' | 'POST' = 'POST') =>
      relayApp.inject({ method, url, headers, payload: method === 'POST' ? '{}' : undefined });
    const bearer = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

    expect((await call('/model/v1/files', bearer)).statusCode).toBe(404);
    expect((await call('/model/v1/messages', bearer, 'GET')).statusCode).toBe(404);
    expect(
      (await call('/model/v1/messages', { 'content-type': 'application/json' })).statusCode,
    ).toBe(401);
    expect(
      (await call('/model/v1/messages', { ...bearer, authorization: 'Bearer nonsense' }))
        .statusCode,
    ).toBe(401);

    // A computer's run is its owner's subscription: its token opens no model.
    const own = await agentWithRun(memberId);
    const laptop = (await pair(memberCookie, 'subscription-laptop')).json<{ token: string }>();
    const onLaptop = LaunchPackage.parse((await claim(laptop.token)).json());
    expect(onLaptop.run.id).toBe(own.run.id);
    const theirs = { ...bearer, authorization: `Bearer ${onLaptop.run.token}` };
    expect((await call('/model/v1/messages', theirs)).statusCode).toBe(401);

    // Cancelled: the next call is refused, whatever the seat does.
    await db.update(runs).set({ cancelRequestedAt: new Date() }).where(eq(runs.id, runId));
    const refused = await call('/model/v1/messages', bearer);
    expect(refused.statusCode).toBe(401);
    expect(refused.json().error.message).toContain('no working server run');
    expect(heard).toHaveLength(0);
  });
});

describe("a person's place on the server", () => {
  const presence = (headers: Record<string, string>) =>
    app.inject({ method: 'POST', url: '/api/me/presence', headers });

  it("takes its owner's agents' runs only while the owner is at work in the web app", async () => {
    // Paired by a member for themselves: no admin needed, as for a computer.
    const answer = await pair(memberCookie, 'subscription-server');
    expect(answer.statusCode).toBe(201);
    const place = answer.json<{ token: string }>();
    // Somebody else's computer agent, and a server agent: never this place's.
    await agentWithRun(adminId);
    await agentWithRun(memberId, {
      runsOn: 'server',
      modelConnectionId: connectionId,
      modelPref: 'anthropic/claude-sonnet-4.5',
    });
    const own = await agentWithRun(memberId);
    await db.update(users).set({ presentAt: null }).where(eq(users.id, memberId));

    const away = await claim(place.token);
    expect(away.statusCode).toBe(204);
    expect(away.headers['x-agentome-waiting']).toBe('presence');

    // A token cannot keep its person present: only a session in the browser says so.
    const made = await app.inject({
      method: 'POST',
      url: '/api/me/tokens',
      headers: { cookie: memberCookie },
      payload: { name: 'Mine', scope: 'write', expiresInDays: 7 },
    });
    const personal = made.json<{ token: string }>().token;
    expect((await presence({ authorization: `Bearer ${personal}` })).statusCode).toBe(403);
    expect((await claim(place.token)).statusCode).toBe(204);

    expect((await presence({ cookie: memberCookie })).statusCode).toBe(204);
    // Runs the tests above left queued are other people's or the server's: the place takes its own.
    const taken = await claim(place.token);
    expect(taken.statusCode).toBe(200);
    const launch = LaunchPackage.parse(taken.json());
    expect(launch.run.id).toBe(own.run.id);
    expect(launch.model).toBeUndefined();
    expect(taken.headers['x-agentome-waiting']).toBeUndefined();
  });

  it('waits again once the owner has been away for its idle time', async () => {
    const place = (await pair(memberCookie, 'subscription-server')).json<{ token: string }>();
    await agentWithRun(memberId);
    await db
      .update(users)
      .set({ presentAt: new Date(Date.now() - 16 * 60_000) })
      .where(eq(users.id, memberId));
    const stale = await claim(place.token);
    expect(stale.statusCode).toBe(204);
    expect(stale.headers['x-agentome-waiting']).toBe('presence');
  });
});

describe("a person's place, made from Computers", () => {
  type State = 'none' | 'asleep' | 'awake';
  const places = new Map<string, { state: State; startedAt?: string }>();
  const orders: string[] = [];
  let lastCode = '';
  const launcher: Launcher = {
    state: async (id) => places.get(id)?.state ?? 'none',
    status: async (id) => ({
      state: places.get(id)?.state ?? 'none',
      startedAt: places.get(id)?.startedAt,
      terminals: 0,
    }),
    create: async (id, code) => {
      orders.push(`create ${id}`);
      lastCode = code;
      places.set(id, { state: 'awake', startedAt: new Date().toISOString() });
    },
    wake: async (id) => {
      orders.push(`wake ${id}`);
      places.set(id, { state: 'awake', startedAt: new Date().toISOString() });
    },
    sleep: async (id) => {
      orders.push(`sleep ${id}`);
      places.set(id, { state: 'asleep' });
    },
    remove: async (id) => {
      orders.push(`remove ${id}`);
      places.delete(id);
    },
    freshFolders: async (id, agentId) => {
      orders.push(`fresh ${id} ${agentId}`);
    },
    resize: async (id, cols, rows) => {
      orders.push(`resize ${id} ${cols}x${rows}`);
    },
    services: async (id, shape) => {
      orders.push(`services ${id} ${shape.services.map((service) => service.name).join(',')}`);
      await servicesStarted;
    },
    // A shell that says back what it is sent.
    terminal: async (id) => {
      orders.push(`terminal ${id}`);
      return new PassThrough();
    },
  };
  // The services start when the test says so.
  let startServices: () => void = () => {};
  let servicesStarted = new Promise<void>((resolve) => (startServices = resolve));
  let placesApp: Awaited<ReturnType<typeof buildApp>>;
  const log = { info: () => {}, warn: () => {} } as unknown as Parameters<typeof tendPlaces>[2];

  beforeAll(async () => {
    placesApp = await buildApp(config, {
      workerBundle: join(dataDir, 'no-bundle.mjs'),
      placeLauncher: launcher,
    });
  });
  afterAll(async () => placesApp?.close());

  const call = (
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    headers = { cookie: adminCookie },
  ) => placesApp.inject({ method, url, headers });

  it('is not offered without a launcher', async () => {
    const none = await app.inject({ url: '/api/me/place', headers: { cookie: adminCookie } });
    expect(none.json()).toEqual({ available: false, place: null });
    const refused = await app.inject({
      method: 'POST',
      url: '/api/me/place',
      headers: { cookie: adminCookie },
    });
    expect(refused.statusCode).toBe(404);
  });

  it('is made by its person in the browser, with a code that pairs it as their place, once', async () => {
    expect((await call('GET', '/api/me/place')).json()).toEqual({ available: true, place: null });
    const made = await call('POST', '/api/me/place');
    expect(made.statusCode).toBe(201);
    expect(orders).toEqual([`create ${adminId}`]);
    // What the place's worker does with the code in its container.
    const paired = await placesApp.inject({
      method: 'POST',
      url: '/api/seats/pair',
      payload: {
        code: lastCode,
        name: 'Place on the server',
        kind: 'subscription-server',
        engines: ['claude-code'],
      },
    });
    expect(paired.statusCode).toBe(201);
    const view = (await call('GET', '/api/me/place')).json();
    expect(view).toMatchObject({
      available: true,
      place: { state: 'awake', seatId: paired.json().seatId },
    });
    expect((await call('POST', '/api/me/place')).statusCode).toBe(409);

    // Not with a token: a place runs its person's subscription.
    const token = (
      await placesApp.inject({
        method: 'POST',
        url: '/api/me/tokens',
        headers: { cookie: adminCookie },
        payload: { name: 'Script', scope: 'write', expiresInDays: 7 },
      })
    ).json<{ token: string }>().token;
    expect(
      (await call('POST', '/api/me/place/sleep', { authorization: `Bearer ${token}` } as never))
        .statusCode,
    ).toBe(403);
  });

  it('wakes for a queued run while its person is present, and sleeps once nothing has run in it', async () => {
    orders.length = 0;
    places.set(adminId, { state: 'asleep' });
    await db.update(users).set({ presentAt: null }).where(eq(users.id, adminId));
    await agentWithRun(adminId);
    await tendPlaces(db, launcher, log);
    expect(orders).toEqual([]);

    await db.update(users).set({ presentAt: new Date() }).where(eq(users.id, adminId));
    await tendPlaces(db, launcher, log);
    expect(orders).toEqual([`wake ${adminId}`]);

    // Awake with its person away, no run in it and none since it started a while ago: it sleeps.
    orders.length = 0;
    await db
      .update(runs)
      .set({ status: 'cancelled', endedAt: new Date() })
      .where(eq(runs.status, 'queued'));
    await db.update(users).set({ presentAt: null }).where(eq(users.id, adminId));
    places.set(adminId, {
      state: 'awake',
      startedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    });
    await db
      .update(seats)
      .set({ createdAt: new Date(Date.now() - 60 * 60_000) })
      .where(and(eq(seats.ownerUserId, adminId), eq(seats.kind, 'subscription-server')));
    await tendPlaces(db, launcher, log);
    expect(orders).toEqual([`sleep ${adminId}`]);
  });

  it('opens a terminal for its person, from a page of this server only', async () => {
    orders.length = 0;
    type Client = {
      send(data: Buffer | string): void;
      once(event: 'message', listener: (data: Buffer) => void): void;
      close(): void;
    };
    const origin = new URL(config.publicUrl).origin;
    const open = (headers: Record<string, string>) =>
      placesApp.injectWS('/api/me/place/terminal', { headers } as never) as Promise<Client>;
    // Another site's page would bring the person's cookie too.
    await expect(open({ cookie: adminCookie, origin: 'https://evil.example' })).rejects.toThrow();
    await expect(open({ cookie: adminCookie })).rejects.toThrow();
    expect(orders).toEqual([]);

    const socket = await open({ cookie: adminCookie, origin });
    await vi.waitFor(() => expect(orders).toEqual([`terminal ${adminId}`]));
    const said = new Promise<Buffer>((resolve) => socket.once('message', resolve));
    socket.send(Buffer.from('claude\r'));
    expect((await said).toString()).toBe('claude\r');
    socket.send(JSON.stringify({ cols: 120, rows: 40 }));
    await vi.waitFor(() => expect(orders).toContain(`resize ${adminId} 120x40`));
    socket.close();
  });

  it('keeps what the browser sends while the shell opens: the first size and keystrokes', async () => {
    orders.length = 0;
    type Client = {
      send(data: Buffer | string): void;
      once(event: 'message', listener: (data: Buffer) => void): void;
      close(): void;
    };
    // A shell that takes a moment to open, as a waking place's does.
    const opening = launcher.terminal;
    let open: (() => void) | undefined;
    launcher.terminal = async (id) => {
      await new Promise<void>((resolve) => (open = resolve));
      return opening(id);
    };
    try {
      const origin = new URL(config.publicUrl).origin;
      const socket = (await placesApp.injectWS('/api/me/place/terminal', {
        headers: { cookie: adminCookie, origin },
      } as never)) as Client;
      socket.send(JSON.stringify({ cols: 132, rows: 43 }));
      socket.send(Buffer.from('whoami\r'));
      const said = new Promise<Buffer>((resolve) => socket.once('message', resolve));
      await vi.waitFor(() => expect(open).toBeDefined());
      open?.();
      expect((await said).toString()).toBe('whoami\r');
      await vi.waitFor(() => expect(orders).toContain(`resize ${adminId} 132x43`));
      socket.close();
    } finally {
      launcher.terminal = opening;
    }
  });

  it("starts its person's agent's folders fresh, not another's, not while it runs", async () => {
    orders.length = 0;
    const { agent: mine, run } = await agentWithRun(adminId);
    const { agent: theirs } = await agentWithRun(memberId);
    expect((await call('DELETE', `/api/me/place/folders/${theirs.id}`)).statusCode).toBe(404);
    await db.update(runs).set({ status: 'running' }).where(eq(runs.id, run.id));
    expect((await call('DELETE', `/api/me/place/folders/${mine.id}`)).statusCode).toBe(409);
    await db.update(runs).set({ status: 'done', endedAt: new Date() }).where(eq(runs.id, run.id));
    expect((await call('DELETE', `/api/me/place/folders/${mine.id}`)).statusCode).toBe(204);
    expect(orders).toEqual([`fresh ${adminId} ${mine.id}`]);
  });

  it("waits for its project's approved services before it takes the run, then names them", async () => {
    orders.length = 0;
    // The runs the tests above left queued are not this one's.
    await db
      .update(runs)
      .set({ status: 'cancelled', endedAt: new Date() })
      .where(eq(runs.status, 'queued'));
    const services = [
      { name: 'db', image: 'postgres:16', environment: { POSTGRES_PASSWORD: 'dev' }, volumes: [] },
    ];
    const hash = servicesHash(services);
    const [project] = await db
      .insert(projects)
      .values({
        name: 'Shop',
        createdBy: adminId,
        environment: {
          repository: 'https://github.com/acme/shop',
          devcontainer: '.devcontainer/devcontainer.json',
          services,
          problems: [],
          readAt: new Date().toISOString(),
          hash,
        },
        environmentApproved: hash,
      })
      .returning();
    const { run } = await agentWithRun(adminId);
    await db
      .update(tasks)
      .set({ projectId: project?.id })
      .where(eq(tasks.id, run.taskId ?? ''));
    await db.update(users).set({ presentAt: new Date() }).where(eq(users.id, adminId));
    const place = (await pair(adminCookie, 'subscription-server')).json<{ token: string }>();
    const claimHere = () =>
      placesApp.inject({
        url: '/api/seats/claim?wait=0',
        headers: { authorization: `Bearer ${place.token}` },
      });

    const waiting = await claimHere();
    expect(waiting.statusCode).toBe(204);
    expect(waiting.headers['x-agentome-waiting']).toBe('services');
    await vi.waitFor(() => expect(orders).toEqual([`services ${adminId} db`]));
    // Asked again while they start: no second order.
    expect((await claimHere()).statusCode).toBe(204);
    expect(orders).toHaveLength(1);

    startServices();
    // The person has a place from the test above too: this one is the one that got ready.
    await vi.waitFor(async () => {
      const shapes = await db
        .select({ shape: seats.placeShape })
        .from(seats)
        .where(eq(seats.ownerUserId, adminId));
      expect(shapes.map((seat) => seat.shape)).toContainEqual(
        expect.objectContaining({ state: 'ready', projectId: project?.id }),
      );
    });
    const taken = await claimHere();
    expect(taken.statusCode).toBe(200);
    const launch = LaunchPackage.parse(taken.json());
    expect(launch.run.id).toBe(run.id);
    expect(launch.workspace.services).toEqual(['db']);
    expect(launch.workspace.profile.claudeMd).toContain('- `db`: postgres:16');

    // Asleep, its services are stopped: the next run gets them ready again.
    await db.update(runs).set({ status: 'done', endedAt: new Date() }).where(eq(runs.id, run.id));
    expect((await call('POST', '/api/me/place/sleep')).statusCode).toBe(200);
    const after = await db
      .select({ shape: seats.placeShape })
      .from(seats)
      .where(eq(seats.ownerUserId, adminId));
    expect(after.every((seat) => seat.shape === null)).toBe(true);
    servicesStarted = new Promise<void>((resolve) => (startServices = resolve));
  });

  it('is deleted with its seat', async () => {
    orders.length = 0;
    const deleted = await call('DELETE', '/api/me/place');
    expect(deleted.statusCode).toBe(204);
    expect(orders).toEqual([`remove ${adminId}`]);
    expect((await call('GET', '/api/me/place')).json()).toEqual({ available: true, place: null });
  });
});

describe("the places' egress", () => {
  const hostsFor = (body: object) =>
    app.inject({ method: 'POST', url: '/api/egress/hosts', payload: body });

  it("opens to a run Agentome, the vendors and its project's hosts, which only an admin sets", async () => {
    const made = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie: memberCookie },
      payload: { name: 'Billing' },
    });
    const project = made.json<{ id: string }>();
    // The project is Maria's, but its hosts open the company's network: an admin's call.
    const theirs = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${project.id}`,
      headers: { cookie: memberCookie },
      payload: { allowedHosts: ['gitlab.corp.example'] },
    });
    expect(theirs.statusCode).toBe(403);
    const odd = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${project.id}`,
      headers: { cookie: adminCookie },
      payload: { allowedHosts: ['http://x.example/'] },
    });
    expect(odd.statusCode).toBe(400);
    const set = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${project.id}`,
      headers: { cookie: adminCookie },
      payload: { allowedHosts: [' GitLab.Corp.Example ', '*.jira.corp.example', '10.0.4.12'] },
    });
    expect(set.json<{ allowedHosts: string[] }>().allowedHosts).toEqual([
      'gitlab.corp.example',
      '*.jira.corp.example',
      '10.0.4.12',
    ]);

    const { run } = await agentWithRun(memberId, {
      runsOn: 'server',
      modelConnectionId: connectionId,
      modelPref: 'anthropic/claude-sonnet-4.5',
    });
    await db
      .update(tasks)
      .set({ projectId: project.id })
      .where(eq(tasks.id, run.taskId ?? ''));
    let token = '';
    for (let taken = 0; taken < 20 && !token; taken++) {
      const seat = (await pair(adminCookie, 'api-server')).json<{ token: string }>();
      const answer = await claim(seat.token);
      if (answer.statusCode !== 200) break;
      const launch = LaunchPackage.parse(answer.json());
      if (launch.run.id === run.id) token = launch.run.token;
    }
    expect(token).not.toBe('');

    const opened = (await hostsFor({ kind: 'run', token })).json<{
      who: string;
      hosts: string[];
    }>();
    expect(opened.who).toBe(`run ${run.id}`);
    expect(opened.hosts).toEqual(
      expect.arrayContaining([
        'agentome.example.com',
        '*.anthropic.com',
        'chatgpt.com',
        'gitlab.corp.example',
        '*.jira.corp.example',
        '10.0.4.12',
      ]),
    );
    // A stopped run opens nothing.
    await db.update(runs).set({ cancelRequestedAt: new Date() }).where(eq(runs.id, run.id));
    expect((await hostsFor({ kind: 'run', token })).statusCode).toBe(401);
    expect((await hostsFor({ kind: 'run', token: 'not a token' })).statusCode).toBe(401);
  });

  it("takes the proxy's account of hosts by each line's own token, and nothing else", async () => {
    const token = placeEgressToken(config.secretKey, memberId);
    const told = await app.inject({
      method: 'POST',
      url: '/api/egress/events',
      payload: {
        events: [
          {
            kind: 'place',
            id: memberId,
            token,
            host: 'claude.ai',
            port: 443,
            allowed: true,
            count: 4,
          },
          {
            kind: 'place',
            id: memberId,
            token: 'forged',
            host: 'evil.example',
            port: 443,
            allowed: false,
            count: 1,
          },
          {
            kind: 'run',
            token: 'not a run',
            host: 'example.com',
            port: 443,
            allowed: false,
            count: 1,
          },
        ],
      },
    });
    expect(told.statusCode).toBe(204);
    const odd = await app.inject({
      method: 'POST',
      url: '/api/egress/events',
      payload: {
        events: [{ kind: 'run', token: 'x', host: 'a', port: 0, allowed: true, count: 1 }],
      },
    });
    expect(odd.statusCode).toBe(400);
  });

  it("opens to a place's own token Agentome, the vendors and npm, and to no other token", async () => {
    const token = placeEgressToken(config.secretKey, memberId);
    const opened = await hostsFor({ kind: 'place', id: memberId, token });
    expect(opened.json<{ hosts: string[] }>().hosts).toEqual(
      expect.arrayContaining(['agentome.example.com', 'claude.ai', 'registry.npmjs.org']),
    );
    expect(opened.json<{ hosts: string[] }>().hosts).not.toContain('gitlab.corp.example');
    // Another person's id with this token, or no id, opens nothing.
    expect((await hostsFor({ kind: 'place', id: adminId, token })).statusCode).toBe(401);
    expect((await hostsFor({ kind: 'place', token })).statusCode).toBe(401);
  });
});
