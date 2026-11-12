import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentGrants,
  agents,
  and,
  catalogItems,
  costEvents,
  createDb,
  type Db,
  eq,
  isNull,
  migrate,
  runs,
  sql,
  tasks,
  toolCalls,
} from '@agentome/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { LaunchPackage } from '../src/protocol.js';
import { returnDueAgents } from '../src/agents/ownership.js';
import { enqueueRun } from '../src/runs/service.js';
import { prepareInstallation } from '../src/setup.js';
import { licenseEnterprise, projectOfAgent, setupCodeIn } from './app.js';

// The agents API against the real server and database:
// every route checks a grant, and the preview shows what a run of the agent gets.

let container: StartedPostgreSqlContainer;
let app: Awaited<ReturnType<typeof buildApp>>;
let db: Db;
let dataDir: string;
let config: ReturnType<typeof loadConfig>;
let admin: Person;

type Person = { id: string; email: string; name: string; cookie: string };
type Template = { id: string; name: string; version: number; roleTitle: string };
type Agent = {
  id: string;
  name: string;
  roleTitle: string;
  instructions: string;
  status: string;
  modelPref: string | null;
  budget: Record<string, number> | null;
  owner: { id: string; name: string };
  template: { id: string; name: string; version: number } | null;
  copiedFromAgentId: string | null;
  lastRun: { id: string; taskId: string | null; status: string; at: string } | null;
  week?: {
    runs: number;
    usd: string | null;
    ended: number;
    done: number;
    medianSeconds: number | null;
    daily: number[];
  };
  seat: { name: string; busy: boolean } | null;
  people: { id: string; level: string }[];
  tools: { connector: string; name: string; policy: string }[];
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  dataDir = mkdtempSync(join(tmpdir(), 'agentome-agents-'));
  await migrate(container.getConnectionUri());
  config = loadConfig({
    AGENTOME_DATABASE_URL: container.getConnectionUri(),
    AGENTOME_DATA_DIR: dataDir,
    AGENTOME_LOG_LEVEL: 'silent',
    AGENTOME_PUBLIC_URL: 'https://agentome.example.com',
  });
  app = await buildApp(config);
  // What every start does after the migrations: here, the templates are seeded.
  await prepareInstallation(config, app.log);
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
  admin = { ...setup.json<Omit<Person, 'cookie'>>(), cookie: cookieOf(setup) };
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
/** A member who joined by invitation, signed in. */
async function person(): Promise<Person> {
  people += 1;
  const invitation = await call(admin, 'POST', '/api/invitations', {});
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
  expect(accepted.statusCode).toBe(201);
  return { ...accepted.json<Omit<Person, 'cookie'>>(), cookie: cookieOf(accepted) };
}

const call = (
  who: Person,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  url: string,
  payload?: object,
) => app.inject({ method, url, payload, headers: { cookie: who.cookie } });

async function templates(): Promise<Template[]> {
  const response = await call(admin, 'GET', '/api/templates');
  expect(response.statusCode).toBe(200);
  return response.json<{ templates: Template[] }>().templates;
}

async function create(who: Person, body: object): Promise<Agent> {
  const response = await call(who, 'POST', '/api/agents', body);
  expect(response.statusCode).toBe(201);
  return response.json<Agent>();
}

const backend = async () => {
  const found = (await templates()).find((template) => template.name === 'Backend developer');
  if (!found) throw new Error('no Backend developer template');
  return found;
};

const list = async (who: Person, query = '') =>
  (await call(who, 'GET', `/api/agents${query}`)).json<{ agents: Agent[] }>().agents;

describe('role templates', () => {
  it('lists the seven platform templates by name, with a line about each', async () => {
    const all = await templates();
    expect(all.map((template) => template.name)).toEqual([
      'Backend developer',
      'Code reviewer',
      'Frontend developer',
      'Product owner',
      'QA engineer',
      'Release manager',
      'Technical writer',
    ]);
    for (const template of all) {
      expect(template).toMatchObject({ version: 1, description: expect.any(String) });
    }
  });

  it('are seeded once however many times the server starts, and versioned when they change', async () => {
    await Promise.all([prepareInstallation(config, app.log), prepareInstallation(config, app.log)]);
    const rows = () =>
      db
        .select()
        .from(catalogItems)
        .where(and(eq(catalogItems.kind, 'template'), isNull(catalogItems.ownerUserId)));
    expect(await rows()).toHaveLength(7);

    // A text that differs from the one the server ships, as after an upgrade.
    const { id } = await backend();
    await db
      .update(catalogItems)
      .set({ spec: sql`jsonb_set(${catalogItems.spec}, '{instructions}', '"Older text"')` })
      .where(eq(catalogItems.id, id));
    await prepareInstallation(config, app.log);
    await prepareInstallation(config, app.log);
    const [updated] = await db.select().from(catalogItems).where(eq(catalogItems.id, id));
    expect(updated?.version).toBe('2');
    expect(updated?.spec).toMatchObject({
      instructions: expect.stringContaining('## What you own'),
    });
    expect(await rows()).toHaveLength(7);
  });
});

describe('creating an agent', () => {
  it('copies a template and grants its creator ownership in the same step', async () => {
    const maria = await person();
    const template = await backend();
    const agent = await create(maria, { name: 'Payments backend', templateId: template.id });
    expect(agent).toMatchObject({
      name: 'Payments backend',
      roleTitle: 'Backend engineer',
      status: 'active',
      modelPref: 'claude-sonnet-5-5',
      budget: { maxTurns: 80 },
      owner: { id: maria.id, name: maria.name },
      template: { id: template.id, name: 'Backend developer', version: template.version },
      lastRun: null,
      seat: null,
      people: [{ id: maria.id, level: 'owner' }],
    });
    expect(agent.instructions).toContain('## What you own');
    // The workspace tools, always allowed, then the gateway's under their default policy.
    expect(agent.tools.map((tool) => [tool.connector, tool.name, tool.policy])).toEqual([
      ['Workspace', 'Bash', 'allow'],
      ['Workspace', 'Glob', 'allow'],
      ['Workspace', 'Grep', 'allow'],
      ['Workspace', 'Read', 'allow'],
      ['Workspace', 'TodoWrite', 'allow'],
      ['Code host', 'code_host_create_branch', 'allow'],
      ['Code host', 'code_host_open_change_request', 'ask'],
      ['Code host', 'code_host_get_change_request', 'allow'],
      ['Code host', 'code_host_get_pipeline_failures', 'allow'],
      ['Code host', 'code_host_reply_to_review', 'allow'],
      ['Task', 'task_comment', 'allow'],
      ['Memory', 'memory_read', 'allow'],
      ['Memory', 'memory_write', 'allow'],
      ['Knowledge', 'knowledge_search', 'allow'],
      ['Knowledge', 'knowledge_read', 'allow'],
      ['Jira', 'jira_get_issue', 'allow'],
      ['Jira', 'jira_add_comment', 'ask'],
    ]);
    const grants = await db.select().from(agentGrants).where(eq(agentGrants.agentId, agent.id));
    expect(grants).toMatchObject([{ userId: maria.id, level: 'owner' }]);
  });

  it('makes a blank agent, and refuses a missing template or name', async () => {
    const maria = await person();
    const blank = await create(maria, { name: '  Scratch  ', roleTitle: 'Helper' });
    expect(blank).toMatchObject({
      name: 'Scratch',
      roleTitle: 'Helper',
      instructions: '',
      modelPref: null,
      budget: null,
      template: null,
    });
    const missing = await call(maria, 'POST', '/api/agents', {
      name: 'Ghost',
      templateId: '7f3a9c21-0000-4000-8000-000000000009',
    });
    expect(missing.statusCode).toBe(404);
    const nameless = await call(maria, 'POST', '/api/agents', { name: ' ' });
    expect(nameless.statusCode).toBe(400);
    expect(nameless.json()).toMatchObject({ error: { code: 'validation_failed' } });
  });

  it('needs a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/agents' });
    expect(response.statusCode).toBe(401);
  });
});

describe('access', () => {
  it("shows a person their own agents only, and someone else's agent is not found", async () => {
    const maria = await person();
    const ilya = await person();
    const agent = await create(maria, { name: 'Maria’s reviewer' });
    expect((await list(maria)).map((item) => item.id)).toContain(agent.id);
    expect((await list(ilya)).map((item) => item.id)).not.toContain(agent.id);

    const routes: ['GET' | 'POST' | 'PATCH', string, object?][] = [
      ['GET', ''],
      ['PATCH', '', { name: 'Taken' }],
      ['POST', '/duplicate'],
      ['GET', '/export'],
      ['POST', '/archive'],
      ['POST', '/unarchive'],
      ['GET', '/workspace-preview'],
    ];
    for (const [method, path, body] of routes) {
      const response = await call(ilya, method, `/api/agents/${agent.id}${path}`, body);
      expect(response.statusCode, `${method} ${path}`).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'not_found' } });
    }
    const [unchanged] = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect(unchanged).toMatchObject({ name: 'Maria’s reviewer', status: 'active' });
  });

  it('lists every agent for an admin who asks, and only for an admin', async () => {
    const maria = await person();
    const agent = await create(maria, { name: 'For the dashboard' });
    expect((await list(admin)).map((item) => item.id)).not.toContain(agent.id);
    expect((await list(admin, '?all=true')).map((item) => item.id)).toContain(agent.id);
    const refused = await call(maria, 'GET', '/api/agents?all=true');
    expect(refused.statusCode).toBe(403);
  });
});

describe('changing an agent', () => {
  it('saves the identity, instructions, model and budget', async () => {
    const maria = await person();
    const agent = await create(maria, { name: 'Draft', templateId: (await backend()).id });
    const response = await call(maria, 'PATCH', `/api/agents/${agent.id}`, {
      name: 'Billing backend',
      roleTitle: 'Senior backend engineer, Billing',
      instructions: '## Rules\n\nWrite the test first.',
      modelPref: 'claude-opus-5-5',
      budget: { maxMinutes: 30, maxTurns: 120, maxTokens: 1_000_000, usdPerMonth: 250 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      name: 'Billing backend',
      roleTitle: 'Senior backend engineer, Billing',
      instructions: '## Rules\n\nWrite the test first.',
      modelPref: 'claude-opus-5-5',
      budget: { maxMinutes: 30, maxTurns: 120, maxTokens: 1_000_000, usdPerMonth: 250 },
    });

    const cleared = await call(maria, 'PATCH', `/api/agents/${agent.id}`, {
      modelPref: null,
      budget: {},
    });
    expect(cleared.json()).toMatchObject({
      name: 'Billing backend',
      modelPref: null,
      budget: null,
    });
  });

  it('refuses a model that looks like a flag and a budget it does not know', async () => {
    const maria = await person();
    const agent = await create(maria, { name: 'Strict' });
    for (const body of [
      { modelPref: '--dangerously-skip-permissions' },
      { budget: { maxTurns: 0 } },
      { budget: { tokens: 5 } },
      { name: '' },
    ]) {
      const response = await call(maria, 'PATCH', `/api/agents/${agent.id}`, body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it('refuses a change that a page of another site sends with the person’s cookie', async () => {
    const maria = await person();
    const agent = await create(maria, { name: 'Kept' });
    const archive = (origin?: string) =>
      app.inject({
        method: 'POST',
        url: `/api/agents/${agent.id}/archive`,
        headers: { cookie: maria.cookie, ...(origin && { origin }) },
      });
    for (const origin of ['https://wiki.example.com', 'http://localhost:3001', 'null']) {
      const refused = await archive(origin);
      expect(refused.statusCode, origin).toBe(403);
      expect(refused.json()).toMatchObject({
        error: { code: 'forbidden', message: 'This request came from another site' },
      });
    }
    const [kept] = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect(kept?.status).toBe('active');
    // Reading is anyone's who has the cookie; Agentome's own page changes what it likes.
    const read = await app.inject({
      url: `/api/agents/${agent.id}`,
      headers: { cookie: maria.cookie, origin: 'https://wiki.example.com' },
    });
    expect(read.statusCode).toBe(200);
    expect((await archive(new URL(config.publicUrl).origin)).statusCode).toBe(200);
  });

  it('archives an agent out of the list, cancelling its queued runs, and brings it back', async () => {
    const maria = await person();
    const agent = await create(maria, { name: 'Seasonal' });
    const [task] = await db
      .insert(tasks)
      .values({ agentId: agent.id, title: 'Later', source: 'manual', createdBy: maria.id })
      .returning();
    if (!task) throw new Error('no task');
    const waiting = await enqueueRun(db, task.id, maria.id);

    const archived = await call(maria, 'POST', `/api/agents/${agent.id}/archive`);
    expect(archived.json()).toMatchObject({ status: 'archived', lastRun: { status: 'cancelled' } });
    expect((await list(maria)).map((item) => item.id)).not.toContain(agent.id);
    expect((await list(maria, '?archived=true')).map((item) => item.id)).toEqual([agent.id]);

    // Back, the agent does not start the run it was given before.
    const back = await call(maria, 'POST', `/api/agents/${agent.id}/unarchive`);
    expect(back.json()).toMatchObject({ status: 'active' });
    expect((await list(maria)).map((item) => item.id)).toContain(agent.id);
    const [run] = await db.select().from(runs).where(eq(runs.id, waiting.id));
    expect(run).toMatchObject({ status: 'cancelled', endedAt: expect.any(Date) });
  });
});

describe('transferring an agent', () => {
  const transfer = (who: Person, agentId: string, body: object) =>
    call(who, 'POST', `/api/agents/${agentId}/transfer`, body);
  const sees = async (who: Person, agentId: string) =>
    (await call(who, 'GET', `/api/agents/${agentId}`)).statusCode === 200;
  const grantsOf = (agentId: string) =>
    db.select().from(agentGrants).where(eq(agentGrants.agentId, agentId));
  const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

  it('gives the agent to another person for good: its tasks and queued runs go along', async () => {
    const [maria, ilya] = [await person(), await person()];
    const agent = await create(maria, { name: 'Handed over' });
    const task = (
      await call(maria, 'POST', '/api/tasks', {
        agentId: agent.id,
        projectId: await projectOfAgent(db, agent.id),
        title: 'Stays queued',
      })
    ).json<{ task: { id: string }; run: { id: string } }>();

    const done = await transfer(maria, agent.id, { to: ilya.id });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toEqual({
      transferred: [{ id: agent.id, name: 'Handed over' }],
      to: { id: ilya.id, name: ilya.name },
      until: null,
    });
    expect(await sees(maria, agent.id)).toBe(false);
    const theirs = (await call(ilya, 'GET', `/api/agents/${agent.id}`)).json<Agent>();
    expect(theirs.owner).toEqual({ id: ilya.id, name: ilya.name });
    expect(await grantsOf(agent.id)).toMatchObject([
      { userId: ilya.id, level: 'owner', validFrom: null, validUntil: null },
    ]);
    // The task is read by the agent's grant, and its run waits for the new owner's computer.
    expect((await call(ilya, 'GET', `/api/tasks/${task.task.id}`)).statusCode).toBe(200);
    expect((await call(maria, 'GET', `/api/tasks/${task.task.id}`)).statusCode).toBe(404);
    const [run] = await db.select().from(runs).where(eq(runs.id, task.run.id));
    expect(run?.status).toBe('queued');
  });

  it('refuses what makes no sense, and anyone who is neither its owner nor an admin', async () => {
    const [maria, ilya, olga] = [await person(), await person(), await person()];
    const agent = await create(maria, { name: 'Kept' });
    expect((await transfer(ilya, agent.id, { to: ilya.id })).statusCode).toBe(404);
    expect((await transfer(maria, agent.id, { to: maria.id })).json()).toMatchObject({
      error: { message: `Kept is ${maria.name}'s already` },
    });
    expect((await transfer(maria, agent.id, { to: crypto.randomUUID() })).statusCode).toBe(400);
    expect((await transfer(maria, agent.id, { to: ilya.id, until: inDays(-1) })).statusCode).toBe(
      400,
    );
    await call(admin, 'PATCH', `/api/users/${olga.id}`, { disabled: true });
    expect((await transfer(maria, agent.id, { to: olga.id })).json()).toMatchObject({
      error: { message: 'There is no such person to transfer to' },
    });

    // A run that is going keeps its computer: nothing changes hands under it.
    const task = (
      await call(maria, 'POST', '/api/tasks', {
        agentId: agent.id,
        projectId: await projectOfAgent(db, agent.id),
        title: 'Going',
      })
    ).json<{ run: { id: string } }>();
    await db.update(runs).set({ status: 'running' }).where(eq(runs.id, task.run.id));
    const busy = await transfer(maria, agent.id, { to: ilya.id });
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toMatchObject({ error: { code: 'run_in_progress' } });
    await db.update(runs).set({ status: 'done' }).where(eq(runs.id, task.run.id));

    // An admin transfers an agent that is not theirs: that is how it leaves someone who is away.
    expect((await transfer(admin, agent.id, { to: ilya.id })).statusCode).toBe(200);
    expect(await sees(ilya, agent.id)).toBe(true);
  });

  it('moves a lead with its whole team, and never a member alone', async () => {
    const [maria, ilya] = [await person(), await person()];
    const lead = await create(maria, { name: 'Team lead' });
    const members = [await create(maria, { name: 'Writer' }), await create(maria, { name: 'QA' })];
    const team = await call(maria, 'POST', '/api/teams', {
      name: 'Delivery',
      leadId: lead.id,
      members: members.map((member) => member.id),
    });
    expect(team.statusCode).toBe(201);

    expect((await transfer(maria, members[0]!.id, { to: ilya.id })).json()).toMatchObject({
      error: {
        message: "Writer is in Team lead's team: transfer Team lead, and its team goes with it",
      },
    });
    const done = await transfer(maria, lead.id, { to: ilya.id });
    expect(
      done.json<{ transferred: { name: string }[] }>().transferred.map((one) => one.name),
    ).toEqual(['Team lead', 'Writer', 'QA']);
    for (const one of [lead, ...members]) {
      expect(await sees(ilya, one.id)).toBe(true);
      expect(await sees(maria, one.id)).toBe(false);
    }
    // The team is its lead's owner's: Ilya sees it, and may give it to a project of his.
    const teams = (await call(ilya, 'GET', '/api/teams')).json<{ teams: { name: string }[] }>();
    expect(teams.teams.map((one) => one.name)).toContain('Delivery');
    expect((await call(maria, 'GET', '/api/teams')).json<{ teams: object[] }>().teams).toEqual([]);
  });

  it('lends an agent until a day, and it comes back by itself', async () => {
    const [maria, ilya, olga] = [await person(), await person(), await person()];
    const agent = await create(maria, { name: 'On loan' });
    const until = inDays(14);
    const lent = await transfer(maria, agent.id, { to: ilya.id, until });
    expect(lent.json()).toMatchObject({ until });
    expect(await sees(ilya, agent.id)).toBe(true);
    expect(await sees(maria, agent.id)).toBe(false);
    const view = (await call(ilya, 'GET', `/api/agents/${agent.id}`)).json<{
      owner: { id: string };
      people: { id: string; validFrom: string | null; validUntil: string | null }[];
    }>();
    expect(view.owner.id).toBe(ilya.id);
    expect(view.people).toEqual([
      expect.objectContaining({ id: maria.id, validFrom: until, validUntil: null }),
      expect.objectContaining({ id: ilya.id, validFrom: null, validUntil: until }),
    ]);

    // Its owner decides nothing while it is away: not a run of it, not a call that waits.
    const task = (
      await call(ilya, 'POST', '/api/tasks', {
        agentId: agent.id,
        projectId: await projectOfAgent(db, agent.id),
        title: 'While away',
      })
    ).json<{ run: { id: string } }>();
    const [asked] = await db
      .insert(toolCalls)
      .values({
        runId: task.run.id,
        agentId: agent.id,
        tool: 'jira_add_comment',
        input: {},
        decision: 'pending',
      })
      .returning({ id: toolCalls.id });
    await db
      .update(runs)
      .set({
        status: 'waiting_approval',
        startedAt: new Date(),
        limits: { maxMinutes: 60, maxTurns: 50, maxTokens: 2_000_000 },
      })
      .where(eq(runs.id, task.run.id));
    const approve = (who: Person) => call(who, 'POST', `/api/tool-calls/${asked?.id}/approve`);
    expect((await approve(maria)).statusCode).toBe(404);
    expect((await call(maria, 'POST', `/api/runs/${task.run.id}/cancel`)).statusCode).toBe(404);
    expect((await approve(ilya)).statusCode).toBe(200);
    expect((await call(ilya, 'POST', `/api/runs/${task.run.id}/cancel`)).statusCode).toBe(200);
    await db.update(runs).set({ status: 'cancelled' }).where(eq(runs.id, task.run.id));

    // Until then it can only go back early: not on to a third person, not for longer.
    expect((await transfer(ilya, agent.id, { to: olga.id })).json()).toMatchObject({
      error: {
        message: `On loan goes back to ${maria.name} on ${until.slice(0, 10)}: until then it can only be returned early`,
      },
    });
    expect((await transfer(ilya, agent.id, { to: maria.id, until: inDays(30) })).statusCode).toBe(
      400,
    );
    // Nothing is due yet.
    expect(await returnDueAgents(db)).toEqual([]);

    // The day comes.
    const past = new Date(Date.now() - 60_000);
    await db.update(agentGrants).set({ validFrom: past }).where(eq(agentGrants.userId, maria.id));
    await db.update(agentGrants).set({ validUntil: past }).where(eq(agentGrants.userId, ilya.id));
    expect(await returnDueAgents(db)).toEqual([agent.id]);
    expect(await sees(maria, agent.id)).toBe(true);
    expect(await sees(ilya, agent.id)).toBe(false);
    expect(await grantsOf(agent.id)).toMatchObject([
      { userId: maria.id, validFrom: null, validUntil: null },
    ]);
    const [row] = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect(row?.ownerUserId).toBe(maria.id);

    // Lent again and returned early by the one who has it.
    await transfer(maria, agent.id, { to: ilya.id, until: inDays(7) });
    expect((await transfer(ilya, agent.id, { to: maria.id })).statusCode).toBe(200);
    expect(await sees(maria, agent.id)).toBe(true);
    expect(await grantsOf(agent.id)).toHaveLength(1);
  });

  it('hands everything a person owns to a successor, for an admin: what they had for a time goes back', async () => {
    const [maria, ilya, olga, pavel] = [
      await person(),
      await person(),
      await person(),
      await person(),
    ];
    const own = await create(maria, { name: 'Her own' });
    const borrowed = await create(olga, { name: 'Borrowed from Olga' });
    await transfer(olga, borrowed.id, { to: maria.id, until: inDays(10) });
    const away = await create(maria, { name: 'Lent to Pavel' });
    await transfer(maria, away.id, { to: pavel.id, until: inDays(10) });

    const handOver = (who: Person, to: string) =>
      call(who, 'POST', `/api/users/${maria.id}/transfer-agents`, { to });
    expect((await handOver(ilya, ilya.id)).statusCode).toBe(403);
    expect((await handOver(admin, maria.id)).statusCode).toBe(400);
    const done = await handOver(admin, ilya.id);
    expect(done.statusCode).toBe(200);
    expect(done.json()).toEqual({
      transferred: [{ id: own.id, name: 'Her own' }],
      returned: [{ id: borrowed.id, name: 'Borrowed from Olga' }],
      to: { id: ilya.id, name: ilya.name },
    });
    expect(await sees(ilya, own.id)).toBe(true);
    expect(await sees(olga, borrowed.id)).toBe(true);
    // Pavel keeps what he was lent until its day; then it is the successor's, not Maria's.
    expect(await sees(pavel, away.id)).toBe(true);
    const past = new Date(Date.now() - 60_000);
    await db
      .update(agentGrants)
      .set({ validFrom: past })
      .where(and(eq(agentGrants.agentId, away.id), sql`${agentGrants.validFrom} is not null`));
    expect(await returnDueAgents(db)).toEqual([away.id]);
    expect(await sees(ilya, away.id)).toBe(true);
    expect(await sees(pavel, away.id)).toBe(false);
    expect(await list(maria)).toEqual([]);
  });

  it('names the people an agent can go to, without their addresses', async () => {
    const [maria, gone] = [await person(), await person()];
    await call(admin, 'PATCH', `/api/users/${gone.id}`, { disabled: true });
    const listed = await call(maria, 'GET', '/api/people');
    expect(listed.statusCode).toBe(200);
    const { people } = listed.json<{ people: { id: string; name: string }[] }>();
    expect(people).toContainEqual({ id: maria.id, name: maria.name });
    expect(people.map((one) => one.id)).not.toContain(gone.id);
    expect(listed.body).not.toContain('@');
  });
});

describe('approving a call and not being asked again', () => {
  /** A call of the agent's that waits for its owner, on a run that is going. */
  async function waiting(owner: Person, agentId: string, tool: string) {
    const task = (
      await call(owner, 'POST', '/api/tasks', {
        agentId,
        projectId: await projectOfAgent(db, agentId),
        title: `Calls ${tool}`,
      })
    ).json<{ run: { id: string } }>();
    await db
      .update(runs)
      .set({
        status: 'waiting_approval',
        startedAt: new Date(),
        limits: { maxMinutes: 60, maxTurns: 50, maxTokens: 2_000_000 },
      })
      .where(eq(runs.id, task.run.id));
    const [asked] = await db
      .insert(toolCalls)
      .values({ runId: task.run.id, agentId, tool, input: {}, decision: 'pending' })
      .returning({ id: toolCalls.id });
    return asked?.id ?? '';
  }
  const policyOf = async (owner: Person, agentId: string, tool: string) =>
    (await call(owner, 'GET', `/api/agents/${agentId}`))
      .json<{ tools: { name: string; policy: string }[] }>()
      .tools.find((one) => one.name === tool)?.policy;

  it('lets the call run and allows the tool from then on; a plain approve changes nothing', async () => {
    const maria = await person();
    const agent = await create(maria, { name: 'Asks less' });
    const tool = 'code_host_open_change_request';
    expect(await policyOf(maria, agent.id, tool)).toBe('ask');

    const once = await waiting(maria, agent.id, tool);
    expect((await call(maria, 'POST', `/api/tool-calls/${once}/approve`)).statusCode).toBe(200);
    expect(await policyOf(maria, agent.id, tool)).toBe('ask');

    const forGood = await waiting(maria, agent.id, tool);
    const approved = await call(maria, 'POST', `/api/tool-calls/${forGood}/approve`, {
      always: true,
    });
    expect(approved.json()).toMatchObject({ decision: 'approved' });
    expect(await policyOf(maria, agent.id, tool)).toBe('allow');
    // Its other policies are as they were.
    expect(await policyOf(maria, agent.id, 'jira_add_comment')).toBe('ask');
  });

  it('keeps asking a question each time, and changes nothing for someone else', async () => {
    const [maria, ilya] = [await person(), await person()];
    const agent = await create(maria, { name: 'Asks a question' });
    const asked = await waiting(maria, agent.id, 'ask_owner');
    const refused = await call(maria, 'POST', `/api/tool-calls/${asked}/approve`, { always: true });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({
      error: { message: 'A question is asked each time: answer this one' },
    });

    const theirs = await waiting(maria, agent.id, 'jira_add_comment');
    const stranger = await call(ilya, 'POST', `/api/tool-calls/${theirs}/approve`, {
      always: true,
    });
    expect(stranger.statusCode).toBe(404);
    expect(await policyOf(maria, agent.id, 'jira_add_comment')).toBe('ask');
  });
});

describe('the list says what an agent is on', () => {
  it("names the task of each agent's latest run, and its project", async () => {
    const maria = await person();
    const [busy, idle] = [
      await create(maria, { name: 'Busy' }),
      await create(maria, { name: 'Idle' }),
    ];
    const project = (await call(maria, 'POST', '/api/projects', { name: 'Payments' })).json<{
      id: string;
    }>();
    await call(maria, 'PUT', `/api/projects/${project.id}/agents/${busy.id}`);
    await call(maria, 'POST', '/api/tasks', {
      agentId: busy.id,
      projectId: project.id,
      title: 'Already there',
    });
    const second = await call(maria, 'POST', '/api/tasks', {
      agentId: busy.id,
      projectId: project.id,
      title: 'Fix the flaky test',
    });
    expect(second.statusCode).toBe(201);
    const listed = (await call(maria, 'GET', '/api/agents')).json<{
      agents: { id: string; lastRun: { status: string; task: object | null } | null }[];
    }>().agents;
    expect(listed.find((one) => one.id === busy.id)?.lastRun).toMatchObject({
      status: 'queued',
      task: { title: 'Fix the flaky test', project: 'Payments' },
    });
    expect(listed.find((one) => one.id === idle.id)?.lastRun).toBeNull();
    // An agent's own page has its last run without the task: the page shows it elsewhere.
    const own = (await call(maria, 'GET', `/api/agents/${busy.id}`)).json<{
      lastRun: { task: object | null };
    }>();
    expect(own.lastRun.task).toBeNull();
  });
});

describe('duplicate and export', () => {
  it('copies the configuration to the person who duplicates, without the grants', async () => {
    const maria = await person();
    const ilya = await person();
    const source = await create(maria, { name: 'Original', templateId: (await backend()).id });
    // A second grant on the source, the way a deputy's grant would stand.
    await db.insert(agentGrants).values({ agentId: source.id, userId: ilya.id, level: 'owner' });

    const response = await call(ilya, 'POST', `/api/agents/${source.id}/duplicate`);
    expect(response.statusCode).toBe(201);
    const copy = response.json<Agent>();
    expect(copy).toMatchObject({
      name: 'Original (copy)',
      roleTitle: source.roleTitle,
      instructions: source.instructions,
      modelPref: source.modelPref,
      budget: source.budget,
      template: source.template,
      copiedFromAgentId: source.id,
      owner: { id: ilya.id },
      people: [{ id: ilya.id, level: 'owner' }],
    });
    expect(copy.id).not.toBe(source.id);
  });

  it('exports the configuration as a file, with no ids, grants or tokens', async () => {
    const maria = await person();
    const template = await backend();
    const agent = await create(maria, { name: 'Ünïcode agent / v2', templateId: template.id });
    const response = await call(maria, 'GET', `/api/agents/${agent.id}/export`);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="unicode-agent-v2.agent.json"',
    );
    const file = response.json<{ format: string; agent: Record<string, unknown> }>();
    expect(file).toEqual({
      format: 'agentome/agent@2',
      agent: {
        name: 'Ünïcode agent / v2',
        roleTitle: 'Backend engineer',
        instructions: agent.instructions,
        engine: 'claude-code',
        modelPref: 'claude-sonnet-5-5',
        budget: { maxTurns: 80 },
        skills: [],
        tools: [],
        mcpServers: [],
        template: { name: 'Backend developer', version: template.version },
      },
    });
    for (const id of [agent.id, maria.id, template.id]) expect(response.body).not.toContain(id);
  });

  it('imports an agent file into another person: its skills join their library', async () => {
    const maria = await person();
    const ilya = await person();
    const agent = await create(maria, { name: 'Notes writer', templateId: (await backend()).id });
    const notes =
      '---\nname: release-notes\ndescription: Writes the release notes.\n---\n\nGroup by area.';
    const skill = await call(maria, 'POST', '/api/library/skills', { content: notes });
    await call(maria, 'PUT', `/api/agents/${agent.id}/skills`, {
      skills: [skill.json<{ id: string }>().id],
    });
    await call(maria, 'PUT', `/api/agents/${agent.id}/tools/jira_add_comment`, { policy: 'allow' });
    const file = (await call(maria, 'GET', `/api/agents/${agent.id}/export`)).json<{
      agent: { skills: { content: string }[]; tools: unknown[]; mcpServers: unknown[] };
    }>();
    expect(file.agent.skills).toEqual([{ content: notes }]);
    expect(file.agent.tools).toEqual([{ name: 'jira_add_comment', policy: 'allow' }]);

    // Another person: the skill becomes theirs, and the server the file names is one they lack.
    file.agent.mcpServers = [{ name: 'jira' }];
    const imported = await call(ilya, 'POST', '/api/agents/import', file);
    expect(imported.statusCode).toBe(201);
    const result = imported.json<{
      agent: { id: string };
      skills: object[];
      missingServers: string[];
    }>();
    expect(result.skills).toEqual([{ name: 'release-notes', version: 1, added: true }]);
    expect(result.missingServers).toEqual(['jira']);
    const sheet = (await call(ilya, 'GET', `/api/agents/${result.agent.id}`)).json<{
      name: string;
      template: { name: string } | null;
      skills: { name: string; privateTo?: string }[];
      tools: { name: string; policy: string }[];
    }>();
    expect(sheet.name).toBe('Notes writer');
    expect(sheet.template?.name).toBe('Backend developer');
    expect(sheet.skills.map((one) => one.name)).toEqual(['release-notes']);
    expect(sheet.tools.find((tool) => tool.name === 'jira_add_comment')?.policy).toBe('allow');

    // The same text again is the skill they have; a changed one is its next version.
    const again = await call(ilya, 'POST', '/api/agents/import', file);
    expect(again.json<{ skills: object[] }>().skills).toEqual([
      { name: 'release-notes', version: 1, added: false },
    ]);
    file.agent.skills = [{ content: `${notes}\nName every breaking change.` }];
    const changed = await call(ilya, 'POST', '/api/agents/import', file);
    expect(changed.json<{ skills: object[] }>().skills).toEqual([
      { name: 'release-notes', version: 2, added: true },
    ]);

    // The first format's references belong to the install that made them: they are left out.
    const old = await call(ilya, 'POST', '/api/agents/import', {
      format: 'agentome/agent@1',
      agent: { ...file.agent, skills: [{ id: skill.json<{ id: string }>().id }], tools: [] },
    });
    expect(old.statusCode).toBe(201);
    expect(old.json<{ skills: object[] }>().skills).toEqual([]);

    const unknown = await call(ilya, 'POST', '/api/agents/import', {
      format: 'agent@9',
      agent: {},
    });
    expect(unknown.statusCode).toBe(400);
    const twice = await call(ilya, 'POST', '/api/agents/import', {
      ...file,
      agent: { ...file.agent, skills: [{ content: notes }, { content: `${notes}\nAgain.` }] },
    });
    expect(twice.statusCode).toBe(400);
  });
});

// The catalog lives with the site, which not every copy of the repository carries.
const catalog = new URL('../../site/public/agents/', import.meta.url);

describe.skipIf(!existsSync(catalog))('the catalog on agentome.ai', () => {
  it('imports every agent the catalog offers', async () => {
    const dir = catalog;
    const files = readdirSync(dir).filter((name) => name.endsWith('.agent.json'));
    expect(files.length).toBeGreaterThanOrEqual(20);
    const owner = await person();
    for (const name of files) {
      const response = await call(
        owner,
        'POST',
        '/api/agents/import',
        JSON.parse(readFileSync(new URL(name, dir), 'utf8')),
      );
      expect(response.statusCode, `${name}: ${response.body}`).toBe(201);
    }
  });
});

describe('workspace preview', () => {
  it('is what a run of the agent gets, and the sheet sees the run and the computer', async () => {
    const maria = await person();
    const agent = await create(maria, { name: 'Previewed', templateId: (await backend()).id });
    await call(maria, 'PATCH', `/api/agents/${agent.id}`, { instructions: 'Fix it with a test.' });
    const skill = await call(maria, 'POST', '/api/library/skills', {
      content: '---\nname: release-notes\ndescription: Writes the release notes.\n---\n',
    });
    await call(maria, 'PUT', `/api/agents/${agent.id}/skills`, {
      skills: [skill.json<{ id: string }>().id],
    });
    const preview = await call(maria, 'GET', `/api/agents/${agent.id}/workspace-preview`);
    expect(preview.statusCode).toBe(200);
    const { claudeMd } = preview.json<{ claudeMd: string }>();
    expect(claudeMd).toContain('## Instructions\n\nFix it with a test.');
    expect(claudeMd).toContain(
      '- **release-notes** (skills/release-notes/SKILL.md): Writes the release notes.',
    );

    // A computer of Maria's claims a run of the agent.
    const code = await call(maria, 'POST', '/api/seats/pairing-codes');
    const paired = await app.inject({
      method: 'POST',
      url: '/api/seats/pair',
      payload: {
        code: code.json<{ code: string }>().code,
        name: 'maria-mbp',
        kind: 'subscription-laptop',
        engines: ['claude-code'],
      },
    });
    const [task] = await db
      .insert(tasks)
      .values({ agentId: agent.id, title: 'Add a README', source: 'manual', createdBy: maria.id })
      .returning();
    if (!task) throw new Error('no task');
    await enqueueRun(db, task.id, maria.id);
    const claim = await app.inject({
      method: 'GET',
      url: '/api/seats/claim?wait=0',
      headers: { authorization: `Bearer ${paired.json<{ token: string }>().token}` },
    });
    const launch = LaunchPackage.parse(claim.json());
    expect(preview.json()).toEqual(launch.workspace.profile);

    // The run and its task, which the sidebar opens for an agent at work.
    const running = { id: launch.run.id, taskId: task.id, status: 'running' };
    const view = (await call(maria, 'GET', `/api/agents/${agent.id}`)).json<Agent>();
    expect(view.lastRun).toMatchObject(running);
    expect(view.seat).toMatchObject({ name: 'maria-mbp', busy: true });
    const [listed] = (await list(maria)).filter((item) => item.id === agent.id);
    expect(listed?.lastRun).toMatchObject(running);
    expect(listed?.week).toEqual({
      runs: 1,
      usd: null,
      ended: 0,
      done: 0,
      medianSeconds: null,
      daily: [0, 0, 0, 0, 0, 0, 1],
    });

    // The week's cost: what was priced in the last seven days, not what is older.
    const usage = {
      runId: launch.run.id,
      agentId: agent.id,
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      tokensIn: 1,
      tokensOut: 1,
      tokensCacheRead: 0,
      tokensCacheWrite: 0,
      source: 'test',
    };
    await db.insert(costEvents).values([
      { ...usage, usd: '0.40' },
      { ...usage, usd: '0.02' },
      { ...usage, usd: null },
      { ...usage, usd: '9.00', createdAt: new Date(Date.now() - 8 * 86_400_000) },
    ]);
    const [priced] = (await list(maria)).filter((item) => item.id === agent.id);
    expect(priced?.week).toMatchObject({ runs: 1, usd: '0.42' });

    // A finished run counts for the card: ended, done, and how long it took.
    await db
      .update(runs)
      .set({ status: 'done', startedAt: new Date(Date.now() - 600_000), endedAt: new Date() })
      .where(eq(runs.id, launch.run.id));
    const [ended] = (await list(maria)).filter((item) => item.id === agent.id);
    expect(ended?.week).toMatchObject({ ended: 1, done: 1, medianSeconds: 600 });
  });
});
