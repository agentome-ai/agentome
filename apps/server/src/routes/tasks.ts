import { agentStatusEnum, type Db, taskStatusEnum } from '@agentome/db';
import { ConnectionKind, RunStatus, TaskSource } from '@agentome/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { IdParams } from '../protocol.js';
import {
  ChangeRequestStatus,
  createTask,
  listTasks,
  recentFolders,
  runTask,
  taskView,
  updateTask,
} from '../tasks/service.js';
import type { Config } from '../config.js';
import { connectionsKey } from '../connections/crypto.js';
import { TaskChanges, taskChanges } from '../tasks/changes.js';
import { Text } from './validators.js';
import { CommentBody, commentAsPerson } from '../tasks/thread.js';

const Iso = z.iso.datetime();
const Ref = z.object({ id: z.uuid(), name: z.string() });
const TaskStatus = z.enum(taskStatusEnum.enumValues);
const Title = Text(200).trim().min(1);
const Body = Text(100_000);

/**
 * What the seat can make a workspace from (apps/worker/src/workspace.ts, sourceOf): a URL it
 * clones without credentials, or an absolute path on its own computer. A path is not checked
 * here: it is read only by a seat of the agent's owner, on that person's computer. The scheme
 * is lower case only, as git's allowed transports are matched.
 */
export function repositoryProblem(value: string): string | undefined {
  // Any @ before the path is a user name, however it is spelled: git reads `user\:token@host`
  // as credentials where the URL parser sees a host named "user".
  if (/^https?:\/\/[^/?#]*@/.test(value)) {
    return 'Remove the user name and password from the URL: the computer clones without credentials.';
  }
  const url = /^https?:\/\//.test(value) && URL.canParse(value) ? new URL(value) : undefined;
  const path = value.startsWith('/') || value.startsWith('~/');
  if (/\p{Cc}/u.test(value) || !(path || url?.hostname)) {
    return 'Use a URL that starts with https:// or http://, or an absolute path such as /Users/you/code/repo or ~/code/repo.';
  }
  return undefined;
}

// Empty means none: each run then starts in a new, empty repository.
const Repository = z
  .string()
  .trim()
  .max(2000)
  .superRefine((value, context) => {
    const problem = value && repositoryProblem(value);
    if (problem) context.addIssue({ code: 'custom', message: problem });
  })
  .transform((value) => value || null)
  .nullable();

const TaskSummary = z.object({
  id: z.uuid(),
  title: z.string(),
  agent: Ref,
  status: TaskStatus,
  source: TaskSource,
  repository: z.string().nullable(),
  /** The repository is its project's main one, not the task's own. */
  repositoryFromProject: z.boolean(),
  createdBy: Ref,
  createdAt: Iso,
  latestRun: z.object({ id: z.uuid(), status: RunStatus, at: Iso }).nullable(),
  // The project it was filed in or whose Jira it came from.
  project: Ref.nullable(),
  // The newest merge or pull request of its runs, as its host last told of it.
  changeRequest: ChangeRequestStatus.pick({ state: true, pipeline: true })
    .extend({ url: z.string() })
    .nullable(),
});

const TaskView = TaskSummary.extend({
  agent: Ref.extend({ status: z.enum(agentStatusEnum.enumValues) }),
  body: z.string(),
  // What Jira refused when the task reported back to its issue.
  externalError: z.string().nullable(),
  // The connection the repository falls under among the agent's projects; null for
  // a path, a URL nobody connected, or a host outside the agent's projects.
  connection: z.object({ id: z.uuid(), kind: ConnectionKind, project: Ref }).nullable(),
  // The task whose lead assigned this one, and the ones this task's agent assigned.
  parent: z.object({ id: z.uuid(), title: z.string(), agent: z.string() }).nullable(),
  subtasks: z.array(
    z.object({
      id: z.uuid(),
      title: z.string(),
      agent: z.string(),
      status: TaskStatus,
      runStatus: RunStatus.nullable(),
    }),
  ),
  runs: z.array(
    z.object({
      id: z.uuid(),
      status: RunStatus,
      startedAt: Iso.nullable(),
      endedAt: Iso.nullable(),
      errorCode: z.string().nullable(),
      // The agent's report at the end of the run: its message in the thread.
      summary: z.string().nullable(),
      seat: z.object({ name: z.string() }).nullable(),
      createdAt: Iso,
      // Its cost at API prices, priced events only; null before any is priced.
      usd: z.string().nullable(),
    }),
  ),
  // The task's merge and pull requests, newest first, as their host last told of them.
  changeRequests: z.array(
    ChangeRequestStatus.extend({ url: z.string(), runId: z.string(), createdAt: Iso }),
  ),
  // The thread, oldest first: a person's or an agent's, with the run it wrote it in.
  comments: z.array(
    z.object({
      id: z.uuid(),
      body: z.string(),
      runId: z.uuid().nullable(),
      createdAt: Iso,
      author: z.object({ kind: z.enum(['person', 'agent']), id: z.uuid(), name: z.string() }),
    }),
  ),
  // The agents' questions to the person in the task's runs, oldest first.
  questions: z.array(
    z.object({
      id: z.uuid(),
      runId: z.uuid(),
      question: z.string(),
      answer: z.string().nullable(),
      state: z.enum(['waiting', 'answered', 'skipped', 'unanswered']),
      askedAt: Iso,
      answeredAt: Iso.nullable(),
      answeredBy: z.string().nullable(),
    }),
  ),
});

const QueuedRun = z.object({ id: z.uuid(), status: RunStatus });

const ListQuery = z.object({
  agent: z.uuid().optional(),
  project: z.uuid().optional(),
  status: TaskStatus.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** `nextBefore` of the previous page: its last task's createdAt and id. */
  before: z
    .string()
    .transform((value) => {
      const [at, id] = value.split('_');
      return { at, id };
    })
    .pipe(z.object({ at: z.iso.datetime({ offset: true }), id: z.uuid() }))
    .optional(),
  all: z.stringbool().default(false),
});

// Every route needs a session; a task is someone else's when its agent is, and then it is 404.
export const taskRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config }> = async (
  app,
  { db, config },
) => {
  const key = connectionsKey(config.secretKey);
  app.addHook('onRequest', app.requireSession);

  app.get(
    '/api/tasks',
    {
      schema: {
        summary:
          'Tasks of the agents the person has a grant on; every task with all=true, for admins',
        querystring: ListQuery,
        response: {
          200: z.object({ tasks: z.array(TaskSummary), nextBefore: z.string().nullable() }),
        },
      },
    },
    async (request) => {
      if (request.query.all && request.user.role !== 'admin') {
        throw new AppError('forbidden', 'Only admins can list every task');
      }
      return listTasks(db, request.user.id, request.query);
    },
  );

  app.post(
    '/api/tasks',
    {
      schema: {
        summary:
          "Creates a manual task in a project and, unless run is false, queues its run. Without agentId it goes to the project's team lead in the project's main repository, and runs at once when the project's intake is auto",
        body: z.object({
          projectId: z.uuid({ error: 'Pick the project the task is filed in' }),
          agentId: z.uuid().optional(),
          title: Title,
          body: Body.default(''),
          repository: Repository.default(null),
          run: z.boolean().optional(),
        }),
        response: { 201: z.object({ task: TaskView, run: QueuedRun.nullable() }) },
      },
    },
    async (request, reply) =>
      reply.code(201).send(await createTask(db, request.user.id, request.body)),
  );

  app.get(
    '/api/tasks/folders',
    {
      schema: {
        summary:
          "Folders on a computer the person's own tasks worked in, the most recent first: what the task form offers before a path is typed",
        response: { 200: z.object({ folders: z.array(z.string()) }) },
      },
    },
    async (request) => ({ folders: await recentFolders(db, request.user.id) }),
  );

  app.get(
    '/api/tasks/:id',
    {
      schema: {
        summary: 'A task with its description and its runs, newest first',
        params: IdParams,
        response: { 200: TaskView },
      },
    },
    async (request) => taskView(db, request.params.id, request.user.id),
  );

  app.get(
    '/api/tasks/:id/changes',
    {
      schema: {
        summary:
          "What the task changed: its runs' branches with their commits and size, and its change requests as the code host has them now",
        params: IdParams,
        response: { 200: TaskChanges },
      },
    },
    async (request) => taskChanges(db, key, request.params.id, request.user.id),
  );

  app.patch(
    '/api/tasks/:id',
    {
      schema: {
        summary: 'Changes the title, description, repository or status (open, review or done)',
        params: IdParams,
        body: z
          .object({ title: Title, body: Body, repository: Repository, status: TaskStatus })
          .partial(),
        response: { 200: TaskView },
      },
    },
    async (request) => updateTask(db, request.params.id, request.user.id, request.body),
  );

  app.post(
    '/api/tasks/:id/run',
    {
      schema: {
        summary: "Queues another run of the task, for a seat of the agent's owner",
        params: IdParams,
        response: { 201: QueuedRun },
      },
    },
    async (request, reply) =>
      reply.code(201).send(await runTask(db, request.params.id, request.user.id)),
  );

  app.post(
    '/api/tasks/:id/comments',
    {
      schema: {
        summary:
          "Comments on a task, in markdown; with run true, also queues a run, which reads the comment (refused while one is going). The task's agent reads the thread in its next run",
        params: IdParams,
        body: z.object({ body: CommentBody, run: z.boolean().default(false) }),
        response: { 201: z.object({ id: z.uuid(), run: QueuedRun.nullable() }) },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(await commentAsPerson(db, request.params.id, request.user.id, request.body)),
  );
};
