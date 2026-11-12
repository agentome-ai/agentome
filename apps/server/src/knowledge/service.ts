import {
  and,
  type Db,
  desc,
  eq,
  isNull,
  knowledgeDocuments,
  knowledgeSources,
  lt,
  notInArray,
  or,
  projectAgents,
  sql,
} from '@agentome/db';
import { z } from 'zod';
import { CodeHostError } from '../code-host/index.js';
import { codeHostOf, projectConnectionFor } from '../connections/service.js';
import { AppError } from '../errors.js';

// A project's knowledge: markdown from a connected repository, read through the code
// host's API, since the server has no git, and searched with Postgres full text. A sync reads
// the branch's tree, fetches only the files whose content changed and drops the ones gone.

/** A file or a folder of the repository; a folder stands for every markdown file under it. */
const SourcePath = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((path) => !path.split('/').includes('..'), 'Use a path inside the repository')
  .transform((path) => path.replace(/^\/+|\/+$/g, ''));
export const SourceConfig = z.object({
  repository: z.url({ protocol: /^https?$/ }).max(500),
  paths: z.array(SourcePath).min(1).max(20),
});
export type SourceConfig = z.infer<typeof SourceConfig>;

/** What one sync reads at most: a repository's docs, not the repository. */
const MAX_FILES = 500;
const MAX_CHARS = 200_000;
const PARALLEL = 4;

const covers = (paths: string[], file: string) =>
  file.toLowerCase().endsWith('.md') &&
  paths.some((path) => path === '' || file === path || file.startsWith(`${path}/`));

const titleOf = (path: string, content: string) =>
  /^#\s+(.+)$/m.exec(content)?.[1]?.trim() ?? path.split('/').pop() ?? path;

// Spelled out: inside the subquery Drizzle's bare "id" would be the document's own.
const documents = sql<number>`(select count(*)::int from knowledge_documents d where d.source_id = knowledge_sources.id)`;

async function views(db: Db, where: ReturnType<typeof eq>) {
  const rows = await db
    .select({ row: knowledgeSources, documents })
    .from(knowledgeSources)
    .where(where)
    .orderBy(knowledgeSources.createdAt);
  return rows.map(({ row, documents: count }) => ({
    id: row.id,
    ...SourceConfig.parse(row.config),
    lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
    lastSyncError: row.lastSyncError,
    documents: count,
  }));
}

export const listSources = (db: Db, projectId: string) =>
  views(db, eq(knowledgeSources.projectId, projectId));

export async function sourceView(db: Db, id: string) {
  const [view] = await views(db, eq(knowledgeSources.id, id));
  if (!view) throw new AppError('not_found', 'Knowledge source not found');
  return view;
}

export async function createSource(db: Db, key: Buffer, projectId: string, config: SourceConfig) {
  if (!(await projectConnectionFor(db, projectId, config.repository))) {
    throw new AppError(
      'validation_failed',
      `No connection of this project reaches ${config.repository}. Connect its owner or group in Admin, Connections first.`,
    );
  }
  const [row] = await db
    .insert(knowledgeSources)
    .values({ projectId, config })
    .returning({ id: knowledgeSources.id });
  if (!row) throw new Error('The insert returned no knowledge source');
  await syncSource(db, key, row.id);
  return sourceView(db, row.id);
}

export async function deleteSource(db: Db, id: string): Promise<void> {
  await db.delete(knowledgeSources).where(eq(knowledgeSources.id, id));
}

/**
 * Brings a source's documents up to its repository's default branch. What the host or the
 * configuration refuses is kept on the source for a person to read, not thrown.
 */
export async function syncSource(db: Db, key: Buffer, id: string): Promise<void> {
  const [source] = await db.select().from(knowledgeSources).where(eq(knowledgeSources.id, id));
  if (!source) throw new AppError('not_found', 'Knowledge source not found');
  let failure: string | null = null;
  try {
    const config = SourceConfig.parse(source.config);
    const connection = await projectConnectionFor(db, source.projectId, config.repository);
    if (!connection) {
      throw new AppError(
        'validation_failed',
        `No connection of the project reaches ${config.repository}`,
      );
    }
    const host = await codeHostOf(db, key, connection.id);
    const repository = await host.repository(config.repository);
    const tree = await host.tree(repository.path, repository.defaultBranch);
    const wanted = tree.files.filter((file) => covers(config.paths, file.path)).slice(0, MAX_FILES);
    const known = new Map(
      (
        await db
          .select({ path: knowledgeDocuments.path, sha: knowledgeDocuments.sha })
          .from(knowledgeDocuments)
          .where(eq(knowledgeDocuments.sourceId, id))
      ).map((doc) => [doc.path, doc.sha]),
    );
    const changed = wanted.filter((file) => known.get(file.path) !== file.sha);
    for (let i = 0; i < changed.length; i += PARALLEL) {
      await Promise.all(
        changed.slice(i, i + PARALLEL).map(async (file) => {
          // Postgres text takes no NUL, and a binary file misnamed .md has them.
          const text = await host.file(repository.path, file.sha);
          const content = text.replaceAll('\0', '').slice(0, MAX_CHARS);
          const fields = { sha: file.sha, title: titleOf(file.path, content), content };
          await db
            .insert(knowledgeDocuments)
            .values({ sourceId: id, path: file.path, ...fields })
            .onConflictDoUpdate({
              target: [knowledgeDocuments.sourceId, knowledgeDocuments.path],
              set: fields,
            });
        }),
      );
    }
    // A tree the host cut short says nothing of the files it left out: keep them.
    if (!tree.truncated) {
      const kept = wanted.map((file) => file.path);
      await db
        .delete(knowledgeDocuments)
        .where(
          and(
            eq(knowledgeDocuments.sourceId, id),
            kept.length > 0 ? notInArray(knowledgeDocuments.path, kept) : undefined,
          ),
        );
    }
  } catch (error) {
    if (!(error instanceof AppError || error instanceof CodeHostError)) throw error;
    failure = error.message;
  }
  await db
    .update(knowledgeSources)
    .set({ lastSyncAt: new Date(), lastSyncError: failure })
    .where(eq(knowledgeSources.id, id));
}

/**
 * The scheduled sync: every source not synced for `minutes`, each claimed first by moving its
 * time on, so a tick that starts while another still runs leaves its sources alone.
 */
export async function syncDue(db: Db, key: Buffer, minutes: number): Promise<void> {
  const due = await db
    .update(knowledgeSources)
    .set({ lastSyncAt: new Date() })
    .where(
      or(
        isNull(knowledgeSources.lastSyncAt),
        lt(knowledgeSources.lastSyncAt, new Date(Date.now() - minutes * 60_000)),
      ),
    )
    .returning({ id: knowledgeSources.id });
  for (const { id } of due) await syncSource(db, key, id);
}

/** The documents of an agent's projects: only these are its to search and read. */
const ofAgent = (agentId: string) =>
  and(eq(projectAgents.projectId, knowledgeSources.projectId), eq(projectAgents.agentId, agentId));

const fields = {
  id: knowledgeDocuments.id,
  repository: sql<string>`${knowledgeSources.config}->>'repository'`,
  path: knowledgeDocuments.path,
  title: knowledgeDocuments.title,
};

export async function searchKnowledge(db: Db, agentId: string, query: string, limit: number) {
  // As the column is built (schema.ts): word forms of Russian and English; quotes, "or" and a
  // minus work as in a web search.
  const q = sql`websearch_to_tsquery('russian', ${query})`;
  return db
    .select({
      ...fields,
      snippet: sql<string>`ts_headline('russian', ${knowledgeDocuments.content}, ${q}, 'MaxFragments=2, MinWords=8, MaxWords=30, StartSel=**, StopSel=**')`,
    })
    .from(knowledgeDocuments)
    .innerJoin(knowledgeSources, eq(knowledgeSources.id, knowledgeDocuments.sourceId))
    .innerJoin(projectAgents, ofAgent(agentId))
    .where(sql`${knowledgeDocuments.tsv} @@ ${q}`)
    .orderBy(desc(sql`ts_rank(${knowledgeDocuments.tsv}, ${q})`))
    .limit(limit);
}

export async function readKnowledge(db: Db, agentId: string, id: string) {
  const [found] = await db
    .select({ ...fields, content: knowledgeDocuments.content })
    .from(knowledgeDocuments)
    .innerJoin(knowledgeSources, eq(knowledgeSources.id, knowledgeDocuments.sourceId))
    .innerJoin(projectAgents, ofAgent(agentId))
    .where(eq(knowledgeDocuments.id, id));
  return found ?? null;
}
