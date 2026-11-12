import type { Page } from '@playwright/test';
import { runList, runRoutes } from './mock-runs';

// What the server would answer, for the smoke and the screenshots: they run on the Vite dev
// server alone. The flows against the real server are flows.spec.ts.
const people = [
  ['u1', 'Ann Admin', 'ann@acme.com', 'admin', null],
  ['u2', 'Ilya Smirnov', 'ilya.smirnov@acme.com', 'admin', null],
  ['u3', 'Maria Garcia', 'maria.garcia@acme.com', 'member', null],
  ['u4', 'Bob Member', 'bob@acme.com', 'member', '2026-10-20T16:00:00Z'],
] as const;

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const owner = { id: 'u1', name: 'Ann Admin' };
const agents = [
  ['a1', 'Payments backend', 'Senior backend engineer, Payments', 'done', 130],
  ['a2', 'Checkout QA', 'Quality engineer', 'running', 4],
  ['a3', 'Release notes writer', 'Technical writer', 'waiting_approval', 12],
  ['a4', 'Billing reviewer', 'Code reviewer', 'failed', 60 * 26],
  ['a5', 'Docs site frontend', 'Frontend engineer', null, 0],
] as const;
const summaries = agents.map(([id, name, roleTitle, status, minutes]) => ({
  id,
  name,
  roleTitle,
  status: 'active',
  owner,
  lastRun: status
    ? {
        id: `r-${id}`,
        taskId: null,
        status,
        at: ago(minutes),
        // What the agents at work are on, as the list says it.
        task:
          id === 'a2'
            ? { title: 'Fix the flaky checkout total test', project: 'Payments' }
            : id === 'a3'
              ? { title: 'Write the release notes for 2.14', project: 'Docs site' }
              : null,
      }
    : null,
  createdAt: '2026-10-12T09:00:00Z',
  modelPref: id === 'a5' ? null : id === 'a3' ? 'claude-sonnet-5-5' : 'claude-opus-5-5',
  week: status
    ? {
        runs: Math.max(1, Math.round(1200 / (minutes + 60))),
        usd: '6.35',
        ended: 6,
        done: status === 'failed' ? 3 : 5,
        medianSeconds: 760,
        daily: [1, 0, 2, 1, 3, 2, 4],
      }
    : { runs: 0, usd: null, ended: 0, done: 0, medianSeconds: null, daily: [0, 0, 0, 0, 0, 0, 0] },
  month: status
    ? {
        accepted: { a1: 9, a2: 7, a3: 6, a4: 4 }[id] ?? 0,
        handed: 12,
        medianUsd: { a1: '1.18', a2: '0.86', a3: '0.42', a4: '2.31' }[id] ?? null,
      }
    : { accepted: 0, handed: 0, medianUsd: null },
}));
const instructions = `You answer to the person who set your task: a decision the task does not make, and that changes its scope, is theirs, not yours.

## What you own

- Yours: one task at a time, finished as commits a person can review: the code, its tests, and a summary of what changed, why and how you verified it.
- Not yours: the interface, a choice between designs the task does not settle, scope the task does not state, and merging.

## How a task runs

1. Read the task, the code it is about and the tests around it.
2. Where the repository has tests, start from a test that fails for the right reason.
3. Commit as you go, one commit per meaningful step.
4. After your last edit, run the checks the repository has for what you touched.`;
const tools = [
  ['Workspace', 'Bash', 'Run commands in the sandbox', 'allow'],
  ['Workspace', 'Glob', 'Find files by name', 'allow'],
  ['Workspace', 'Grep', 'Search inside files', 'allow'],
  ['Workspace', 'Read', 'Read files', 'allow'],
  ['Workspace', 'TodoWrite', 'Keep a to-do list for the task', 'allow'],
  ['Code host', 'code_host_create_branch', 'Create a branch', 'allow'],
  ['Code host', 'code_host_open_change_request', 'Open a change request', 'ask'],
  ['Code host', 'code_host_get_change_request', 'Read a change request', 'allow'],
  ['Code host', 'code_host_get_pipeline_failures', 'Read pipeline failures', 'allow'],
  ['Code host', 'code_host_reply_to_review', 'Reply on a change request', 'deny'],
  ['Memory', 'memory_read', 'Read its memory', 'allow'],
  ['Memory', 'memory_write', 'Write to its memory', 'allow'],
  ['Knowledge', 'knowledge_search', 'Search the knowledge', 'allow'],
  ['Knowledge', 'knowledge_read', 'Read a knowledge document', 'allow'],
  ['tracker', 'tracker__create_issue', 'Create an issue', 'ask'],
  ['tracker', 'tracker__search_issues', 'Search issues', 'allow'],
].map(([connector, name, title, policy]) => ({ connector, name, title, policy }));
export const paymentsBackend = {
  ...summaries[0],
  instructions,
  engine: 'claude-code',
  modelPref: 'claude-sonnet-5-5',
  runsOn: 'laptop',
  modelConnection: null,
  serverShell: false,
  budget: { maxTurns: 80, usdPerMonth: 250 },
  runDefaults: { maxMinutes: 60, maxTurns: 50, maxTokens: 2_000_000 },
  copiedFromAgentId: null,
  template: { id: 't1', name: 'Backend developer', version: 2 },
  seat: { id: 's1', name: 'Ann’s MacBook Pro', busy: false, lastSeenAt: ago(0.2) },
  people: [{ id: 'u1', name: 'Ann Admin', level: 'owner', validFrom: null, validUntil: null }],
  tools,
  memoryDocuments: 2,
  skills: [{ id: 'sk1', name: 'code-review', version: '2' }],
  mcpServers: [{ id: 'm1', name: 'tracker' }],
  projects: [
    {
      id: 'p1',
      name: 'Payments',
      hosts: ['github', 'gitlab'],
      repositories: [
        'https://github.com/northfold/payments-api',
        'https://github.com/northfold/ledger',
      ],
    },
    {
      id: 'p2',
      name: 'Docs site',
      hosts: ['github'],
      repositories: ['https://github.com/northfold/docs'],
    },
  ],
  spend: { usdThisMonth: 61.4, limit: 250, reached: false, resumed: false },
};
const templates = [
  ['Backend developer', 'Backend engineer', 'Turns a task into tested server-side commits.'],
  [
    'Code reviewer',
    'Code reviewer',
    'Reviews a branch and reports only the findings it is sure of.',
  ],
  [
    'Frontend developer',
    'Frontend engineer',
    'Builds screens with every state covered and checked.',
  ],
  ['QA engineer', 'Quality engineer', 'Checks a change against its acceptance criteria.'],
  [
    'Release manager',
    'Release manager',
    'Prepares the changelog, version, checklist and rollback.',
  ],
  [
    'Technical writer',
    'Technical writer',
    'Keeps the docs true to a change and writes release notes.',
  ],
].map(([name, roleTitle, description], index) => ({
  id: `t${index + 1}`,
  name,
  version: 1,
  description,
  roleTitle,
  modelPref: 'claude-sonnet-5-5',
}));

// Tasks of the agents above, newest first: [id, title, agent, status, created and latest run
// in minutes ago].
const laptop = { name: 'Ann’s MacBook Pro' };
const taskRows = [
  ['k1', 'Add a README to the test repository', 0, 'open', 25, 'running', 3],
  ['k2', 'Fix the flaky checkout total test', 1, 'open', 70, 'waiting_approval', 12],
  ['k3', 'Write the release notes for 2.14', 2, 'open', 95, 'queued', 1],
  ['k4', 'Review the refund flow branch', 3, 'open', 60 * 27, 'failed', 60 * 26],
  ['k5', 'Retry webhook deliveries with backoff', 0, 'done', 60 * 28, 'done', 60 * 5],
  ['k6', 'Document the payouts API', 4, 'open', 60 * 30, null, 0],
  ['k7', 'Bump the Stripe SDK to 19.2', 0, 'review', 60 * 52, 'done', 60 * 50],
] as const;
const taskSummaries = taskRows.map(([id, title, agent, status, created, run, minutes]) => ({
  id,
  title,
  agent: { id: agents[agent][0], name: agents[agent][1] },
  status,
  source: 'manual',
  repository: id === 'k2' ? 'https://github.com/acme/checkout.git' : '~/code/test-repo',
  createdBy: owner,
  createdAt: ago(created),
  latestRun: run && { id: `r-${id}`, status: run, at: ago(minutes) },
  // A task in review left a pull request, green, for the dashboard's "Ready for your review".
  changeRequest:
    status === 'review'
      ? {
          url: `https://github.com/northfold/payments-api/pull/4${id.slice(1)}`,
          state: 'draft',
          pipeline: 'success',
        }
      : null,
  project: id === 'k1' ? { id: 'p1', name: 'Payments' } : null,
}));
const run = (
  id: string,
  status: string,
  started: number,
  minutes: number | null,
  errorCode?: string,
) => ({
  id,
  status,
  startedAt: ago(started),
  endedAt: minutes === null ? null : ago(started - minutes),
  errorCode: errorCode ?? null,
  seat: laptop,
  createdAt: ago(started + 0.2),
  usd: minutes === null ? null : (minutes * 0.21).toFixed(2),
});
/** A task as its page reads it: the summary with the agent's status, the text and the runs. */
const detail = (
  index: number,
  body: string,
  runs: object[],
  changeRequests: object[] = [],
  questions: object[] = [],
  parent: object | null = null,
) => {
  const summary = taskSummaries[index];
  return (
    summary && {
      ...summary,
      agent: { ...summary.agent, status: 'active' },
      body,
      externalError: null,
      runs,
      changeRequests,
      questions,
      parent,
      subtasks: [],
      comments: [],
    }
  );
};
const readme = `The test repository has no README, and people ask in chat how to run it.

## Done when

- \`README.md\` says what the service does in two sentences.
- It lists the commands to install, test and run it locally, copied from \`package.json\`.
- It links to \`docs/architecture.md\` instead of repeating it.

Keep it under 80 lines. Commit on a branch; do not touch the code.`;
export const tasksApi: Record<string, unknown> = {
  'GET /api/tasks': { tasks: taskSummaries, nextBefore: taskSummaries.at(-1)?.createdAt },
  'GET /api/tasks?status=review&limit=20': {
    tasks: taskSummaries.filter((task) => task.status === 'review'),
    nextBefore: null,
  },
  'GET /api/tasks?agent=a1': {
    tasks: taskSummaries.filter((task) => task.agent.id === 'a1'),
    nextBefore: null,
  },
  'GET /api/tasks/folders': { folders: ['~/code/payments', '/Users/ann/work/ledger-tools'] },
  'GET /api/tasks/k1': detail(
    0,
    readme,
    [
      run('r-k1', 'running', 3, null),
      run('r-k1b', 'failed', 140, 14, 'max_turns'),
      run('r-k1c', 'cancelled', 60 * 20, 2),
    ],
    [],
    [
      {
        id: 'q-k1',
        runId: 'r-k1b',
        question: 'Should the README cover the Docker setup too, or only the local one?',
        answer: 'Only the local one; Docker has its own page.',
        state: 'answered',
        askedAt: ago(134),
        answeredAt: ago(131),
        answeredBy: 'Ann Admin',
      },
    ],
  ),
  'GET /api/tasks/k1/changes': {
    branches: [
      {
        name: 'agent/add-readme',
        commits: [
          { sha: '3f9c2a14be', subject: 'Say how to run the tests' },
          { sha: '8d41e07c55', subject: 'Add a README with the setup steps' },
        ],
        additions: 64,
        deletions: 3,
        files: 2,
        url: 'https://github.com/acme/test-repo/compare/main...agent/add-readme',
      },
    ],
    changeRequests: [],
    problem: null,
  },
  'GET /api/tasks/k5/changes': {
    // A run's own branch and a change request the host did not describe: the longest lines
    // the cards hold, which must not widen a phone's page.
    branches: [
      {
        name: 'agent/run-e6d8cca3-4d8d-4c9a-9541-491f9d28b480',
        commits: [{ sha: '3b7f1c2a90', subject: 'Retry deliveries with exponential backoff' }],
        additions: null,
        deletions: null,
        files: null,
        url: null,
      },
    ],
    changeRequests: [
      {
        url: 'https://github.com/acme/payments/pull/318',
        number: 318,
        title: 'Retry failed webhook deliveries with backoff',
        state: 'merged',
        pipeline: 'success',
      },
      {
        url: 'https://gitlab.northfold.dev/payments-platform/payments-api/payments-api/-/merge_requests/321',
        number: null,
        title: null,
        state: 'draft',
        pipeline: null,
      },
    ],
    problem: null,
  },
  'GET /api/tasks/k5': {
    ...detail(
      4,
      'Failed webhook deliveries are retried at once and give up after one try. Retry them with exponential backoff, at most 8 times over 24 hours, and record each attempt.',
      [run('r-k5', 'done', 60 * 5 + 18, 18), run('r-k5b', 'failed', 60 * 6, 41, 'timeout')],
      [
        {
          url: 'https://github.com/acme/payments/pull/318',
          runId: 'r-k5',
          state: 'merged',
          pipeline: 'success',
          review: 'approved',
          createdAt: ago(60 * 5 + 2),
        },
      ],
      [],
      { id: 'k0', title: 'Make the payment webhooks reliable', agent: 'Platform lead' },
    ),
    runs: [
      {
        ...run('r-k5', 'done', 60 * 5 + 18, 18),
        summary:
          'Deliveries are retried with exponential backoff: 1, 2, 4… minutes, at most 8 times over 24 hours, each attempt recorded in `webhook_attempts`. Tests cover the backoff and the give-up. PR #318.',
      },
      run('r-k5b', 'failed', 60 * 6, 41, 'timeout'),
    ],
    comments: [
      {
        id: 'c-k5',
        body: 'Also log the last error on the delivery, so we can see why it gave up.',
        runId: null,
        createdAt: ago(60 * 5),
        author: { kind: 'person', id: 'u1', name: 'Ann Admin' },
      },
      {
        id: 'c-k5b',
        body: 'Done: `last_error` is on the delivery and shown in Admin → Logs. Same PR.',
        runId: 'r-k5',
        createdAt: ago(60 * 4),
        author: { kind: 'agent', id: 'a1', name: 'Payments backend' },
      },
    ],
  },
};

/** Calls waiting for Ann, oldest first: the page words each one. */
export const approvals = [
  {
    id: 'tc1',
    tool: 'code_host_open_change_request',
    input: {
      branch: 'agent/fix-checkout-total',
      title: 'Fix the flaky checkout total test',
      description:
        'The test compared totals as floats and failed about once in forty runs. It now compares cents as integers.\n\nRan the suite 200 times locally: no failures.',
    },
    runId: 'r-k2',
    agent: { id: 'a2', name: 'Checkout QA' },
    task: {
      id: 'k2',
      title: 'Fix the flaky checkout total test',
      repository: 'https://github.com/acme/checkout.git',
    },
    createdAt: ago(12),
  },
  {
    id: 'tc2',
    tool: 'code_host_create_branch',
    input: { branch: 'agent/release-notes-2-14' },
    runId: 'r-k3',
    agent: { id: 'a3', name: 'Release notes writer' },
    task: {
      id: 'k3',
      title: 'Write the release notes for 2.14',
      repository: 'https://gitlab.northfold.dev/payments/services/docs.git',
    },
    createdAt: ago(3),
  },
];

// The memory of Payments backend: what its runs learned, and a note its owner added.
const memoryDoc = (version: number, content: string, minutes: number, run: boolean) => ({
  path: 'MEMORY.md',
  version,
  content,
  updatedAt: ago(minutes),
  updatedBy: run ? { kind: 'run', id: 'r3' } : { kind: 'user', id: 'u1', name: 'Ann Admin' },
});
const memory = [
  memoryDoc(
    3,
    '# Payments backend\n\n## Tests\n\n- `settlement/retry.test.ts` reads the clock twice: freeze time with `vi.useFakeTimers()`, never widen the tolerance.\n- Run a flaky test 20 times before calling it fixed.\n\n## Repository\n\n- Money is in integer cents; never compare floats.\n',
    95,
    true,
  ),
  memoryDoc(
    2,
    '# Payments backend\n\n## Tests\n\n- Run a flaky test 20 times before calling it fixed.\n\n## Repository\n\n- Money is in integer cents; never compare floats.\n',
    60 * 26,
    true,
  ),
  memoryDoc(
    1,
    '# Payments backend\n\n## Repository\n\n- Money is in integer cents; never compare floats.\n',
    60 * 50,
    false,
  ),
];
const stripeNote = {
  ...memoryDoc(1, 'The Stripe SDK is pinned at 19.2 until the 2.15 release.\n', 60 * 30, false),
  path: 'memory/stripe.md',
};

// The library: two skills everyone may use and one only its author sees.
const librarySkill = (
  id: string,
  name: string,
  description: string,
  version: number,
  own: boolean,
  org: boolean,
) => ({
  id,
  name,
  description,
  version,
  owner: own ? { id: 'u1', name: 'Ann Admin' } : { id: 'u2', name: 'Ilya Smirnov' },
  visibility: org ? 'org' : 'private',
  createdAt: ago(60 * 24 * (version + 1)),
});
const librarySkills = [
  librarySkill(
    'sk1',
    'code-review',
    'Reviews a branch and reports only the findings it is sure of',
    3,
    true,
    true,
  ),
  librarySkill(
    'sk2',
    'release-notes',
    'Writes release notes from merged pull requests, in the house style',
    1,
    false,
    true,
  ),
  librarySkill(
    'sk3',
    'payments-fixtures',
    'Builds settlement test fixtures from a production export',
    2,
    true,
    false,
  ),
];
const codeReviewMd = `---
name: code-review
description: Reviews a branch and reports only the findings it is sure of
---

# Code review

1. Read the diff against the default branch, then the files it touches.
2. Report a finding only when you can name the input that breaks it.
3. Group findings by severity; say plainly when there are none.
`;

// A team: Payments backend leads, QA and the docs frontend work in manual steps.
const ref = (id: string, name: string, roleTitle: string) => ({
  id,
  name,
  roleTitle,
  status: 'active',
});
export const deliveryTeam = {
  id: 't1',
  name: 'Refunds delivery',
  mode: 'manual',
  lead: ref('a1', 'Payments backend', 'Senior backend engineer, Payments'),
  members: [
    ref(
      'a2',
      'Checkout QA',
      'Tests the checkout end to end, from the cart to the refund, on every browser we support',
    ),
    ref('a5', 'Docs site frontend', 'Frontend engineer'),
  ],
  steps: [
    { agents: ['a5'], note: 'The refund screen is built' },
    { agents: ['a2', 'a5'], note: 'The e2e suite passes on the branch' },
  ],
};

export const api: Record<string, unknown> = {
  'GET /api/teams': { teams: [deliveryTeam] },
  'GET /api/teams/t1': deliveryTeam,
  'GET /api/approvals': { approvals },
  'GET /api/me': { id: 'u1', name: 'Ann Admin', email: 'ann@acme.com', role: 'admin' },
  'POST /api/me/presence': null,
  'GET /api/me/place': { available: false, place: null },
  'GET /api/me/tokens': {
    tokens: [
      {
        id: 'k1',
        name: 'Claude Code on my MacBook',
        scope: 'write',
        createdAt: ago(1440),
        expiresAt: ago(-29 * 1440),
        lastUsedAt: ago(12),
      },
      {
        id: 'k2',
        name: 'Weekly report script',
        scope: 'read',
        createdAt: ago(40 * 1440),
        expiresAt: ago(10 * 1440),
        lastUsedAt: ago(11 * 1440),
      },
    ],
  },
  // The computer the agents' sheets name.
  'GET /api/seats': [
    {
      id: 's1',
      name: 'Ann’s MacBook Pro',
      owner: { id: 'u1', name: 'Ann Admin' },
      kind: 'subscription-laptop',
      status: 'active',
      lastSeenAt: ago(0.2),
      idleMinutes: 15,
      activeRun: null,
      updateCommand: null,
      signedOut: [],
      platform: null,
      sandbox: { none: false, allowedAt: null },
    },
  ],
  'GET /api/agents': { agents: summaries },
  'GET /api/agents?all=true': { agents: summaries },
  'GET /api/admin/version': { version: '0.1.0', commit: '572776f', updateCheck: true },
  'GET /api/projects': {
    projects: [
      {
        id: 'p1',
        name: 'Payments',
        agentCount: 3,
        createdBy: 'u1',
        connectionCount: 2,
        createdAt: '2026-09-14T09:12:00Z',
        team: { id: 't1', name: 'Refunds delivery' },
        week: {
          runs: 14,
          ended: 12,
          done: 9,
          medianSeconds: 1260,
          usd: '61.4',
          daily: [1, 3, 2, 0, 4, 2, 2],
        },
        lastRun: null,
      },
      {
        id: 'p2',
        name: 'Docs site',
        agentCount: 1,
        createdBy: 'u1',
        connectionCount: 1,
        createdAt: '2026-10-02T11:40:00Z',
        team: null,
        week: {
          runs: 3,
          ended: 2,
          done: 2,
          medianSeconds: 480,
          usd: '2.9',
          daily: [0, 0, 1, 0, 1, 0, 1],
        },
        lastRun: null,
      },
      {
        id: 'p3',
        name: 'Internal tools',
        agentCount: 0,
        createdBy: 'u1',
        connectionCount: 0,
        createdAt: '2026-10-18T15:05:00Z',
        team: null,
        week: {
          runs: 0,
          ended: 0,
          done: 0,
          medianSeconds: null,
          usd: null,
          daily: [0, 0, 0, 0, 0, 0, 0],
        },
        lastRun: null,
      },
    ],
  },
  // Admin → Logs: a request with its calls out, a slow GitLab, a computer's warning.
  'GET /api/admin/logs/level': { level: 'info' },
  'GET /api/admin/logs?level=info&limit=100': {
    entries: [
      {
        id: 9,
        at: ago(0.2),
        level: 30,
        source: 'server',
        message: 'request completed',
        context: { res: { statusCode: 200 } },
        traceId: 'a1b2c3d4e5f60718',
        runId: 'r1',
        seatId: null,
        span: 'POST /mcp',
        durationMs: 3480,
      },
      {
        id: 8,
        at: ago(0.21),
        level: 30,
        source: 'server',
        message: 'outbound call',
        context: { status: 200 },
        traceId: 'a1b2c3d4e5f60718',
        runId: 'r1',
        seatId: null,
        span: 'GET https://gitlab.northfold.dev/api/v4/projects/42/merge_requests/306',
        durationMs: 3310,
      },
      {
        id: 7,
        at: ago(0.5),
        level: 40,
        source: 'worker',
        message: 'the claim failed (The server answered 502.); trying again',
        context: null,
        traceId: null,
        runId: null,
        seatId: 's1',
        span: null,
        durationMs: null,
      },
      {
        id: 6,
        at: ago(0.6),
        level: 30,
        source: 'server',
        message: 'request completed',
        context: { res: { statusCode: 200 } },
        traceId: 'b2c3d4e5f6071829',
        runId: null,
        seatId: null,
        span: 'GET /api/tasks',
        durationMs: 38,
      },
      {
        id: 5,
        at: ago(1),
        level: 50,
        source: 'server',
        message: 'the run notification failed',
        context: { err: { type: 'Error', message: 'push service answered 410' } },
        traceId: 'c3d4e5f607182930',
        runId: null,
        seatId: null,
        span: null,
        durationMs: null,
      },
      {
        id: 4,
        at: ago(1.2),
        level: 30,
        source: 'worker',
        message: 'run r1 claimed: Payments backend, "Add a README"',
        context: null,
        traceId: null,
        runId: 'r1',
        seatId: 's1',
        span: null,
        durationMs: null,
      },
      {
        id: 3,
        at: ago(1.3),
        level: 30,
        source: 'server',
        message: 'outbound call',
        context: { status: 200 },
        traceId: 'd4e5f60718293041',
        runId: null,
        seatId: null,
        span: 'POST https://lite-llm.northfold.dev/Jira_mcp/mcp',
        durationMs: 640,
      },
    ],
    nextBefore: 2,
  },
  'GET /api/admin/logs/traces/a1b2c3d4e5f60718': {
    traceId: 'a1b2c3d4e5f60718',
    entries: [
      {
        id: 10,
        at: ago(0.215),
        level: 30,
        source: 'server',
        message: 'outbound call',
        context: { status: 200 },
        traceId: 'a1b2c3d4e5f60718',
        runId: 'r1',
        seatId: null,
        span: 'POST https://lite-llm.northfold.dev/Jira_mcp/mcp',
        durationMs: 120,
      },
      {
        id: 8,
        at: ago(0.21),
        level: 30,
        source: 'server',
        message: 'outbound call',
        context: { status: 200 },
        traceId: 'a1b2c3d4e5f60718',
        runId: 'r1',
        seatId: null,
        span: 'GET https://gitlab.northfold.dev/api/v4/projects/42/merge_requests/306',
        durationMs: 3310,
      },
      {
        id: 9,
        at: ago(0.2),
        level: 30,
        source: 'server',
        message: 'request completed',
        context: { res: { statusCode: 200 } },
        traceId: 'a1b2c3d4e5f60718',
        runId: 'r1',
        seatId: null,
        span: 'POST /mcp',
        durationMs: 3480,
      },
    ],
  },
  'GET /api/projects/p1/knowledge': {
    sources: [
      {
        id: 'k1',
        repository: 'https://github.com/northfold/payments',
        paths: ['README.md', 'docs'],
        lastSyncAt: ago(12),
        lastSyncError: null,
        documents: 34,
      },
      {
        id: 'k2',
        repository: 'https://gitlab.northfold.dev/payments/services/ledger',
        paths: ['docs/decisions'],
        lastSyncAt: ago(40),
        lastSyncError: 'gitlab.northfold.dev answered 401: the token was revoked or has expired',
        documents: 9,
      },
    ],
  },
  'GET /api/projects/p1': {
    id: 'p1',
    name: 'Payments',
    agentCount: 3,
    createdBy: 'u1',
    connectionCount: 3,
    createdAt: '2026-09-14T09:12:00Z',
    team: { id: 't1', name: 'Refunds delivery', lead: { id: 'a1', name: 'Payments backend' } },
    intake: 'auto',
    budget: { usdPerMonth: 300, usdThisMonth: 61.4 },
    triggers: { onPipelineFailed: true, onReview: false, reviewer: null },
    description:
      'The money path: checkout, refunds and the ledger. Anything an agent changes here is reviewed by a person before it ships.',
    goals: '',
    repositories: [
      'https://github.com/northfold/payments-api',
      'https://github.com/northfold/ledger',
      'https://gitlab.northfold.dev/platform/settlement',
    ],
    environment: {
      repository: 'https://github.com/northfold/payments-api',
      devcontainer: '.devcontainer/devcontainer.json',
      services: [
        {
          name: 'db',
          image: 'postgres:16-alpine',
          environment: { POSTGRES_DB: 'payments', POSTGRES_PASSWORD: 'dev' },
          volumes: [{ name: 'pgdata', target: '/var/lib/postgresql/data' }],
        },
        {
          name: 'cache',
          image: 'redis:7-alpine',
          environment: {},
          command: ['redis-server', '--appendonly', 'yes'],
          volumes: [],
        },
        {
          name: 'stripe-mock',
          image: 'stripe/stripe-mock:0.188.0',
          environment: {},
          volumes: [],
        },
      ],
      problems: [
        'mailhog: left out, it asks for privileged',
        'db: a folder of the host is not mounted (./seed)',
      ],
      readAt: new Date(Date.now() - 18 * 60_000).toISOString(),
      hash: 'a'.repeat(64),
      approved: false,
    },
    agents: [
      {
        id: 'a1',
        name: 'Payments backend',
        roleTitle: 'Senior backend engineer',
        status: 'active',
      },
      { id: 'a2', name: 'Checkout QA', roleTitle: 'QA engineer', status: 'active' },
      { id: 'a5', name: 'Billing reviewer', roleTitle: 'Code reviewer', status: 'archived' },
    ],
    week: {
      runs: 14,
      ended: 12,
      done: 9,
      medianSeconds: 1260,
      usd: '61.4',
      daily: [1, 3, 2, 0, 4, 2, 2],
    },
    connections: [
      {
        id: 'c1',
        kind: 'github',
        host: 'github.com',
        namespace: 'northfold',
        accountLogin: 'northfold-agent',
        agentName: null,
      },
      {
        id: 'c2',
        kind: 'gitlab',
        host: 'gitlab.northfold.dev',
        namespace: 'payments/services',
        accountLogin: null,
        agentName: 'Payments backend',
      },
      {
        id: 'c4',
        kind: 'jira',
        host: 'jira.northfold.dev',
        namespace: 'project = "PAY" AND (labels = ai-team)',
        accountLogin: 'svc-agentome',
        agentName: 'Payments backend',
      },
    ],
  },
  'GET /api/connections': {
    connections: [
      {
        id: 'c1',
        project: { id: 'p1', name: 'Payments' },
        agent: null,
        kind: 'github',
        config: { owner: 'northfold' },
        host: 'github.com',
        namespace: 'northfold',
        accountLogin: 'northfold-agent',
        lastTestedAt: '2026-10-21T08:30:00Z',
        syncedAt: null,
        syncError: null,
        createdAt: '2026-09-14T09:20:00Z',
      },
      {
        id: 'c2',
        project: { id: 'p1', name: 'Payments' },
        agent: { id: 'a1', name: 'Payments backend' },
        kind: 'gitlab',
        config: { baseUrl: 'https://gitlab.northfold.dev', group: 'payments/services' },
        host: 'gitlab.northfold.dev',
        namespace: 'payments/services',
        accountLogin: null,
        lastTestedAt: null,
        syncedAt: null,
        syncError: null,
        createdAt: '2026-10-02T12:00:00Z',
      },
      {
        id: 'c4',
        project: { id: 'p1', name: 'Payments' },
        agent: { id: 'a1', name: 'Payments backend' },
        kind: 'jira',
        config: {
          baseUrl: 'https://jira.northfold.dev',
          projectKey: 'PAY',
          jql: 'labels = ai-team',
          inProgress: 'In Progress',
          inReview: 'In Review',
          done: 'Done',
          timeZone: 'Europe/Berlin',
        },
        host: 'jira.northfold.dev',
        namespace: 'project = "PAY" AND (labels = ai-team)',
        accountLogin: 'svc-agentome',
        lastTestedAt: '2026-10-28T09:10:00Z',
        syncedAt: '2026-10-28T09:15:00Z',
        syncError: null,
        createdAt: '2026-10-28T09:00:00Z',
      },
      {
        id: 'c3',
        project: { id: 'p2', name: 'Docs site' },
        agent: null,
        kind: 'github',
        config: { owner: 'northfold-docs' },
        host: 'github.com',
        namespace: 'northfold-docs',
        accountLogin: 'maria',
        lastTestedAt: '2026-10-19T16:05:00Z',
        syncedAt: null,
        syncError: null,
        createdAt: '2026-10-02T11:45:00Z',
      },
    ],
  },
  'GET /api/model-connections': {
    connections: [
      {
        id: 'mc1',
        name: 'Anthropic',
        kind: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        models: ['claude-haiku-4-5', 'claude-opus-4-1', 'claude-sonnet-4-5'].map((id) => ({
          id,
          engine: 'claude-code',
        })),
        checkedAt: '2026-10-30T09:12:00Z',
        createdAt: '2026-10-30T09:12:00Z',
      },
      {
        id: 'mc2',
        name: 'Northfold LiteLLM',
        kind: 'gateway',
        baseUrl: 'https://litellm.northfold.dev',
        models: [
          { id: 'claude-sonnet-4-5', engine: 'claude-code' },
          { id: 'gpt-5-codex', engine: 'codex' },
          { id: 'gpt-5-mini', engine: 'codex' },
          { id: 'qwen3-coder-30b', engine: 'codex' },
          { id: 'northfold-llama-70b', engine: 'codex' },
        ],
        checkedAt: '2026-11-01T08:40:00Z',
        createdAt: '2026-10-31T16:05:00Z',
      },
    ],
  },
  'GET /api/models': {
    connections: [
      {
        id: 'mc2',
        name: 'Northfold LiteLLM',
        models: [
          { id: 'claude-sonnet-4-5', engine: 'claude-code' },
          { id: 'gpt-5-codex', engine: 'codex' },
        ],
      },
    ],
  },
  'GET /api/connections/c1/webhook': {
    url: 'https://agentome.northfold.dev/webhooks/github/c1',
    secret: '3f9c1d7a52b84e06af1c83d4e75b2069c4a8f13d6e07b295ca48f0d31e7b6a52',
  },
  'GET /api/agents/a1': paymentsBackend,
  'GET /api/agents/a1/quality': {
    since: ago(60 * 24 * 30),
    tasks: 14,
    handed: 12,
    accepted: 9,
    firstTime: 6,
    changeRequests: { merged: 8, closed: 1, open: 2 },
    returns: { total: 5, tasks: 3, person: 3, ci: 1, review: 1 },
    usd: { median: '1.18', total: '21.64' },
    seconds: { work: 1140, toReview: 5400 },
    runs: { ended: 22, failed: 2, limited: 1 },
    mostReturned: [
      { id: 'k5', title: 'Retry webhook deliveries with backoff', returns: 2, usd: '3.40' },
      { id: 'k7', title: 'Bump the Stripe SDK to 19.2', returns: 2, usd: '2.95' },
      { id: 'k1', title: 'Add a README to the test repository', returns: 1, usd: '1.10' },
    ],
  },
  'GET /api/agents/a1/schedules': {
    schedules: [
      {
        id: 's1',
        title: 'Check the overnight refunds',
        body: '',
        days: [1, 2, 3, 4, 5],
        time: '09:00',
        timeZone: 'Europe/Moscow',
        enabled: true,
        when: 'Every weekday at 09:00',
        lastRunAt: '2026-10-30T06:00:00Z',
      },
    ],
  },
  'GET /api/library/skills': { skills: librarySkills },
  'GET /api/library/mcp': {
    servers: [
      {
        id: 'm1',
        name: 'tracker',
        description: 'Files and reads issues in the company tracker',
        url: 'https://mcp.northfold.dev/tracker',
        hasAuthorization: true,
        tools: [
          {
            name: 'create_issue',
            title: 'Create an issue',
            description: 'Files an issue in a project',
          },
          {
            name: 'search_issues',
            title: 'Search issues',
            description: 'Finds issues by text and status',
          },
        ],
        checkedAt: ago(90),
        owner: { id: 'u1', name: 'Ann Admin' },
        visibility: 'org',
      },
      {
        id: 'm2',
        name: 'metrics',
        description: '',
        url: 'https://grafana.northfold.dev/mcp',
        hasAuthorization: false,
        tools: [{ name: 'query', title: 'Query a dashboard', description: '' }],
        checkedAt: ago(60 * 26),
        owner: { id: 'u2', name: 'Ilya Smirnov' },
        visibility: 'private',
      },
      {
        id: 'm3',
        name: 'wiki',
        description: 'Reads and edits the company wiki',
        url: 'https://llm.northfold.dev/wiki/mcp',
        hasAuthorization: false,
        auth: 'oauth',
        signedIn: false,
        tools: [],
        checkedAt: ago(60 * 2),
        owner: { id: 'u1', name: 'Ann Admin' },
        visibility: 'org',
      },
    ],
  },
  'GET /api/library/skills/sk1': { ...librarySkills[0], content: codeReviewMd },
  // Who has an item: two agents the skill, one the tracker, nobody the rest.
  'GET /api/library/skills/sk1/agents': {
    agents: [
      { id: 'a2', name: 'Checkout QA' },
      { id: 'a1', name: 'Payments backend' },
    ],
  },
  'GET /api/library/mcp/m1/agents': { agents: [{ id: 'a1', name: 'Payments backend' }] },
  'GET /api/library/mcp/m2/agents': { agents: [] },
  'GET /api/library/mcp/m3/agents': { agents: [] },
  'GET /api/agents/a1/memory': { documents: [memory[0], stripeNote] },
  'GET /api/agents/a1/memory/versions': { path: 'MEMORY.md', versions: memory },
  'GET /api/templates': { templates },
  ...tasksApi,
  'GET /api/agents/a1/workspace-preview': {
    claudeMd: `# Payments backend\n\nYou are Payments backend, Senior backend engineer, Payments, an agent of this company on Agentome.\n\n## Instructions\n\n${instructions}\n\n## Workspace\n\n- Work only inside this workspace. It is deleted when the run ends: commit what should stay, and describe everything else in your final answer.\n- The network is closed except for the Agentome server.\n`,
    settings: {
      permissionMode: 'acceptEdits',
      allowedTools: ['Bash', 'Glob', 'Grep', 'Read', 'TodoWrite'],
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        network: { allowedDomains: ['agentome.acme.com'], strictAllowlist: true },
      },
    },
  },
  'GET /api/setup': { completed: false, keycloak: true },
  'GET /api/license': {
    status: 'valid',
    enterprise: true,
    installationId: '3f2a-91c0-7be4-55d1',
    id: '6f1c2a4e-9b7d-4e21-8c3a-5d0f9e7b1a2c',
    company: 'Acme',
    expiresAt: '2027-11-02T23:59:59.999Z',
    graceEndsAt: '2027-11-16T23:59:59.999Z',
    agents: { limit: 10, active: 5, peak: 6 },
    over: [],
  },
  'GET /api/invitations/sample-token': {
    valid: true,
    role: 'member',
    email: null,
    invitedBy: 'Ann Admin',
    orgName: 'Northfold',
  },
  // Whom an agent can be transferred to: the people who are not disabled, by name.
  'GET /api/people': {
    people: people
      .filter(([, , , , disabledAt]) => disabledAt === null)
      .map(([id, name]) => ({ id, name })),
  },
  'GET /api/users': {
    users: people.map(([id, name, email, role, disabledAt]) => ({
      id,
      name,
      email,
      role,
      disabledAt,
      createdAt: '2026-10-01T09:00:00Z',
    })),
  },
  'GET /api/invitations': {
    invitations: [
      {
        id: 'i1',
        role: 'member',
        email: null,
        invitedBy: 'Ann Admin',
        createdAt: '2026-10-21T09:00:00Z',
        expiresAt: '2026-10-28T09:00:00Z',
      },
      {
        id: 'i2',
        role: 'admin',
        email: 'dave.lee@acme.com',
        invitedBy: 'Ilya Smirnov',
        createdAt: '2026-10-20T11:00:00Z',
        expiresAt: '2026-10-27T11:00:00Z',
      },
    ],
  },
  'POST /api/invitations': {
    id: 'i3',
    url: 'https://agentome.acme.com/invite/q3Jx0rTzV7mYc2LkPa9sWb4NdHe1FgUi6oZ5yRtXv8E',
    expiresAt: '2026-10-28T09:00:00Z',
  },
  ...runRoutes,
  // The dashboard asks for each status it shows.
  ...Object.fromEntries(
    ['waiting_approval', 'running', 'queued', 'done', 'failed'].map((status) => [
      `GET /api/runs?status=${status}&limit=100`,
      { runs: runList.runs.filter((run) => run.status === status), nextBefore: null },
    ]),
  ),
};

const isStream = (value: unknown): value is { sse: string } =>
  typeof value === 'object' && value !== null && 'sse' in value;

/** An answer that is the API's error, as in `{ fail: { status, code, message } }`. */
const isFailure = (
  value: unknown,
): value is { fail: { status: number; code: string; message: string } } =>
  typeof value === 'object' && value !== null && 'fail' in value;

export async function mockApi(page: Page, routes: Record<string, unknown> = api) {
  // Admin asks GitHub for the latest release: a newer one is out, and nothing leaves the machine.
  await page.route('https://api.github.com/**', (route) =>
    route.fulfill({
      json: {
        tag_name: 'v0.2.0',
        html_url: 'https://github.com/agentome-ai/agentome/releases/tag/v0.2.0',
      },
    }),
  );
  await page.route('**/api/**', (route) => {
    const request = route.request();
    const { pathname, search } = new URL(request.url());
    // A route that names a query answers that query; one without answers any.
    const path = `${request.method()} ${pathname}`;
    const key = `${path}${search}` in routes ? `${path}${search}` : path;
    const answer = routes[key];
    if (isStream(answer)) {
      return route.fulfill({ contentType: 'text/event-stream', body: answer.sse });
    }
    if (isFailure(answer)) {
      const { status, code, message } = answer.fail;
      return route.fulfill({ status, json: { error: { code, message } } });
    }
    return key in routes
      ? route.fulfill({ json: answer })
      : route.fulfill({ status: 404, json: { error: { code: 'not_found', message: key } } });
  });
}
