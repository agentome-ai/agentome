import { agentMemoryDocs, and, type Db, desc, eq, sql, users } from '@agentome/db';
import { z } from 'zod';
import { AppError, postgresCode } from '../errors.js';

// An agent's memory: markdown documents, one row per version. Shared by the routes
// of the person and the gateway's memory tools.

/** Where a document lands in a run's profile: MEMORY.md, or one file in memory/. */
export const MemoryPath = z
  .string()
  .regex(/^(MEMORY\.md|memory\/[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.md)$/, {
    message: 'Use MEMORY.md or memory/<name>.md',
  });
export const MemoryContent = z.string().max(100_000);

export const MemoryDocument = z.object({
  path: z.string(),
  version: z.int(),
  content: z.string(),
  updatedAt: z.iso.datetime(),
  updatedBy: z.union([
    z.object({ kind: z.literal('run'), id: z.uuid() }),
    z.object({ kind: z.literal('user'), id: z.uuid(), name: z.string() }),
  ]),
});
export type MemoryDocument = z.infer<typeof MemoryDocument>;

/** Who writes a version: a person, or a run of the agent. */
export type Author = { userId: string } | { runId: string };

const columns = {
  path: agentMemoryDocs.path,
  version: agentMemoryDocs.version,
  content: agentMemoryDocs.content,
  createdAt: agentMemoryDocs.createdAt,
  runId: agentMemoryDocs.updatedByRunId,
  userId: agentMemoryDocs.updatedByUserId,
  userName: users.name,
};
type Row = { [K in keyof typeof columns]: (typeof columns)[K]['_']['data'] | null };

function toDocument(row: Row): MemoryDocument {
  return {
    path: row.path ?? '',
    version: row.version ?? 0,
    content: row.content ?? '',
    updatedAt: (row.createdAt ?? new Date(0)).toISOString(),
    updatedBy: row.runId
      ? { kind: 'run', id: row.runId }
      : { kind: 'user', id: row.userId ?? '', name: row.userName ?? '' },
  };
}

const select = (db: Db) =>
  db
    .select(columns)
    .from(agentMemoryDocs)
    .leftJoin(users, eq(users.id, agentMemoryDocs.updatedByUserId));

/** The current documents of the agent, deleted ones left out, by path. */
export async function currentMemory(db: Db, agentId: string): Promise<MemoryDocument[]> {
  const rows = await db
    .selectDistinctOn([agentMemoryDocs.path], columns)
    .from(agentMemoryDocs)
    .leftJoin(users, eq(users.id, agentMemoryDocs.updatedByUserId))
    .where(eq(agentMemoryDocs.agentId, agentId))
    .orderBy(agentMemoryDocs.path, desc(agentMemoryDocs.version));
  return rows.filter((row) => row.content !== '').map(toDocument);
}

/** Every version of one document, newest first; none is a 404. */
export async function memoryVersions(db: Db, agentId: string, path: string) {
  const rows = await select(db)
    .where(and(eq(agentMemoryDocs.agentId, agentId), eq(agentMemoryDocs.path, path)))
    .orderBy(desc(agentMemoryDocs.version));
  if (rows.length === 0) throw new AppError('not_found', 'Memory document not found');
  return rows.map(toDocument);
}

/**
 * Writes the next version of a document. With `baseVersion`, the write stands only if the
 * document is still at it: a person who edited an old version does not overwrite what the agent
 * wrote since. Two writes at once meet at the unique index, and the later one is told the same.
 */
export async function writeMemory(
  db: Db,
  input: { agentId: string; path: string; content: string; author: Author; baseVersion?: number },
): Promise<MemoryDocument> {
  const { agentId, path, content, author, baseVersion } = input;
  const stale = () =>
    new AppError(
      'memory_conflict',
      `${path} changed since version ${baseVersion ?? 0}. Reload it.`,
    );
  try {
    const version = await db.transaction(async (tx) => {
      const [latest] = await tx
        .select({ version: sql<number>`coalesce(max(${agentMemoryDocs.version}), 0)::int` })
        .from(agentMemoryDocs)
        .where(and(eq(agentMemoryDocs.agentId, agentId), eq(agentMemoryDocs.path, path)));
      const current = latest?.version ?? 0;
      if (baseVersion !== undefined && baseVersion !== current) throw stale();
      await tx.insert(agentMemoryDocs).values({
        agentId,
        path,
        content,
        version: current + 1,
        updatedByUserId: 'userId' in author ? author.userId : null,
        updatedByRunId: 'runId' in author ? author.runId : null,
      });
      return current + 1;
    });
    const [written] = await memoryVersions(db, agentId, path).then((all) =>
      all.filter((doc) => doc.version === version),
    );
    if (!written) throw new AppError('internal', 'The memory version was not stored');
    return written;
  } catch (error) {
    if (postgresCode(error) === '23505') throw stale();
    throw error;
  }
}
