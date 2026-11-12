import type { Host } from '../ui/host-glyph';
import type { RunStatus } from '../ui/status';

// Projects and their connections as the API describes them. No shape here carries a token:
// the server never answers one.

export type ProjectSummary = {
  id: string;
  name: string;
  agentCount: number;
  connectionCount: number;
  /** Its maker, who may change it, as admins may. */
  createdBy: string;
  createdAt: string;
};

/** The week of the runs of the project's tasks: the dashboard's card and the project's page. */
export type ProjectWeek = {
  runs: number;
  ended: number;
  done: number;
  medianSeconds: number | null;
  usd: string | null;
  daily: number[];
};

/** A project as the list has it, with what the dashboard's card shows. */
export type ProjectListItem = ProjectSummary & {
  team: { id: string; name: string } | null;
  week: ProjectWeek;
  lastRun: {
    id: string;
    status: RunStatus;
    at: string;
    agent: { id: string; name: string };
    task: { id: string; title: string };
  } | null;
};

export type ProjectAgent = {
  id: string;
  name: string;
  roleTitle: string;
  status: 'active' | 'archived';
};

/** A connection as a project shows it: where it reaches, and whose account answered. */
export type ProjectConnection = {
  id: string;
  kind: Host;
  host: string;
  namespace: string;
  accountLogin: string | null;
  /** Whose token it is: one agent's own, or every agent's of the project (null). */
  agentName: string | null;
};

export type ProjectView = ProjectSummary & {
  /** The team that takes the project's tasks, and whether its lead starts at once. */
  team: { id: string; name: string; lead: { id: string; name: string } } | null;
  intake: 'manual' | 'auto';
  /** What its tasks' runs may cost a calendar month, and what they did this month. */
  budget: { usdPerMonth: number | null; usdThisMonth: number };
  /** What its code hosts' webhooks start. */
  triggers: {
    onPipelineFailed: boolean;
    onReview: boolean;
    reviewer: { id: string; name: string } | null;
  };
  description: string;
  goals: string;
  /** URLs under the project's connections; the first is the main one. */
  repositories: string[];
  agents: ProjectAgent[];
  connections: ProjectConnection[];
  week: ProjectWeek;
};

export type Connection = Omit<ProjectConnection, 'agentName'> & {
  project: { id: string; name: string };
  agent: { id: string; name: string } | null;
  config: Record<string, string>;
  lastTestedAt: string | null;
  /** Jira's poll: when the last good one started, and why the last one failed. */
  syncedAt: string | null;
  syncError: string | null;
  createdAt: string;
};

/**
 * Where a connection reaches, as a person reads it: `acme` on GitHub, a path on a GitLab, the
 * filter on a Jira.
 */
export const place = (connection: Pick<Connection, 'kind' | 'host' | 'namespace'>) =>
  connection.kind === 'github'
    ? connection.namespace
    : connection.kind === 'jira'
      ? `${connection.host}: ${connection.namespace}`
      : `${connection.host}/${connection.namespace}`;

/** A repository by its last name: "web-elm" for …/web-elm/web-elm, "app" for ~/code/app. */
export const repositoryName = (url: string) => url.replace(/\/+$/, '').split('/').at(-1) ?? url;
