import { and, type Db, eq, projectConnections, sql, tasks } from '@agentome/db';
import { enqueueRun } from '../runs/service.js';
import { projectIntake } from '../tasks/service.js';
import { decryptSecret } from '../connections/crypto.js';
import { ConnectionConfig } from '../connections/service.js';
import { AppError } from '../errors.js';
import { refusesRun } from '../license/service.js';
import {
  inProject,
  issueUrl,
  probeJira,
  projectFilter,
  searchIssues,
  type JiraConnection,
  type JiraIssue,
} from './client.js';

// Jira's issues become tasks by polling: nothing to set up on the Jira side, and a quiet
// Jira costs one search per connection per interval. What a poll keeps lives in the connection's
// config: `pollStartedAt` claims it, so two servers do not poll it at once; `syncedAt` is when the
// last good poll started, and the next asks for what changed since, less an overlap; `syncError`
// is why the last one failed.

/** The window starts this much before the last poll did: a clock apart, an index catching up. */
const OVERLAP_MS = 2 * 60_000;

/** A date as JQL reads it: minutes, in the time zone of the account the token belongs to. */
export function jqlDate(date: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}

const merge = (id: string, values: Record<string, string | null>) =>
  sql`update ${projectConnections}
      set config = jsonb_strip_nulls(${projectConnections.config} || ${JSON.stringify(values)}::jsonb)
      where ${projectConnections.id} = ${id}`;

/**
 * A new task for an issue seen first, in the project's main repository; the title and
 * description brought up to date otherwise, and the repository left as a person set it.
 */
async function importIssue(
  db: Db,
  connection: JiraConnection,
  owner: { agentId: string; projectId: string; createdBy: string; repository: string | null },
  issue: JiraIssue,
  run: boolean,
): Promise<'imported' | 'updated' | 'same'> {
  const title = `${issue.key}: ${issue.summary}`;
  const body = `${issueUrl(connection, issue.key)}\n\n${issue.description}`.trim();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(tasks)
      .values({ ...owner, title, body, source: 'jira', externalRef: issue.key })
      .onConflictDoUpdate({
        target: [tasks.agentId, tasks.externalRef],
        targetWhere: sql`${tasks.source} = 'jira'`,
        set: { title, body },
        setWhere: sql`(${tasks.title}, ${tasks.body}) is distinct from (${title}, ${body})`,
      })
      // xmax is 0 on a row this statement inserted, and set on one it updated.
      .returning({ id: tasks.id, inserted: sql<boolean>`xmax = 0` });
    // A new issue the project's team takes in auto: its lead starts on it.
    // A month spent leaves the task imported and waiting: its owner starts it once the budget
    // allows.
    if (row?.inserted && run) {
      await enqueueRun(tx, row.id, owner.createdBy).catch((error: unknown) => {
        if (!refusesRun(error)) throw error;
      });
    }
    return !row ? 'same' : row.inserted ? 'imported' : 'updated';
  });
}

/**
 * One poll of one connection: every issue under its filter changed since the last good poll,
 * a page at a time. A failure is kept on the connection and thrown; the window stays where it
 * was, so the next poll asks again for what this one missed.
 */
export async function pollConnection(
  db: Db,
  key: Buffer,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ imported: number; updated: number }> {
  const [row] = await db
    .select()
    .from(projectConnections)
    .where(and(eq(projectConnections.id, id), eq(projectConnections.kind, 'jira')));
  if (!row) throw new AppError('not_found', 'Jira connection not found');
  const config = ConnectionConfig.parse({ kind: row.kind, ...row.config });
  if (config.kind !== 'jira') throw new Error('Not a Jira connection');
  const connection: JiraConnection = {
    baseUrl: config.baseUrl,
    token: decryptSecret(key, row.tokenCiphertext),
    request: { fetchImpl },
  };
  // Issues go to the connection's agent, or else to the project's team lead.
  const intake = await projectIntake(db, row.projectId);
  const agentId = row.agentId ?? intake.leadId;
  const run = !row.agentId && intake.auto;
  const owner = {
    agentId: agentId ?? '',
    projectId: row.projectId,
    createdBy: row.createdBy,
    // None of its own: its runs take the project's main repository as it is then.
    repository: null,
  };
  const started = new Date();
  const counts = { imported: 0, updated: 0 };
  try {
    if (!agentId)
      throw new Error('The project has no team to take its issues. Give it one on its page.');
    // A connection never checked has no time zone yet, and a window in the wrong one misses hours.
    const filter = projectFilter(config.projectKey, config.jql);
    const timeZone = config.timeZone ?? (await probeJira(connection, filter)).timeZone;
    const since = row.config.syncedAt;
    const jql = since
      ? `(${filter}) AND updated >= "${jqlDate(new Date(Date.parse(since) - OVERLAP_MS), timeZone)}"`
      : filter;
    for (let at: number | null = 0; at !== null;) {
      const page = await searchIssues(connection, jql, at);
      for (const issue of page.issues) {
        // Jira answers what the filter asked; an answer from elsewhere is not taken on trust.
        if (!inProject(config.projectKey, issue.key)) continue;
        const done = await importIssue(db, connection, owner, issue, run);
        if (done !== 'same') counts[done]++;
      }
      at = page.next;
    }
    await db.execute(merge(id, { syncedAt: started.toISOString(), timeZone, syncError: null }));
    return counts;
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error);
    await db.execute(merge(id, { syncError: said.slice(0, 500) }));
    throw error;
  }
}

/**
 * Claims the Jira connections whose interval has passed, and polls them one after another. A
 * claim is one update, so a second server finds them taken; a poll that fails is logged and
 * tried again an interval later.
 */
export async function pollDue(
  db: Db,
  key: Buffer,
  minutes: number,
  log: { warn: (fields: object, message: string) => void },
): Promise<void> {
  const now = new Date();
  const due = await db.execute<{ id: string }>(sql`
    update ${projectConnections}
    set config = ${projectConnections.config} || jsonb_build_object('pollStartedAt', ${now.toISOString()}::text)
    where ${projectConnections.kind} = 'jira'
      and (${projectConnections.config}->>'pollStartedAt' is null
        or (${projectConnections.config}->>'pollStartedAt')::timestamptz < ${new Date(now.getTime() - minutes * 60_000).toISOString()}::timestamptz)
    returning ${projectConnections.id} as id`);
  for (const { id } of due) {
    await pollConnection(db, key, id).catch((error: unknown) => {
      log.warn({ err: error, connectionId: id }, 'a Jira poll failed');
    });
  }
}
