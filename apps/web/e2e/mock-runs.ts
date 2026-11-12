import { readFileSync } from 'node:fs';

// Runs for the smoke and the screenshots, as GET /api/runs, /api/runs/:id and the stream would
// answer: one running, one done, one failed, and a list around them. Times are relative to now,
// so that durations read as they would on the day.

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

// The agents, the person and the computer of mock-api.ts.
const agent = (id: string, name: string) => ({ id, name });
const backend = agent('a1', 'Payments backend');
const qa = agent('a2', 'Checkout QA');
const ann = { id: 'u1', name: 'Ann Admin' };
const laptop = { id: 's1', name: 'Ann’s MacBook Pro', owner: { id: 'u1', name: 'Ann Admin' } };
const byPerson = { kind: 'user', user: ann };

type Row = [string, string, { id: string; name: string }, string, number | null, number | null];
// id, status, agent, task, started (min ago), ended (min ago)
const rows: Row[] = [
  ['r1', 'running', backend, 'Fix the flaky retry test in payments-api', 12, null],
  [
    'r2',
    'queued',
    agent('a3', 'Release notes writer'),
    'Write the release notes for 2.14',
    null,
    null,
  ],
  ['r3', 'done', backend, 'Add a README to the test repository', 95, 86],
  ['r4', 'failed', qa, 'Fix the checkout end-to-end suite', 180, 158],
  ['r5', 'done', agent('a4', 'Billing reviewer'), 'Review the invoice export branch', 1500, 1491],
  ['r6', 'cancelled', backend, 'Regenerate the API client', 1620, 1617],
  ['r7', 'done', backend, 'Add refund reason codes', 2900, 2874],
];
const cost: Record<string, { usd: string | null; tokens: number }> = {
  r1: { usd: null, tokens: 412_118 },
  r2: { usd: null, tokens: 0 },
  r3: { usd: '0.418200', tokens: 61_840 },
  r4: { usd: '2.752000', tokens: 1_204_500 },
  r5: { usd: '1.120000', tokens: 220_310 },
  r6: { usd: '0.210000', tokens: 30_200 },
  r7: { usd: '5.400000', tokens: 2_310_400 },
};

const summary = ([id, status, owner, title, started, ended]: Row) => ({
  id,
  status,
  agent: owner,
  // The release notes are the docs site's; the rest are Payments' work.
  task: { id: `t-${id}`, title, projectId: id === 'r2' ? 'p2' : 'p1' },
  seat: started === null ? null : laptop,
  startedBy: byPerson,
  startedAt: started === null ? null : ago(started),
  endedAt: ended === null ? null : ago(ended),
  errorCode: status === 'failed' ? 'max_turns' : null,
  createdAt: ago((started ?? 1) + 1),
});

export const runList = {
  runs: rows.map((row) => ({ ...summary(row), cost: cost[row[0]] })),
  nextBefore: null,
};

const limits = { maxMinutes: 60, maxTurns: 50, maxTokens: 2_000_000 };
const detail = (id: string, extra: object = {}) => {
  const row = rows.find(([rowId]) => rowId === id);
  if (!row) throw new Error(id);
  return {
    ...summary(row),
    limits,
    cancelRequestedAt: null,
    summary: null,
    artifacts: [],
    cost: { rows: [], totalUsd: null, unpriced: false },
    ...extra,
  };
};

let seq = 0;
const event = (type: string, fields: object) => ({ seq: seq++, type, at: ago(10), ...fields });
const usage = (messageId: string, tokensIn: number, tokensOut: number, tokensCacheRead: number) =>
  event('usage', {
    model: 'claude-sonnet-5',
    tokensIn,
    tokensOut,
    tokensCacheRead,
    tokensCacheWrite: 0,
    messageId,
  });

/** The first events of every run; each run's events start their seq at 0 (`fresh`). */
function opening() {
  return [
    event('started', { model: 'claude-sonnet-5', cliVersion: '2.1.90' }),
    // Where Claude Code 2.1 reports it, before the first answer.
    event('unknown', {
      rawType: 'rate_limit_event',
      raw: { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } },
    }),
    event('assistant_message', {
      text: 'I’ll start by reproducing the failure. The retry test in `settlement/retry.test.ts` fails about one run in five, so I’ll run it in a loop first.',
    }),
    event('tool_use', {
      id: 'toolu_1',
      name: 'Bash',
      input: {
        command: 'pnpm vitest run settlement/retry.test.ts --repeat 20',
        description: 'Run the test 20 times',
      },
    }),
    event('tool_result', {
      toolUseId: 'toolu_1',
      isError: true,
      output:
        ' FAIL  settlement/retry.test.ts > retries a failed export\nAssertionError: expected 2 to be 3\n ❯ settlement/retry.test.ts:41:23\n\n Test Files  1 failed (1)\n      Tests  4 failed | 16 passed (20)',
    }),
    usage('msg_1', 2104, 138, 9200),
    event('assistant_message', {
      text: 'It fails when the clock moves between two reads. The test uses `Date.now()` for both the deadline and the check:\n\n1. `scheduleRetry` reads the clock once for the deadline.\n2. The assertion reads it again, a few milliseconds later.\n\nI’ll freeze time in the test instead of widening the tolerance.',
    }),
    event('tool_use', {
      id: 'toolu_2',
      name: 'Read',
      input: { file_path: 'settlement/retry.test.ts' },
    }),
    event('tool_result', {
      toolUseId: 'toolu_2',
      isError: false,
      output:
        "     1\timport { describe, expect, it } from 'vitest';\n     2\timport { scheduleRetry } from './retry';\n     3\t\n     4\tdescribe('scheduleRetry', () => {",
    }),
    usage('msg_2', 2461, 74, 11_304),
  ];
}

// The agent's plan as it keeps it with TodoWrite: the run page shows it above the transcript.
const todos = (current: number) => ({
  todos: [
    ['Read the flaky test and its history', 'Reading the flaky test'],
    // As long as an agent's own words get: the dashboard line cuts it, never the page.
    [
      'Freeze time in the retry test',
      'Freezing time in the retry test and checking each of the twenty runs for the same failure',
    ],
    ['Run the suite 20 times', 'Running the suite 20 times'],
    ['Open a pull request', 'Opening a pull request'],
  ].map(([content, activeForm], index) => ({
    content,
    activeForm,
    status: index < current ? 'completed' : index === current ? 'in_progress' : 'pending',
  })),
});

const fresh = () => {
  seq = 0;
  return [];
};

const runningEvents = () => [
  ...fresh(),
  event('tool_use', { id: 'plan_0', name: 'TodoWrite', input: todos(0) }),
  event('tool_result', { toolUseId: 'plan_0', isError: false, output: 'ok' }),
  ...opening(),
  event('tool_use', { id: 'plan_1', name: 'TodoWrite', input: todos(1) }),
  event('tool_result', { toolUseId: 'plan_1', isError: false, output: 'ok' }),
  event('tool_use', {
    id: 'toolu_3',
    name: 'Edit',
    input: { file_path: 'settlement/retry.test.ts', old_string: 'it(', new_string: 'it(' },
  }),
];

const answer =
  'Fixed the flaky test. `retry.test.ts` now freezes time with `vi.useFakeTimers()`, so the deadline and the check read the same clock.\n\n- 20 runs in a row pass\n- No change to `scheduleRetry` itself';

const doneEvents = () => {
  const events = [...fresh(), ...opening()];
  return [
    ...events,
    event('tool_use', {
      id: 'toolu_3',
      name: 'Bash',
      input: { command: 'git commit -am "Freeze time in the retry test"' },
    }),
    event('tool_result', {
      toolUseId: 'toolu_3',
      isError: false,
      output:
        '[agent/readme 4f2a9c1] Freeze time in the retry test\n 1 file changed, 6 insertions(+), 2 deletions(-)',
    }),
    // Through the gateway, held for the owner: its decision shows under it.
    event('tool_use', {
      id: 'toolu_4',
      name: 'mcp__agentome__code_host_open_change_request',
      input: { branch: 'agent/retry-clock', title: 'Freeze time in the retry test' },
    }),
    event('tool_result', {
      toolUseId: 'toolu_4',
      isError: false,
      output: '{ "number": 42, "url": "https://github.com/acme/payments-api/pull/42" }',
    }),
    event('assistant_message', { text: answer }),
    usage('msg_3', 2890, 212, 12_480),
    event('result', { text: answer, isError: false }),
  ];
};

const failedEvents = () => [
  ...fresh(),
  ...opening(),
  event('error', {
    code: 'max_turns',
    message: 'The run reached its limit of 50 turns.',
    fatal: true,
  }),
];

/** An SSE body: the events, then the status, as the server sends them. */
export const sse = (events: object[], status: string) => ({
  sse:
    events.map((item) => `event: run\ndata: ${JSON.stringify(item)}\n\n`).join('') +
    `event: status\ndata: ${JSON.stringify({ status })}\n\n`,
});

const doneCost = {
  rows: [
    {
      model: 'claude-haiku-4-5',
      tokensIn: 3_120,
      tokensOut: 410,
      tokensCacheRead: 0,
      tokensCacheWrite: 0,
      usd: '0.005170',
    },
    {
      model: 'claude-sonnet-5',
      tokensIn: 7_455,
      tokensOut: 424,
      tokensCacheRead: 32_984,
      tokensCacheWrite: 17_447,
      usd: '0.413030',
    },
  ],
  totalUsd: '0.418200',
  unpriced: false,
};

// The first live runs, as recorded for the unit tests: a commit with a heredoc message
// and commits kept nowhere, and an answer that quotes a code block.
type Recorded = { run: { id: string; status: string; task: { title: string } }; events: object[] };
const recorded = (name: string): Recorded =>
  JSON.parse(readFileSync(new URL(`../src/runs/fixtures/${name}.json`, import.meta.url), 'utf8'));
export const liveRuns = {
  changelog: recorded('run-ee2e51b8'),
  instructions: recorded('run-c6fb25fe'),
};

export const runRoutes: Record<string, unknown> = {
  ...Object.fromEntries(
    Object.values(liveRuns).flatMap(({ run, events }) => [
      [`GET /api/runs/${run.id}`, run],
      [`GET /api/runs/${run.id}/stream`, sse(events, run.status)],
    ]),
  ),
  'GET /api/runs': runList,
  'GET /api/runs/r1': detail('r1'),
  'GET /api/runs/r1/stream': sse(runningEvents(), 'running'),
  // The dashboard reads a running run's plan from its events.
  'GET /api/runs/r1/events': { events: runningEvents(), nextAfter: null },
  // Approvals reads the plan of the run behind each request: one has a plan, one has none.
  'GET /api/runs/r-k2/events': { events: runningEvents(), nextAfter: null },
  'GET /api/runs/r-k3/events': { events: [], nextAfter: null },
  'GET /api/runs/r3': detail('r3', {
    summary: 'Fixed the flaky test.',
    toolCalls: [
      {
        tool: 'code_host_open_change_request',
        decision: 'approved',
        reason: null,
        decidedBy: { id: 'u1', name: 'Ann Admin' },
        createdAt: ago(10),
      },
    ],
    artifacts: [
      {
        id: 'x1',
        kind: 'branch',
        ref: 'agentome/r3',
        meta: {
          commits: [
            { sha: '4f2a9c1d8e', subject: 'Freeze time in the retry test' },
            { sha: '9b1e07aa52', subject: 'Explain the frozen clock in a comment' },
          ],
          pushedTo: 'https://stand.example.com/git/acme/payments-api.git',
        },
      },
      {
        id: 'x3',
        kind: 'change_request',
        ref: 'https://git.example.com/acme/payments-api/-/merge_requests/307',
        meta: { state: 'draft', pipeline: 'success' },
      },
      { id: 'x2', kind: 'report', ref: 'result', meta: { text: answer } },
    ],
    cost: doneCost,
  }),
  'GET /api/runs/r3/stream': sse(doneEvents(), 'done'),
  'GET /api/runs/r4': detail('r4', {
    cost: {
      rows: [
        {
          model: 'claude-sonnet-5',
          tokensIn: 98_200,
          tokensOut: 21_400,
          tokensCacheRead: 1_048_000,
          tokensCacheWrite: 36_900,
          usd: '2.752000',
        },
      ],
      totalUsd: '2.752000',
      unpriced: false,
    },
  }),
  'GET /api/runs/r4/stream': sse(failedEvents(), 'failed'),
};
