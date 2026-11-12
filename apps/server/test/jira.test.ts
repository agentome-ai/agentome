import { describe, expect, it, vi } from 'vitest';
import { CodeHostError } from '../src/code-host/errors.js';
import {
  addComment,
  getIssue,
  issueUrl,
  linkIssue,
  moveIssue,
  searchIssues,
  type JiraConnection,
} from '../src/jira/client.js';

// The Jira client against answers as Data Center 10 shapes them (REST v2), cut down to the
// fields we read. `fetch` answers from a table by `METHOD /path`, so the test holds the client to
// the requests it sends as much as to the answers it reads.

const TOKEN = 'jira-token-nobody-should-see';

type Recorded = { status?: number; body?: unknown; headers?: Record<string, string> };

function jira(table: Record<string, Recorded | Recorded[]>) {
  const seen: { method: string; path: string; body: unknown; auth: string | null }[] = [];
  const left = new Map(
    Object.entries(table).map(([key, value]) => [key, Array.isArray(value) ? [...value] : [value]]),
  );
  const fetchImpl = vi.fn(async (input: Request) => {
    const url = new URL(input.url);
    const text = await input.clone().text();
    seen.push({
      method: input.method,
      path: url.pathname + url.search,
      body: text === '' ? undefined : JSON.parse(text),
      auth: input.headers.get('authorization'),
    });
    const answers = left.get(`${input.method} ${url.pathname}`);
    const answer = answers?.length === 1 ? answers[0] : answers?.shift();
    if (!answer) throw new Error(`No recorded answer for ${input.method} ${url.pathname}`);
    return new Response(answer.status === 204 ? null : JSON.stringify(answer.body ?? {}), {
      status: answer.status ?? 200,
      headers: { 'content-type': 'application/json', ...answer.headers },
    });
  });
  const connection: JiraConnection = {
    baseUrl: 'https://jira.acme.com',
    token: TOKEN,
    request: { fetchImpl: fetchImpl as typeof fetch },
  };
  return { connection, seen, fetchImpl };
}

const issue = (
  key: string,
  status = 'To Do',
  description: string | null = 'h2. Why\nBecause.',
) => ({
  id: String(10000 + Number(key.split('-')[1])),
  key,
  self: `https://jira.acme.com/rest/api/2/issue/${key}`,
  fields: {
    summary: `Fix ${key}`,
    description,
    status: { name: status, id: '1', statusCategory: { key: 'new' } },
    updated: '2026-10-28T10:15:30.000+0300',
  },
});

const transitions = {
  expand: 'transitions',
  transitions: [
    { id: '11', name: 'Start progress', to: { id: '3', name: 'In Progress' } },
    { id: '21', name: 'Send to review', to: { id: '10001', name: 'In Review' } },
  ],
};

async function failure(promise: Promise<unknown>): Promise<CodeHostError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(CodeHostError);
  expect((error as Error).message).not.toContain(TOKEN);
  return error as CodeHostError;
}

describe('the Jira client', () => {
  it('reads an issue with the fields a task takes, under the bearer token', async () => {
    const { connection, seen } = jira({
      'GET /rest/api/2/issue/PAY-12': { body: issue('PAY-12', 'To Do', null) },
    });
    expect(await getIssue(connection, 'PAY-12')).toEqual({
      id: '10012',
      key: 'PAY-12',
      summary: 'Fix PAY-12',
      description: '',
      status: 'To Do',
      updated: '2026-10-28T10:15:30.000+0300',
    });
    expect(seen).toEqual([
      {
        method: 'GET',
        path: '/rest/api/2/issue/PAY-12?fields=summary,description,status,updated',
        body: undefined,
        auth: `Bearer ${TOKEN}`,
      },
    ]);
    expect(issueUrl(connection, 'PAY-12')).toBe('https://jira.acme.com/browse/PAY-12');
  });

  it('sends nothing for what is not an issue key', async () => {
    const { connection, fetchImpl } = jira({});
    const error = await failure(getIssue(connection, '../../myself'));
    expect(error.kind).toBe('not_found');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('pages through a filter, oldest change first', async () => {
    const { connection, seen } = jira({
      'POST /rest/api/2/search': [
        {
          body: { startAt: 0, maxResults: 50, total: 51, issues: [issue('PAY-1'), issue('PAY-2')] },
        },
        { body: { startAt: 50, maxResults: 50, total: 51, issues: [issue('PAY-3')] } },
      ],
    });
    const first = await searchIssues(connection, 'project = PAY AND labels = ai-team');
    expect(first.issues.map((i) => i.key)).toEqual(['PAY-1', 'PAY-2']);
    expect(first).toMatchObject({ total: 51, next: 2 });
    const last = await searchIssues(connection, 'project = PAY order by priority DESC', 50);
    expect(last).toMatchObject({ total: 51, next: null });
    expect(seen[0]?.body).toEqual({
      jql: 'project = PAY AND labels = ai-team ORDER BY updated ASC',
      startAt: 0,
      maxResults: 50,
      fields: ['summary', 'description', 'status', 'updated'],
    });
    // The filter's own order would clash with ours, so it goes.
    expect(seen[1]?.body).toMatchObject({ jql: 'project = PAY ORDER BY updated ASC', startAt: 50 });
  });

  it('moves an issue by the status it ends in, whatever the transition is called', async () => {
    const { connection, seen } = jira({
      'GET /rest/api/2/issue/PAY-12/transitions': { body: transitions },
      'POST /rest/api/2/issue/PAY-12/transitions': { status: 204 },
    });
    expect(await moveIssue(connection, 'PAY-12', 'in review')).toBe('moved');
    expect(seen[1]).toMatchObject({ method: 'POST', body: { transition: { id: '21' } } });
  });

  it('leaves an issue already in the status alone, and names what Jira offers otherwise', async () => {
    const { connection, seen } = jira({
      'GET /rest/api/2/issue/PAY-12/transitions': { body: transitions },
      'GET /rest/api/2/issue/PAY-12': [
        { body: issue('PAY-12', 'Done') },
        { body: issue('PAY-12', 'To Do') },
      ],
    });
    expect(await moveIssue(connection, 'PAY-12', 'Done')).toBe('already');
    const error = await failure(moveIssue(connection, 'PAY-12', 'Done'));
    expect(error.kind).toBe('conflict');
    expect(error.message).toBe('Jira can move PAY-12 to "In Progress", "In Review", not to "Done"');
    expect(seen.filter((call) => call.method === 'POST')).toEqual([]);
  });

  it('comments, and links a pull request once however often it is linked', async () => {
    const { connection, seen } = jira({
      'POST /rest/api/2/issue/PAY-12/comment': { status: 201, body: { id: '10500', body: 'Done' } },
      'POST /rest/api/2/issue/PAY-12/remotelink': { status: 200, body: { id: 7 } },
    });
    expect(await addComment(connection, 'PAY-12', 'The run opened a pull request.')).toEqual({
      id: '10500',
    });
    const link = { url: 'https://github.com/acme/api/pull/42', title: 'Fix PAY-12' };
    await linkIssue(connection, 'PAY-12', link);
    await linkIssue(connection, 'PAY-12', link);
    const links = seen.filter((call) => call.path.endsWith('/remotelink')).map((call) => call.body);
    expect(links).toEqual([
      {
        globalId: 'agentome:https://github.com/acme/api/pull/42',
        object: { url: link.url, title: link.title },
      },
      links[0],
    ]);
  });

  it('says what Jira said when it refuses', async () => {
    const { connection } = jira({
      'POST /rest/api/2/issue/PAY-12/comment': {
        status: 400,
        body: { errorMessages: [], errors: { comment: 'Comment body can not be empty!' } },
      },
      'GET /rest/api/2/issue/PAY-404': {
        status: 404,
        body: { errorMessages: ['Issue Does Not Exist'], errors: {} },
      },
    });
    const empty = await failure(addComment(connection, 'PAY-12', ''));
    expect(empty.message).toBe('jira.acme.com answered 400: Comment body can not be empty!');
    const missing = await failure(getIssue(connection, 'PAY-404'));
    expect(missing).toMatchObject({ kind: 'not_found' });
    expect(missing.message).toContain('Issue Does Not Exist');
  });

  it('waits out a short rate limit once, and reports a long one', async () => {
    const { connection, fetchImpl } = jira({
      'GET /rest/api/2/issue/PAY-12': [
        { status: 429, headers: { 'retry-after': '0' } },
        { body: issue('PAY-12') },
        { status: 429, headers: { 'retry-after': '120' } },
      ],
    });
    expect((await getIssue(connection, 'PAY-12')).key).toBe('PAY-12');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const limited = await failure(getIssue(connection, 'PAY-12'));
    expect(limited.kind).toBe('rate_limited');
  });

  it('refuses an answer in a shape it does not read', async () => {
    const { connection } = jira({
      'GET /rest/api/2/issue/PAY-12': { body: { id: '1', key: 'PAY-12', fields: {} } },
    });
    expect((await failure(getIssue(connection, 'PAY-12'))).kind).toBe('invalid_response');
  });
});
