import { Octokit } from 'octokit';
import { z } from 'zod';
import { CodeHostError, kindOfStatus } from './errors.js';
import { fetchThrough, type RequestOptions } from './http.js';
import type {
  ChangeRequest,
  ChangeRequestState,
  CodeHost,
  PipelineFailure,
  PipelineState,
  RepositoryRef,
  WebhookEvent,
} from './types.js';

// GitHub through octokit, over our own transport. octokit brings the endpoints and
// their types; `request.fetch` is ours, so the retries, the deadline and the size ceiling are
// the same as GitLab's.

/** The tail of a check's output we keep: enough to see what failed, not a log file. */
const MAX_LOG_CHARS = 4000;

type Repo = { owner: string; repo: string };

/** `owner/name`, from the path a task's URL carries or the one a tool passed. */
function split(repository: string): Repo {
  const [owner, repo] = repository.replace(/\.git$/, '').split('/');
  if (!owner || !repo) {
    throw new CodeHostError('not_found', `${repository} is not an owner and a repository`);
  }
  return { owner, repo };
}

/** Whatever octokit threw, in our words. A token is never in the message. */
function asCodeHostError(error: unknown): CodeHostError {
  // Our transport throws through octokit, which wraps what it catches in an HttpError of its
  // own with status 500: a timeout or a spent rate limit must keep its name.
  for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
    if (cause instanceof CodeHostError) return cause;
  }
  const status = (error as { status?: unknown } | null)?.status;
  const said = (error as { message?: unknown } | null)?.message;
  const detail = typeof said === 'string' ? `: ${said.slice(0, 300)}` : '';
  if (typeof status === 'number') {
    return new CodeHostError(kindOfStatus(status), `GitHub answered ${String(status)}${detail}`, {
      cause: error,
    });
  }
  return new CodeHostError('network', `GitHub could not be reached${detail}`, { cause: error });
}

async function call<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw asCodeHostError(error);
  }
}

const stateOf = (pull: {
  state: string;
  draft?: boolean | undefined;
  merged_at?: string | null;
}): ChangeRequestState => {
  if (pull.merged_at) return 'merged';
  if (pull.state === 'closed') return 'closed';
  return pull.draft ? 'draft' : 'open';
};

export function githubHost(options: {
  token: string;
  /** Where the API answers; github.com for now. */
  apiBase?: string;
  request?: RequestOptions;
}): CodeHost {
  const apiBase = options.apiBase ?? 'https://api.github.com';
  const octokit = new Octokit({
    auth: options.token,
    baseUrl: apiBase,
    request: { fetch: fetchThrough(options.request) },
    // octokit brings a retry and a throttle plugin of its own, which would sleep and try
    // again on top of our transport — the very behaviour we took away from gitbeaker.
    retry: { enabled: false },
    throttle: { enabled: false },
  });

  /**
   * The pipeline of a head commit: GitHub's check runs, folded into one word. A token without
   * Checks: read cannot see them; the change request is still there, so its pipeline is `none`
   * rather than the whole answer an error (the live run of 24 Oct 2026 opened a pull request
   * and told the agent it had failed).
   */
  async function pipelineOf(repo: Repo, sha: string): Promise<PipelineState> {
    const checks = await octokit.rest.checks
      .listForRef({ ...repo, ref: sha, per_page: 100 })
      .catch((error: unknown) => {
        if (asCodeHostError(error).kind === 'forbidden') return undefined;
        throw error;
      });
    if (!checks) return 'none';
    const { data } = checks;
    const runs = data.check_runs;
    if (runs.length === 0) return 'none';
    if (runs.some((run) => run.status !== 'completed')) return 'running';
    const bad = ['failure', 'timed_out', 'cancelled', 'action_required'];
    return runs.some((run) => bad.includes(run.conclusion ?? '')) ? 'failed' : 'success';
  }

  const changeRequestOf = async (
    repo: Repo,
    pull: Parameters<typeof stateOf>[0] & {
      number: number;
      title: string;
      html_url: string;
      head: { ref: string; sha: string };
      base: { ref: string };
    },
  ): Promise<ChangeRequest> => ({
    number: pull.number,
    title: pull.title,
    state: stateOf(pull),
    url: pull.html_url,
    sourceBranch: pull.head.ref,
    targetBranch: pull.base.ref,
    pipeline: await pipelineOf(repo, pull.head.sha),
  });

  return {
    kind: 'github',
    changeRequestWord: 'pull request',

    probe: () =>
      call(async () => {
        const { data } = await octokit.rest.users.getAuthenticated();
        return { login: data.login };
      }),

    repository: (url: string) =>
      call(async (): Promise<RepositoryRef> => {
        const path = new URL(url).pathname.replace(/^\/+|\.git$|\/+$/g, '');
        const repo = split(path);
        const { data } = await octokit.rest.repos.get(repo);
        return {
          path: data.full_name,
          cloneUrl: data.clone_url,
          webUrl: data.html_url,
          defaultBranch: data.default_branch,
        };
      }),

    createBranch: (repository, branch, from) =>
      call(async () => {
        const repo = split(repository);
        const { data: head } = await octokit.rest.git.getRef({ ...repo, ref: `heads/${from}` });
        await octokit.rest.git.createRef({
          ...repo,
          ref: `refs/heads/${branch}`,
          sha: head.object.sha,
        });
      }),

    openChangeRequest: (input) =>
      call(async () => {
        const repo = split(input.repository);
        const base = input.targetBranch ?? (await octokit.rest.repos.get(repo)).data.default_branch;
        const { data } = await octokit.rest.pulls.create({
          ...repo,
          title: input.title,
          body: input.description,
          head: input.sourceBranch,
          base,
          draft: input.draft ?? false,
        });
        return changeRequestOf(repo, data);
      }),

    getChangeRequest: (repository, number) =>
      call(async () => {
        const repo = split(repository);
        const { data } = await octokit.rest.pulls.get({ ...repo, pull_number: number });
        return changeRequestOf(repo, data);
      }),

    getPipelineFailures: (repository, number) =>
      call(async (): Promise<PipelineFailure[]> => {
        const repo = split(repository);
        const { data: pull } = await octokit.rest.pulls.get({ ...repo, pull_number: number });
        const { data } = await octokit.rest.checks.listForRef({
          ...repo,
          ref: pull.head.sha,
          per_page: 100,
        });
        // The check's own output, not the raw log: the log is a redirect to a signed address,
        // which this transport does not follow, and a job's output is what names the failure.
        return data.check_runs
          .filter((run) => run.conclusion !== null && run.conclusion !== 'success')
          .filter((run) => run.conclusion !== 'skipped' && run.conclusion !== 'neutral')
          .map((run) => ({
            job: run.name,
            url: run.html_url ?? pull.html_url,
            log: [run.output.title, run.output.summary, run.output.text]
              .filter((part): part is string => typeof part === 'string' && part !== '')
              .join('\n\n')
              .slice(-MAX_LOG_CHARS),
          }));
      }),

    replyToReview: (input) =>
      call(async () => {
        const repo = split(input.repository);
        // A pull request is an issue for comments: this is the conversation, not a line note.
        const { data } = await octokit.rest.issues.createComment({
          ...repo,
          issue_number: input.number,
          body: input.body,
        });
        return { url: data.html_url };
      }),

    tree: (repository, ref) =>
      call(async () => {
        const { data } = await octokit.rest.git.getTree({
          ...split(repository),
          tree_sha: ref,
          recursive: 'true',
        });
        const files = data.tree
          .filter((entry) => entry.type === 'blob' && entry.path && entry.sha)
          .map((entry) => ({ path: String(entry.path), sha: String(entry.sha) }));
        return { files, truncated: data.truncated };
      }),

    file: (repository, sha) =>
      call(async () => {
        const { data } = await octokit.rest.git.getBlob({ ...split(repository), file_sha: sha });
        return Buffer.from(data.content, data.encoding === 'base64' ? 'base64' : 'utf8').toString(
          'utf8',
        );
      }),

    compare: (repository, base, head) =>
      call(async () => {
        const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
          ...split(repository),
          basehead: `${base}...${head}`,
        });
        const files = data.files ?? [];
        return {
          additions: files.reduce((sum, file) => sum + file.additions, 0),
          deletions: files.reduce((sum, file) => sum + file.deletions, 0),
          files: files.length,
          url: data.html_url,
        };
      }),

    isAncestor: (repository, older, newer) =>
      call(async () => {
        const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
          ...split(repository),
          basehead: `${older}...${newer}`,
        });
        return data.status === 'ahead' || data.status === 'identical';
      }),

    // GitHub takes the token as the password under any user name; x-access-token is the one
    // its own documentation uses.
    gitCredential: () => ({ username: 'x-access-token', password: options.token }),

    parseWebhook: parseGithubWebhook,
  };
}

// The fields of GitHub's webhook bodies that we read (docs.github.com, "Webhook events and
// payloads"); anything else in them is let through unread.
const Url = z.url({ protocol: /^https$/ });
const Pull = z.object({
  html_url: Url,
  state: z.string(),
  draft: z.boolean().optional(),
  merged_at: z.string().nullable().optional(),
  title: z.string().optional(),
  user: z.object({ login: z.string() }).optional(),
});
const Login = z.object({ login: z.string() });
const Suite = z.object({
  status: z.string().nullable(),
  conclusion: z.string().nullable(),
  // The pull requests whose head is this commit. Their base can be another repository (a
  // fork's suite lists the upstream's pull request), where the same number is someone else's.
  pull_requests: z
    .array(
      z.object({
        number: z.int().positive(),
        base: z.object({ repo: z.object({ id: z.int() }) }),
      }),
    )
    .max(100),
});
const SuiteRepository = z.object({ id: z.int(), html_url: Url });
const Hooks = {
  pull_request: z.object({
    action: z.string().optional(),
    pull_request: Pull,
    repository: z.object({ html_url: Url }).optional(),
  }),
  pull_request_review: z.object({
    action: z.literal('submitted'),
    pull_request: Pull,
    review: z.object({
      state: z.enum(['approved', 'changes_requested', 'commented']),
      user: Login.optional(),
    }),
  }),
  check_suite: z.object({ repository: SuiteRepository, check_suite: Suite }),
  workflow_run: z.object({ repository: SuiteRepository, workflow_run: Suite }),
};

/**
 * A check suite or a workflow run in one word. Success only when GitHub says so; `stale` (a
 * suite GitHub gave up waiting on) is no verdict at all; any other conclusion is a failure.
 */
function suiteState(suite: z.infer<typeof Suite>): PipelineState {
  if (suite.status !== 'completed') return 'running';
  if (['success', 'neutral', 'skipped'].includes(suite.conclusion ?? '')) return 'success';
  return suite.conclusion === 'stale' ? 'none' : 'failed';
}

function parseGithubWebhook(event: string, body: unknown): WebhookEvent | null {
  if (event === 'pull_request') {
    const parsed = Hooks.pull_request.safeParse(body);
    if (!parsed.success) return null;
    const { pull_request: pull, action, repository } = parsed.data;
    const ready = ['opened', 'reopened', 'ready_for_review'].includes(action ?? '') && !pull.draft;
    const opened =
      ready && pull.title !== undefined && pull.user && repository
        ? { title: pull.title, author: pull.user.login, repository: repository.html_url }
        : undefined;
    return {
      changeRequests: [pull.html_url],
      update: { state: stateOf(pull) },
      ...(opened && { opened }),
    };
  }
  if (event === 'pull_request_review') {
    const parsed = Hooks.pull_request_review.safeParse(body);
    if (!parsed.success) return null;
    const { pull_request: pull, review } = parsed.data;
    return {
      changeRequests: [pull.html_url],
      update: { state: stateOf(pull), review: review.state },
      ...(review.user && { actor: review.user.login }),
    };
  }
  if (event === 'check_suite' || event === 'workflow_run') {
    const parsed = (event === 'check_suite' ? Hooks.check_suite : Hooks.workflow_run).safeParse(
      body,
    );
    if (!parsed.success) return null;
    const suite = 'check_suite' in parsed.data ? parsed.data.check_suite : parsed.data.workflow_run;
    const { id, html_url } = parsed.data.repository;
    const numbers = suite.pull_requests.filter((pull) => pull.base.repo.id === id);
    if (numbers.length === 0) return null;
    const repository = html_url.replace(/\/+$/, '');
    return {
      changeRequests: numbers.map(({ number }) => `${repository}/pull/${number}`),
      update: { pipeline: suiteState(suite) },
    };
  }
  return null;
}
