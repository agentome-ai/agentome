import { Gitlab } from '@gitbeaker/rest';
import { z } from 'zod';
import { CodeHostError, kindOfStatus } from './errors.js';
import { hostMessage, request, type RequestOptions } from './http.js';
import type {
  ChangeRequest,
  ChangeRequestState,
  CodeHost,
  PipelineFailure,
  PipelineState,
  RepositoryRef,
  WebhookEvent,
} from './types.js';

// GitLab through gitbeaker, over our own transport. gitbeaker's own requester
// retries ten times on a 429 without reading `Retry-After`, keeps a rate limiter of its own
// and gives no deadline per call (donor manifest §5.2), so it gets `requesterFn` instead.

const MAX_LOG_CHARS = 4000;
/** A job's trace is read by ranges: the whole of it can be hundreds of megabytes. */
const LOG_TAIL_BYTES = 16 * 1024;
/** Pages of 100 entries a tree is read to: 10 000 files, far more than a repository's docs. */
const TREE_PAGES = 100;

type Json = Record<string, unknown>;

/**
 * An agent's text, as GitLab must not act on it. GitLab runs a line that starts with `/` in a
 * note or a description as a quick action, as the token's user: `/approve` and `/merge` from an
 * agent would merge past its owner, as push options would. A backslash before the
 * slash stops that and renders as the slash. Code blocks get it too: GitLab tells them apart by
 * rules of its own, and a slash shown in code costs less than a merge nobody approved.
 */
export function inert(text: string): string {
  return text.replace(/^\//gm, '\\/');
}

/** The option gitbeaker takes; its RequesterType is generic over a body we do not parse. */
type Requester = NonNullable<ConstructorParameters<typeof Gitlab>[0]>['requesterFn'];
/** What gitbeaker hands a verb: a query as a record, and a body it has not serialized. */
type GitbeakerOptions = { searchParams?: Record<string, unknown>; body?: unknown };

/**
 * gitbeaker asks for one of these per verb; each is our `request` with its answer parsed.
 * Its `RequesterType` promises the caller's own `T` for a body gitbeaker parsed itself, so
 * the shape is cast once, here, rather than at every call.
 */
// gitbeaker hands a requester its options in camelCase, `sourceBranch`, and leaves turning them
// into GitLab's `source_branch` to its own requester, which ours stands in for.
const snake = (key: string) => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

function snakeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [snake(key), snakeKeys(item)]),
  );
}

function requesterFor(options: RequestOptions): Requester {
  const verbs = (resource: {
    headers: Record<string, string>;
    authHeaders: Record<string, () => Promise<string>>;
    url: string;
  }) => {
    const send = async (method: string, endpoint: string, given?: GitbeakerOptions) => {
      // The token is a lazy header: gitbeaker resolves it per call, and so do we.
      const auth = await Promise.all(
        Object.entries(resource.authHeaders ?? {}).map(
          async ([name, read]) => [name, await read()] as const,
        ),
      );
      const url = new URL(endpoint.replace(/^\/+/, ''), `${resource.url.replace(/\/+$/, '')}/`);
      for (const [name, value] of Object.entries(given?.searchParams ?? {})) {
        // A list goes as GitLab reads one, `refs[]=a&refs[]=b`, as gitbeaker's own requester sends it.
        if (Array.isArray(value)) {
          for (const item of value) url.searchParams.append(`${snake(name)}[]`, String(item));
        } else if (value !== undefined) url.searchParams.set(snake(name), String(value));
      }
      const headers: Record<string, string> = { ...resource.headers, ...Object.fromEntries(auth) };
      const init: RequestInit = { method, headers };
      if (given?.body !== undefined) {
        headers['content-type'] = 'application/json';
        init.body = JSON.stringify(snakeKeys(given.body));
      }
      const { response, body: bytes } = await request(new Request(url, init), options);
      const text = new TextDecoder().decode(bytes);
      if (!response.ok) {
        throw new CodeHostError(
          kindOfStatus(response.status),
          `${url.host} answered ${String(response.status)}${hostMessage(text)}`,
        );
      }
      const type = response.headers.get('content-type') ?? '';
      const parsed: unknown = type.includes('json') && text !== '' ? JSON.parse(text) : text;
      return {
        body: parsed,
        headers: Object.fromEntries(response.headers),
        status: response.status,
      };
    };
    return {
      get: (endpoint: string, given?: GitbeakerOptions) => send('GET', endpoint, given),
      post: (endpoint: string, given?: GitbeakerOptions) => send('POST', endpoint, given),
      put: (endpoint: string, given?: GitbeakerOptions) => send('PUT', endpoint, given),
      patch: (endpoint: string, given?: GitbeakerOptions) => send('PATCH', endpoint, given),
      delete: (endpoint: string, given?: GitbeakerOptions) => send('DELETE', endpoint, given),
    };
  };
  // gitbeaker's RequesterType promises each caller's own body type for JSON it never sees;
  // the cast is here, once, instead of at every call.
  return verbs as unknown as Requester;
}

async function call<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CodeHostError) throw error;
    const said = (error as { message?: unknown } | null)?.message;
    const detail = typeof said === 'string' ? `: ${said.slice(0, 300)}` : '';
    throw new CodeHostError('network', `GitLab could not be reached${detail}`, { cause: error });
  }
}

const stateOf = (mr: { state?: string; draft?: boolean }): ChangeRequestState => {
  if (mr.state === 'merged') return 'merged';
  if (mr.state === 'closed' || mr.state === 'locked') return 'closed';
  return mr.draft ? 'draft' : 'open';
};

const pipelineOf = (status: unknown): PipelineState => {
  if (status === 'success' || status === 'manual') return 'success';
  if (status === 'failed' || status === 'canceled') return 'failed';
  if (typeof status !== 'string' || status === '') return 'none';
  return 'running';
};

export function gitlabHost(options: {
  token: string;
  /** Where this GitLab runs: its origin, as the connection stores it. */
  baseUrl: string;
  request?: RequestOptions;
}): CodeHost {
  const api = new Gitlab({
    host: options.baseUrl,
    token: options.token,
    requesterFn: requesterFor(options.request ?? {}),
  });
  const headers = { 'private-token': options.token };

  const changeRequestOf = (mr: Json): ChangeRequest => ({
    number: Number(mr.iid),
    title: String(mr.title ?? ''),
    state: stateOf(mr),
    url: String(mr.web_url ?? mr.webUrl ?? ''),
    sourceBranch: String(mr.source_branch ?? mr.sourceBranch ?? ''),
    targetBranch: String(mr.target_branch ?? mr.targetBranch ?? ''),
    pipeline: pipelineOf(
      (mr.head_pipeline ?? mr.headPipeline ?? mr.pipeline) &&
        ((mr.head_pipeline ?? mr.headPipeline ?? mr.pipeline) as Json).status,
    ),
  });

  return {
    kind: 'gitlab',
    changeRequestWord: 'merge request',

    probe: () =>
      call(async () => {
        const user = (await api.Users.showCurrentUser()) as unknown as Json;
        const login = user.username;
        if (typeof login !== 'string' || login === '') {
          throw new CodeHostError('invalid_response', 'GitLab answered without an account');
        }
        return { login };
      }),

    repository: (url: string) =>
      call(async (): Promise<RepositoryRef> => {
        const path = new URL(url).pathname.replace(/^\/+|\.git$|\/+$/g, '');
        const project = (await api.Projects.show(path)) as unknown as Json;
        return {
          path: String(project.path_with_namespace ?? path),
          cloneUrl: String(project.http_url_to_repo ?? `${options.baseUrl}/${path}.git`),
          webUrl: String(project.web_url ?? `${options.baseUrl}/${path}`),
          defaultBranch: String(project.default_branch ?? 'main'),
        };
      }),

    createBranch: (repository, branch, from) =>
      call(async () => {
        await api.Branches.create(repository, branch, from);
      }),

    openChangeRequest: (input) =>
      call(async () => {
        const target =
          input.targetBranch ??
          String(((await api.Projects.show(input.repository)) as unknown as Json).default_branch);
        const mr = (await api.MergeRequests.create(
          input.repository,
          input.sourceBranch,
          target,
          input.draft ? `Draft: ${input.title}` : input.title,
          { description: inert(input.description) },
        )) as unknown as Json;
        return changeRequestOf(mr);
      }),

    getChangeRequest: (repository, number) =>
      call(async () => {
        const mr = (await api.MergeRequests.show(repository, number)) as unknown as Json;
        return changeRequestOf(mr);
      }),

    getPipelineFailures: (repository, number) =>
      call(async (): Promise<PipelineFailure[]> => {
        const mr = (await api.MergeRequests.show(repository, number)) as unknown as Json;
        const pipeline = (mr.head_pipeline ?? mr.headPipeline) as Json | undefined;
        if (!pipeline?.id) return [];
        const jobs = (await api.Jobs.all(repository, {
          pipelineId: Number(pipeline.id),
        })) as unknown as Json[];
        const failed = jobs.filter((job) => job.status === 'failed');
        return Promise.all(
          failed.map(async (job) => ({
            job: String(job.name ?? 'job'),
            url: String(job.web_url ?? pipeline.web_url ?? ''),
            log: await logTail(repository, Number(job.id)),
          })),
        );
      }),

    replyToReview: (input) =>
      call(async () => {
        const note = (await api.MergeRequestNotes.create(
          input.repository,
          input.number,
          inert(input.body),
        )) as unknown as Json;
        const id = note.id === undefined ? '' : `#note_${String(note.id)}`;
        const mr = (await api.MergeRequests.show(
          input.repository,
          input.number,
        )) as unknown as Json;
        return { url: `${String(mr.web_url ?? '')}${id}` };
      }),

    tree: (repository, ref) =>
      call(async () => {
        const files: { path: string; sha: string }[] = [];
        // Page by page, as GitLab's x-next-page names them, up to a ceiling: a monorepo's tree
        // can have hundreds of thousands of entries.
        for (let page = '1'; page !== '';) {
          if (Number(page) > TREE_PAGES) return { files, truncated: true };
          const { body, next } = await get(`repository/tree`, repository, {
            recursive: 'true',
            ref,
            per_page: '100',
            page,
          });
          for (const entry of JSON.parse(body) as Json[]) {
            if (entry.type === 'blob')
              files.push({ path: String(entry.path), sha: String(entry.id) });
          }
          page = next;
        }
        return { files, truncated: false };
      }),

    file: (repository, sha) =>
      call(
        async () => (await get(`repository/blobs/${encodeURIComponent(sha)}/raw`, repository)).body,
      ),

    compare: (repository, base, head) =>
      call(async () => {
        // GitLab sends each file's diff, not counts: the counts are its + and - lines.
        const { body } = await get('repository/compare', repository, { from: base, to: head });
        const diffs = (JSON.parse(body) as { diffs?: { diff?: string }[] }).diffs ?? [];
        let additions = 0;
        let deletions = 0;
        for (const { diff = '' } of diffs) {
          for (const line of diff.split('\n')) {
            if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
            else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
          }
        }
        const encode = (ref: string) => ref.split('/').map(encodeURIComponent).join('/');
        return {
          additions,
          deletions,
          files: diffs.length,
          url: `${options.baseUrl}/${repository}/-/compare/${encode(base)}...${encode(head)}`,
        };
      }),

    isAncestor: (repository, older, newer) =>
      call(async () => {
        // The merge base of the two is the older commit exactly when it is an ancestor.
        const base = (await api.Repositories.mergeBase(repository, [
          older,
          newer,
        ])) as unknown as Json;
        // Exactly equal, never a prefix: this guards the git proxy against a push that rewrites
        // history, and a short `older` would match any merge base that starts the same way.
        // The proxy passes the full SHAs git sends it.
        return String(base.id ?? '') === older;
      }),

    gitCredential: () => ({ username: 'oauth2', password: options.token }),

    parseWebhook: parseGitlabWebhook,
  };

  /** A project's endpoint read directly: its text, and the page after it, if any. */
  async function get(endpoint: string, repository: string, query: Record<string, string> = {}) {
    const url = new URL(
      `${options.baseUrl}/api/v4/projects/${encodeURIComponent(repository)}/${endpoint}`,
    );
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    const { response, body } = await request(new Request(url, { headers }), options.request);
    if (!response.ok) {
      throw new CodeHostError(
        kindOfStatus(response.status),
        `${url.host} answered ${String(response.status)}`,
      );
    }
    return {
      body: new TextDecoder().decode(body),
      next: response.headers.get('x-next-page') ?? '',
    };
  }

  /** The last bytes of a job's log: a trace can be hundreds of megabytes. */
  async function logTail(repository: string, jobId: number): Promise<string> {
    const project = encodeURIComponent(repository);
    const url = `${options.baseUrl}/api/v4/projects/${project}/jobs/${String(jobId)}/trace`;
    // The range asks for the tail; `keepTail` makes sure of it when a GitLab ignores the range
    // and sends the whole trace, which can be hundreds of megabytes.
    const { body } = await request(
      new Request(url, { headers: { ...headers, range: `bytes=-${String(LOG_TAIL_BYTES)}` } }),
      { ...options.request, keepTail: LOG_TAIL_BYTES },
    );
    return new TextDecoder().decode(body).slice(-MAX_LOG_CHARS);
  }
}

// The fields of GitLab's webhook bodies that we read (docs.gitlab.com, "Webhook events"). The
// body names its kind itself, so the X-Gitlab-Event header is not needed to tell them apart.
const MergeRequestUrl = z.object({ url: z.url({ protocol: /^https?$/ }) });
const User = z.object({ username: z.string() });
const Hook = z.discriminatedUnion('object_kind', [
  z.object({
    object_kind: z.literal('merge_request'),
    object_attributes: MergeRequestUrl.extend({
      state: z.string(),
      draft: z.boolean().optional(),
      work_in_progress: z.boolean().optional(),
      action: z.string().optional(),
      title: z.string().optional(),
    }),
    user: User.optional(),
    project: z.object({ web_url: z.url() }).optional(),
  }),
  // A pipeline of a branch without a merge request has none here.
  z.object({
    object_kind: z.literal('pipeline'),
    object_attributes: z.object({ status: z.string() }),
    merge_request: MergeRequestUrl.nullish(),
  }),
  z.object({
    object_kind: z.literal('note'),
    object_attributes: z.object({ noteable_type: z.string() }),
    merge_request: MergeRequestUrl.optional(),
    user: User.optional(),
  }),
]);

function parseGitlabWebhook(_event: string, body: unknown): WebhookEvent | null {
  const parsed = Hook.safeParse(body);
  if (!parsed.success) return null;
  const hook = parsed.data;
  if (hook.object_kind === 'merge_request') {
    const mr = hook.object_attributes;
    const state = stateOf({ state: mr.state, draft: mr.draft ?? mr.work_in_progress });
    // An approval comes as a merge request event of its own, not as a note.
    const review = mr.action === 'approved' ? ('approved' as const) : undefined;
    const draft = mr.draft ?? mr.work_in_progress ?? false;
    const ready = ['open', 'reopen'].includes(mr.action ?? '') && !draft;
    const { user, project } = hook;
    const opened =
      ready && mr.title !== undefined && user && project
        ? { title: mr.title, author: user.username, repository: project.web_url }
        : undefined;
    return {
      changeRequests: [mr.url],
      update: { state, review },
      ...(opened && { opened }),
      ...(user && review && { actor: user.username }),
    };
  }
  if (hook.object_kind === 'pipeline') {
    if (!hook.merge_request) return null;
    const pipeline = pipelineOf(hook.object_attributes.status);
    return { changeRequests: [hook.merge_request.url], update: { pipeline } };
  }
  if (hook.object_attributes.noteable_type !== 'MergeRequest' || !hook.merge_request) return null;
  return {
    changeRequests: [hook.merge_request.url],
    update: { review: 'commented' },
    ...(hook.user && { actor: hook.user.username }),
  };
}
