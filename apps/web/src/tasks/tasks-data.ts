import type { RunStatus } from '../runs/run-data';

// The tasks API as the pages read it.

// A run that is done moves an open task to review; a person marks it done or runs it again.
export type TaskStatus = 'open' | 'review' | 'done';
export const taskStatusLabel: Record<TaskStatus, string> = {
  open: 'Open',
  review: 'In review',
  done: 'Done',
};

export type TaskSummary = {
  id: string;
  title: string;
  agent: {
    id: string;
    name: string;
  };
  status: TaskStatus;
  source: 'manual' | 'jira' | 'cron' | 'webhook' | 'chat' | 'agent';
  repository: string | null;
  createdBy: { id: string; name: string };
  createdAt: string;
  latestRun: { id: string; status: RunStatus; at: string } | null;
  /** The newest merge or pull request of its runs, as its host last told of it. */
  changeRequest: {
    url: string;
    state: 'open' | 'draft' | 'merged' | 'closed' | null;
    pipeline: 'none' | 'running' | 'success' | 'failed' | null;
  } | null;
  /** The repository is its project's main one, as it is now, not the task's own. */
  repositoryFromProject: boolean;
  /** The project it was filed in or whose Jira it came from. */
  project: { id: string; name: string } | null;
};

export type TaskRun = {
  id: string;
  status: RunStatus;
  startedAt: string | null;
  endedAt: string | null;
  errorCode: string | null;
  seat: { name: string } | null;
  createdAt: string;
  /** Its cost at API prices; null before any of it is priced. */
  usd: string | null;
  /** The agent's report at its end: its message in the thread. */
  summary: string | null;
};

/** A comment in the task's thread, a person's or an agent's. */
export type TaskComment = {
  id: string;
  body: string;
  runId: string | null;
  createdAt: string;
  author: { kind: 'person' | 'agent'; id: string; name: string };
};

/** An agent's question to the person in one of the task's runs, and what became of it. */
export type TaskQuestion = {
  id: string;
  runId: string;
  question: string;
  answer: string | null;
  state: 'waiting' | 'answered' | 'skipped' | 'unanswered';
  askedAt: string;
  answeredAt: string | null;
  answeredBy: string | null;
};

export type Task = TaskSummary & {
  agent: { id: string; name: string; status: 'active' | 'archived' };
  body: string;
  /** What Jira refused when the task reported back to its issue. */
  externalError: string | null;
  runs: TaskRun[];
  // Newest first, as their host's webhooks last told of them.
  changeRequests: {
    url: string;
    runId: string;
    state: 'open' | 'draft' | 'merged' | 'closed' | null;
    pipeline: 'none' | 'running' | 'success' | 'failed' | null;
    review: 'approved' | 'changes_requested' | 'commented' | null;
    createdAt: string;
  }[];
  questions: TaskQuestion[];
  comments: TaskComment[];
  /** The task whose lead assigned this one. */
  parent: { id: string; title: string; agent: string } | null;
  /** What this task's agent assigned to the leads under it, oldest first. */
  subtasks: {
    id: string;
    title: string;
    agent: string;
    status: TaskStatus;
    runStatus: RunStatus | null;
  }[];
};

export type TaskPage = { tasks: TaskSummary[]; nextBefore: string | null };

/** In work: its latest run is queued, going, or waiting for a person's approval. */
export const isInWork = (task: Pick<TaskSummary, 'latestRun'>): boolean =>
  task.latestRun !== null &&
  ['queued', 'running', 'waiting_approval'].includes(task.latestRun.status);

const parse = (value: string) => {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
};

/**
 * The server's rule for a repository (apps/server/src/routes/tasks.ts), so that the dialog
 * says what is wrong before it sends anything; the server checks again.
 */
export function repositoryProblem(value: string): string | undefined {
  if (/^https?:\/\/[^/?#]*@/.test(value)) {
    return 'Remove the user name and password from the URL: the computer clones without credentials.';
  }
  const url = /^https?:\/\//.test(value) ? parse(value) : undefined;
  const path = value.startsWith('/') || value.startsWith('~/');
  if (/\p{Cc}/u.test(value) || !(path || url?.hostname)) {
    return 'Use a URL that starts with https:// or http://, or an absolute path such as /Users/you/code/repo or ~/code/repo.';
  }
  return undefined;
}
