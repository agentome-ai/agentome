import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodeHostError, codeHostFor, type CodeHost } from '../src/code-host/index.js';

// One suite over both hosts. `fetch` answers from a table of recorded
// shapes, so the test holds the adapters to the requests they send and the answers they read,
// without touching github.com or a GitLab. The bodies are cut down to the fields we use.

const TOKEN = 'secret-token-nobody-should-see';

type Recorded = { status?: number; body?: unknown; headers?: Record<string, string> };
type Table = Record<string, Recorded | Recorded[]>;

/** The calls a test made, and the answers it gave, by `METHOD /path`. */
function host(kind: 'github' | 'gitlab', table: Table) {
  const seen: { method: string; path: string; body: unknown; headers: Headers }[] = [];
  const left = new Map<string, Recorded[]>(
    Object.entries(table).map(([key, value]) => [key, Array.isArray(value) ? [...value] : [value]]),
  );
  const fetchImpl = vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
    const call = input instanceof Request ? input : new Request(input, init);
    const url = new URL(call.url);
    const key = `${call.method} ${url.pathname}`;
    const text = await call.clone().text();
    seen.push({
      method: call.method,
      path: url.pathname + url.search,
      body: text === '' ? undefined : JSON.parse(text),
      headers: call.headers,
    });
    const answers = left.get(key);
    const answer = answers?.length === 1 ? answers[0] : answers?.shift();
    if (!answer) throw new Error(`No recorded answer for ${key}`);
    const body = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body ?? {});
    return new Response(answer.status === 204 ? null : body, {
      status: answer.status ?? 200,
      headers: { 'content-type': 'application/json', ...answer.headers },
    });
  });
  const connection = kind === 'github' ? { kind } : { kind, baseUrl: 'https://gitlab.acme.com' };
  const api: CodeHost = codeHostFor(connection, TOKEN, { fetchImpl: fetchImpl as typeof fetch });
  return { api, seen, fetchImpl };
}

afterEach(() => vi.useRealTimers());

// What each host answers for the same repository, as its API shapes it.
const repo = {
  github: {
    'GET /repos/acme/api': {
      body: {
        full_name: 'acme/api',
        clone_url: 'https://github.com/acme/api.git',
        html_url: 'https://github.com/acme/api',
        default_branch: 'main',
      },
    },
  },
  gitlab: {
    'GET /api/v4/projects/acme%2Fapi': {
      body: {
        path_with_namespace: 'acme/api',
        http_url_to_repo: 'https://gitlab.acme.com/acme/api.git',
        web_url: 'https://gitlab.acme.com/acme/api',
        default_branch: 'main',
      },
    },
  },
};

describe('both hosts answer the same questions', () => {
  it('reads a repository from the URL a task names', async () => {
    const gh = host('github', repo.github);
    expect(await gh.api.repository('https://github.com/acme/api.git')).toEqual({
      path: 'acme/api',
      cloneUrl: 'https://github.com/acme/api.git',
      webUrl: 'https://github.com/acme/api',
      defaultBranch: 'main',
    });

    const gl = host('gitlab', repo.gitlab);
    expect(await gl.api.repository('https://gitlab.acme.com/acme/api')).toEqual({
      path: 'acme/api',
      cloneUrl: 'https://gitlab.acme.com/acme/api.git',
      webUrl: 'https://gitlab.acme.com/acme/api',
      defaultBranch: 'main',
    });
  });

  it('says whose account the token is', async () => {
    const gh = host('github', { 'GET /user': { body: { login: 'acme-bot' } } });
    expect(await gh.api.probe()).toEqual({ login: 'acme-bot' });
    expect(gh.seen[0]?.headers.get('authorization')).toBe(`token ${TOKEN}`);

    const gl = host('gitlab', { 'GET /api/v4/user': { body: { username: 'acme-bot' } } });
    expect(await gl.api.probe()).toEqual({ login: 'acme-bot' });
    expect(gl.seen[0]?.headers.get('private-token')).toBe(TOKEN);
  });

  it('opens a change request and reads it back in our words', async () => {
    const pull = {
      number: 42,
      title: 'Add a README',
      state: 'open',
      draft: false,
      merged_at: null,
      html_url: 'https://github.com/acme/api/pull/42',
      head: { ref: 'agent/readme', sha: 'c0ffee' },
      base: { ref: 'main' },
    };
    const gh = host('github', {
      ...repo.github,
      'POST /repos/acme/api/pulls': { status: 201, body: pull },
      'GET /repos/acme/api/commits/c0ffee/check-runs': {
        body: { check_runs: [{ status: 'completed', conclusion: 'success' }] },
      },
    });
    const opened = await gh.api.openChangeRequest({
      repository: 'acme/api',
      title: 'Add a README',
      description: 'As the task asked.',
      sourceBranch: 'agent/readme',
    });
    expect(opened).toEqual({
      number: 42,
      title: 'Add a README',
      state: 'open',
      url: 'https://github.com/acme/api/pull/42',
      sourceBranch: 'agent/readme',
      targetBranch: 'main',
      pipeline: 'success',
    });
    // The target branch was not given, so the repository's default was read and sent.
    expect(gh.seen.find((call) => call.method === 'POST')?.body).toMatchObject({
      base: 'main',
      head: 'agent/readme',
      draft: false,
    });

    const mr = {
      iid: 42,
      title: 'Add a README',
      state: 'opened',
      draft: false,
      web_url: 'https://gitlab.acme.com/acme/api/-/merge_requests/42',
      source_branch: 'agent/readme',
      target_branch: 'main',
      head_pipeline: { id: 7, status: 'running' },
    };
    const gl = host('gitlab', {
      ...repo.gitlab,
      'POST /api/v4/projects/acme%2Fapi/merge_requests': { status: 201, body: mr },
    });
    expect(
      await gl.api.openChangeRequest({
        repository: 'acme/api',
        title: 'Add a README',
        description: 'As the task asked.',
        sourceBranch: 'agent/readme',
        targetBranch: 'main',
      }),
    ).toEqual({
      number: 42,
      title: 'Add a README',
      state: 'open',
      url: 'https://gitlab.acme.com/acme/api/-/merge_requests/42',
      sourceBranch: 'agent/readme',
      targetBranch: 'main',
      pipeline: 'running',
    });
    // GitLab's own names: gitbeaker hands its requester `sourceBranch`, which GitLab ignores.
    expect(gl.seen.find((call) => call.method === 'POST')?.body).toEqual({
      source_branch: 'agent/readme',
      target_branch: 'main',
      title: 'Add a README',
      description: 'As the task asked.',
    });
  });

  it("keeps GitLab from running an agent's lines as quick actions", async () => {
    const mr = {
      iid: 42,
      title: 'Add a README',
      state: 'opened',
      web_url: 'https://gitlab.acme.com/acme/api/-/merge_requests/42',
    };
    const gl = host('gitlab', {
      ...repo.gitlab,
      'POST /api/v4/projects/acme%2Fapi/merge_requests': { status: 201, body: mr },
      'POST /api/v4/projects/acme%2Fapi/merge_requests/42/notes': { status: 201, body: { id: 7 } },
      'GET /api/v4/projects/acme%2Fapi/merge_requests/42': { body: mr },
    });
    // A prompt-injected agent: approve and merge its own change request, past its owner.
    await gl.api.openChangeRequest({
      repository: 'acme/api',
      title: 'Add a README',
      description: 'Done.\n/approve\n/merge',
      sourceBranch: 'agent/readme',
      targetBranch: 'main',
    });
    await gl.api.replyToReview({
      repository: 'acme/api',
      number: 42,
      body: '/approve\r\nFixed, see /docs.\n```\n/merge\n```',
    });
    const [opened, note] = gl.seen.filter((call) => call.method === 'POST');
    expect(opened?.body).toMatchObject({ description: 'Done.\n\\/approve\n\\/merge' });
    expect(note?.body).toEqual({ body: '\\/approve\r\nFixed, see /docs.\n```\n\\/merge\n```' });
  });

  it('reads a merged change request as merged, and a draft as a draft', async () => {
    const gh = host('github', {
      'GET /repos/acme/api/pulls/42': {
        body: {
          number: 42,
          title: 'Done',
          state: 'closed',
          draft: false,
          merged_at: '2026-10-22T10:00:00Z',
          html_url: 'https://github.com/acme/api/pull/42',
          head: { ref: 'agent/readme', sha: 'c0ffee' },
          base: { ref: 'main' },
        },
      },
      'GET /repos/acme/api/commits/c0ffee/check-runs': { body: { check_runs: [] } },
    });
    expect(await gh.api.getChangeRequest('acme/api', 42)).toMatchObject({
      state: 'merged',
      pipeline: 'none',
    });

    const gl = host('gitlab', {
      'GET /api/v4/projects/acme%2Fapi/merge_requests/42': {
        body: {
          iid: 42,
          title: 'Draft: Done',
          state: 'opened',
          draft: true,
          web_url: 'https://gitlab.acme.com/acme/api/-/merge_requests/42',
          source_branch: 'agent/readme',
          target_branch: 'main',
        },
      },
    });
    expect(await gl.api.getChangeRequest('acme/api', 42)).toMatchObject({
      state: 'draft',
      pipeline: 'none',
    });
  });

  it('creates a branch from another', async () => {
    const gh = host('github', {
      'GET /repos/acme/api/git/ref/heads%2Fmain': { body: { object: { sha: 'c0ffee' } } },
      'POST /repos/acme/api/git/refs': { status: 201, body: {} },
    });
    await gh.api.createBranch('acme/api', 'agent/readme', 'main');
    expect(gh.seen.at(-1)?.body).toEqual({ ref: 'refs/heads/agent/readme', sha: 'c0ffee' });

    const gl = host('gitlab', {
      'POST /api/v4/projects/acme%2Fapi/repository/branches': { status: 201, body: {} },
    });
    await gl.api.createBranch('acme/api', 'agent/readme', 'main');
    const branch = gl.seen.at(-1);
    expect(branch?.path).toBe('/api/v4/projects/acme%2Fapi/repository/branches');
    expect(branch?.body).toEqual({ branch: 'agent/readme', ref: 'main' });
  });

  it('brings back what the pipeline failed on, without the whole log', async () => {
    const gh = host('github', {
      'GET /repos/acme/api/pulls/42': {
        body: {
          number: 42,
          title: 'Done',
          state: 'open',
          draft: false,
          merged_at: null,
          html_url: 'https://github.com/acme/api/pull/42',
          head: { ref: 'agent/readme', sha: 'c0ffee' },
          base: { ref: 'main' },
        },
      },
      'GET /repos/acme/api/commits/c0ffee/check-runs': {
        body: {
          check_runs: [
            { name: 'tests', status: 'completed', conclusion: 'success', output: {} },
            {
              name: 'lint',
              status: 'completed',
              conclusion: 'failure',
              html_url: 'https://github.com/acme/api/runs/9',
              output: { title: 'ESLint', summary: '1 problem', text: 'no-unused-vars' },
            },
          ],
        },
      },
    });
    expect(await gh.api.getPipelineFailures('acme/api', 42)).toEqual([
      {
        job: 'lint',
        url: 'https://github.com/acme/api/runs/9',
        log: 'ESLint\n\n1 problem\n\nno-unused-vars',
      },
    ]);

    const trace = `${'x'.repeat(9000)}\nthe last line`;
    const gl = host('gitlab', {
      'GET /api/v4/projects/acme%2Fapi/merge_requests/42': {
        body: { iid: 42, state: 'opened', head_pipeline: { id: 7, status: 'failed' } },
      },
      'GET /api/v4/projects/acme%2Fapi/pipelines/7/jobs': {
        body: [
          { id: 9, name: 'lint', status: 'failed', web_url: 'https://gitlab.acme.com/jobs/9' },
          { id: 10, name: 'tests', status: 'success' },
        ],
      },
      'GET /api/v4/projects/acme%2Fapi/jobs/9/trace': {
        body: trace,
        headers: { 'content-type': 'text/plain' },
      },
    });
    const failures = await gl.api.getPipelineFailures('acme/api', 42);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.job).toBe('lint');
    // The tail, asked for by range and cut to what a person reads.
    expect(failures[0]?.log.endsWith('the last line')).toBe(true);
    expect(failures[0]?.log.length).toBeLessThanOrEqual(4000);
    expect(gl.seen.at(-1)?.headers.get('range')).toBe('bytes=-16384');
  });

  it('keeps the tail of a log even when GitLab ignores the range and sends all of it', async () => {
    // Megabytes of trace with no Range honoured: the tail survives, and nothing is too large.
    const huge = `${'noise\n'.repeat(400_000)}the real error`;
    const gl = host('gitlab', {
      'GET /api/v4/projects/acme%2Fapi/merge_requests/42': {
        body: { iid: 42, state: 'opened', head_pipeline: { id: 7, status: 'failed' } },
      },
      'GET /api/v4/projects/acme%2Fapi/pipelines/7/jobs': {
        body: [{ id: 9, name: 'build', status: 'failed' }],
      },
      'GET /api/v4/projects/acme%2Fapi/jobs/9/trace': {
        body: huge,
        headers: { 'content-type': 'text/plain', 'content-length': String(huge.length) },
      },
    });
    const [failure] = await gl.api.getPipelineFailures('acme/api', 42);
    expect(failure?.log.endsWith('the real error')).toBe(true);
  });

  it('answers whether one commit is an ancestor of another', async () => {
    const ahead = host('github', {
      'GET /repos/acme/api/compare/old...new': { body: { status: 'ahead' } },
    });
    expect(await ahead.api.isAncestor('acme/api', 'old', 'new')).toBe(true);
    const diverged = host('github', {
      'GET /repos/acme/api/compare/old...new': { body: { status: 'diverged' } },
    });
    expect(await diverged.api.isAncestor('acme/api', 'old', 'new')).toBe(false);

    const base = host('gitlab', {
      'GET /api/v4/projects/acme%2Fapi/repository/merge_base': { body: { id: 'old' } },
    });
    expect(await base.api.isAncestor('acme/api', 'old', 'new')).toBe(true);
    // A list as GitLab reads one: `refs=old,new` would be a 400, and the proxy would put back
    // every push it could not check.
    expect(new URL(`https://x${base.seen[0]?.path ?? ''}`).searchParams.getAll('refs[]')).toEqual([
      'old',
      'new',
    ]);
    const other = host('gitlab', {
      'GET /api/v4/projects/acme%2Fapi/repository/merge_base': { body: { id: 'elsewhere' } },
    });
    expect(await other.api.isAncestor('acme/api', 'old', 'new')).toBe(false);
    // A prefix is not the commit: the proxy's guard against a rewritten history must not match
    // a short `older` against any merge base that starts with the same letters.
    const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
    const prefix = host('gitlab', {
      'GET /api/v4/projects/acme%2Fapi/repository/merge_base': { body: { id: sha } },
    });
    expect(await prefix.api.isAncestor('acme/api', 'a1b2', 'new')).toBe(false);
    expect(await prefix.api.isAncestor('acme/api', sha, 'new')).toBe(true);
  });

  it('lists the files of a branch and reads one by the id of its content', async () => {
    const gh = host('github', {
      'GET /repos/acme/api/git/trees/main': {
        body: {
          truncated: false,
          tree: [
            { path: 'docs', type: 'tree', sha: 't1' },
            { path: 'docs/refunds.md', type: 'blob', sha: 'b1' },
          ],
        },
      },
      'GET /repos/acme/api/git/blobs/b1': {
        body: { encoding: 'base64', content: Buffer.from('# Refunds\n').toString('base64') },
      },
    });
    expect(await gh.api.tree('acme/api', 'main')).toEqual({
      files: [{ path: 'docs/refunds.md', sha: 'b1' }],
      truncated: false,
    });
    expect(gh.seen[0]?.path).toBe('/repos/acme/api/git/trees/main?recursive=true');
    expect(await gh.api.file('acme/api', 'b1')).toBe('# Refunds\n');

    // GitLab pages its tree: the second page is asked for by the number the first one named.
    const gl = host('gitlab', {
      'GET /api/v4/projects/acme%2Fapi/repository/tree': [
        {
          body: [{ path: 'README.md', type: 'blob', id: 'r1' }],
          headers: { 'x-next-page': '2' },
        },
        {
          body: [
            { path: 'docs/a.md', type: 'blob', id: 'a1' },
            { path: 'docs', type: 'tree', id: 't' },
          ],
        },
      ],
      'GET /api/v4/projects/acme%2Fapi/repository/blobs/a1/raw': {
        body: '# A',
        headers: { 'content-type': 'text/plain' },
      },
    });
    expect(await gl.api.tree('acme/api', 'main')).toEqual({
      files: [
        { path: 'README.md', sha: 'r1' },
        { path: 'docs/a.md', sha: 'a1' },
      ],
      truncated: false,
    });
    expect(gl.seen[1]?.path).toContain('page=2');
    expect(gl.seen[0]?.path).toContain('recursive=true');
    expect(await gl.api.file('acme/api', 'a1')).toBe('# A');
  });

  it('gives git a credential whose password is the token', () => {
    expect(host('github', {}).api.gitCredential()).toEqual({
      username: 'x-access-token',
      password: TOKEN,
    });
    expect(host('gitlab', {}).api.gitCredential()).toEqual({ username: 'oauth2', password: TOKEN });
  });

  it('calls a change request by the name its host uses', () => {
    expect(host('github', {}).api.changeRequestWord).toBe('pull request');
    expect(host('gitlab', {}).api.changeRequestWord).toBe('merge request');
  });
});

describe('a token without Checks: read', () => {
  it('opens and reads a pull request all the same, with no pipeline', async () => {
    const pull = {
      number: 7,
      title: 'Docs',
      state: 'open',
      draft: false,
      merged_at: null,
      html_url: 'https://github.com/acme/api/pull/7',
      head: { ref: 'agent/docs', sha: 'c0ffee' },
      base: { ref: 'main' },
    };
    const forbidden = {
      status: 403,
      body: { message: 'Resource not accessible by personal access token' },
    };
    const gh = host('github', {
      ...repo.github,
      'POST /repos/acme/api/pulls': { status: 201, body: pull },
      'GET /repos/acme/api/pulls/7': { body: pull },
      'GET /repos/acme/api/commits/c0ffee/check-runs': forbidden,
    });
    const opened = await gh.api.openChangeRequest({
      repository: 'acme/api',
      title: 'Docs',
      description: '',
      sourceBranch: 'agent/docs',
    });
    expect(opened).toMatchObject({ number: 7, pipeline: 'none' });
    expect(await gh.api.getChangeRequest('acme/api', 7)).toMatchObject({ pipeline: 'none' });
  });
});

describe('what the transport does with a host that misbehaves', () => {
  it('retries a rate limit once, after the wait the host asked for', async () => {
    const gh = host('github', {
      'GET /user': [
        { status: 429, headers: { 'retry-after': '1' }, body: { message: 'slow down' } },
        { body: { login: 'acme-bot' } },
      ],
    });
    expect(await gh.api.probe()).toEqual({ login: 'acme-bot' });
    expect(gh.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('gives up on a rate limit it would have to wait out, without echoing the token', async () => {
    const gh = host('github', {
      'GET /user': { status: 429, headers: { 'retry-after': '600' }, body: {} },
    });
    const failed = await gh.api.probe().catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(CodeHostError);
    expect((failed as CodeHostError).kind).toBe('rate_limited');
    expect((failed as CodeHostError).message).not.toContain(TOKEN);
    expect(gh.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reads a refused token as unauthorized on either host', async () => {
    const gh = host('github', {
      'GET /user': { status: 401, body: { message: 'Bad credentials' } },
    });
    await expect(gh.api.probe()).rejects.toMatchObject({ kind: 'unauthorized' });

    const gl = host('gitlab', { 'GET /api/v4/user': { status: 401, body: {} } });
    await expect(gl.api.probe()).rejects.toMatchObject({ kind: 'unauthorized' });
  });

  it('reads a missing repository as not_found and a taken branch as conflict', async () => {
    const gh = host('github', { 'GET /repos/acme/api': { status: 404, body: {} } });
    await expect(gh.api.repository('https://github.com/acme/api')).rejects.toMatchObject({
      kind: 'not_found',
    });

    const gl = host('gitlab', {
      'POST /api/v4/projects/acme%2Fapi/repository/branches': { status: 409, body: {} },
    });
    await expect(gl.api.createBranch('acme/api', 'agent/x', 'main')).rejects.toMatchObject({
      kind: 'conflict',
    });
  });

  it("keeps GitLab's own words for a refusal, whatever shape they come in", async () => {
    const mrs = 'POST /api/v4/projects/acme%2Fapi/merge_requests';
    const open = (api: CodeHost) =>
      api.openChangeRequest({
        repository: 'acme/api',
        sourceBranch: 'agent/x',
        targetBranch: 'dev',
        title: 'X',
        description: '',
      });
    const fields = host('gitlab', {
      [mrs]: { status: 400, body: { message: { title: ['is too long'], labels: ['bad'] } } },
    });
    await expect(open(fields.api)).rejects.toMatchObject({
      kind: 'invalid_response',
      message: 'gitlab.acme.com answered 400: title is too long; labels bad',
    });
    const list = host('gitlab', {
      [mrs]: { status: 409, body: { message: ['Another open merge request already exists'] } },
    });
    await expect(open(list.api)).rejects.toMatchObject({
      kind: 'conflict',
      message: 'gitlab.acme.com answered 409: Another open merge request already exists',
    });
    const scope = host('gitlab', {
      [mrs]: { status: 403, body: { error: 'insufficient_scope' } },
    });
    await expect(open(scope.api)).rejects.toMatchObject({
      message: 'gitlab.acme.com answered 403: insufficient_scope',
    });
  });

  it('refuses an answer larger than the ceiling instead of holding it in memory', async () => {
    const gl = host('gitlab', {
      'GET /api/v4/user': {
        body: { username: 'x' },
        headers: { 'content-length': String(64 * 1024 * 1024) },
      },
    });
    await expect(gl.api.probe()).rejects.toMatchObject({ kind: 'too_large' });
  });

  it('does not follow a redirect, which would hand the token to another host', async () => {
    const gh = host('github', {
      'GET /user': { status: 302, headers: { location: 'https://evil.example/user' }, body: {} },
    });
    await expect(gh.api.probe()).rejects.toBeInstanceOf(CodeHostError);
    // One call: the redirect was read as an answer, not followed.
    expect(gh.fetchImpl).toHaveBeenCalledTimes(1);
    expect(gh.fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
  });
});
