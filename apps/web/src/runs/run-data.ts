import type { RunEvent, RunStatus } from '@agentome/shared';
import { formatDate } from '../api';

export type { RunEvent, RunStatus };

// What GET /api/runs and GET /api/runs/:id answer.
type Ref = { id: string; name: string };
export type RunSummary = {
  id: string;
  status: RunStatus;
  agent: Ref;
  task: { id: string; title: string; projectId: string | null } | null;
  seat: (Ref & { owner: Ref }) | null;
  startedBy: { kind: 'user' | 'cron' | 'webhook' | 'agent'; user: Ref | null };
  startedAt: string | null;
  endedAt: string | null;
  errorCode: string | null;
  createdAt: string;
};
export type RunList = {
  runs: (RunSummary & { cost: { usd: string | null; tokens: number } })[];
  nextBefore: string | null;
};
export type Artifact = {
  id: string;
  kind: 'branch' | 'change_request' | 'file' | 'report';
  ref: string;
  meta: Record<string, unknown>;
};
export type Tokens = {
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
};
export type TeamMember = { key: string; agentId: string; name: string };
/** A call through the platform's gateway, and who decided it when its policy asked. */
export type ToolCallDecision = {
  tool: string;
  /** Absent from a server before team runs; a member's id for its own calls. */
  agentId?: string;
  decision: 'allowed' | 'pending' | 'approved' | 'denied';
  reason: string | null;
  decidedBy: Ref | null;
  createdAt: string;
  /** A team step's members, whose assignments wait on it. */
  members?: string[];
};
export type RunDetail = RunSummary & {
  limits: { maxMinutes: number; maxTurns: number; maxTokens: number } | null;
  cancelRequestedAt: string | null;
  artifacts: Artifact[];
  /** Absent from a server before the transcript showed approvals. */
  toolCalls?: ToolCallDecision[];
  /** A team run's members by key. Absent from a server before team runs. */
  team?: TeamMember[];
  cost: {
    rows: (Tokens & { model: string; usd: string | null })[];
    totalUsd: string | null;
    unpriced: boolean;
  };
};

export const isLive = (status: RunStatus) =>
  status === 'queued' || status === 'running' || status === 'waiting_approval';

/** A run is named by its task: no numbers. */
export const runTitle = (run: RunSummary) => run.task?.title ?? `Run of ${run.agent.name}`;

/** An http(s) address to link to, or null: agents write the refs, so nothing else is a link. */
export function httpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 21 Oct 2026, 14:02: the product's date with the time, 24-hour. */
export function formatWhen(iso: string): string {
  const date = new Date(iso);
  return `${formatDate(iso)}, ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 45 s, 12 min, 1 h 04 min. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${pad(minutes % 60)} min`;
}

/** From the claim to the end, or to now while it runs; nothing before a computer took it. */
export function runDuration(run: Pick<RunSummary, 'startedAt' | 'endedAt'>, now = Date.now()) {
  if (!run.startedAt) return null;
  const end = run.endedAt ? new Date(run.endedAt).getTime() : now;
  return formatDuration(end - new Date(run.startedAt).getTime());
}

const dollars = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
/** $1,284.10; an amount under half a cent is "< $0.01", not "$0.00". */
export function formatUsd(usd: string): string {
  const value = Number(usd);
  return value > 0 && value < 0.005 ? '< $0.01' : dollars.format(value);
}

const count = new Intl.NumberFormat('en-US');
const compact = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumSignificantDigits: 3,
});
export const formatCount = (n: number) => count.format(n);
/** 412K tokens: for a table cell. */
export const formatTokensShort = (n: number) => `${compact.format(n)} tokens`;

/** The kinds of tokens a model burned, zeros left out; `out` is optional. */
function kinds(tokens: Tokens, out = true) {
  const all: [number, string][] = [
    [tokens.tokensIn, 'in'],
    [out ? tokens.tokensOut : 0, 'out'],
    [tokens.tokensCacheRead, 'cache read'],
    [tokens.tokensCacheWrite, 'cache write'],
  ];
  return all.filter(([n]) => n > 0);
}

/** "1,843 in, 96 out, 12,480 cache read": for the cost of a run, exact. */
export const tokenParts = (tokens: Tokens) =>
  kinds(tokens)
    .map(([n, label]) => `${formatCount(n)} ${label}`)
    .join(', ');

/** "1.84K in, 96 out, 12.5K cache read": the same on one line of a narrow column. */
export const tokenPartsShort = (tokens: Tokens) =>
  kinds(tokens)
    .map(([n, label]) => `${compact.format(n)} ${label}`)
    .join(', ');

/**
 * "2 tokens in, 20.6K cache read": one turn's usage, a footnote rather than a ledger. Without
 * the output: the CLI reports what a turn wrote only in the run's result, and the one or
 * two tokens a turn's own lines say would stand under a call that wrote a whole file.
 */
export const turnTokens = (tokens: Tokens) =>
  kinds(tokens, false)
    .map(([n, label], i) => {
      const noun = i > 0 ? '' : n === 1 ? ' token' : ' tokens';
      return `${compact.format(n)}${noun} ${label}`;
    })
    .join(', ');

/** Why a run stopped short, in two or three words for a table; the code stays in the title. */
export function stoppedBy(code: string): string {
  const words: Record<string, string> = {
    orphaned: 'Computer went away',
    timeout: 'Time limit',
    max_turns: 'Turn limit',
    token_limit: 'Token limit',
    not_authenticated: 'Not signed in',
    subscription_not_allowed: 'Subscription blocked',
    not_installed: 'No Claude Code',
    rate_limited: 'Usage limit',
    cancelled: 'Cancelled',
  };
  return words[code] ?? code;
}

// What a failure code means, for the line under the status. The transcript has the details.
const limit = (what: string) =>
  `The run reached its ${what} limit. Raise it in the agent's budget, or split the task.`;
const failures: Record<string, string> = {
  orphaned: 'The computer stopped responding. Check that it is awake and online.',
  timeout: limit('time'),
  max_turns: limit('turn'),
  token_limit: limit('token'),
  not_authenticated: "Claude Code isn't signed in on that computer. Sign in there first.",
  subscription_not_allowed:
    'Claude Code on that computer is signed in to an organization that blocks subscription use. Sign in there with your own subscription.',
  not_installed: "Claude Code isn't installed on that computer. Install it there first.",
  rate_limited: 'The Claude account reached its usage limit. Run the task again once it resets.',
};

/** A failed run's reason in words, or nothing for a code nobody named here. */
export const failureText = (code: string): string | undefined => failures[code];
