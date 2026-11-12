import { render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../app';
import { admin, mockApi } from '../test-api';

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const run = (id: string, status: string, task: string | null, started: number | null) => ({
  id,
  status,
  agent: { id: 'a1', name: 'Payments backend' },
  task: task && { id: `t-${id}`, title: task, projectId: 'p1' },
  seat:
    started === null
      ? null
      : { id: 's1', name: 'maria-mbp', owner: { id: 'u2', name: 'Maria Garcia' } },
  startedBy: { kind: 'user', user: { id: 'u1', name: 'Ann Admin' } },
  startedAt: started === null ? null : ago(started),
  endedAt: null,
  errorCode: null,
  createdAt: ago((started ?? 0) + 1),
  cost: { usd: null, tokens: 0 },
});
const ended = (id: string, status: string, minutesAgo: number) => ({
  ...run(id, status, 'Older work', minutesAgo + 10),
  endedAt: ago(minutesAgo),
  cost: { usd: '0.40', tokens: 1000 },
});
const list = (runs: object[]) => ({ runs, nextBefore: null });
const planCall = (seq: number, name: string, input: object) => ({
  seq,
  at: ago(5),
  type: 'tool_use',
  id: `c${seq}`,
  name,
  input,
});

/** `cut`: the statuses whose list is a full page with more behind it. */
function renderDashboard(lists: Record<string, object[]>, cut: string[] = []) {
  const routes = Object.fromEntries(
    ['waiting_approval', 'running', 'queued', 'done', 'failed'].map((status) => [
      `GET /api/runs?status=${status}&limit=100`,
      { ...list(lists[status] ?? []), nextBefore: cut.includes(status) ? ago(600) : null },
    ]),
  );
  mockApi({
    'GET /api/me': admin,
    'GET /api/agents': {
      agents: [
        {
          id: 'a1',
          name: 'Payments backend',
          roleTitle: 'Backend engineer',
          status: 'active',
          owner: { id: 'u1', name: 'Ann Admin' },
          lastRun: { status: 'done', at: ago(90) },
          createdAt: '2026-10-12T09:00:00Z',
          modelPref: 'claude-opus-5-5',
          week: {
            runs: 9,
            usd: '48.1',
            ended: 8,
            done: 6,
            medianSeconds: 3840,
            daily: [1, 0, 2, 1, 1, 3, 1],
          },
        },
        {
          id: 'a2',
          name: 'Code reviewer',
          roleTitle: 'Code reviewer',
          status: 'active',
          owner: { id: 'u1', name: 'Ann Admin' },
          lastRun: null,
          createdAt: '2026-10-12T09:00:00Z',
          modelPref: null,
          week: {
            runs: 0,
            usd: null,
            ended: 0,
            done: 0,
            medianSeconds: null,
            daily: [0, 0, 0, 0, 0, 0, 0],
          },
        },
      ],
    },
    'GET /api/projects': {
      projects: [
        {
          id: 'p1',
          name: 'Payments',
          agentCount: 2,
          connectionCount: 1,
          createdAt: '2026-10-12T09:00:00Z',
          team: { id: 'tm1', name: 'Payments team' },
          week: {
            runs: 9,
            usd: '48.1',
            ended: 8,
            done: 6,
            medianSeconds: 3840,
            daily: [1, 0, 2, 1, 1, 3, 1],
          },
          lastRun: {
            id: 'r9',
            status: 'done',
            at: ago(90),
            agent: { id: 'a1', name: 'Payments backend' },
            task: { id: 't9', title: 'Bump the SDK' },
          },
        },
        {
          id: 'p2',
          name: 'Billing',
          agentCount: 1,
          connectionCount: 0,
          createdAt: '2026-10-12T09:00:00Z',
          team: null,
          week: {
            runs: 0,
            usd: null,
            ended: 0,
            done: 0,
            medianSeconds: null,
            daily: [0, 0, 0, 0, 0, 0, 0],
          },
          lastRun: null,
        },
      ],
    },
    'GET /api/seats': [
      {
        id: 's1',
        name: 'maria-mbp',
        owner: { id: 'u2', name: 'Maria Garcia' },
        kind: 'subscription-laptop',
        status: 'active',
        lastSeenAt: ago(0),
        idleMinutes: 15,
        updateCommand: null,
        signedOut: [],
        platform: null,
        sandbox: { none: false, allowedAt: null },
        activeRun: { id: 'r1', agentName: 'Payments backend', startedAt: ago(12) },
      },
      {
        id: 's2',
        name: 'mini',
        owner: { id: 'u1', name: 'Ann Admin' },
        kind: 'subscription-laptop',
        status: 'active',
        lastSeenAt: ago(0),
        idleMinutes: 15,
        updateCommand: null,
        signedOut: [],
        platform: null,
        sandbox: { none: false, allowedAt: null },
        activeRun: null,
      },
    ],
    'GET /api/approvals': {
      approvals: [
        {
          id: 'tc1',
          tool: 'jira_add_comment',
          input: { body: 'Analysis done.' },
          runId: 'r0',
          agent: { id: 'a1', name: 'Payments backend' },
          task: { id: 't-r0', title: 'Fix the retry', repository: null },
          createdAt: ago(2),
        },
      ],
    },
    'GET /api/tasks?status=review&limit=20': {
      tasks: [
        {
          id: 't7',
          title: 'Bump the Stripe SDK',
          agent: { id: 'a1', name: 'Payments backend' },
          status: 'review',
          source: 'manual',
          repository: null,
          repositoryFromProject: false,
          createdBy: { id: 'u1', name: 'Ann Admin' },
          createdAt: ago(60),
          latestRun: { id: 'r7', status: 'done', at: ago(25) },
          changeRequest: {
            url: 'https://gitlab.example.com/acme/api/-/merge_requests/304',
            state: 'draft',
            pipeline: 'success',
          },
          project: null,
        },
      ],
      nextBefore: null,
    },
    // The running run's plan: three steps, the first done, the second in progress.
    'GET /api/runs/r1/events?after=-1': {
      events: [
        planCall(0, 'TaskCreate', { subject: 'Read the repository', activeForm: 'Reading it' }),
        planCall(1, 'TaskCreate', {
          subject: 'Write the README',
          activeForm: 'Writing the README',
        }),
        planCall(2, 'TaskCreate', { subject: 'Open a pull request', activeForm: 'Opening it' }),
        planCall(3, 'TaskUpdate', { taskId: '1', status: 'completed' }),
        planCall(4, 'TaskUpdate', { taskId: '2', status: 'in_progress' }),
      ],
      nextAfter: null,
    },
    ...routes,
  });
  render(<RouterProvider router={createMemoryRouter([{ path: '*', element: <App /> }])} />);
}

describe('the dashboard', () => {
  it('lists a task that failed again and again today once, and not once run again', async () => {
    const sinceMidnight = (Date.now() - new Date().setHours(0, 0, 0, 0)) / 60_000;
    const of = (task: string, failure: ReturnType<typeof ended>) => ({
      ...failure,
      task: { id: task, title: task },
    });
    renderDashboard({
      failed: [
        of('PAY-165', ended('f1', 'failed', sinceMidnight / 4)),
        of('PAY-165', ended('f2', 'failed', sinceMidnight / 3)),
        of('PAY-165', ended('f3', 'failed', sinceMidnight / 2)),
        of('PAY-170', ended('f4', 'failed', sinceMidnight / 2)),
      ],
      // PAY-170 runs again: its new run says how it goes.
      queued: [
        { ...run('q1', 'queued', 'PAY-170', null), task: { id: 'PAY-170', title: 'PAY-170' } },
      ],
    });
    const failed = within(await screen.findByRole('region', { name: /^Failed today/ }));
    expect(failed.getAllByRole('button', { name: 'Run again' })).toHaveLength(1);
    expect(failed.getByRole('link', { name: 'PAY-165' }).getAttribute('href')).toBe('/runs/f1');
    expect(failed.getByText(/failed 3 times today$/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /^Failed today/ }).textContent).toBe(
      'Failed today14 runs',
    );
  });

  it('shows the runs going now, each opening its run, and what finished today', async () => {
    // Today's runs end halfway since midnight, which is today even a second after it; the
    // other ended an hour before midnight.
    const sinceMidnight = (Date.now() - new Date().setHours(0, 0, 0, 0)) / 60_000;
    renderDashboard({
      running: [run('r1', 'running', 'Add a README', 12)],
      queued: [run('r2', 'queued', null, null)],
      done: [ended('r3', 'done', sinceMidnight / 2), ended('r4', 'done', sinceMidnight + 60)],
      failed: [ended('r5', 'failed', sinceMidnight / 2)],
    });
    // The project at work as a card: its state, team, week, and which agent works on what.
    const card = within(await screen.findByRole('article', { name: 'Payments' }));
    await card.findByText('1 of 3 done');
    expect(card.getByText('Running')).toBeTruthy();
    expect(card.getByText('Payments team · 2 agents')).toBeTruthy();
    expect(
      within(card.getByRole('list', { name: 'At work on Payments' })).getByText('Payments backend'),
    ).toBeTruthy();
    expect(
      card.getByRole('img', { name: 'Runs a day this week: 1, 0, 2, 1, 1, 3, 1' }),
    ).toBeTruthy();
    expect(card.getByText('75%')).toBeTruthy();
    expect(card.getByText('1 h 04 min')).toBeTruthy();
    expect(card.getByText('$48.10')).toBeTruthy();
    expect(card.getByRole('link', { name: 'Add a README' }).getAttribute('href')).toBe('/runs/r1');
    // A project that did not run this week has no card; a run outside every project has its own.
    expect(screen.queryByRole('article', { name: 'Billing' })).toBeNull();
    const outside = within(screen.getByRole('article', { name: 'Outside projects' }));
    expect(outside.getByText('Queued')).toBeTruthy();
    expect(screen.getByText('1 of 2 ran this week')).toBeTruthy();
    // What waits for the person is decided here, each call naming its task.
    const waiting = within(screen.getByRole('region', { name: 'Waiting for you' }));
    expect(waiting.getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(waiting.getByRole('link', { name: 'Fix the retry' }).getAttribute('href')).toBe(
      '/tasks/t-r0',
    );
    // Work handed over: its merge request and CI, and what the person can do with it.
    const review = within(screen.getByRole('region', { name: /^Ready for your review/ }));
    expect(review.getByText('Payments backend finished 25 min ago')).toBeTruthy();
    expect(review.getByRole('link', { name: 'MR !304' }).getAttribute('href')).toBe(
      'https://gitlab.example.com/acme/api/-/merge_requests/304',
    );
    expect(review.getByText('CI passed')).toBeTruthy();
    expect(review.getByRole('button', { name: 'Mark done' })).toBeTruthy();
    // Today's failure, with what to do about it.
    const failed = within(screen.getByRole('region', { name: /^Failed today/ }));
    expect(failed.getByText('The run failed; its transcript says where.')).toBeTruthy();
    expect(failed.getByRole('button', { name: 'Run again' })).toBeTruthy();
    // The day in numbers: one run of yesterday's is not today's; the week's cost of the agents.
    const done = screen.getByRole('link', { name: /^Done today/ });
    expect(done.textContent).toBe('Done today11 yesterday');
    expect(done.getAttribute('href')).toBe('/runs?status=done');
    expect(screen.getByRole('link', { name: /^Failed today/ }).textContent).toContain('1');
    expect(screen.getByRole('link', { name: /^This week/ }).textContent).toBe(
      'This week$48.10at API prices',
    );
    // Lately: every run, newest first, said in words.
    const activity = within(screen.getByRole('region', { name: 'Recent activity' }));
    const items = activity.getAllByRole('listitem').map((item) => item.textContent);
    expect(items.length).toBe(5);
    expect(items.some((text) => text?.startsWith('Run stopped'))).toBe(true);
    // Whose computers can take a run.
    expect(
      screen.getByRole('link', { name: 'Online: Maria Garcia, Ann Admin' }).getAttribute('href'),
    ).toBe('/admin/computers');
  });

  it('shows a count as a floor when the page of runs it counts from is full', async () => {
    const sinceMidnight = (Date.now() - new Date().setHours(0, 0, 0, 0)) / 60_000;
    const today = (id: string) => ended(id, 'done', sinceMidnight / 2);
    // A full page, all of it done today: there are more than these, and yesterday is beyond it.
    renderDashboard({ done: [today('r1'), today('r2'), today('r3')] }, ['done']);
    const tile = (await screen.findByText('Done today')).closest('a');
    expect(tile?.textContent).toBe('Done today3+latest 3 counted');
  });

  it('counts exactly when the full page reaches back past the stretch', async () => {
    const sinceMidnight = (Date.now() - new Date().setHours(0, 0, 0, 0)) / 60_000;
    renderDashboard(
      {
        done: [
          ended('r1', 'done', sinceMidnight / 2),
          ended('r2', 'done', sinceMidnight + 60),
          ended('r3', 'done', sinceMidnight + 60 * 30),
        ],
      },
      ['done'],
    );
    const tile = (await screen.findByText('Done today')).closest('a');
    expect(tile?.textContent).toBe('Done today11 yesterday');
  });

  it('says so when nothing is going and nothing finished today', async () => {
    renderDashboard({});
    // The call and the task in review still wait; the agent that ran this week rests.
    expect(await screen.findByText('No agent at work, 2 things wait for you.')).toBeTruthy();
    const card = within(screen.getByRole('article', { name: 'Payments' }));
    expect(card.getByText('Idle')).toBeTruthy();
    expect(card.getByText(/^Last:/).textContent).toBe(
      'Last: Payments backend Bump the SDK, done 1 h ago',
    );
    expect(screen.getByText('No runs yet.')).toBeTruthy();
  });
});
