import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiTokens, createDb, eq, migrate } from '@agentome/db';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { setupCodeIn } from './app.js';

// The management MCP through the SDK's own client, as Claude Code connects: a
// personal token opens it, its tools are the API's routes, and each call acts as the person.

let container: StartedPostgreSqlContainer;
let app: Awaited<ReturnType<typeof buildApp>>;
let dataDir: string;
let base: string;
let cookie: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  dataDir = mkdtempSync(join(tmpdir(), 'agentome-manage-'));
  await migrate(container.getConnectionUri());
  app = await buildApp(
    loadConfig({
      AGENTOME_DATABASE_URL: container.getConnectionUri(),
      AGENTOME_DATA_DIR: dataDir,
      AGENTOME_LOG_LEVEL: 'silent',
    }),
  );
  base = await app.listen({ host: '127.0.0.1', port: 0 });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: {
      code: setupCodeIn(dataDir),
      orgName: 'Acme',
      admin: { name: 'Ann Admin', email: 'admin@example.com', password: 'the admin password' },
    },
  });
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
    .map((item) => item.split(';', 1)[0])
    .join('; ');
}

const inBrowser = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, payload, headers: { cookie } });
const withToken = (token: string, method: 'GET' | 'POST' | 'DELETE', url: string) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token}` } });

async function newToken(name = 'Claude Code on the MacBook', options: object = {}) {
  const made = await inBrowser('POST', '/api/me/tokens', { name, ...options });
  expect(made.statusCode).toBe(201);
  return made.json<{ id: string; token: string }>();
}

async function clientFor(token: string) {
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp/manage`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

const text = (result: unknown) =>
  ((result as { content: { text: string }[] }).content ?? []).map((part) => part.text).join('');

describe('personal tokens', () => {
  it('act as the person on the API, show once, and stop when revoked', async () => {
    const { id, token } = await newToken();
    expect(token).toMatch(/^[\w-]{43}$/);
    expect((await withToken(token, 'GET', '/api/me')).json()).toMatchObject({
      email: 'admin@example.com',
    });
    const listed = (await inBrowser('GET', '/api/me/tokens')).json<{ tokens: object[] }>();
    expect(listed.tokens).toContainEqual(
      expect.objectContaining({
        id,
        name: 'Claude Code on the MacBook',
        lastUsedAt: expect.any(String),
      }),
    );
    expect(JSON.stringify(listed)).not.toContain(token);

    expect((await inBrowser('DELETE', `/api/me/tokens/${id}`)).statusCode).toBe(204);
    expect((await withToken(token, 'GET', '/api/me')).statusCode).toBe(401);
    expect(
      (await inBrowser('GET', '/api/me/tokens')).json<{ tokens: { id: string }[] }>().tokens,
    ).not.toContainEqual(expect.objectContaining({ id }));
  });

  it('mint nothing that would outlive them: no seat code, no invitation', async () => {
    const { token } = await newToken();
    const code = await app.inject({
      method: 'POST',
      url: '/api/seats/pairing-codes',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(code.statusCode).toBe(403);
    const invite = await app.inject({
      method: 'POST',
      url: '/api/invitations',
      payload: { role: 'admin' },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(invite.statusCode).toBe(403);
  });

  it('expire when their time is up, and say when', async () => {
    const week = (
      await inBrowser('POST', '/api/me/tokens', { name: 'For a week', expiresInDays: 7 })
    ).json<{ expiresAt: string; scope: string }>();
    const inDays = (new Date(week.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(inDays).toBeGreaterThan(6.99);
    expect(inDays).toBeLessThanOrEqual(7);
    expect(week.scope).toBe('write');
    const never = (
      await inBrowser('POST', '/api/me/tokens', { name: 'Forever', expiresInDays: null })
    ).json<{ expiresAt: string | null }>();
    expect(never.expiresAt).toBeNull();
    const tooLong = await inBrowser('POST', '/api/me/tokens', { name: 'x', expiresInDays: 366 });
    expect(tooLong.statusCode).toBe(400);

    const { id, token } = await newToken('Soon gone');
    expect((await withToken(token, 'GET', '/api/me')).statusCode).toBe(200);
    const db = createDb(container.getConnectionUri(), () => undefined);
    try {
      await db
        .update(apiTokens)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(apiTokens.id, id));
    } finally {
      await db.$client.end();
    }
    const expired = await withToken(token, 'GET', '/api/me');
    expect(expired.statusCode).toBe(401);
    expect(expired.json()).toMatchObject({
      error: { message: expect.stringContaining('expired') },
    });
    // Still listed, so its person sees why it stopped, and can remove it.
    expect(
      (await inBrowser('GET', '/api/me/tokens')).json<{ tokens: { id: string }[] }>().tokens,
    ).toContainEqual(expect.objectContaining({ id, expiresAt: expect.any(String) }));
  });

  it('read and nothing more when made to read only, on the API and in the MCP', async () => {
    const { token } = await newToken('Reader', { scope: 'read' });
    expect((await withToken(token, 'GET', '/api/agents')).statusCode).toBe(200);
    const write = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { title: 'Not allowed' },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(write.statusCode).toBe(403);
    expect(write.json()).toMatchObject({ error: { message: 'This token can only read' } });

    const client = await clientFor(token);
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain('list_agents');
      expect(names).not.toContain('create_task');
      expect(names).not.toContain('approve_tool_call');
      const listed = await client.callTool({ name: 'list_agents', arguments: {} });
      expect(listed.isError).toBeFalsy();
    } finally {
      await client.close();
    }
  });

  it('cannot be made or revoked with a token', async () => {
    const { id, token } = await newToken();
    const minted = await app.inject({
      method: 'POST',
      url: '/api/me/tokens',
      payload: { name: 'another' },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(minted.statusCode).toBe(403);
    expect((await withToken(token, 'DELETE', `/api/me/tokens/${id}`)).statusCode).toBe(403);
  });
});

describe('the management MCP', () => {
  it('opens with a personal token only', async () => {
    const wrong = await app.inject({
      method: 'POST',
      url: '/mcp/manage',
      headers: { authorization: `Bearer ${'x'.repeat(43)}` },
      payload: {},
    });
    expect(wrong.statusCode).toBe(401);
    const asBrowser = await inBrowser('POST', '/mcp/manage', {});
    expect(asBrowser.statusCode).toBe(401);
    expect((await inBrowser('GET', '/mcp/manage')).statusCode).toBe(405);
  });

  it('offers the API as tools, each taking what its route takes', async () => {
    const { token } = await newToken();
    const client = await clientFor(token);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual(
      [
        'approve_tool_call',
        'cancel_run',
        'create_agent',
        'export_agent',
        'import_agent',
        'create_task',
        'update_task',
        'deny_tool_call',
        'get_agent',
        'agent_quality',
        'get_run',
        'get_run_transcript',
        'get_task',
        'list_agents',
        'list_people',
        'transfer_agent',
        'transfer_agents_of_person',
        'list_approvals',
        'list_projects',
        'list_runs',
        'list_tasks',
        'run_task',
        'comment_on_task',
        'set_tool_mode',
        'set_tool_policy',
        'update_agent',
        'list_templates',
        'get_project',
        'update_project',
        'read_project_environment',
        'approve_project_environment',
        'add_agent_to_project',
        'get_agent_memory',
        'get_agent_memory_versions',
        'write_agent_memory',
        'revert_agent_memory',
        'list_skills',
        'get_skill',
        'add_skill',
        'add_skill_version',
        'answer_question',
        'list_logs',
        'get_trace',
        'get_license',
        'set_license',
        'list_model_connections',
        'list_models',
        'resume_agent_budget',
        'list_schedules',
        'add_schedule',
        'update_schedule',
        'remove_schedule',
        'check_model_connection',
        'share_skill',
        'set_agent_skills',
        'list_mcp_servers',
        'check_mcp_server',
        'share_mcp_server',
        'set_agent_mcp_servers',
        'list_teams',
        'get_team',
        'create_team',
        'update_team',
        'duplicate_team',
        'remove_team',
        'list_knowledge_sources',
        'add_knowledge_source',
        'sync_knowledge_source',
        'remove_knowledge_source',
        'remove_mcp_server',
        'remove_project',
        'remove_skill',
      ].sort(),
    );
    const createTask = tools.find((tool) => tool.name === 'create_task');
    expect(createTask?.description).toContain('Creates a manual task');
    expect(Object.keys(createTask?.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(['agentId', 'title', 'body', 'repository']),
    );
    // A field with a transform is offered as the route receives it: a string, not its result.
    const listTasks = tools.find((tool) => tool.name === 'list_tasks');
    const before = (listTasks?.inputSchema.properties ?? {}).before as { type?: string };
    expect(before.type).toBe('string');
    const transcript = tools.find((tool) => tool.name === 'get_run_transcript');
    expect(Object.keys(transcript?.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(['id', 'after']),
    );
    expect(transcript?.annotations?.readOnlyHint).toBe(true);
    // An MCP server's header is a secret: adding or changing one stays in the web app.
    expect(names).not.toContain('add_mcp_server');
    const memory = tools.find((tool) => tool.name === 'get_agent_memory_versions');
    expect(Object.keys(memory?.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(['id', 'path']),
    );
    await client.close();
  });

  it('creates a task as the person, and reads it back', async () => {
    const agent = (await inBrowser('POST', '/api/agents', { name: 'Docs writer' })).json<{
      id: string;
    }>();
    const project = (await inBrowser('POST', '/api/projects', { name: 'Docs' })).json<{
      id: string;
    }>();
    await inBrowser('PUT', `/api/projects/${project.id}/agents/${agent.id}`);
    const { token } = await newToken();
    const client = await clientFor(token);
    // A task is filed in a project, from Claude as from the web app.
    const unfiled = await client.callTool({
      name: 'create_task',
      arguments: { agentId: agent.id, title: 'Anywhere' },
    });
    expect(unfiled.isError).toBe(true);
    expect(text(unfiled)).toContain('Pick the project the task is filed in');
    const created = await client.callTool({
      name: 'create_task',
      arguments: {
        agentId: agent.id,
        projectId: project.id,
        title: 'Apply the review to #75',
        body: 'Merge main into the branch and answer each point.',
        repository: 'https://github.com/acme/api',
        run: false,
      },
    });
    // The tool answers what the route answers: here the task and the run it did not queue.
    const { task, run } = JSON.parse(text(created)) as {
      task: { id: string; title: string };
      run: null;
    };
    expect(task.title).toBe('Apply the review to #75');
    expect(run).toBeNull();
    const read = await client.callTool({ name: 'get_task', arguments: { id: task.id } });
    expect(JSON.parse(text(read))).toMatchObject({
      id: task.id,
      repository: 'https://github.com/acme/api',
      agent: { id: agent.id },
    });
    const listed = await client.callTool({ name: 'list_tasks', arguments: { agent: agent.id } });
    expect(text(listed)).toContain(task.id);
    // The web app sees the same task, made by the same person.
    const fromBrowser = await inBrowser('GET', `/api/tasks/${task.id}`);
    expect(fromBrowser.json()).toMatchObject({ createdBy: { name: 'Ann Admin' } });
    await client.close();
  });

  it('sets an agent up from Claude: a skill from the library and a note in its memory', async () => {
    const agent = (await inBrowser('POST', '/api/agents', { name: 'Spec writer' })).json<{
      id: string;
    }>();
    const { token } = await newToken();
    const client = await clientFor(token);
    const skill = JSON.parse(
      text(
        await client.callTool({
          name: 'add_skill',
          arguments: {
            content:
              '---\nname: specs\ndescription: Writes specs the house way\n---\n\nKeep it short.\n',
          },
        }),
      ),
    ) as { id: string; name: string };
    expect(skill.name).toBe('specs');
    await client.callTool({
      name: 'set_agent_skills',
      arguments: { id: agent.id, skills: [skill.id] },
    });
    await client.callTool({
      name: 'write_agent_memory',
      arguments: {
        id: agent.id,
        path: 'MEMORY.md',
        content: '# Decisions\n\nSpecs live in docs/specs.\n',
      },
    });
    const view = (await inBrowser('GET', `/api/agents/${agent.id}`)).json<{
      skills: { name: string }[];
      memoryDocuments: number;
    }>();
    expect(view.skills.map((s) => s.name)).toEqual(['specs']);
    expect(view.memoryDocuments).toBe(1);
    await client.close();
  });

  it('builds a team from Claude: a lead with its steps', async () => {
    const make = async (name: string) =>
      (await inBrowser('POST', '/api/agents', { name })).json<{ id: string }>().id;
    const [lead, backend, qa] = [await make('PO'), await make('Backend'), await make('QA')];
    const { token } = await newToken();
    const client = await clientFor(token);
    await client.callTool({
      name: 'create_team',
      arguments: {
        name: 'Delivery',
        leadId: lead,
        mode: 'manual',
        members: [backend, qa],
        steps: [
          { agents: [backend], note: 'Build it' },
          { agents: [qa], note: 'Check it' },
        ],
      },
    });
    const [team] = (await inBrowser('GET', '/api/teams')).json<{
      teams: { name: string; mode: string; members: { name: string }[]; steps: unknown[] }[];
    }>().teams;
    expect(team).toMatchObject({ name: 'Delivery', mode: 'manual' });
    expect(team?.members.map((member) => member.name)).toEqual(['Backend', 'QA']);
    expect(team?.steps).toHaveLength(2);
    await client.close();
  });

  it("hands the route's refusal back as the tool's error", async () => {
    const { token } = await newToken();
    const client = await clientFor(token);
    const missing = await client.callTool({
      name: 'get_task',
      arguments: { id: '00000000-0000-0000-0000-000000000000' },
    });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/not found/i);
    await client.close();
  });
});
