import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, migrate } from '@agentome/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { LaunchPackage } from '../src/protocol.js';
import { parseSkill, seedSkills } from '../src/library/skills.js';
import { prepareInstallation } from '../src/setup.js';
import { setupCodeIn } from './app.js';

// The skills of the library against the real server: who sees
// which, versions, sharing, an agent's pinned skills, and what a run of it gets.

let container: StartedPostgreSqlContainer;
let app: Awaited<ReturnType<typeof buildApp>>;
let dataDir: string;
let admin: Person;
let bob: Person;

type Person = { id: string; cookie: string };
type Skill = {
  id: string;
  name: string;
  version: number;
  visibility: string;
  description: string;
  content?: string;
};

const cookieOf = (response: LightMyRequestResponse) =>
  [response.headers['set-cookie'] ?? []]
    .flat()
    .map((cookie) => String(cookie).split(';', 1)[0])
    .join('; ');
const call = (
  who: Person,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
) => app.inject({ method, url, payload, headers: { cookie: who.cookie } });
const skillMd = (name: string, body = 'Do it well.') =>
  `---\nname: ${name}\ndescription: Writes ${name} the house way\n---\n\n${body}\n`;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  dataDir = mkdtempSync(join(tmpdir(), 'agentome-skills-'));
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
  admin = { id: setup.json<{ id: string }>().id, cookie: cookieOf(setup) };
  const invitation = await call(admin, 'POST', '/api/invitations', {});
  const token = invitation.json<{ url: string }>().url.split('/invite/')[1];
  const accepted = await app.inject({
    method: 'POST',
    url: `/api/invitations/${token}/accept`,
    payload: { name: 'Bob', email: 'bob@example.com', password: 'a long enough password' },
  });
  bob = { id: accepted.json<{ id: string }>().id, cookie: cookieOf(accepted) };
}, 120_000);

afterAll(async () => {
  await app?.close();
  await container?.stop();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

const list = async (who: Person) =>
  (await call(who, 'GET', '/api/library/skills')).json<{ skills: Skill[] }>().skills;

describe('the skills library', () => {
  it('keeps a skill private to its author until an admin shares it, versions and all', async () => {
    const added = await call(bob, 'POST', '/api/library/skills', {
      content: skillMd('release-notes'),
    });
    expect(added.statusCode).toBe(201);
    const v1 = added.json<Skill>();
    expect(v1).toMatchObject({ name: 'release-notes', version: 1, visibility: 'private' });
    expect(v1.description).toBe('Writes release-notes the house way');
    expect((await list(admin)).map((skill) => skill.name)).not.toContain('release-notes');

    const v2 = (
      await call(bob, 'POST', `/api/library/skills/${v1.id}/versions`, {
        content: skillMd('release-notes', 'Do it better.'),
      })
    ).json<Skill>();
    expect(v2.version).toBe(2);
    expect((await list(bob)).find((skill) => skill.name === 'release-notes')?.version).toBe(2);
    // The list leaves each SKILL.md out; one version brings its own.
    expect((await list(bob))[0]).not.toHaveProperty('content');
    expect(
      (await call(bob, 'GET', `/api/library/skills/${v1.id}`)).json<Skill>().content,
    ).toContain('Do it well.');

    expect((await call(bob, 'POST', `/api/library/skills/${v1.id}/share`)).statusCode).toBe(403);
    expect((await call(admin, 'POST', `/api/library/skills/${v2.id}/share`)).statusCode).toBe(404);
    // Bob's private skill is out of the admin's sight, so sharing goes through what Bob shows.
    const renamed = await call(bob, 'POST', `/api/library/skills/${v1.id}/versions`, {
      content: skillMd('other-name'),
    });
    expect(renamed.statusCode).toBe(400);
  });

  it('refuses a SKILL.md without its frontmatter, and a second skill of the same name', async () => {
    for (const content of [
      'no frontmatter',
      '---\nname: Bad Name\ndescription: x\n---\n',
      '---\nname: ok\n---\n',
    ]) {
      expect(
        (await call(bob, 'POST', '/api/library/skills', { content })).statusCode,
        content,
      ).toBe(400);
    }
    await call(bob, 'POST', '/api/library/skills', { content: skillMd('twice') });
    expect(
      (await call(bob, 'POST', '/api/library/skills', { content: skillMd('twice') })).statusCode,
    ).toBe(400);
  });

  it('shares an admin skill with everyone, and pins skills on an agent for its runs', async () => {
    const mine = (
      await call(admin, 'POST', '/api/library/skills', { content: skillMd('code-review').trim() })
    ).json<Skill>();
    const shared = await call(admin, 'POST', `/api/library/skills/${mine.id}/share`);
    expect(shared.json<Skill>().visibility).toBe('org');
    expect((await list(bob)).map((skill) => skill.name)).toContain('code-review');

    const agent = (await call(admin, 'POST', '/api/agents', { name: 'Reviewer' })).json<{
      id: string;
    }>();
    const pinned = await call(admin, 'PUT', `/api/agents/${agent.id}/skills`, {
      skills: [mine.id],
    });
    expect(pinned.statusCode).toBe(200);
    const view = (await call(admin, 'GET', `/api/agents/${agent.id}`)).json<{ skills: object[] }>();
    expect(view.skills).toEqual([{ id: mine.id, name: 'code-review', version: '1' }]);
    // The Library says which of the person's own agents have it: at any version of it,
    // and to another person none, though they may use the skill.
    const holders = async (id: string, who = admin) =>
      (await call(who, 'GET', `/api/library/skills/${id}/agents`)).json<{ agents: object[] }>()
        .agents;
    expect(await holders(mine.id)).toEqual([{ id: agent.id, name: 'Reviewer' }]);
    const next = (
      await call(admin, 'POST', `/api/library/skills/${mine.id}/versions`, {
        content: `${skillMd('code-review').trim()}\n\nAnd say so.`,
      })
    ).json<Skill>();
    expect(next.id).not.toBe(mine.id);
    expect(await holders(next.id)).toEqual([{ id: agent.id, name: 'Reviewer' }]);
    expect(await holders(mine.id, bob)).toEqual([]);
    // Another person's private skill cannot be given to an agent.
    const bobs = (await list(bob)).find((skill) => skill.name === 'twice');
    expect(
      (await call(admin, 'PUT', `/api/agents/${agent.id}/skills`, { skills: [bobs?.id] }))
        .statusCode,
    ).toBe(404);

    // A run of the agent gets the skill's text and a line about it in its CLAUDE.md.
    const project = (await call(admin, 'POST', '/api/projects', { name: 'Reviews' })).json<{
      id: string;
    }>();
    await call(admin, 'PUT', `/api/projects/${project.id}/agents/${agent.id}`);
    await call(admin, 'POST', '/api/tasks', {
      agentId: agent.id,
      projectId: project.id,
      title: 'Review the branch',
      repository: null,
    });
    const code = (await call(admin, 'POST', '/api/seats/pairing-codes')).json<{ code: string }>()
      .code;
    const seat = await app.inject({
      method: 'POST',
      url: '/api/seats/pair',
      payload: {
        code,
        name: 'mini',
        kind: 'subscription-laptop',
        engines: ['claude-code'],
        capabilities: { sandbox: true },
      },
    });
    const claim = await app.inject({
      method: 'GET',
      url: '/api/seats/claim?wait=0',
      headers: { authorization: `Bearer ${seat.json<{ token: string }>().token}` },
    });
    const launch = LaunchPackage.parse(claim.json());
    expect(launch.agent.skills).toEqual([
      { name: 'code-review', version: 1, content: skillMd('code-review').trim() },
    ]);
    expect(launch.workspace.profile.claudeMd).toContain(
      '- **code-review** (skills/code-review/SKILL.md): Writes code-review the house way',
    );
  });
});

describe('deleting a skill', () => {
  it('takes every version: its author may, an admin once it is shared, nobody else', async () => {
    const draft = (
      await call(bob, 'POST', '/api/library/skills', { content: skillMd('scratch') })
    ).json<Skill>();
    await call(bob, 'POST', `/api/library/skills/${draft.id}/versions`, {
      content: skillMd('scratch', 'Do it better.'),
    });
    // Bob's private skill is not the admin's to see, so not to delete.
    expect((await call(admin, 'DELETE', `/api/library/skills/${draft.id}`)).statusCode).toBe(404);
    expect((await call(bob, 'DELETE', `/api/library/skills/${draft.id}`)).statusCode).toBe(204);
    expect((await list(bob)).map((skill) => skill.name)).not.toContain('scratch');
    expect((await call(bob, 'GET', `/api/library/skills/${draft.id}`)).statusCode).toBe(404);

    // A shared skill is the admin's to delete; an agent that had it loses it.
    const house = (
      await call(admin, 'POST', '/api/library/skills', { content: skillMd('house-style') })
    ).json<Skill>();
    await call(admin, 'POST', `/api/library/skills/${house.id}/share`);
    expect((await call(bob, 'DELETE', `/api/library/skills/${house.id}`)).statusCode).toBe(403);
    const agent = (await call(admin, 'POST', '/api/agents', { name: 'Stylist' })).json<{
      id: string;
    }>();
    await call(admin, 'PUT', `/api/agents/${agent.id}/skills`, { skills: [house.id] });
    expect((await call(admin, 'DELETE', `/api/library/skills/${house.id}`)).statusCode).toBe(204);
    const view = (await call(admin, 'GET', `/api/agents/${agent.id}`)).json<{ skills: object[] }>();
    expect(view.skills).toEqual([]);
  });

  it('refuses a skill Agentome ships, which would come back on the next start', async () => {
    const shipped = (await list(admin)).find((skill) => skill.name === 'frontend-design');
    const refused = await call(admin, 'DELETE', `/api/library/skills/${shipped?.id}`);
    expect(refused.statusCode).toBe(403);
    expect((await list(admin)).map((skill) => skill.name)).toContain('frontend-design');
  });
});

describe('the skills Agentome ships', () => {
  it("are everyone's from the first start, owned by nobody, and a second start changes nothing", async () => {
    const shipped = (await list(bob)).filter((skill) =>
      ['doc-coauthoring', 'frontend-design'].includes(skill.name),
    );
    expect(shipped).toEqual([
      expect.objectContaining({
        name: 'doc-coauthoring',
        version: 1,
        visibility: 'org',
        owner: null,
      }),
      expect.objectContaining({
        name: 'frontend-design',
        version: 1,
        visibility: 'org',
        owner: null,
      }),
    ]);
    expect(shipped[0]?.description).toMatch(/^Guide users through a structured workflow/);
    const db = createDb(container.getConnectionUri(), () => {});
    await seedSkills(db);
    await db.$client.end();
    expect((await list(bob)).find((skill) => skill.name === 'frontend-design')?.version).toBe(1);
    // Nobody's skill takes no new version and no share: there is no author to be.
    const id = shipped[1]?.id ?? '';
    expect(
      (
        await call(admin, 'POST', `/api/library/skills/${id}/versions`, {
          content: skillMd('frontend-design'),
        })
      ).statusCode,
    ).toBe(403);
  });

  it('reads a description written as a YAML block, as Anthropic writes some of theirs', () => {
    expect(
      parseSkill(
        '---\nname: nudge\ndescription: >\n  After you give an answer,\n  ask for a check.\nlicense: x\n---\nBody\n',
      ),
    ).toEqual({ name: 'nudge', description: 'After you give an answer, ask for a check.' });
    expect(
      parseSkill('---\nname: api\ndescription: |-\n  Reference for the API.\n---\n').description,
    ).toBe('Reference for the API.');
  });
});
