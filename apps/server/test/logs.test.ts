import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, type Db, logEntries, migrate } from '@agentome/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { redactValue } from '../src/logs/redact.js';
import { pruneLogs } from '../src/logs/service.js';
import { rowOf } from '../src/logs/sink.js';
import { setupCodeIn } from './app.js';

// Admin → Logs: the server's lines and the workers', kept in the database with their
// trace, without secrets, read by an admin alone.

let container: StartedPostgreSqlContainer;
let app: Awaited<ReturnType<typeof buildApp>>;
let db: Db;
let dataDir: string;
let adminCookie = '';
let memberCookie = '';

const cookieOf = (response: LightMyRequestResponse) => {
  const setCookie = response.headers['set-cookie'] ?? [];
  return (Array.isArray(setCookie) ? setCookie : [setCookie])
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  dataDir = mkdtempSync(join(tmpdir(), 'agentome-logs-'));
  await migrate(container.getConnectionUri());
  const config = loadConfig({
    AGENTOME_DATABASE_URL: container.getConnectionUri(),
    AGENTOME_DATA_DIR: dataDir,
    AGENTOME_LOG_LEVEL: 'info',
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
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

const asAdmin = (url: string) =>
  app.inject({ method: 'GET', url, headers: { cookie: adminCookie } });

type Entry = {
  id: number;
  level: number;
  source: string;
  message: string;
  context: Record<string, unknown> | null;
  traceId: string | null;
  seatId: string | null;
  span: string | null;
  durationMs: number | null;
};

/** The server writes its lines in batches: wait for the one that should be there. */
async function lines(url: string, until: (entries: Entry[]) => boolean) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const entries = (await asAdmin(url)).json<{ entries: Entry[] }>().entries;
    if (until(entries)) return entries;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`no such lines at ${url}`);
}

describe('log lines', () => {
  it('keep a request as a span of its trace, and show it to an admin alone', async () => {
    const called = await app.inject({
      method: 'GET',
      url: '/api/agents?secret=x',
      headers: { cookie: memberCookie },
    });
    const traceId = String(called.headers['request-id'] ?? '');
    const entries = await lines('/api/admin/logs?q=/api/agents', (found) =>
      found.some((entry) => entry.span === 'GET /api/agents'),
    );
    const request = entries.find((entry) => entry.span === 'GET /api/agents');
    expect(request).toMatchObject({ level: 30, source: 'server', message: 'request completed' });
    expect(typeof request?.durationMs).toBe('number');
    // The id is 16 hex characters, not Fastify's count that starts again on each start.
    expect(request?.traceId).toMatch(/^[0-9a-f]{16}$/);
    expect(traceId === '' || traceId === request?.traceId).toBe(true);

    const trace = (await asAdmin(`/api/admin/logs/traces/${request?.traceId}`)).json<{
      entries: Entry[];
    }>();
    expect(trace.entries.map((entry) => entry.span)).toContain('GET /api/agents');

    const member = await app.inject({
      method: 'GET',
      url: '/api/admin/logs',
      headers: { cookie: memberCookie },
    });
    expect(member.statusCode).toBe(403);
  });

  it('change level until a restart, and filter from a level up', async () => {
    expect((await asAdmin('/api/admin/logs/level')).json()).toEqual({ level: 'info' });
    const set = await app.inject({
      method: 'PUT',
      url: '/api/admin/logs/level',
      headers: { cookie: adminCookie },
      payload: { level: 'debug' },
    });
    expect(set.json()).toEqual({ level: 'debug' });
    const warned = await lines('/api/admin/logs?level=warn', (found) =>
      found.some((entry) => entry.message === 'log level changed'),
    );
    expect(warned.every((entry) => entry.level >= 40)).toBe(true);
    await app.inject({
      method: 'PUT',
      url: '/api/admin/logs/level',
      headers: { cookie: adminCookie },
      payload: { level: 'info' },
    });
  }, 15_000);

  it("take a worker's lines under its seat, without the secrets in them", async () => {
    const code = await app.inject({
      method: 'POST',
      url: '/api/seats/pairing-codes',
      headers: { cookie: adminCookie },
    });
    const paired = await app.inject({
      method: 'POST',
      url: '/api/seats/pair',
      payload: {
        code: code.json<{ code: string }>().code,
        name: 'maria-mbp',
        kind: 'subscription-laptop',
        engines: ['claude-code'],
        capabilities: { sandbox: true },
      },
    });
    const seat = paired.json<{ seatId: string; token: string }>();
    const sent = await app.inject({
      method: 'POST',
      url: '/api/seats/logs',
      headers: { authorization: `Bearer ${seat.token}` },
      payload: {
        lines: [
          {
            // A date that would dodge the retention, and a run that is not this seat's.
            at: '2099-01-01T00:00:00.000Z',
            level: 'warn',
            message:
              'the claim failed: Authorization: Bearer abc.def-ghi, token glpat-0123456789abcdef',
            runId: '7b5c6f1e-3d2a-4f6b-9a8c-1e2d3c4b5a69',
          },
        ],
      },
    });
    expect(sent.statusCode).toBe(204);
    const [stored] = await db.select().from(logEntries).where(eq(logEntries.source, 'worker'));
    expect(stored).toMatchObject({ level: 40, seatId: seat.seatId, runId: null });
    expect(Math.abs((stored?.at.getTime() ?? 0) - Date.now())).toBeLessThan(6 * 60_000);
    expect(stored?.message).toBe(
      'the claim failed: Authorization: Bearer [redacted], token [redacted]',
    );
    const refused = await app.inject({
      method: 'POST',
      url: '/api/seats/logs',
      headers: { authorization: 'Bearer not-a-seat' },
      payload: { lines: [] },
    });
    expect(refused.statusCode).toBe(401);
  });

  it('are kept for their retention and no longer', async () => {
    await db.insert(logEntries).values({
      at: sql`now() - interval '31 days'`,
      level: 30,
      source: 'server',
      message: 'a month ago',
    });
    await pruneLogs(db, 30);
    const left = await db.select().from(logEntries).where(eq(logEntries.message, 'a month ago'));
    expect(left).toEqual([]);
  });
});

describe('a stored line', () => {
  it('carries no secret in its context or words, and no "incoming request"', () => {
    expect(rowOf(JSON.stringify({ level: 30, time: 1, msg: 'incoming request' }))).toBeUndefined();
    const row = rowOf(
      JSON.stringify({
        level: 50,
        time: 1,
        msg: 'call failed with ghp_abcdefghijklmnopqrstu',
        traceId: 'abc',
        runId: '7b5c6f1e-3d2a-4f6b-9a8c-1e2d3c4b5a69',
        headers: { authorization: 'token secret-value', accept: 'json' },
        err: { message: 'Bearer zzz' },
      }),
    );
    expect(row).toMatchObject({
      level: 50,
      message: 'call failed with [redacted]',
      traceId: 'abc',
      runId: '7b5c6f1e-3d2a-4f6b-9a8c-1e2d3c4b5a69',
      context: {
        headers: { authorization: '[redacted]', accept: 'json' },
        err: { message: 'Bearer [redacted]' },
      },
    });
  });

  it('keeps a request as its route and time', () => {
    expect(
      rowOf(
        JSON.stringify({
          level: 30,
          time: 1,
          msg: 'request completed',
          reqId: 'r1',
          route: 'GET /api/tasks',
          res: { statusCode: 200 },
          responseTime: 12.6,
        }),
      ),
    ).toMatchObject({ span: 'GET /api/tasks', durationMs: 13, traceId: 'r1' });
  });

  it('redacts nested keys and credential-looking values', () => {
    expect(
      redactValue({ a: { apiKey: 'x', list: ['github_pat_0123456789abcdefghijkl'] } }),
    ).toEqual({ a: { apiKey: '[redacted]', list: ['[redacted]'] } });
  });
});
