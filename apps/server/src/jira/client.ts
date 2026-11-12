import { z } from 'zod';
import { CodeHostError } from '../code-host/errors.js';
import { json, type RequestOptions } from '../code-host/http.js';

// Jira Data Center 10+ over REST v2 with a personal access token: our own fetch, through
// the same transport as the code hosts, so a Jira that hangs or answers too much is cut off the
// same way, and a rate limit is waited out once on `retry-after` and then reported. Six endpoints
// in all: issue, search, transitions, transition, comment, remotelink.

export interface JiraConnection {
  readonly baseUrl: string;
  readonly token: string;
  readonly request?: RequestOptions;
}

type ServerInfo = { version?: unknown; versionNumbers?: unknown };
type Myself = { name?: unknown; timeZone?: unknown };

/** The fields an issue brings into a task; the poll asks for these and nothing else. */
const FIELDS = ['summary', 'description', 'status', 'updated'];
/** Jira's own default page, and as much as one poll reads in one request. */
const PAGE = 50;

const issueSchema = z.object({
  id: z.string(),
  key: z.string(),
  fields: z.object({
    summary: z.string(),
    // Wiki markup in v2, absent when nobody wrote one.
    description: z.string().nullish(),
    status: z.object({ name: z.string() }),
    updated: z.string(),
  }),
});
const searchSchema = z.object({
  startAt: z.number(),
  total: z.number(),
  issues: z.array(issueSchema),
});
const transitionsSchema = z.object({
  transitions: z.array(
    z.object({ id: z.string(), name: z.string(), to: z.object({ name: z.string() }) }),
  ),
});
const idSchema = z.object({ id: z.union([z.string(), z.number()]) });

export interface JiraIssue {
  readonly id: string;
  readonly key: string;
  readonly summary: string;
  readonly description: string;
  readonly status: string;
  /** As Jira wrote it, with the account's offset: `2026-10-28T10:15:30.000+0300`. */
  readonly updated: string;
}

function call<T>(connection: JiraConnection, path: string, init?: RequestInit): Promise<T> {
  const url = `${connection.baseUrl}/rest/api/2/${path}`;
  const input = new Request(url, {
    ...init,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${connection.token}`,
    },
  });
  return json<T>(input, connection.request);
}

/** An answer in the shape we read, or `invalid_response`: a field we rely on is never guessed. */
async function parsed<T>(
  schema: z.ZodType<T>,
  connection: JiraConnection,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const result = schema.safeParse(await call<unknown>(connection, path, init));
  if (!result.success) {
    throw new CodeHostError('invalid_response', `Jira answered ${path} in a shape we do not read`);
  }
  return result.data;
}

/** A key goes into a path: `PAY-12` and nothing that could step out of it. */
function issuePath(key: string, rest = ''): string {
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) {
    throw new CodeHostError('not_found', `"${key}" is not a Jira issue key`);
  }
  return `issue/${key}${rest}`;
}

const toIssue = (issue: z.infer<typeof issueSchema>): JiraIssue => ({
  id: issue.id,
  key: issue.key,
  summary: issue.fields.summary,
  description: issue.fields.description ?? '',
  status: issue.fields.status.name,
  updated: issue.fields.updated,
});

/** A filter without its own `ORDER BY`, which would clash with the one a search adds. */
export const withoutOrder = (jql: string): string => jql.replace(/\s*\border\s+by\b[\s\S]*$/i, '');

/**
 * What a connection searches: its project, narrowed by the filter if it has one. The project is
 * never left to the filter, so a filter written wrong cannot reach another project's issues.
 */
export function projectFilter(projectKey: string, jql: string): string {
  const narrow = withoutOrder(jql).trim();
  // Quoted: a key may spell a JQL word, and the key's own pattern leaves no quote to escape.
  return narrow ? `project = "${projectKey}" AND (${narrow})` : `project = "${projectKey}"`;
}

/** Whether an issue key is one of the project's: PAY-12 is PAY's. */
export const inProject = (projectKey: string, key: string): boolean =>
  key.startsWith(`${projectKey}-`);

/** Where a person opens the issue. */
export const issueUrl = (connection: Pick<JiraConnection, 'baseUrl'>, key: string): string =>
  `${connection.baseUrl}/browse/${key}`;

/**
 * Whose token this is, and that the Jira is one we speak to: version 10 or newer, and the filter
 * one it accepts. The time zone is the account's: JQL reads a date in it, and the poll
 * writes its "updated since" there.
 */
export async function probeJira(
  connection: JiraConnection,
  jql: string,
): Promise<{ login: string; timeZone: string }> {
  const info = await call<ServerInfo>(connection, 'serverInfo');
  const major = Array.isArray(info.versionNumbers) ? (info.versionNumbers[0] as unknown) : null;
  if (typeof major !== 'number') {
    throw new CodeHostError('invalid_response', 'The address answered, but not as Jira does');
  }
  if (major < 10) {
    throw new CodeHostError(
      'conflict',
      `This is Jira ${String(info.version)}: Agentome works with Jira Data Center 10 or newer`,
    );
  }
  const me = await call<Myself>(connection, 'myself');
  if (typeof me.name !== 'string' || me.name === '') {
    throw new CodeHostError('invalid_response', 'Jira answered without an account');
  }
  await call(connection, 'search', {
    method: 'POST',
    body: JSON.stringify({ jql, maxResults: 0, fields: ['id'] }),
  }).catch((error: unknown) => {
    if (!(error instanceof CodeHostError) || error.kind !== 'invalid_response') throw error;
    throw new CodeHostError('conflict', `Jira does not accept the filter. ${error.message}`);
  });
  return { login: me.name, timeZone: typeof me.timeZone === 'string' ? me.timeZone : 'UTC' };
}

export async function getIssue(connection: JiraConnection, key: string): Promise<JiraIssue> {
  const path = issuePath(key, `?fields=${FIELDS.join(',')}`);
  return toIssue(await parsed(issueSchema, connection, path));
}

/**
 * One page of the issues under a filter, oldest change first so a poll cut short resumes where
 * it stopped. `next` is where the following page starts, or null on the last one.
 */
export async function searchIssues(
  connection: JiraConnection,
  jql: string,
  startAt = 0,
): Promise<{ issues: JiraIssue[]; total: number; next: number | null }> {
  const page = await parsed(searchSchema, connection, 'search', {
    method: 'POST',
    body: JSON.stringify({
      jql: `${withoutOrder(jql)} ORDER BY updated ASC`,
      startAt,
      maxResults: PAGE,
      fields: FIELDS,
    }),
  });
  const next = page.startAt + page.issues.length;
  return {
    issues: page.issues.map(toIssue),
    total: page.total,
    next: page.issues.length > 0 && next < page.total ? next : null,
  };
}

/**
 * Moves an issue to the status named, through whichever transition Jira offers that ends there.
 * Transition ids differ per workflow, so nothing is stored but the status name. An issue already
 * in that status is left alone, so a retried job changes nothing; a status the workflow does not
 * lead to from here is `conflict`, naming the ones it does.
 */
export async function moveIssue(
  connection: JiraConnection,
  key: string,
  status: string,
): Promise<'moved' | 'already'> {
  const same = (name: string) =>
    name.localeCompare(status, undefined, { sensitivity: 'base' }) === 0;
  const { transitions } = await parsed(
    transitionsSchema,
    connection,
    issuePath(key, '/transitions'),
  );
  const transition =
    transitions.find((t) => same(t.to.name)) ?? transitions.find((t) => same(t.name));
  if (transition) {
    await call(connection, issuePath(key, '/transitions'), {
      method: 'POST',
      body: JSON.stringify({ transition: { id: transition.id } }),
    });
    return 'moved';
  }
  if (same((await getIssue(connection, key)).status)) return 'already';
  const offered = [...new Set(transitions.map((t) => t.to.name))];
  throw new CodeHostError(
    'conflict',
    offered.length === 0
      ? `Jira offers no way to move ${key} to "${status}"`
      : `Jira can move ${key} to ${offered.map((name) => `"${name}"`).join(', ')}, not to "${status}"`,
  );
}

export async function addComment(
  connection: JiraConnection,
  key: string,
  body: string,
): Promise<{ id: string }> {
  const made = await parsed(idSchema, connection, issuePath(key, '/comment'), {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
  return { id: String(made.id) };
}

/**
 * Links a pull or merge request to the issue. Jira keeps one link per `globalId`, so linking the
 * same request again updates its title instead of adding a second link.
 */
export async function linkIssue(
  connection: JiraConnection,
  key: string,
  link: { url: string; title: string },
): Promise<void> {
  await call(connection, issuePath(key, '/remotelink'), {
    method: 'POST',
    body: JSON.stringify({
      globalId: `agentome:${link.url}`,
      object: { url: link.url, title: link.title },
    }),
  });
}
