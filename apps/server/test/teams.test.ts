import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { migrate } from '@agentome/db';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { licenseEnterpriseAt, setupCodeIn } from './app.js';

// Teams as their own thing, against the real server and database.

let container: StartedPostgreSqlContainer;
let app: Awaited<ReturnType<typeof buildApp>>;
let dataDir: string;
let cookie: string;

type Ref = { id: string; name: string };
type Team = { id: string; name: string; mode: string; lead: Ref; members: Ref[]; steps: unknown[] };

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  dataDir = mkdtempSync(join(tmpdir(), 'agentome-teams-'));
  await migrate(container.getConnectionUri());
  app = await buildApp(
    loadConfig({
      AGENTOME_DATABASE_URL: container.getConnectionUri(),
      AGENTOME_DATA_DIR: dataDir,
      AGENTOME_LOG_LEVEL: 'silent',
    }),
  );
  const setup = await app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: {
      code: setupCodeIn(dataDir),
      orgName: 'Acme',
      admin: { name: 'Ann Admin', email: 'admin@example.com', password: 'the admin password' },
    },
  });
  await licenseEnterpriseAt(container.getConnectionUri());
  cookie = cookieOf(setup);
}, 120_000);

afterAll(async () => {
  await app?.close();
  await container?.stop();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

function cookieOf(response: LightMyRequestResponse): string {
  const setCookie = response.headers['set-cookie'] ?? [];
  return (Array.isArray(setCookie) ? setCookie : [setCookie])
    .map((value) => value.split(';', 1)[0])
    .join('; ');
}

const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, payload, headers: { cookie } });

const agent = async (name: string) =>
  (await call('POST', '/api/agents', { name })).json<{ id: string }>().id;

describe('a team', () => {
  it('is made of a lead and members added to it, and its lead leads no other', async () => {
    const [lead, backend, qa] = [await agent('Lead'), await agent('Backend'), await agent('QA')];
    const created = await call('POST', '/api/teams', { name: 'Payments', leadId: lead });
    expect(created.statusCode, created.body).toBe(201);
    const team = created.json<Team>();
    expect(team).toMatchObject({ name: 'Payments', mode: 'auto', lead: { id: lead }, members: [] });

    const grown = await call('PATCH', `/api/teams/${team.id}`, { members: [backend, qa] });
    expect(grown.json<Team>().members.map((member) => member.name)).toEqual(['Backend', 'QA']);
    // The lead's runs now ask about team steps, as its policies show.
    const view = (await call('GET', `/api/agents/${lead}`)).json<{ tools: { name: string }[] }>();
    expect(view.tools.map((tool) => tool.name)).toContain('team_step');

    const second = await call('POST', '/api/teams', { name: 'Again', leadId: lead });
    expect(second.statusCode).toBe(409);
    expect(second.json<{ error: { message: string } }>().error.message).toBe(
      'Lead already leads Payments',
    );
    const own = await call('PATCH', `/api/teams/${team.id}`, { members: [lead] });
    expect(own.statusCode).toBe(400);

    const listed = (await call('GET', '/api/teams')).json<{ teams: Team[] }>().teams;
    expect(listed.map((each) => each.name)).toContain('Payments');
  });

  it('in manual keeps its steps to members, and drops a member who leaves from them', async () => {
    const [lead, a, b] = [await agent('Lead 2'), await agent('A'), await agent('B')];
    const team = (
      await call('POST', '/api/teams', {
        name: 'Steps',
        leadId: lead,
        mode: 'manual',
        members: [a, b],
        steps: [
          { agents: [a], note: 'First' },
          { agents: [b], note: 'Then' },
        ],
      })
    ).json<Team>();
    const left = await call('PATCH', `/api/teams/${team.id}`, { members: [a] });
    expect(left.json<Team>().steps).toEqual([{ agents: [a], note: 'First' }]);
  });

  it('is copied whole: new agents, the steps on them, and the originals untouched', async () => {
    const [lead, a] = [await agent('Lead 3'), await agent('Writer')];
    const team = (
      await call('POST', '/api/teams', {
        name: 'Docs',
        leadId: lead,
        mode: 'manual',
        members: [a],
        steps: [{ agents: [a], note: 'Write' }],
      })
    ).json<Team>();
    const copied = await call('POST', `/api/teams/${team.id}/duplicate`);
    expect(copied.statusCode, copied.body).toBe(201);
    const copy = copied.json<Team>();
    expect(copy.name).toBe('Docs (copy)');
    expect(copy.lead).toMatchObject({ name: 'Lead 3 (copy)' });
    expect(copy.lead.id).not.toBe(lead);
    const writer = copy.members[0];
    expect(writer).toMatchObject({ name: 'Writer (copy)' });
    expect(writer?.id).not.toBe(a);
    expect(copy.steps).toEqual([{ agents: [writer?.id], note: 'Write' }]);

    expect((await call('DELETE', `/api/teams/${team.id}`)).statusCode).toBe(204);
    expect((await call('GET', `/api/teams/${team.id}`)).statusCode).toBe(404);
    expect((await call('GET', `/api/agents/${lead}`)).statusCode).toBe(200);
  });
});
