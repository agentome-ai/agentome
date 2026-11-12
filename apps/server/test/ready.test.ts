import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '@agentome/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { appFor, REFUSING_DATABASE } from './app.js';

let container: StartedPostgreSqlContainer;
let app: Awaited<ReturnType<typeof appFor>>;
let dataDir: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  dataDir = mkdtempSync(join(tmpdir(), 'agentome-server-'));
  await migrate(container.getConnectionUri());
  app = await appFor(container.getConnectionUri(), dataDir);
}, 120_000);

afterAll(async () => {
  await app?.close();
  await container?.stop();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

describe('the server on a real database', () => {
  it('is ready once the database answers', async () => {
    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('is healthy', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('answers an unknown route with an AppError', async () => {
    // Outside /api: until the setup completes, the API answers setup_required instead.
    const response = await app.inject({ method: 'GET', url: '/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: 'not_found', message: 'Route GET /nope not found' },
    });
  });

  it('answers a malformed URL in the same format', async () => {
    const response = await app.inject({ method: 'GET', url: '/%zz' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'bad_request' } });
  });

  it('documents the routes in the OpenAPI document', async () => {
    const response = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(response.statusCode).toBe(200);
    const document: { openapi: string; paths: Record<string, unknown> } = response.json();
    expect(document.openapi).toMatch(/^3\./);
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining([
        '/health',
        '/ready',
        '/api/invitations',
        '/api/invitations/{id}',
        '/api/invitations/{token}',
        '/api/invitations/{token}/accept',
        '/api/me',
        '/api/setup',
        '/api/users',
        '/api/users/{id}',
      ]),
    );
  });
});

describe('the configuration', () => {
  it('stops the start when a setting is invalid', () => {
    expect(() => loadConfig({ AGENTOME_DATA_DIR: dataDir, AGENTOME_LISTEN: 'http' })).toThrow(
      ConfigError,
    );
  });
});

describe('the server without a working database', () => {
  it('is alive but not ready when the database refuses connections', async () => {
    const offline = await appFor(REFUSING_DATABASE, dataDir);
    try {
      expect((await offline.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      const response = await offline.inject({ method: 'GET', url: '/ready' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        error: { code: 'not_ready', message: 'The database is not reachable' },
      });
    } finally {
      await offline.close();
    }
  });

  it('is not ready within seconds, and still shuts down, when the database stalls', async () => {
    // Accepts connections and never answers, like a paused container.
    const sockets: Socket[] = [];
    const silent = createServer((socket) => sockets.push(socket));
    await new Promise<void>((done) => silent.listen(0, '127.0.0.1', done));
    const { port } = silent.address() as AddressInfo;
    const stalled = await appFor(
      `postgres://agentome:agentome@127.0.0.1:${port}/agentome`,
      dataDir,
    );
    try {
      const started = Date.now();
      const response = await stalled.inject({ method: 'GET', url: '/ready' });
      expect(response.statusCode).toBe(503);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await stalled.close();
      for (const socket of sockets) socket.destroy();
      await new Promise((done) => silent.close(done));
    }
  }, 20_000);
});
