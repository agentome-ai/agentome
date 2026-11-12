import { and, catalogItems, type Db, engineEnum, eq, isNull } from '@agentome/db';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { serversNamed, serversOf } from '../library/mcp.js';
import { adoptSkill, parseSkill, skillsOf } from '../library/skills.js';
import { Budget } from './templates.js';
import { type AgentRow, budgetOf, insertAgent, templateOf } from './service.js';

// An agent as a file: what another Agentome needs to make the same agent, and nothing of
// this one's: no ids, owner, grants, runs, memory or secrets. A skill travels as its SKILL.md and
// a library MCP server by its name, since ids belong to the install they were made in.

const Policy = z.enum(['allow', 'ask', 'deny']);
const Template = z.object({ name: z.string(), version: z.int() }).nullable();

const Common = {
  name: z.string().trim().min(1).max(100),
  roleTitle: z.string().trim().max(200),
  instructions: z.string().max(100_000),
  engine: z.enum(engineEnum.enumValues),
  modelPref: z
    .string()
    .trim()
    .max(100)
    .regex(/^[a-z0-9][\w.:/[\]-]*$/i)
    .nullable(),
  budget: Budget.nullable(),
  template: Template,
};

/** The first format: skills and tools as this install's references, which another cannot read. */
export const AgentFileV1 = z.object({
  format: z.literal('agentome/agent@1'),
  agent: z.object({ ...Common, skills: z.array(z.unknown()), tools: z.array(z.unknown()) }),
});

export const AgentFileV2 = z.object({
  format: z.literal('agentome/agent@2'),
  agent: z.object({
    ...Common,
    skills: z.array(z.object({ content: z.string().min(1).max(100_000) })).max(50),
    tools: z.array(z.object({ name: z.string().max(200), policy: Policy })).max(500),
    mcpServers: z.array(z.object({ name: z.string().max(100) })).max(50),
  }),
  /** Where the agent comes from, for the catalog's credit: shown at import, not kept. */
  source: z
    .object({ name: z.string().max(200), url: z.url().max(500), license: z.string().max(100) })
    .optional(),
});

export const AgentFile = z.discriminatedUnion('format', [AgentFileV1, AgentFileV2]);

export const ImportResult = z.object({
  agent: z.object({ id: z.uuid(), name: z.string() }),
  skills: z.array(z.object({ name: z.string(), version: z.int(), added: z.boolean() })),
  /** Library MCP servers the file names that this person has none of: add them, then give them. */
  missingServers: z.array(z.string()),
});

/** The agent's configuration as a file. */
export async function exportAgent(db: Db, agent: AgentRow): Promise<z.infer<typeof AgentFileV2>> {
  const [template, skills, servers] = await Promise.all([
    templateOf(db, agent),
    skillsOf(db, agent.skills),
    serversOf(db, agent.tools),
  ]);
  return {
    format: 'agentome/agent@2',
    agent: {
      name: agent.name,
      roleTitle: agent.roleTitle,
      instructions: agent.instructions,
      engine: agent.engine,
      modelPref: agent.modelPref,
      budget: budgetOf(agent.budget),
      skills: skills.map((skill) => ({ content: skill.content })),
      tools: policies(agent.tools),
      mcpServers: servers.map((server) => ({ name: server.name })),
      template: template && { name: template.name, version: template.version },
    },
  };
}

const policies = (tools: unknown) =>
  z
    .array(z.object({ name: z.string(), policy: Policy }).catch(null as never))
    .catch([])
    .parse(tools)
    .filter(Boolean);

/**
 * A new agent of the person from a file. Its skills join their library (the same text is used
 * where it already is), its MCP servers are the ones of theirs by those names, and it keeps its
 * template where this install has one by that name.
 */
export async function importAgent(db: Db, ownerUserId: string, file: z.infer<typeof AgentFile>) {
  const { agent } = file;
  const v2 = file.format === 'agentome/agent@2' ? file.agent : null;
  // Every skill is read before any is kept, so a file that is wrong leaves the library as it was.
  const names = new Set<string>();
  for (const skill of v2?.skills ?? []) {
    const { name } = parseSkill(skill.content);
    if (names.has(name))
      throw new AppError('validation_failed', `The file has the skill ${name} twice`);
    names.add(name);
  }
  const skills = [];
  for (const skill of v2?.skills ?? [])
    skills.push(await adoptSkill(db, ownerUserId, skill.content));
  const wanted = (v2?.mcpServers ?? []).map((server) => server.name);
  const servers = await serversNamed(db, ownerUserId, wanted);
  const [template] = agent.template
    ? await db
        .select({ id: catalogItems.id })
        .from(catalogItems)
        .where(
          and(
            eq(catalogItems.kind, 'template'),
            eq(catalogItems.name, agent.template.name),
            isNull(catalogItems.ownerUserId),
          ),
        )
    : [];
  const row = await insertAgent(db, ownerUserId, {
    name: agent.name,
    roleTitle: agent.roleTitle,
    instructions: agent.instructions,
    engine: agent.engine,
    modelPref: agent.modelPref,
    budget: agent.budget,
    skills: skills.map((skill) => ({ id: skill.id })),
    // A file's tool policies are its author's: an imported agent starts with the defaults, and its
    // owner allows what they mean to in Tools & policies.
    tools: [...servers.values()].map((server) => ({ server })),
    templateId: template?.id ?? null,
  });
  return {
    agent: { id: row.id, name: row.name },
    skills: skills.map(({ name, version, added }) => ({ name, version, added })),
    missingServers: wanted.filter((name) => !servers.has(name)),
  };
}
