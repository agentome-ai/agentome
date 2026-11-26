import {
  agents,
  and,
  catalogItems,
  type Db,
  desc,
  eq,
  inArray,
  or,
  skillFiles,
  sql,
  users,
} from '@agentome/db';
import { SKILL_FILES, skillFilePath } from '@agentome/shared';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { agentFor, agentsThat, Holders } from '../agents/service.js';
import { AppError } from '../errors.js';
import { IdParams } from '../protocol.js';

// The skills of the library: a SKILL.md per version, one catalog_items row each, and the files
// it brings beside it in skill_files. A person adds skills for themself (private); an
// admin shares one with everyone (org, approved_by). An agent points at rows, so it keeps the
// version it was given until its owner moves it on.

/** The name Claude Code knows a skill by: lowercase letters, digits and hyphens, up to 64. */
const SkillName = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SkillMd = z.string().trim().min(1).max(100_000);

/** A request with a skill's files: their bytes in base64, with room for paths and JSON. */
export const SKILL_FILES_BODY = Math.ceil((SKILL_FILES.bytes * 4) / 3) + 4 * 1024 * 1024;

const SkillFileIn = z.object({
  path: z
    .string()
    .min(1)
    .max(512)
    .refine(skillFilePath, 'Give each file a relative path of plain folder and file names'),
  content: z.base64(),
});
const SkillFilesIn = z.array(SkillFileIn).max(SKILL_FILES.count).optional();
const SkillBody = z.object({ content: SkillMd, files: SkillFilesIn });

/** The files of a new version, decoded and checked against the limits; empty without any. */
function decodeFiles(files: z.infer<typeof SkillFilesIn>) {
  const decoded = (files ?? []).map(({ path, content }) => ({
    path,
    content: Buffer.from(content, 'base64'),
  }));
  const paths = new Set(decoded.map(({ path }) => path));
  if (paths.size !== decoded.length)
    throw new AppError('validation_failed', 'Each file of a skill needs a path of its own');
  // A path that is also a folder of another could not be laid out.
  const clash = decoded.find(({ path }) =>
    decoded.some((other) => other.path.startsWith(`${path}/`)),
  );
  if (clash) throw new AppError('validation_failed', `${clash.path} is both a file and a folder`);
  const big = decoded.find(({ content }) => content.length > SKILL_FILES.file);
  if (big)
    throw new AppError('validation_failed', `${big.path} is over 5 MB, the most a file may be`);
  const bytes = decoded.reduce((sum, { content }) => sum + content.length, 0);
  if (bytes > SKILL_FILES.bytes)
    throw new AppError('validation_failed', "A skill's files may come to 25 MB at most");
  return decoded;
}

/**
 * What the launch package says of a version's files: how many, and a digest of their paths and
 * bytes, by which the worker keeps them.
 */
function filesSummary(files: { path: string; content: Buffer }[]) {
  if (files.length === 0) return undefined;
  const digest = createHash('sha256');
  for (const { path, content } of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    digest.update(`${path}\0${content.length}\0`).update(content);
  }
  return {
    count: files.length,
    bytes: files.reduce((sum, { content }) => sum + content.length, 0),
    digest: digest.digest('hex'),
  };
}

/**
 * name and description from the frontmatter, as Claude Code reads them; anything else is refused.
 * A value may be a YAML block (`description: >` or `|-` and indented lines), as many of
 * Anthropic's own skills write theirs; its lines are joined with spaces.
 */
export function parseSkill(text: string): { name: string; description: string } {
  const front = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text)?.[1];
  const lines = front?.split(/\r?\n/) ?? [];
  const field = (key: string) => {
    const at = lines.findIndex((line) => line.startsWith(`${key}:`));
    const value = lines[at]?.slice(key.length + 1).trim();
    if (value === undefined) return undefined;
    if (!/^[>|][+-]?$/.test(value)) return value.replace(/^(["'])(.*)\1$/, '$2');
    const block = lines.slice(at + 1);
    const end = block.findIndex((line) => line.trim() !== '' && !/^\s/.test(line));
    return (end === -1 ? block : block.slice(0, end))
      .map((line) => line.trim())
      .filter(Boolean)
      .join(' ');
  };
  const name = field('name');
  const description = field('description');
  if (!name || !SkillName.test(name)) {
    throw new AppError(
      'validation_failed',
      'Start SKILL.md with frontmatter whose name is lowercase letters, digits and hyphens, such as name: release-notes',
    );
  }
  if (!description)
    throw new AppError('validation_failed', 'Give the skill a description in its frontmatter');
  return { name, description };
}

type FilesSummary = NonNullable<ReturnType<typeof filesSummary>>;
const filesOfSpec = (skill: { fileCount: number; fileBytes: number; filesDigest?: string }) => ({
  count: skill.fileCount,
  bytes: skill.fileBytes,
  digest: skill.filesDigest ?? '',
});
type SkillSpec = { content: string; description: string; files?: FilesSummary };
const specOf = (spec: unknown): SkillSpec => spec as SkillSpec;

const SkillSummary = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string(),
  version: z.int(),
  owner: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  visibility: z.enum(['org', 'private']),
  /** How many files the version brings beside its SKILL.md, and their size in bytes. */
  fileCount: z.int(),
  fileBytes: z.int(),
  createdAt: z.iso.datetime(),
});
const Skill = SkillSummary.extend({
  content: z.string(),
  files: z.array(z.object({ path: z.string(), size: z.int() })),
});

const columns = {
  id: catalogItems.id,
  name: catalogItems.name,
  version: catalogItems.version,
  spec: catalogItems.spec,
  visibility: catalogItems.visibility,
  ownerId: catalogItems.ownerUserId,
  ownerName: users.name,
  createdAt: catalogItems.createdAt,
};
type Row = { [K in keyof typeof columns]: (typeof columns)[K]['_']['data'] | null };

const toSkill = (row: Row) => ({
  id: row.id ?? '',
  name: row.name ?? '',
  description: specOf(row.spec).description,
  content: specOf(row.spec).content,
  version: Number(row.version),
  owner: row.ownerId ? { id: row.ownerId, name: row.ownerName ?? '' } : null,
  visibility: row.visibility ?? 'private',
  fileCount: specOf(row.spec).files?.count ?? 0,
  fileBytes: specOf(row.spec).files?.bytes ?? 0,
  filesDigest: specOf(row.spec).files?.digest,
  createdAt: (row.createdAt ?? new Date(0)).toISOString(),
});

/** What a person may see: their own skills and the ones shared with everyone. */
const visibleTo = (userId: string) =>
  and(
    eq(catalogItems.kind, 'skill'),
    or(eq(catalogItems.visibility, 'org'), eq(catalogItems.ownerUserId, userId)),
  );

const select = (db: Db) =>
  db.select(columns).from(catalogItems).leftJoin(users, eq(users.id, catalogItems.ownerUserId));

/** One version, if the person may see it. */
async function skillFor(db: Db, id: string, userId: string) {
  const [row] = await select(db).where(and(eq(catalogItems.id, id), visibleTo(userId)));
  if (!row) throw new AppError('not_found', 'Skill not found');
  return toSkill(row);
}

/** One version as its page shows it: with the paths and sizes of its files. */
async function skillWithFiles(db: Db, id: string, userId: string) {
  const skill = await skillFor(db, id, userId);
  const files = skill.fileCount
    ? await db
        .select({ path: skillFiles.path, size: sql<number>`octet_length(${skillFiles.content})` })
        .from(skillFiles)
        .where(eq(skillFiles.skillId, id))
        .orderBy(skillFiles.path)
    : [];
  return { ...skill, files };
}

/** A version's files with their bytes, for a run of an agent that has it. */
export async function skillFilesOf(db: Db, id: string) {
  return db
    .select({ path: skillFiles.path, content: skillFiles.content })
    .from(skillFiles)
    .where(eq(skillFiles.skillId, id))
    .orderBy(skillFiles.path);
}

/**
 * A new version: its row and its files at once, so that no run finds the one without the other.
 * Without files of its own it keeps those of `previous`, if given: a new SKILL.md alone changes
 * the text, not the references beside it.
 */
async function insertVersion(
  db: Db,
  values: Omit<typeof catalogItems.$inferInsert, 'kind' | 'spec' | 'name'> & { content: string },
  files: z.infer<typeof SkillFilesIn>,
  previous?: { id: string; files?: FilesSummary },
) {
  const decoded = decodeFiles(files);
  const { name, description } = parseSkill(values.content);
  const { content, ...rest } = values;
  const kept = files === undefined ? previous : undefined;
  const summary = kept ? kept.files : filesSummary(decoded);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(catalogItems)
      .values({
        ...rest,
        kind: 'skill',
        name,
        spec: { content, description, ...(summary && { files: summary }) },
      })
      .returning({ id: catalogItems.id });
    if (!row) throw new Error('The skill was not inserted');
    // In batches: one insert of thousands of rows would pass PostgreSQL's 65 535 parameters.
    for (let at = 0; at < decoded.length; at += 500) {
      await tx
        .insert(skillFiles)
        .values(decoded.slice(at, at + 500).map((file) => ({ skillId: row.id, ...file })));
    }
    if (kept?.files) {
      await tx.execute(sql`
        insert into ${skillFiles} (skill_id, path, content)
        select ${row.id}::uuid, path, content from ${skillFiles} where skill_id = ${kept.id}`);
    }
    return row.id;
  });
}

/** The skills an agent was given, pinned to their versions, for its view and its runs. */
export async function skillsOf(db: Db, refs: unknown) {
  const ids = z
    .array(z.object({ id: z.uuid() }))
    .catch([])
    .parse(refs)
    .map((ref) => ref.id);
  if (ids.length === 0) return [];
  const rows = await select(db).where(
    and(eq(catalogItems.kind, 'skill'), inArray(catalogItems.id, ids)),
  );
  return rows.map(toSkill);
}

/**
 * A skill as a launch package carries it: its SKILL.md, and of its files only what the worker
 * fetches them by.
 */
export function launchSkill(skill: Awaited<ReturnType<typeof skillsOf>>[number]) {
  const { id, name, version, content, fileCount, filesDigest } = skill;
  return {
    name,
    version,
    content,
    ...(filesDigest && { files: { skillId: id, count: fileCount, digest: filesDigest } }),
  };
}

/**
 * A skill an imported agent brings, as the person's library holds it: the same text
 * already in reach is used as it is; otherwise it becomes the next version of the person's own
 * skill of that name, or a new private skill of theirs.
 */
export async function adoptSkill(db: Db, userId: string, content: string) {
  const text = SkillMd.parse(content);
  const { name, description } = parseSkill(text);
  const rows = await db
    .select({
      id: catalogItems.id,
      version: catalogItems.version,
      spec: catalogItems.spec,
      ownerUserId: catalogItems.ownerUserId,
      visibility: catalogItems.visibility,
    })
    .from(catalogItems)
    .where(and(visibleTo(userId), eq(catalogItems.name, name)));
  const same = rows.find((row) => specOf(row.spec).content === text);
  if (same) return { id: same.id, name, version: Number(same.version), added: false };
  const mine = rows.filter((row) => row.ownerUserId === userId);
  const version = Math.max(0, ...mine.map((row) => Number(row.version))) + 1;
  const [row] = await db
    .insert(catalogItems)
    .values({
      kind: 'skill',
      name,
      version: String(version),
      spec: { content: text, description },
      ownerUserId: userId,
      visibility: mine[0]?.visibility ?? 'private',
    })
    .returning({ id: catalogItems.id });
  if (!row) throw new Error('The skill was not inserted');
  return { id: row.id, name, version, added: true };
}

/** Skills the platform ships, from Anthropic's open-source ones. */
const BUILT_IN = new URL('../../skills/', import.meta.url);

/**
 * Brings the shipped skills up to date on every start, as the role templates are: everyone's
 * from the first start, owned by nobody, and changed in place with the next version, so an
 * agent that has one gets the platform's newest text.
 */
export async function seedSkills(db: Db): Promise<void> {
  const shipped = readdirSync(BUILT_IN, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readFileSync(new URL(`${entry.name}/SKILL.md`, BUILT_IN), 'utf8'));
  if (shipped.length === 0) return;
  await db
    .insert(catalogItems)
    .values(
      shipped.map((content) => {
        const { name, description } = parseSkill(content);
        return { kind: 'skill' as const, name, version: '1', spec: { content, description } };
      }),
    )
    .onConflictDoUpdate({
      target: [catalogItems.kind, catalogItems.name],
      targetWhere: sql`${catalogItems.ownerUserId} is null`,
      set: { spec: sql`excluded.spec`, version: sql`(${catalogItems.version}::int + 1)::text` },
      setWhere: sql`${catalogItems.spec} is distinct from excluded.spec`,
    });
}

export const skillRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.addHook('onRequest', app.requireSession);

  app.get(
    '/api/library/skills',
    {
      schema: {
        summary: 'The newest version of every skill the person may use',
        response: { 200: z.object({ skills: z.array(SkillSummary) }) },
      },
    },
    async (request) => {
      const rows = await db
        .selectDistinctOn([catalogItems.ownerUserId, catalogItems.name], columns)
        .from(catalogItems)
        .leftJoin(users, eq(users.id, catalogItems.ownerUserId))
        .where(visibleTo(request.user.id))
        .orderBy(
          catalogItems.ownerUserId,
          catalogItems.name,
          desc(sql`${catalogItems.version}::int`),
        );
      // The response's schema leaves each SKILL.md out of the list.
      return { skills: rows.map(toSkill).sort((a, b) => a.name.localeCompare(b.name)) };
    },
  );

  app.get(
    '/api/library/skills/:id',
    {
      schema: {
        summary: 'One version of a skill, with its SKILL.md',
        params: IdParams,
        response: { 200: Skill },
      },
    },
    async (request) => skillWithFiles(db, request.params.id, request.user.id),
  );

  app.get(
    '/api/library/skills/:id/agents',
    {
      schema: {
        summary: "The person's agents that have the skill, at any version of it",
        params: IdParams,
        response: { 200: Holders },
      },
    },
    async (request) => {
      const skill = await skillFor(db, request.params.id, request.user.id);
      // An agent holds one version of a skill: every version of this author's skill counts.
      const holds = sql`exists (
        select 1 from jsonb_array_elements(${agents.skills}) held
        join ${catalogItems} on ${catalogItems.id}::text = held->>'id'
        where ${catalogItems.kind} = 'skill' and ${catalogItems.name} = ${skill.name}
          and ${catalogItems.ownerUserId} is not distinct from ${skill.owner?.id ?? null}::uuid)`;
      return { agents: await agentsThat(db, request.user.id, holds) };
    },
  );

  app.post(
    '/api/library/skills',
    {
      bodyLimit: SKILL_FILES_BODY,
      schema: {
        summary: 'Adds a skill for the person, from its SKILL.md and the files beside it',
        body: SkillBody,
        response: { 201: Skill },
      },
    },
    async (request, reply) => {
      const { name } = parseSkill(request.body.content);
      const [mine] = await db
        .select({ id: catalogItems.id })
        .from(catalogItems)
        .where(
          and(
            eq(catalogItems.kind, 'skill'),
            eq(catalogItems.name, name),
            eq(catalogItems.ownerUserId, request.user.id),
          ),
        );
      if (mine)
        throw new AppError(
          'validation_failed',
          `You already have a skill named ${name}: add a version to it instead`,
        );
      const id = await insertVersion(
        db,
        {
          content: request.body.content,
          version: '1',
          ownerUserId: request.user.id,
          visibility: 'private',
        },
        request.body.files,
      );
      return reply.code(201).send(await skillWithFiles(db, id, request.user.id));
    },
  );

  app.post(
    '/api/library/skills/:id/versions',
    {
      bodyLimit: SKILL_FILES_BODY,
      schema: {
        summary: "Adds a version to the person's own skill; agents keep theirs until moved on",
        params: IdParams,
        body: SkillBody,
        response: { 201: Skill },
      },
    },
    async (request, reply) => {
      const base = await skillFor(db, request.params.id, request.user.id);
      if (base.owner?.id !== request.user.id)
        throw new AppError('forbidden', 'Only its author changes a skill');
      const { name } = parseSkill(request.body.content);
      if (name !== base.name)
        throw new AppError(
          'validation_failed',
          `Keep the name ${base.name}: a new name is a new skill`,
        );
      const [latest] = await db
        .select({ version: sql<number>`max(${catalogItems.version}::int)::int` })
        .from(catalogItems)
        .where(
          and(
            eq(catalogItems.kind, 'skill'),
            eq(catalogItems.name, name),
            eq(catalogItems.ownerUserId, request.user.id),
          ),
        );
      const id = await insertVersion(
        db,
        {
          content: request.body.content,
          version: String((latest?.version ?? 0) + 1),
          ownerUserId: request.user.id,
          visibility: base.visibility,
          approvedBy: null,
        },
        request.body.files,
        { id: base.id, files: base.filesDigest ? filesOfSpec(base) : undefined },
      );
      return reply.code(201).send(await skillWithFiles(db, id, request.user.id));
    },
  );

  app.post(
    '/api/library/skills/:id/share',
    {
      onRequest: app.requireAdmin,
      schema: {
        summary: 'Shares a skill with everyone: every version of it, now and to come',
        params: IdParams,
        response: { 200: Skill },
      },
    },
    async (request) => {
      const skill = await skillFor(db, request.params.id, request.user.id);
      await db
        .update(catalogItems)
        .set({ visibility: 'org', approvedBy: request.user.id })
        .where(
          and(
            eq(catalogItems.kind, 'skill'),
            eq(catalogItems.name, skill.name),
            skill.owner ? eq(catalogItems.ownerUserId, skill.owner.id) : sql`false`,
          ),
        );
      return skillWithFiles(db, skill.id, request.user.id);
    },
  );

  app.delete(
    '/api/library/skills/:id',
    {
      schema: {
        summary: 'Deletes a skill with every version: its author, or an admin once it is shared',
        params: IdParams,
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const skill = await skillFor(db, request.params.id, request.user.id);
      if (!skill.owner)
        throw new AppError(
          'forbidden',
          'Agentome ships this skill and brings it back on every start, so it cannot be deleted',
        );
      const admin = request.user.role === 'admin' && skill.visibility === 'org';
      if (skill.owner.id !== request.user.id && !admin)
        throw new AppError('forbidden', 'Only its author or an admin deletes a skill');
      // Agents keep the ids in agents.skills, and skillsOf skips the rows that are gone.
      await db
        .delete(catalogItems)
        .where(
          and(
            eq(catalogItems.kind, 'skill'),
            eq(catalogItems.name, skill.name),
            eq(catalogItems.ownerUserId, skill.owner.id),
          ),
        );
      return reply.code(204).send(null);
    },
  );

  app.put(
    '/api/agents/:id/skills',
    {
      schema: {
        summary: "Sets the agent's skills, each at the version given",
        params: IdParams,
        body: z.object({ skills: z.array(z.uuid()).max(50) }),
        response: { 200: z.object({ skills: z.array(SkillSummary) }) },
      },
    },
    async (request) => {
      const agent = await agentFor(db, request.params.id, request.user.id);
      const wanted = [...new Set(request.body.skills)];
      const found = await Promise.all(wanted.map((id) => skillFor(db, id, request.user.id)));
      if (new Set(found.map((skill) => skill.name)).size !== found.length) {
        throw new AppError('validation_failed', 'Give the agent one version of each skill');
      }
      await db
        .update(agents)
        .set({ skills: wanted.map((id) => ({ id })) })
        .where(eq(agents.id, agent.id));
      return { skills: found };
    },
  );
};
