import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '@agentome/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { prepareInstallation } from '../src/setup.js';
import { setupCodeIn } from './app.js';

// An agent's memory against the real server and database:
// every write is a version, and revert and delete are versions too.

let container: StartedPostgreSqlContainer;
let app: Awaited<ReturnType<typeof buildApp>>;
let dataDir: string;
let admin: Person;

type Person = { id: string; name: string; cookie: string };
type Doc = {
  path: string;
  version: number;
  content: string;
  updatedBy: { kind: string; id: string; name?: string };
};

const cookieOf = (response: LightMyRequestResponse) =>
  [response.headers['set-cookie'] ?? []]
    .flat()
    .map((cookie) => String(cookie).split(';', 1)[0])
    .join('; ');

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  dataDir = mkdtempSync(join(tmpdir(), 'agentome-memory-'));
  await migrate(container.getConnectionUri());
  const config = loadConfig({
    AGENTOME_DATABASE_URL: container.getConnectionUri(),
    AGENTOME_DATA_DIR: dataDir,
    AGENTOME_LOG_LEVEL: 'silent',
    AGENTOME_PUBLIC_URL: 'https://agentome.example.com',
  });
  app = await buildApp(config);
  await prepareInstallation(config, app.log);
  const setup = await app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: {
      code: setupCodeIn(dataDir),
      orgName: 'Acme',
      admin: { name: 'Ann Admin', email: 'admin@example.com', password: 'the admin password' },
    },
  });
  admin = { ...setup.json<Omit<Person, 'cookie'>>(), cookie: cookieOf(setup) };
}, 120_000);

afterAll(async () => {
  await app?.close();
  await container?.stop();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

const call = (
  who: Person,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
) => app.inject({ method, url, payload, headers: { cookie: who.cookie } });

async function agent(who: Person): Promise<string> {
  const templates = (await call(who, 'GET', '/api/templates')).json<{
    templates: { id: string; name: string }[];
  }>().templates;
  const backend = templates.find((template) => template.name === 'Backend developer');
  const created = await call(who, 'POST', '/api/agents', {
    templateId: backend?.id,
    name: 'Payments',
  });
  expect(created.statusCode).toBe(201);
  return created.json<{ id: string }>().id;
}

async function member(): Promise<Person> {
  const invitation = await call(admin, 'POST', '/api/invitations', {});
  const token = invitation.json<{ url: string }>().url.split('/invite/')[1];
  const accepted = await app.inject({
    method: 'POST',
    url: `/api/invitations/${token}/accept`,
    payload: { name: 'Bob', email: 'bob@example.com', password: 'a long enough password' },
  });
  return { ...accepted.json<Omit<Person, 'cookie'>>(), cookie: cookieOf(accepted) };
}

const write = (id: string, body: object) => call(admin, 'PUT', `/api/agents/${id}/memory`, body);
const versions = async (id: string, path: string) =>
  (await call(admin, 'GET', `/api/agents/${id}/memory/versions?path=${path}`)).json<{
    versions: Doc[];
  }>().versions;

describe('agent memory', () => {
  it('writes versions per document, newest on top, signed by the person', async () => {
    const id = await agent(admin);
    expect((await call(admin, 'GET', `/api/agents/${id}/memory`)).json()).toEqual({
      documents: [],
    });

    const first = await write(id, { path: 'MEMORY.md', content: '# Payments\n' });
    expect(first.statusCode).toBe(200);
    expect(first.json<Doc>()).toMatchObject({
      path: 'MEMORY.md',
      version: 1,
      updatedBy: { kind: 'user', id: admin.id, name: 'Ann Admin' },
    });
    await write(id, { path: 'MEMORY.md', content: '# Payments\n\nRetries freeze time.\n' });
    await write(id, { path: 'memory/stripe.md', content: 'The SDK is pinned at 19.2.\n' });

    const now = (await call(admin, 'GET', `/api/agents/${id}/memory`)).json<{ documents: Doc[] }>();
    expect(now.documents.map((doc) => [doc.path, doc.version])).toEqual([
      ['MEMORY.md', 2],
      ['memory/stripe.md', 1],
    ]);
    expect((await versions(id, 'MEMORY.md')).map((doc) => doc.version)).toEqual([2, 1]);
  });

  it('refuses a write from a stale version, and keeps what was written since', async () => {
    const id = await agent(admin);
    await write(id, { path: 'MEMORY.md', content: 'one' });
    await write(id, { path: 'MEMORY.md', content: 'two', baseVersion: 1 });
    const stale = await write(id, { path: 'MEMORY.md', content: 'mine', baseVersion: 1 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json<{ error: { code: string } }>().error.code).toBe('memory_conflict');
    expect((await versions(id, 'MEMORY.md'))[0]?.content).toBe('two');
  });

  it('reverts and deletes as new versions, so the history keeps everything', async () => {
    const id = await agent(admin);
    await write(id, { path: 'memory/notes.md', content: 'first' });
    await write(id, { path: 'memory/notes.md', content: 'second' });
    const reverted = await call(admin, 'POST', `/api/agents/${id}/memory/revert`, {
      path: 'memory/notes.md',
      version: 1,
    });
    expect(reverted.json<Doc>()).toMatchObject({ version: 3, content: 'first' });
    const missing = await call(admin, 'POST', `/api/agents/${id}/memory/revert`, {
      path: 'memory/notes.md',
      version: 9,
    });
    expect(missing.statusCode).toBe(404);

    const deleted = await call(admin, 'DELETE', `/api/agents/${id}/memory?path=memory/notes.md`);
    expect(deleted.statusCode).toBe(204);
    expect((await call(admin, 'GET', `/api/agents/${id}/memory`)).json()).toEqual({
      documents: [],
    });
    expect((await versions(id, 'memory/notes.md')).map((doc) => doc.content)).toEqual([
      '',
      'first',
      'second',
      'first',
    ]);
    const again = await call(admin, 'DELETE', `/api/agents/${id}/memory?path=memory/notes.md`);
    expect(again.statusCode).toBe(404);
  });

  it('takes only paths that land in the profile, and only on agents the person holds', async () => {
    const id = await agent(admin);
    for (const path of [
      '../secrets.md',
      'memory/a/b.md',
      'notes.txt',
      '/MEMORY.md',
      'memory/.md',
    ]) {
      const bad = await write(id, { path, content: 'x' });
      expect(bad.statusCode, path).toBe(400);
    }
    const bob = await member();
    await write(id, { path: 'MEMORY.md', content: 'private to the owner' });
    expect((await call(bob, 'GET', `/api/agents/${id}/memory`)).statusCode).toBe(404);
    expect(
      (await call(bob, 'PUT', `/api/agents/${id}/memory`, { path: 'MEMORY.md', content: 'x' }))
        .statusCode,
    ).toBe(404);
  });
});
