import {
  agents,
  and,
  type Db,
  desc,
  eq,
  inArray,
  isNull,
  or,
  projectAgents,
  projectConnections,
  projects,
  sql,
} from '@agentome/db';
import { CodeHostKind, type ConnectionKind } from '@agentome/shared';
import { z } from 'zod';
import { CodeHostError, codeHostFor } from '../code-host/index.js';
import { projectIntake } from '../tasks/service.js';
import { AppError, postgresCode } from '../errors.js';
import { probeJira, projectFilter } from '../jira/client.js';
import { decryptSecret, encryptSecret, newWebhookSecret } from './crypto.js';

// A project's connections to its code hosts: what the gateway, the git proxy and the
// webhooks of the next tasks act through; and to the Jira its tasks come from. The
// token is encrypted here and decrypted only for a request to the host; no answer of the API
// carries it.

const Owner = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, 'A GitHub user or organization name');
// A group path, nested or not: acme or acme/platform/backend.
const Group = z
  .string()
  .trim()
  .regex(/^[\w.-]+(?:\/[\w.-]+)*$/, 'A GitLab group path such as acme/platform')
  .max(255);
const BaseUrl = z
  .url({ protocol: /^https?$/ })
  .max(500)
  .transform((url) => new URL(url).origin);

// Jira Data Center often lives under a path (`https://intranet.acme.com/jira`), so its address
// keeps one; only a trailing slash goes.
const JiraUrl = z
  .url({ protocol: /^https?$/ })
  .max(500)
  .transform((url) => {
    const { origin, pathname } = new URL(url);
    return origin + pathname.replace(/\/+$/, '');
  });
// The project's key is the bound of what a connection reaches; the filter only narrows it.
const ProjectKey = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9_]{0,49}$/, 'A Jira project key, such as PAY');
const Jql = z.string().trim().max(1000);
const Status = z.string().trim().min(1).max(100);

/**
 * What a connection reaches, per host: GitHub is github.com, GitLab is wherever. Jira:
 * the issues its filter finds, and the statuses a run moves them to, by name; the time
 * zone is the account's, as the last check found it.
 */
export const ConnectionConfig = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('github'), owner: Owner }),
  z.object({ kind: z.literal('gitlab'), baseUrl: BaseUrl, group: Group }),
  z.object({
    kind: z.literal('jira'),
    baseUrl: JiraUrl,
    projectKey: ProjectKey,
    jql: Jql.default(''),
    inProgress: Status,
    inReview: Status,
    done: Status,
    timeZone: z.string().max(100).optional(),
  }),
]);
export type ConnectionConfig = z.infer<typeof ConnectionConfig>;

export const Token = z.string().min(1).max(500).regex(/^\S+$/, 'A token has no spaces');

type Row = typeof projectConnections.$inferSelect;

/**
 * Where a connection reaches, as the resolver compares it: the host and the namespace, both
 * lower case. The host keeps the spelling it was given in `config`, which is what the proxy
 * and the hosts' APIs will use: a path on GitLab is case-sensitive, so `config`
 * holds `Acme/Platform` while the match is on `acme/platform`.
 */
function placeOf(config: ConnectionConfig): { host: string; namespace: string } {
  if (config.kind === 'github') {
    return { host: 'github.com', namespace: config.owner.toLowerCase() };
  }
  // A filter is no repository path: nothing resolves a repository to it (CodeHostKind below).
  if (config.kind === 'jira') {
    return {
      host: new URL(config.baseUrl).host,
      namespace: projectFilter(config.projectKey, config.jql),
    };
  }
  return {
    host: new URL(config.baseUrl).host.toLowerCase(),
    namespace: config.group.toLowerCase(),
  };
}

const configOf = (row: Row): ConnectionConfig =>
  ConnectionConfig.parse({ kind: row.kind, ...row.config });

/** The config as stored: without `kind`, which is a column of its own. */
function storedConfig(config: ConnectionConfig): Record<string, string> {
  const copy: Record<string, string> = { ...config };
  delete copy.kind;
  return copy;
}

/** The shape the API answers with: everything but the secrets. */
type Named = { id: string; name: string };

export function toConnection(row: Row, project: Named, agent: Named | null) {
  return {
    id: row.id,
    project,
    // Whose token this is: one agent's own, or every agent's of the project (null); for Jira,
    // the agent its issues go to.
    agent,
    kind: row.kind,
    config: storedConfig(configOf(row)),
    host: row.host,
    namespace: row.namespace,
    accountLogin: row.accountLogin,
    lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
    // Jira's poll: when the last good one started, and why the last one failed.
    syncedAt: row.config.syncedAt ?? null,
    syncError: row.config.syncError ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
export type ConnectionView = ReturnType<typeof toConnection>;

const withProject = (db: Db) =>
  db
    .select({
      row: projectConnections,
      project: { id: projects.id, name: projects.name },
      agentId: agents.id,
      agentName: agents.name,
    })
    .from(projectConnections)
    .innerJoin(projects, eq(projects.id, projectConnections.projectId))
    .leftJoin(agents, eq(agents.id, projectConnections.agentId));

const viewOf = (found: Awaited<ReturnType<ReturnType<typeof withProject>['execute']>>[number]) =>
  toConnection(
    found.row,
    found.project,
    found.agentId && found.agentName ? { id: found.agentId, name: found.agentName } : null,
  );

export async function listConnections(db: Db): Promise<ConnectionView[]> {
  const rows = await withProject(db).orderBy(desc(projectConnections.createdAt));
  return rows.map(viewOf);
}

async function rowFor(db: Db, id: string) {
  const [found] = await withProject(db).where(eq(projectConnections.id, id));
  if (!found) throw new AppError('not_found', 'Connection not found');
  return found;
}

export async function connectionView(db: Db, id: string): Promise<ConnectionView> {
  return viewOf(await rowFor(db, id));
}

/**
 * A failure of the host, as this API answers it: the token was refused, or the host could not
 * be reached. The gateway reads the same error its own way, for the agent.
 */
export function asApiError(error: unknown): AppError {
  if (!(error instanceof CodeHostError))
    return new AppError('connection_unreachable', String(error));
  if (error.kind === 'unauthorized' || error.kind === 'forbidden') {
    return new AppError('connection_unauthorized', error.message);
  }
  if (error.kind === 'conflict') return new AppError('bad_request', error.message);
  return new AppError('connection_unreachable', error.message);
}

/** An agent's own token makes sense only for an agent the project has. */
async function assertOnProject(db: Db, projectId: string, agentId: string) {
  const [member] = await db
    .select({ agentId: projectAgents.agentId })
    .from(projectAgents)
    .where(and(eq(projectAgents.projectId, projectId), eq(projectAgents.agentId, agentId)));
  if (!member) {
    throw new AppError('bad_request', 'Put the agent on this project before giving it a token');
  }
}

function taken(error: unknown): never {
  if (postgresCode(error) === '23505') {
    throw new AppError(
      'connection_exists',
      'This project already has a connection to that host and namespace for the same agents',
    );
  }
  if (postgresCode(error) === '23503') throw new AppError('not_found', 'Project not found');
  throw error;
}

export async function createConnection(
  db: Db,
  key: Buffer,
  userId: string,
  input: { projectId: string; agentId?: string; config: ConnectionConfig; token: string },
): Promise<ConnectionView> {
  const place = placeOf(input.config);
  // Without an agent, a Jira connection's issues go to the project's team.
  if (
    input.config.kind === 'jira' &&
    !input.agentId &&
    !(await projectIntake(db, input.projectId)).leadId
  ) {
    throw new AppError(
      'bad_request',
      'Pick the agent the issues go to, or give the project a team to take them',
    );
  }
  if (input.agentId) await assertOnProject(db, input.projectId, input.agentId);
  let row: Row | undefined;
  try {
    [row] = await db
      .insert(projectConnections)
      .values({
        projectId: input.projectId,
        agentId: input.agentId ?? null,
        kind: input.config.kind,
        config: storedConfig(input.config),
        host: place.host,
        namespace: place.namespace,
        tokenCiphertext: encryptSecret(key, input.token),
        webhookSecretCiphertext: encryptSecret(key, newWebhookSecret()),
        createdBy: userId,
      })
      .returning();
  } catch (error) {
    taken(error);
  }
  if (!row) throw new Error('The insert returned no connection');
  return connectionView(db, row.id);
}

/** A new config moves the connection; a new token forgets what the last test found out. */
export async function updateConnection(
  db: Db,
  key: Buffer,
  id: string,
  changes: { config?: ConnectionConfig; token?: string },
): Promise<ConnectionView> {
  const current = await rowFor(db, id);
  const set: Partial<typeof projectConnections.$inferInsert> = {};
  if (changes.config) {
    if (changes.config.kind !== current.row.kind) {
      throw new AppError('bad_request', 'A connection keeps its kind; create another instead');
    }
    const { host, namespace } = placeOf(changes.config);
    const config = storedConfig(changes.config);
    // The stored token goes only to the host it was entered for: a new address takes it anew.
    const before = (current.row.config as { baseUrl?: string }).baseUrl;
    const after = (config as { baseUrl?: string }).baseUrl;
    if ((host !== current.row.host || before !== after) && changes.token === undefined) {
      throw new AppError(
        'validation_failed',
        'Enter the token again for the new address: a saved token goes only where it was entered for',
      );
    }
    Object.assign(set, { config, host, namespace });
  }
  if (changes.token !== undefined) {
    set.tokenCiphertext = encryptSecret(key, changes.token);
    set.accountLogin = null;
    set.lastTestedAt = null;
  }
  if (Object.keys(set).length > 0) {
    try {
      await db.update(projectConnections).set(set).where(eq(projectConnections.id, id));
    } catch (error) {
      taken(error);
    }
  }
  return connectionView(db, id);
}

export async function deleteConnection(db: Db, id: string): Promise<void> {
  const [gone] = await db
    .delete(projectConnections)
    .where(eq(projectConnections.id, id))
    .returning({ id: projectConnections.id });
  if (!gone) throw new AppError('not_found', 'Connection not found');
}

/** Asks the host whose token this is, and remembers the answer on the connection. */
export async function testConnection(
  db: Db,
  key: Buffer,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ login: string; testedAt: string }> {
  const { row } = await rowFor(db, id);
  const config = configOf(row);
  const token = decryptSecret(key, row.tokenCiphertext);
  const probe: Promise<{ login: string; timeZone?: string }> =
    config.kind === 'jira'
      ? probeJira(
          { baseUrl: config.baseUrl, token, request: { fetchImpl } },
          projectFilter(config.projectKey, config.jql),
        )
      : codeHostFor(codeHostConfig(row), token, { fetchImpl }).probe();
  const { login, timeZone } = await probe.catch((error: unknown) => {
    throw asApiError(error);
  });
  const testedAt = new Date();
  await db
    .update(projectConnections)
    .set({
      accountLogin: login,
      lastTestedAt: testedAt,
      ...(timeZone !== undefined && { config: { ...row.config, timeZone } }),
    })
    .where(eq(projectConnections.id, id));
  return { login, testedAt: testedAt.toISOString() };
}

/** What the code host of a connection needs; a Jira connection is no code host. */
function codeHostConfig(row: Row) {
  const config = configOf(row);
  if (config.kind === 'jira')
    throw new AppError('bad_request', 'A Jira connection is no code host');
  return { kind: config.kind, baseUrl: config.kind === 'gitlab' ? config.baseUrl : undefined };
}

/** The code host a connection reaches, with its token decrypted in this process only. */
export async function codeHostOf(db: Db, key: Buffer, id: string) {
  const { row } = await rowFor(db, id);
  return codeHostFor(codeHostConfig(row), decryptSecret(key, row.tokenCiphertext));
}

/**
 * Where the git proxy sends a repository's git and the header that opens it there:
 * the connection's own host, never an address a host's answer names, so the token goes nowhere
 * else.
 */
export async function gitRemoteOf(db: Db, key: Buffer, id: string, path: string) {
  const { row } = await rowFor(db, id);
  const config = codeHostConfig(row);
  const host = codeHostFor(config, decryptSecret(key, row.tokenCiphertext));
  const origin = config.baseUrl ?? 'https://github.com';
  const { username, password } = host.gitCredential();
  const basic = Buffer.from(`${username}:${password}`).toString('base64');
  return { host, path, url: `${origin}/${path}.git`, authorization: `Basic ${basic}` };
}

/** What the administrator pastes into the host's webhook settings. */
export async function webhookSettings(db: Db, key: Buffer, id: string, publicUrl: string) {
  const { row } = await rowFor(db, id);
  // Jira is polled: there is nothing to paste into it.
  if (row.kind === 'jira') throw new AppError('not_found', 'A Jira connection has no webhook');
  return {
    url: `${publicUrl.replace(/\/+$/, '')}/webhooks/${row.kind}/${row.id}`,
    secret: decryptSecret(key, row.webhookSecretCiphertext),
  };
}

export type ResolvedConnection = {
  id: string;
  kind: ConnectionKind;
  project: { id: string; name: string };
};

/**
 * A repository URL's host and every namespace it could fall under, lower case; null for no URL.
 * The repository's own path is one of them: a GitLab connection may be made for one project,
 * with a project access token, and name that project as its group.
 */
function placeOfUrl(repository: string | null) {
  if (repository === null || !/^https?:\/\//i.test(repository) || !URL.canParse(repository)) {
    return null;
  }
  const url = new URL(repository);
  const segments = url.pathname
    .replace(/\.git$/, '')
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => segment.toLowerCase());
  const namespaces = segments.map((_, i) => segments.slice(0, i + 1).join('/'));
  return segments.length < 2 ? null : { host: url.host.toLowerCase(), namespaces };
}

/**
 * The connection of a project that reaches a repository, for what the project reads as a whole
 * (its knowledge): the shared token before an agent's own, then the deepest namespace.
 */
export async function projectConnectionFor(
  db: Db,
  projectId: string,
  repository: string,
): Promise<{ id: string } | null> {
  const place = placeOfUrl(repository);
  if (!place) return null;
  const [found] = await db
    .select({ id: projectConnections.id })
    .from(projectConnections)
    .where(
      and(
        eq(projectConnections.projectId, projectId),
        inArray(projectConnections.kind, CodeHostKind.options),
        eq(projectConnections.host, place.host),
        inArray(projectConnections.namespace, place.namespaces),
      ),
    )
    .orderBy(sql`${projectConnections.agentId} is not null`, desc(projectConnections.namespace))
    .limit(1);
  return found ?? null;
}

/**
 * The connection a task's repository falls under, among the projects of its agent: the URL's
 * host, and its namespace as the leading path segments (GitHub: the owner; GitLab: any depth
 * of groups, so every prefix short of the repository itself is tried). A path on the computer,
 * a URL nobody connected, or a host of a project the agent is not in: null.
 */
export async function connectionFor(
  db: Db,
  agentId: string,
  repository: string | null,
): Promise<ResolvedConnection | null> {
  const place = placeOfUrl(repository);
  if (!place) return null;
  const { host, namespaces } = place;
  const [found] = await db
    .select({
      id: projectConnections.id,
      kind: projectConnections.kind,
      project: { id: projects.id, name: projects.name },
      namespace: projectConnections.namespace,
    })
    .from(projectConnections)
    .innerJoin(projects, eq(projects.id, projectConnections.projectId))
    .innerJoin(projectAgents, eq(projectAgents.projectId, projects.id))
    .where(
      and(
        eq(projectAgents.agentId, agentId),
        inArray(projectConnections.kind, CodeHostKind.options),
        eq(projectConnections.host, host),
        inArray(projectConnections.namespace, namespaces),
        or(isNull(projectConnections.agentId), eq(projectConnections.agentId, agentId)),
      ),
    )
    // The agent's own token first, whatever the depth; then the deepest
    // namespace: acme/platform over acme.
    .orderBy(sql`${projectConnections.agentId} is null`, desc(projectConnections.namespace))
    .limit(1);
  return found ? { id: found.id, kind: found.kind, project: found.project } : null;
}
