import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentGrants,
  agents,
  createDb,
  type Db,
  installation,
  migrate,
  eq,
  costEvents,
  modelConnections,
  pairingCodes,
  projects,
  and,
  runs,
  seats,
  tasks,
  users,
  logEntries,
} from '@agentome/db';
import { hashSecret, normalizePairingCode } from '../src/tokens.js';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { type Config, loadConfig } from '../src/config.js';
import { connectionsKey, encryptSecret } from '../src/connections/crypto.js';
import { LaunchPackage } from '../src/protocol.js';
import { enqueueRun, reapOrphanedRuns } from '../src/runs/service.js';
import type { Launcher } from '../src/places/client.js';
import { endClosedRuns, tendPlaces } from '../src/places/tend.js';
import {
  cliEgressToken,
  dockerEgressToken,
  placeEgressToken,
  placesKey,
  egressProxyKey,
} from '../src/places/keys.js';
import { VENDOR_HOSTS } from '../src/places/egress.js';
import { servicesHash } from '../src/projects/environment.js';
import { licenseEnterprise, secondStepForAdmins, setupCodeIn } from './app.js';

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
  await secondStepForAdmins(container.getConnectionUri());
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
  // A place's code is the server's own, as it makes one for the launcher.
  if (kind === 'subscription-server') {
    await db
      .update(pairingCodes)
      .set({ forPlace: true })
      .where(eq(pairingCodes.codeHash, hashSecret(normalizePairingCode(code))));
  }
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

  it('are places only by a code the server made for a place, and a place code makes nothing else', async () => {
    const code = async () =>
      (
        await app.inject({
          method: 'POST',
          url: '/api/seats/pairing-codes',
          headers: { cookie: memberCookie },
        })
      ).json<{ code: string }>().code;
    const pairAs = (given: string, kind: string) =>
      app.inject({
        method: 'POST',
        url: '/api/seats/pair',
        payload: { code: given, name: 'mine', kind, engines: ['claude-code'] },
      });
    // A computer that calls itself a place: it would run without the sandbox.
    const computer = await pairAs(await code(), 'subscription-server');
    expect(computer.statusCode).toBe(403);
    expect(computer.json<{ error: { message: string } }>().error.message).toMatch(
      /made from its person’s page/,
    );
    const placeCode = await code();
    await db
      .update(pairingCodes)
      .set({ forPlace: true })
      .where(eq(pairingCodes.codeHash, hashSecret(normalizePairingCode(placeCode))));
    expect((await pairAs(placeCode, 'subscription-laptop')).statusCode).toBe(403);
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
      response.write(
        'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-4.5","usage":{"input_tokens":100,"cache_read_input_tokens":20,"output_tokens":1}}}\n\n',
      );
      response.write(
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":30}}\n\n',
      );
      // A slow answer keeps its call going, as a long one does.
      const ms = body.includes('"slow":true') ? 300 : 20;
      setTimeout(() => response.end('event: message_stop\ndata: {"type":"message_stop"}\n\n'), ms);
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
  async function serverRun(
    kind: 'anthropic' | 'gateway',
    modelPref: string | null = 'claude-sonnet-4.5',
  ) {
    const { port } = provider.address() as AddressInfo;
    const [connection] = await db
      .insert(modelConnections)
      .values({
        name: `Here ${kind} ${Math.random()}`,
        kind,
        baseUrl: `http://127.0.0.1:${port}/`,
        keyCiphertext: encryptSecret(connectionsKey(config.secretKey), `the ${kind} key`),
        models: ['claude-sonnet-4.5', 'gpt-5'],
        createdBy: adminId,
      })
      .returning();
    const { run } = await agentWithRun(memberId, {
      runsOn: 'server',
      modelConnectionId: connection?.id,
      modelPref,
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

  it("counts what the provider says each call used, and prices the run by it, not by its seat's word", async () => {
    const { token, runId } = await serverRun('gateway');
    const call = () =>
      relayApp.inject({
        method: 'POST',
        url: '/model/v1/messages',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload: '{"model":"claude-sonnet-4.5","stream":true}',
      });
    expect((await call()).statusCode).toBe(200);
    expect((await call()).statusCode).toBe(200);
    await vi.waitFor(async () => {
      const [row] = await db
        .select({ usage: runs.relayUsage })
        .from(runs)
        .where(eq(runs.id, runId));
      expect(row?.usage).toEqual({
        'claude-sonnet-4.5': {
          provider: 'anthropic',
          tokensIn: 200,
          tokensOut: 60,
          tokensCacheRead: 40,
          tokensCacheWrite: 0,
        },
      });
    });
    // The seat says it used nothing: the relay's count is what the run costs.
    const finished = await relayApp.inject({
      method: 'POST',
      url: `/api/runs/${runId}/finish`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { status: 'done', artifacts: [], usage: [] },
    });
    expect(finished.statusCode).toBe(200);
    const costs = await db
      .select({ model: costEvents.model, tokensIn: costEvents.tokensIn, source: costEvents.source })
      .from(costEvents)
      .where(eq(costEvents.runId, runId));
    expect(costs).toEqual([{ model: 'claude-sonnet-4.5', tokensIn: 200, source: 'relay' }]);
  });

  it('calls only the models the run may, and a few at once', async () => {
    const { token } = await serverRun('gateway');
    heard.length = 0;
    const call = (payload: string) =>
      relayApp.inject({
        method: 'POST',
        url: '/model/v1/messages',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload,
      });
    // Not a model the agent has or its connection lists: refused here, never sent on.
    const dear = await call('{"model":"claude-opus-4.1"}');
    expect(dear.statusCode).toBe(403);
    expect(dear.json<{ error: { message: string } }>().error.message).toBe(
      'This run may call claude-sonnet-4.5, gpt-5, not claude-opus-4.1',
    );
    expect(heard).toEqual([]);
    // Four at once go; a fifth waits its turn.
    const answers = await Promise.all(
      Array.from({ length: 6 }, () => call('{"model":"claude-sonnet-4.5","slow":true}')),
    );
    expect(answers.filter((answer) => answer.statusCode === 200)).toHaveLength(4);
    expect(answers.filter((answer) => answer.statusCode === 429)).toHaveLength(2);
    // Once they are done, the run calls again.
    expect((await call('{"model":"claude-sonnet-4.5"}')).statusCode).toBe(200);

    // An agent that names no model runs on its CLI's default, which the relay does not know:
    // Codex's, say, through a gateway to any provider.
    const free = await serverRun('gateway', null);
    const codex = await relayApp.inject({
      method: 'POST',
      url: '/model/v1/responses',
      headers: { authorization: `Bearer ${free.token}`, 'content-type': 'application/json' },
      payload: '{"model":"gpt-5-codex"}',
    });
    expect(codex.statusCode).toBe(200);
  });

  it("refuses a call once the run's agent has spent its month", async () => {
    const { token, runId } = await serverRun('gateway');
    const [run] = await db.select({ agentId: runs.agentId }).from(runs).where(eq(runs.id, runId));
    if (!run) throw new Error('no run');
    await db
      .update(agents)
      .set({ budget: { usdPerMonth: 1 } })
      .where(eq(agents.id, run.agentId));
    await db.insert(costEvents).values({
      runId,
      agentId: run.agentId,
      model: 'claude-sonnet-4.5',
      provider: 'anthropic',
      tokensIn: 0,
      tokensOut: 0,
      tokensCacheRead: 0,
      tokensCacheWrite: 0,
      tokensCacheWrite1h: 0,
      usd: '2',
      source: 'relay',
    });
    heard.length = 0;
    const refused = await relayApp.inject({
      method: 'POST',
      url: '/model/v1/messages',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: '{"model":"claude-sonnet-4.5"}',
    });
    expect(refused.statusCode).toBe(402);
    expect(refused.json<{ error: { message: string } }>().error.message).toContain('this month');
    expect(heard).toEqual([]);
  });

  it('counts a call whose caller hung up, and prices it once the server closes the run', async () => {
    const { token, runId } = await serverRun('gateway');
    const address = await relayApp.listen({ port: 0, host: '127.0.0.1' });
    // The caller goes at the first bytes of a slow answer: the provider made the input whatever.
    await new Promise<void>((resolve, reject) => {
      const call = request(
        `${address}/model/v1/messages`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        },
        (answer) => {
          answer.once('data', () => {
            call.destroy();
            resolve();
          });
        },
      );
      call.on('error', (error) => (call.destroyed ? resolve() : reject(error)));
      call.end('{"model":"claude-sonnet-4.5","stream":true,"slow":true}');
    });
    await vi.waitFor(async () => {
      const [row] = await db
        .select({ usage: runs.relayUsage })
        .from(runs)
        .where(eq(runs.id, runId));
      expect(row?.usage?.['claude-sonnet-4.5']?.tokensIn).toBe(100);
    });
    // The seat falls silent: the reaper closes the run and prices what the relay counted.
    await db
      .update(runs)
      .set({ lastHeartbeatAt: new Date(Date.now() - 60 * 60_000) })
      .where(eq(runs.id, runId));
    expect(await reapOrphanedRuns(db, 5)).toContain(runId);
    const costs = await db
      .select({ model: costEvents.model, tokensIn: costEvents.tokensIn, source: costEvents.source })
      .from(costEvents)
      .where(eq(costEvents.runId, runId));
    expect(costs).toEqual([{ model: 'claude-sonnet-4.5', tokensIn: 100, source: 'relay' }]);
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

  it('takes runs while its owner is away when they let it, unless an admin turned that off', async () => {
    const place = (await pair(memberCookie, 'subscription-server')).json<{ token: string }>();
    await db
      .update(runs)
      .set({ status: 'cancelled', endedAt: new Date() })
      .where(eq(runs.status, 'queued'));
    const own = await agentWithRun(memberId);
    await db.update(users).set({ presentAt: null }).where(eq(users.id, memberId));
    const away = () =>
      db
        .update(seats)
        .set({ worksWhileAway: true })
        .where(and(eq(seats.tokenHash, hashSecret(place.token))));
    await away();
    await db.update(installation).set({ placesAwayAllowed: false });
    const refused = await claim(place.token);
    expect(refused.statusCode).toBe(204);
    expect(refused.headers['x-agentome-waiting']).toBe('presence');

    await db.update(installation).set({ placesAwayAllowed: true });
    const taken = await claim(place.token);
    expect(taken.statusCode).toBe(200);
    expect(LaunchPackage.parse(taken.json()).run.id).toBe(own.run.id);
    expect(taken.headers['x-agentome-waiting']).toBeUndefined();
  });
});

describe("a person's place, made from Computers", () => {
  type State = 'none' | 'asleep' | 'awake';
  const places = new Map<string, { state: State; startedAt?: string; diskBytes?: number }>();
  const shells = new Map<string, number>();
  const startedRuns: {
    id: string;
    runId: string;
    run: { folder?: string; shape?: { services: { name: string }[] } };
  }[] = [];
  const orders: string[] = [];
  let lastCode = '';
  const launcher: Launcher = {
    state: async (id) => places.get(id)?.state ?? 'none',
    status: async (id) => ({
      state: places.get(id)?.state ?? 'none',
      startedAt: places.get(id)?.startedAt,
      terminals: shells.get(id) ?? 0,
      diskBytes: places.get(id)?.diskBytes,
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
      // Asleep, its volumes hold what they held.
      places.set(id, { state: 'asleep', diskBytes: places.get(id)?.diskBytes });
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
    startRun: async (id, runId, run) => {
      orders.push(`start run ${runId} of ${id} in ${run.folder ?? 'no folder'}`);
      startedRuns.push({ id, runId, run });
      return {
        cli: { host: '10.0.0.2', port: 7419, key: 'b'.repeat(43) },
        sandbox: { host: '10.0.0.3', port: 7420, key: 'h'.repeat(43) },
      };
    },
    endRun: async (id, runId) => {
      orders.push(`end run ${runId} of ${id}`);
    },
    // A shell that says back what it is sent, counted while it is open as the launcher does.
    terminal: async (id) => {
      orders.push(`terminal ${id}`);
      const shell = new PassThrough();
      shells.set(id, (shells.get(id) ?? 0) + 1);
      shell.once('close', () => shells.set(id, (shells.get(id) ?? 1) - 1));
      return shell;
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
    expect(none.json()).toEqual({
      available: false,
      computers: true,
      awayAllowed: true,
      place: null,
    });
    const refused = await app.inject({
      method: 'POST',
      url: '/api/me/place',
      headers: { cookie: adminCookie },
    });
    expect(refused.statusCode).toBe(404);
  });

  it('is made by its person in the browser, with a code that pairs it as their place, once', async () => {
    expect((await call('GET', '/api/me/place')).json()).toEqual({
      available: true,
      computers: true,
      awayAllowed: true,
      place: null,
    });
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

    // The server's room: with as many places as it may have, nobody else makes one.
    const full = await buildApp(
      { ...config, placeLimits: { ...config.placeLimits, places: 1 } },
      { workerBundle: join(dataDir, 'no-bundle.mjs'), placeLauncher: launcher },
    );
    try {
      const invitation = await full.inject({
        method: 'POST',
        url: '/api/invitations',
        headers: { cookie: adminCookie },
        payload: {},
      });
      const joined = await full.inject({
        method: 'POST',
        url: `/api/invitations/${invitation.json<{ url: string }>().url.split('/invite/')[1]}/accept`,
        payload: { name: 'Nora', email: 'nora@example.com', password: 'nora long password' },
      });
      const refused = await full.inject({
        method: 'POST',
        url: '/api/me/place',
        headers: { cookie: cookieOf(joined) },
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ error: { code: 'places_full' } });
    } finally {
      await full.close();
    }

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

  it('works while its person is away only by their own word in the browser, and as an admin allows', async () => {
    const put = (url: string, payload: object, headers: Record<string, string>) =>
      placesApp.inject({ method: 'PUT', url, payload, headers });
    expect(
      (await call('GET', '/api/me/place')).json<{ place: { worksWhileAway: boolean } }>().place
        .worksWhileAway,
    ).toBe(false);

    // A token, an assistant's way in, cannot turn it on: only the person in the browser.
    const made = await app.inject({
      method: 'POST',
      url: '/api/me/tokens',
      headers: { cookie: adminCookie },
      payload: { name: 'Away', scope: 'write', expiresInDays: 7 },
    });
    const token = made.json<{ token: string }>().token;
    const bearer = { authorization: `Bearer ${token}` };
    expect((await put('/api/me/place/away', { on: true }, bearer)).statusCode).toBe(403);
    expect((await put('/api/admin/places/away', { allowed: false }, bearer)).statusCode).toBe(403);

    const on = await put('/api/me/place/away', { on: true }, { cookie: adminCookie });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toMatchObject({ awayAllowed: true, place: { worksWhileAway: true } });

    // Asleep with a run queued and its person away: it wakes for the run.
    orders.length = 0;
    places.set(adminId, { state: 'asleep' });
    await db.update(users).set({ presentAt: null }).where(eq(users.id, adminId));
    await agentWithRun(adminId);
    await tendPlaces(db, launcher, log);
    expect(orders).toEqual([`wake ${adminId}`]);

    // Only an admin decides for everyone; off, places wait for their people, the choice kept.
    const member = { cookie: memberCookie };
    expect((await put('/api/admin/places/away', { allowed: false }, member)).statusCode).toBe(403);
    const off = await put('/api/admin/places/away', { allowed: false }, { cookie: adminCookie });
    expect(off.json()).toMatchObject({ awayAllowed: false, place: { worksWhileAway: true } });
    orders.length = 0;
    places.set(adminId, { state: 'asleep' });
    await tendPlaces(db, launcher, log);
    expect(orders).toEqual([]);
    const refused = await put('/api/me/place/away', { on: true }, { cookie: adminCookie });
    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ error: { message: string } }>().error.message).toContain(
      'An admin has turned this off',
    );
    // Turning it off for oneself is always possible.
    expect(
      (await put('/api/me/place/away', { on: false }, { cookie: adminCookie })).statusCode,
    ).toBe(200);

    await put('/api/admin/places/away', { allowed: true }, { cookie: adminCookie });
    await db
      .update(runs)
      .set({ status: 'cancelled', endedAt: new Date() })
      .where(eq(runs.status, 'queued'));
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
      {
        name: 'db',
        // Pinned, as a project's services are read.
        image: `postgres:16@sha256:${'b'.repeat(64)}`,
        environment: { POSTGRES_PASSWORD: 'dev' },
        volumes: [],
      },
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
    // In a place the workspace is kept and commands run in a container without the sign-in, and
    // the agent is told so.
    expect(launch.workspace.profile.claudeMd).toContain(
      'Shell commands run in a container of their own beside you',
    );
    expect(launch.workspace.profile.claudeMd).not.toContain('It is deleted when the run ends');

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

  it('opens at most three terminals for a person at once', async () => {
    type Client = { terminate(): void };
    const origin = new URL(config.publicUrl).origin;
    const open = () =>
      placesApp.injectWS('/api/me/place/terminal', {
        headers: { cookie: adminCookie, origin },
      } as never) as Promise<Client>;
    // The launcher's count, which the terminals of the tests above are not part of.
    shells.delete(adminId);
    const opened: Client[] = [];
    for (let n = 0; n < 3; n++) opened.push(await open());
    await expect(open()).rejects.toThrow();
    // One gone, another may open.
    opened.shift()?.terminate();
    await vi.waitFor(() => expect(shells.get(adminId)).toBe(2));
    opened.push(await open());
    for (const socket of opened) socket.terminate();
  });

  it("puts a disabled person's place to sleep and does not wake it", async () => {
    orders.length = 0;
    places.set(adminId, { state: 'awake', startedAt: new Date().toISOString() });
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, adminId));
    try {
      await tendPlaces(db, launcher, log);
      expect(orders).toEqual([`sleep ${adminId}`]);
      // A queued run and a recent presence do not wake it.
      orders.length = 0;
      await agentWithRun(adminId);
      await db.update(users).set({ presentAt: new Date() }).where(eq(users.id, adminId));
      await tendPlaces(db, launcher, log);
      expect(orders).toEqual([]);
    } finally {
      await db.update(users).set({ disabledAt: null }).where(eq(users.id, adminId));
      await db
        .update(runs)
        .set({ status: 'cancelled', endedAt: new Date() })
        .where(eq(runs.status, 'queued'));
    }
  });

  it('sleeps once it holds more than it may, and wakes for nobody until it holds less', async () => {
    const gb = 1024 ** 3;
    orders.length = 0;
    places.set(adminId, {
      state: 'awake',
      startedAt: new Date().toISOString(),
      diskBytes: 25 * gb,
    });
    await agentWithRun(adminId);
    await db.update(users).set({ presentAt: new Date() }).where(eq(users.id, adminId));
    try {
      await tendPlaces(db, launcher, log, 20 * gb);
      expect(orders).toEqual([`sleep ${adminId}`]);
      // A queued run and its present person do not wake it, nor does its person.
      orders.length = 0;
      await tendPlaces(db, launcher, log, 20 * gb);
      expect(orders).toEqual([]);
      const wake = await call('POST', '/api/me/place/wake');
      expect(wake.statusCode).toBe(409);
      expect(wake.json()).toMatchObject({
        error: {
          code: 'place_disk_full',
          message: expect.stringMatching(/holds 25\.0 GB of its 20\.0 GB/),
        },
      });
      expect((await call('GET', '/api/me/place')).json()).toMatchObject({
        place: { disk: { usedBytes: 25 * gb, limitBytes: 20 * gb } },
      });
      // Emptied below its limit, it wakes for the run.
      places.set(adminId, { state: 'asleep', diskBytes: 2 * gb });
      await tendPlaces(db, launcher, log, 20 * gb);
      expect(orders).toEqual([`wake ${adminId}`]);
    } finally {
      places.set(adminId, { state: 'awake', startedAt: new Date().toISOString() });
      await db
        .update(runs)
        .set({ status: 'cancelled', endedAt: new Date() })
        .where(eq(runs.status, 'queued'));
    }
  });

  it('is deleted by an admin for someone else, with its volumes, and by nobody else', async () => {
    orders.length = 0;
    // The member's place of the tests above was paired by hand: this one is made from the page.
    await db
      .update(seats)
      .set({ status: 'revoked' })
      .where(and(eq(seats.ownerUserId, memberId), eq(seats.kind, 'subscription-server')));
    const made = await call('POST', '/api/me/place', { cookie: memberCookie });
    expect(made.statusCode).toBe(201);
    // A member cannot delete another's place; an admin cannot delete one that is not there.
    expect(
      (await call('DELETE', `/api/users/${adminId}/place`, { cookie: memberCookie })).statusCode,
    ).toBe(403);
    expect((await call('DELETE', `/api/users/${randomUUID()}/place`)).statusCode).toBe(404);
    const deleted = await call('DELETE', `/api/users/${memberId}/place`);
    expect(deleted.statusCode).toBe(204);
    expect(orders).toContain(`remove ${memberId}`);
    const [left] = await db
      .select({ id: seats.id })
      .from(seats)
      .where(
        and(
          eq(seats.ownerUserId, memberId),
          eq(seats.kind, 'subscription-server'),
          eq(seats.status, 'active'),
        ),
      );
    expect(left).toBeUndefined();
  });

  it('goes with its seat when its person revokes the seat in Computers', async () => {
    orders.length = 0;
    // The launcher pairs a place's seat as the person's computer would.
    expect((await pair(memberCookie, 'subscription-server')).statusCode).toBe(201);
    const [seat] = await db
      .select({ id: seats.id })
      .from(seats)
      .where(
        and(
          eq(seats.ownerUserId, memberId),
          eq(seats.kind, 'subscription-server'),
          eq(seats.status, 'active'),
        ),
      );
    const revoked = await call('DELETE', `/api/seats/${seat?.id}`, { cookie: memberCookie });
    expect(revoked.statusCode).toBe(204);
    expect(orders).toEqual([`remove ${memberId}`]);
  });

  it('runs each run in a container of its own, which only the place asks for, and reports it by its token', async () => {
    orders.length = 0;
    startedRuns.length = 0;
    // The runs the tests above left queued are not this one's.
    await db
      .update(runs)
      .set({ status: 'cancelled', endedAt: new Date() })
      .where(eq(runs.status, 'queued'));
    await db.update(users).set({ presentAt: new Date() }).where(eq(users.id, adminId));
    const { agent, run } = await agentWithRun(adminId);
    const place = (await pair(adminCookie, 'subscription-server')).json<{ token: string }>();
    const taken = await placesApp.inject({
      url: '/api/seats/claim?wait=0',
      headers: { authorization: `Bearer ${place.token}` },
    });
    expect(taken.statusCode).toBe(200);
    const launch = LaunchPackage.parse(taken.json());
    expect(launch.run.id).toBe(run.id);
    const byPlace = { authorization: `Bearer ${place.token}`, 'content-type': 'application/json' };
    const byRun = {
      authorization: `Bearer ${launch.run.token}`,
      'content-type': 'application/json',
    };
    const container = (
      method: 'PUT' | 'DELETE',
      headers: Record<string, string>,
      folder?: string,
    ) =>
      placesApp.inject({
        method,
        url: `/api/runs/${run.id}/container`,
        headers: method === 'PUT' ? headers : { authorization: headers.authorization ?? '' },
        ...(method === 'PUT' && { payload: folder === undefined ? {} : { folder } }),
      });

    // The run's token is the agent's, in its container: it starts nothing.
    expect((await container('PUT', byRun, `folders/${agent.id}/0123456789abcdef`)).statusCode).toBe(
      401,
    );
    // Another agent's folder is not this run's to have.
    expect(
      (await container('PUT', byPlace, `folders/${randomUUID()}/0123456789abcdef`)).statusCode,
    ).toBe(403);
    const made = await container('PUT', byPlace, `folders/${agent.id}/0123456789abcdef`);
    expect(made.statusCode).toBe(200);
    // Where the CLI container and the sandbox are, as the launcher said, and the CLI container's way out.
    expect(made.json()).toEqual({
      cli: { host: '10.0.0.2', port: 7419, key: 'b'.repeat(43) },
      sandbox: { host: '10.0.0.3', port: 7420, key: 'h'.repeat(43) },
      cliToken: cliEgressToken(placesKey(config.secretKey), run.id),
    });
    expect(startedRuns.at(-1)).toMatchObject({
      id: adminId,
      runId: run.id,
      run: { folder: `folders/${agent.id}/0123456789abcdef` },
    });

    // The transcript and the end are the place's to report: the run's token, which the agent
    // holds in its container, writes neither.
    const event = {
      seq: 0,
      type: 'assistant_message',
      payload: { text: 'hello' },
      at: new Date().toISOString(),
    };
    const events = (headers: Record<string, string>) =>
      placesApp.inject({
        method: 'POST',
        url: `/api/runs/${run.id}/events`,
        headers,
        payload: [event],
      });
    expect((await events(byRun)).statusCode).toBe(401);
    expect((await events(byPlace)).statusCode).toBe(200);
    // No body, so no content type.
    const beat = (headers: Record<string, string>) =>
      placesApp.inject({
        method: 'POST',
        url: `/api/runs/${run.id}/heartbeat`,
        headers: { authorization: headers.authorization ?? '' },
      });
    expect((await beat(byRun)).statusCode).toBe(401);
    expect((await beat(byPlace)).statusCode).toBe(200);
    const finish = (headers: Record<string, string>) =>
      placesApp.inject({
        method: 'POST',
        url: `/api/runs/${run.id}/finish`,
        headers,
        payload: { status: 'done', summary: 'Done', artifacts: [], usage: [] },
      });
    expect((await finish(byRun)).statusCode).toBe(401);
    expect((await finish(byPlace)).statusCode).toBe(200);

    expect((await container('DELETE', byPlace)).statusCode).toBe(204);
    expect(orders).toContain(`end run ${run.id} of ${adminId}`);
    // Ended, the run starts no container again.
    expect((await container('PUT', byPlace)).statusCode).toBe(409);
  });

  it("deletes the containers of a place's run the server closed, whose worker went silent", async () => {
    orders.length = 0;
    await db
      .update(runs)
      .set({ status: 'cancelled', endedAt: new Date() })
      .where(eq(runs.status, 'queued'));
    await db.update(users).set({ presentAt: new Date() }).where(eq(users.id, adminId));
    const { run } = await agentWithRun(adminId);
    const place = (await pair(adminCookie, 'subscription-server')).json<{ token: string }>();
    const taken = await placesApp.inject({
      url: '/api/seats/claim?wait=0',
      headers: { authorization: `Bearer ${place.token}` },
    });
    expect(taken.statusCode).toBe(200);
    // Its worker died: no heartbeat for an hour, and nobody asked for its containers to go.
    await db
      .update(runs)
      .set({ lastHeartbeatAt: new Date(Date.now() - 3_600_000) })
      .where(eq(runs.id, run.id));
    const reaped = await reapOrphanedRuns(db, 3);
    expect(reaped).toContain(run.id);
    await endClosedRuns(db, launcher, reaped, log);
    expect(orders).toContain(`end run ${run.id} of ${adminId}`);
  });

  it('is deleted with its seat', async () => {
    orders.length = 0;
    const deleted = await call('DELETE', '/api/me/place');
    expect(deleted.statusCode).toBe(204);
    expect(orders).toEqual([`remove ${adminId}`]);
    expect((await call('GET', '/api/me/place')).json()).toEqual({
      available: true,
      computers: true,
      awayAllowed: true,
      place: null,
    });
  });
});

describe("the places' egress", () => {
  // The proxy's key, which the egress routes take nobody else's word without.
  const fromProxy = () => ({ 'x-agentome-egress': egressProxyKey(placesKey(config.secretKey)) });
  const hostsFor = (body: object) =>
    app.inject({ method: 'POST', url: '/api/egress/hosts', payload: body, headers: fromProxy() });

  it("answers the proxy alone: a run's token cannot ask, nor write the refused hosts", async () => {
    const token = placeEgressToken(placesKey(config.secretKey), memberId);
    const ask = { kind: 'place', id: memberId, token };
    expect(
      (await app.inject({ method: 'POST', url: '/api/egress/hosts', payload: ask })).statusCode,
    ).toBe(401);
    const wrong = { 'x-agentome-egress': 'x'.repeat(43) };
    expect(
      (await app.inject({ method: 'POST', url: '/api/egress/hosts', payload: ask, headers: wrong }))
        .statusCode,
    ).toBe(401);
    const event = {
      ...ask,
      host: 'gitlab.corp.example.com.evil.tld',
      port: 443,
      allowed: false,
      count: 1,
    };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/egress/events',
          payload: { events: [event] },
        })
      ).statusCode,
    ).toBe(401);
    // With the key, the routes answer as before: the tests below.
  });

  it("opens to a run Agentome and its project's hosts, which only an admin sets, and the vendors to its CLI container alone", async () => {
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
    // Not the platform's own services by their short names, not a whole domain, not this
    // machine or the cloud's metadata.
    for (const host of [
      'postgres',
      '*.com',
      // A star over a domain strangers share.
      '*.co.uk',
      '*.amazonaws.com',
      '*.s3.amazonaws.com',
      '*.github.io',
      'localhost',
      '127.0.0.1',
      '169.254.169.254',
      'a.example:0',
    ]) {
      const refused = await app.inject({
        method: 'PATCH',
        url: `/api/projects/${project.id}`,
        headers: { cookie: adminCookie },
        payload: { allowedHosts: [host] },
      });
      expect(refused.statusCode, host).toBe(400);
    }
    const set = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${project.id}`,
      headers: { cookie: adminCookie },
      payload: {
        allowedHosts: [
          ' GitLab.Corp.Example ',
          '*.jira.corp.example',
          '10.0.4.12',
          'git.corp.example:8443',
        ],
      },
    });
    // Not with a token, an admin's though it is: an assistant holding one could be led by a
    // repository's words to open the company's network, or to approve its services.
    const assistant = (
      await app.inject({
        method: 'POST',
        url: '/api/me/tokens',
        headers: { cookie: adminCookie },
        payload: { name: 'Assistant', scope: 'write', expiresInDays: 7 },
      })
    ).json<{ token: string }>().token;
    const byToken = { authorization: `Bearer ${assistant}` };
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/projects/${project.id}`,
          headers: byToken,
          payload: { allowedHosts: ['jira.corp.example'] },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/projects/${project.id}/environment/approve`,
          headers: byToken,
          payload: { hash: 'a'.repeat(64) },
        })
      ).statusCode,
    ).toBe(403);
    // The rest of the project, an assistant still changes.
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/projects/${project.id}`,
          headers: byToken,
          payload: { description: 'Payments' },
        })
      ).statusCode,
    ).toBe(200);
    expect(set.json<{ allowedHosts: string[] }>().allowedHosts).toEqual([
      'gitlab.corp.example',
      '*.jira.corp.example',
      '10.0.4.12',
      'git.corp.example:8443',
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
    // The server seat's own token opens npm alone, for its CLI; a computer's, nothing.
    const server = (await pair(adminCookie, 'api-server')).json<{ token: string }>();
    expect((await hostsFor({ kind: 'seat', token: server.token })).json()).toEqual({
      who: expect.stringMatching(/^seat [0-9a-f-]{36}$/),
      hosts: ['registry.npmjs.org'],
    });
    const computer = (await pair(adminCookie, 'subscription-laptop')).json<{ token: string }>();
    expect((await hostsFor({ kind: 'seat', token: computer.token })).statusCode).toBe(401);
    expect(opened.hosts).toEqual([
      'agentome.example.com:443',
      'gitlab.corp.example',
      '*.jira.corp.example',
      '10.0.4.12',
      'git.corp.example:8443',
    ]);
    // The vendors are the CLI container's, the CLI's alone: its own token, derived for the run.
    const cli = cliEgressToken(placesKey(config.secretKey), run.id);
    expect((await hostsFor({ kind: 'cli', id: run.id, token: cli })).json()).toEqual({
      who: `run ${run.id}`,
      hosts: ['agentome.example.com:443', ...VENDOR_HOSTS],
    });
    expect((await hostsFor({ kind: 'cli', id: randomUUID(), token: cli })).statusCode).toBe(401);
    expect((await hostsFor({ kind: 'cli', id: run.id, token })).statusCode).toBe(401);
    // The run's own Docker pulls from its project's hosts, and reaches nothing else.
    const pulls = dockerEgressToken(placesKey(config.secretKey), run.id);
    expect((await hostsFor({ kind: 'docker', id: run.id, token: pulls })).json()).toEqual({
      who: `run ${run.id}`,
      hosts: ['gitlab.corp.example', '*.jira.corp.example', '10.0.4.12', 'git.corp.example:8443'],
    });
    expect((await hostsFor({ kind: 'docker', id: run.id, token: cli })).statusCode).toBe(401);
    // What the proxy refused the project's runs this week, for an admin to allow: not what it
    // allows already, nor what is older than a week.
    const refusal = (host: string, count: number, at?: Date) => ({
      level: 40,
      source: 'server' as const,
      message: `a place was refused ${host}: not an allowed host`,
      context: { host, port: 443, count },
      runId: run.id,
      ...(at && { at }),
    });
    await db
      .insert(logEntries)
      .values([
        refusal('registry.npmjs.org', 2),
        refusal('registry.npmjs.org', 2),
        refusal('gitlab.corp.example', 1),
        refusal('old.example', 1, new Date(Date.now() - 8 * 24 * 3600 * 1000)),
      ]);
    const refused = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/refused-hosts`,
      headers: { cookie: adminCookie },
    });
    expect(refused.json<{ hosts: unknown[] }>().hosts).toEqual([
      expect.objectContaining({ host: 'registry.npmjs.org', port: 443, count: 4 }),
    ]);
    const asMember = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/refused-hosts`,
      headers: { cookie: memberCookie },
    });
    expect(asMember.statusCode).toBe(403);
    // A stopped run opens nothing.
    await db.update(runs).set({ cancelRequestedAt: new Date() }).where(eq(runs.id, run.id));
    expect((await hostsFor({ kind: 'run', token })).statusCode).toBe(401);
    expect((await hostsFor({ kind: 'cli', id: run.id, token: cli })).statusCode).toBe(401);
    expect((await hostsFor({ kind: 'run', token: 'not a token' })).statusCode).toBe(401);
  });

  it("takes the proxy's account of hosts by each line's own token, and nothing else", async () => {
    const token = placeEgressToken(placesKey(config.secretKey), memberId);
    const told = await app.inject({
      method: 'POST',
      url: '/api/egress/events',
      headers: fromProxy(),
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
      headers: fromProxy(),
      payload: {
        events: [{ kind: 'run', token: 'x', host: 'a', port: 0, allowed: true, count: 1 }],
      },
    });
    expect(odd.statusCode).toBe(400);
    // A host is a name as the proxy saw it, not a line of the log of its own.
    const forged = await app.inject({
      method: 'POST',
      url: '/api/egress/events',
      headers: fromProxy(),
      payload: {
        events: [
          {
            kind: 'place',
            id: memberId,
            token,
            host: 'x.example\n{"level":50,"msg":"an admin signed in"}',
            port: 443,
            allowed: true,
            count: 1,
          },
        ],
      },
    });
    expect(forged.statusCode).toBe(400);
  });

  it("opens to a place's own token Agentome, the vendors and npm, and to no other token", async () => {
    // The member's place, paired again: the tests above deleted theirs.
    expect((await pair(memberCookie, 'subscription-server')).statusCode).toBe(201);
    const token = placeEgressToken(placesKey(config.secretKey), memberId);
    const opened = await hostsFor({ kind: 'place', id: memberId, token });
    expect(opened.json<{ hosts: string[] }>().hosts).toEqual(
      expect.arrayContaining(['agentome.example.com:443', 'claude.ai', 'registry.npmjs.org']),
    );
    // The vendors' exact hosts, not their domains.
    expect(opened.json<{ hosts: string[] }>().hosts).not.toContain('*.anthropic.com');
    expect(opened.json<{ hosts: string[] }>().hosts).not.toContain('gitlab.corp.example');
    // Another person's id with this token, or no id, opens nothing.
    expect((await hostsFor({ kind: 'place', id: adminId, token })).statusCode).toBe(401);
    expect((await hostsFor({ kind: 'place', token })).statusCode).toBe(401);
    // Once the place is gone, its token, which is derived and cannot be revoked, opens nothing.
    const placeSeats = and(eq(seats.ownerUserId, memberId), eq(seats.kind, 'subscription-server'));
    const before = await db
      .select({ id: seats.id, status: seats.status })
      .from(seats)
      .where(placeSeats);
    await db.update(seats).set({ status: 'revoked' }).where(placeSeats);
    expect((await hostsFor({ kind: 'place', id: memberId, token })).statusCode).toBe(401);
    for (const seat of before) {
      await db.update(seats).set({ status: seat.status }).where(eq(seats.id, seat.id));
    }
  });
});
