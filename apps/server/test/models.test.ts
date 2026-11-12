import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, type Db, migrate, modelConnections } from '@agentome/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { setupCodeIn } from './app.js';

// Admin → Models: an admin's connections to models, checked by reading their models,
// with the key kept encrypted and never answered.

let container: StartedPostgreSqlContainer;
let app: Awaited<ReturnType<typeof buildApp>>;
let db: Db;
let dataDir: string;
let models: Server;
let modelsUrl = '';
let adminCookie = '';
let memberCookie = '';
const seen: { url?: string; authorization?: string; apiKey?: string }[] = [];
let served = ['claude-sonnet-4-5', 'gpt-5-codex', 'qwen3-coder'];

const cookieOf = (response: LightMyRequestResponse) => {
  const setCookie = response.headers['set-cookie'] ?? [];
  return (Array.isArray(setCookie) ? setCookie : [setCookie])
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');
};

/** /v1/models as a gateway, OpenAI and Anthropic answer it: the key "good" lists, others are refused. */
function answer(request: IncomingMessage) {
  const authorization = request.headers.authorization;
  const apiKey = request.headers['x-api-key'] as string | undefined;
  seen.push({ url: request.url, authorization, apiKey });
  const good = authorization === 'Bearer good' || apiKey === 'good';
  if (!good) return { status: 401, body: { error: { message: 'Invalid key' } } };
  if (!request.url?.startsWith('/v1/models')) return { status: 404, body: { detail: 'Not Found' } };
  return { status: 200, body: { data: served.map((id) => ({ id, object: 'model' })) } };
}

beforeAll(async () => {
  models = createServer((request, response) => {
    const { status, body } = answer(request);
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => models.listen(0, '127.0.0.1', resolve));
  modelsUrl = `http://127.0.0.1:${(models.address() as AddressInfo).port}`;

  container = await new PostgreSqlContainer('postgres:16').start();
  dataDir = mkdtempSync(join(tmpdir(), 'agentome-models-'));
  await migrate(container.getConnectionUri());
  const config = loadConfig({
    AGENTOME_DATABASE_URL: container.getConnectionUri(),
    AGENTOME_DATA_DIR: dataDir,
    AGENTOME_LOG_LEVEL: 'silent',
  });
  // The gateway's fetch refuses this machine; the fake models server lives on it.
  app = await buildApp(config, { workerBundle: join(dataDir, 'no-bundle.mjs'), mcpFetch: fetch });
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
  adminCookie = cookieOf(setup);
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
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.$client.end();
  await container?.stop();
  models?.close();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

type View = {
  id: string;
  name: string;
  baseUrl: string;
  models: { id: string; engine: string }[];
  checkedAt: string | null;
};

const as = (
  cookie: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: object,
) => app.inject({ method, url, headers: { cookie }, ...(payload && { payload }) });

describe('model connections', () => {
  it('are an admin’s alone', async () => {
    expect((await as(memberCookie, 'GET', '/api/model-connections')).statusCode).toBe(403);
    const made = await as(memberCookie, 'POST', '/api/model-connections', {
      name: 'LiteLLM',
      kind: 'gateway',
      baseUrl: modelsUrl,
      key: 'good',
    });
    expect(made.statusCode).toBe(403);
  });

  it('keep a connection once its key lists the models, and never answer the key', async () => {
    const refused = await as(adminCookie, 'POST', '/api/model-connections', {
      name: 'LiteLLM',
      kind: 'gateway',
      baseUrl: `${modelsUrl}/v1/`,
      key: 'wrong',
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe('connection_unauthorized');
    expect(await db.select().from(modelConnections)).toHaveLength(0);

    const made = await as(adminCookie, 'POST', '/api/model-connections', {
      name: 'LiteLLM',
      kind: 'gateway',
      baseUrl: `${modelsUrl}/v1/`,
      key: 'good',
    });
    expect(made.statusCode).toBe(201);
    const view = made.json<View>();
    // The address is kept in front of /v1, and each model goes to the engine that runs it.
    expect(view.baseUrl).toBe(modelsUrl);
    expect(view.models).toEqual([
      { id: 'claude-sonnet-4-5', engine: 'claude-code' },
      { id: 'gpt-5-codex', engine: 'codex' },
      { id: 'qwen3-coder', engine: 'codex' },
    ]);
    expect(seen.at(-1)).toMatchObject({
      url: '/v1/models?limit=1000',
      authorization: 'Bearer good',
    });
    expect(made.body).not.toContain('good"');
    const [row] = await db.select().from(modelConnections);
    expect(row?.keyCiphertext.startsWith('v1:')).toBe(true);
    expect(row?.keyCiphertext).not.toContain('good');

    const listed = await as(adminCookie, 'GET', '/api/model-connections');
    expect(listed.json<{ connections: View[] }>().connections.map((c) => c.name)).toEqual([
      'LiteLLM',
    ]);
    const twice = await as(adminCookie, 'POST', '/api/model-connections', {
      name: 'LiteLLM',
      kind: 'gateway',
      baseUrl: modelsUrl,
      key: 'good',
    });
    expect(twice.json().error.code).toBe('connection_exists');
  });

  it('send Anthropic its key in its own header', async () => {
    const made = await as(adminCookie, 'POST', '/api/model-connections', {
      name: 'Anthropic',
      kind: 'anthropic',
      baseUrl: modelsUrl,
      key: 'good',
    });
    expect(made.statusCode).toBe(201);
    expect(seen.at(-1)).toMatchObject({ apiKey: 'good', authorization: undefined });
  });

  it('read the models again on a check, rename without one, and go', async () => {
    const [connection] = (await as(adminCookie, 'GET', '/api/model-connections'))
      .json<{ connections: View[] }>()
      .connections.filter((c) => c.name === 'LiteLLM');
    const id = connection?.id ?? '';
    const before = seen.length;
    const renamed = await as(adminCookie, 'PATCH', `/api/model-connections/${id}`, {
      name: 'Company LiteLLM',
    });
    expect(renamed.json<View>().name).toBe('Company LiteLLM');
    expect(seen.length).toBe(before);

    served = ['claude-opus-4-1', 'llama-3.3-70b'];
    const checked = await as(adminCookie, 'POST', `/api/model-connections/${id}/check`);
    expect(checked.json<View>().models.map((model) => model.id)).toEqual([
      'claude-opus-4-1',
      'llama-3.3-70b',
    ]);
    const wrongKey = await as(adminCookie, 'PATCH', `/api/model-connections/${id}`, {
      key: 'wrong',
    });
    expect(wrongKey.json().error.code).toBe('connection_unauthorized');

    expect((await as(adminCookie, 'DELETE', `/api/model-connections/${id}`)).statusCode).toBe(204);
    expect((await as(adminCookie, 'POST', `/api/model-connections/${id}/check`)).statusCode).toBe(
      404,
    );
  });
});
