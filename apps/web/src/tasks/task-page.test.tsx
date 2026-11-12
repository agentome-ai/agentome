import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../app';
import { admin, answer, failure, mockApi } from '../test-api';
import type { Task, TaskRun } from './tasks-data';

const run = (id: string, status: TaskRun['status'], extra: Partial<TaskRun> = {}): TaskRun => ({
  id,
  status,
  startedAt: '2026-10-21T09:00:00Z',
  endedAt: '2026-10-21T09:14:00Z',
  errorCode: null,
  seat: { name: 'maria-mbp' },
  createdAt: '2026-10-21T08:59:00Z',
  usd: null,
  summary: null,
  ...extra,
});
const task: Task = {
  id: 'k1',
  title: 'Add a README',
  agent: { id: 'a1', name: 'Payments backend', status: 'active' },
  status: 'open',
  source: 'manual',
  repository: '~/code/test-repo',
  createdBy: { id: 'u1', name: 'Ann Admin' },
  createdAt: '2026-10-21T08:58:00Z',
  latestRun: null,
  changeRequest: null,
  repositoryFromProject: false,
  project: null,
  body: '## Done when\n\nThe README explains **setup**.',
  externalError: null,
  parent: null,
  subtasks: [],
  comments: [],
  runs: [
    run('r2', 'failed', { errorCode: 'max_turns' }),
    run('r1', 'cancelled', { startedAt: null, endedAt: '2026-10-21T08:30:00Z', seat: null }),
  ],
  changeRequests: [
    {
      url: 'https://github.com/acme/api/pull/7',
      runId: 'r2',
      state: 'merged',
      pipeline: 'failed',
      review: null,
      createdAt: '2026-10-21T09:10:00Z',
    },
  ],
  questions: [],
};
const url = '/api/tasks/k1';

function renderTask(routes: Parameters<typeof mockApi>[0]) {
  const calls = mockApi({ 'GET /api/me': admin, ...routes });
  const router = createMemoryRouter([{ path: '*', element: <App /> }], {
    initialEntries: ['/tasks/k1'],
  });
  render(<RouterProvider router={router} />);
  return { calls, user: userEvent.setup() };
}

describe('a task', () => {
  it("works in its project's repository, or in a folder of the person's in its place", async () => {
    const inProject = {
      ...task,
      repository: 'https://gitlab.acme.com/web/app',
      repositoryFromProject: true,
      project: { id: 'p1', name: 'ELM' },
    };
    const { calls, user } = renderTask({
      [`GET ${url}`]: inProject,
      'GET /api/projects/p1': { id: 'p1', repositories: ['https://gitlab.acme.com/web/app'] },
      'GET /api/tasks/folders': { folders: ['~/code/elm'] },
      [`PATCH ${url}`]: { ...inProject, repository: '~/code/elm', repositoryFromProject: false },
    });
    expect(await screen.findByText('https://gitlab.acme.com/web/app')).toBeTruthy();
    expect(screen.getByText(/The main repository of/)).toBeTruthy();
    const links = screen.getAllByRole('link', { name: 'ELM' });
    expect(links.at(-1)?.getAttribute('href')).toBe('/projects/p1');
    await user.click(screen.getByRole('button', { name: 'Change' }));
    await user.click(await screen.findByRole('option', { name: '~/code/elm' }));
    expect(calls.find((call) => call.route === `PATCH ${url}`)?.body).toEqual({
      repository: '~/code/elm',
    });
    expect(await screen.findByText(/A folder on the computer that runs the task/)).toBeTruthy();
  });

  it('changes the repository of a task outside a project to a path typed in', async () => {
    const { calls, user } = renderTask({
      [`GET ${url}`]: task,
      [`PATCH ${url}`]: { ...task, repository: '/Users/ann/code/app' },
    });
    await user.click(await screen.findByRole('button', { name: 'Change' }));
    const search = screen.getByRole('combobox', { name: 'Folder path or repository URL' });
    await user.clear(search);
    await user.type(search, '/Users/ann/code/app');
    await user.keyboard('{Enter}');
    expect(calls.find((call) => call.route === `PATCH ${url}`)?.body).toEqual({
      repository: '/Users/ann/code/app',
    });
  });

  it('reads as its run while one goes', async () => {
    renderTask({
      [`GET ${url}`]: {
        ...task,
        latestRun: { id: 'r3', status: 'waiting_approval', at: '2026-10-21T09:00:00Z' },
        runs: [run('r3', 'waiting_approval', { endedAt: null })],
      },
    });
    const facts = within(await screen.findByRole('complementary', { name: 'About this task' }));
    expect(facts.getByText('Waiting for you')).toBeTruthy();
    expect(facts.queryByText('Open')).toBeNull();
  });

  it('shows its changes: a branch with its size and commits, a change request as its host has it', async () => {
    const { user } = renderTask({
      [`GET ${url}`]: task,
      'GET /api/tasks/k1/changes': {
        branches: [
          {
            name: 'agent/readme',
            commits: [
              { sha: 'b2c3d4e5f6', subject: 'Say how to run it' },
              { sha: 'a1b2c3d4e5', subject: 'Add a README' },
            ],
            additions: 13,
            deletions: 2,
            files: 2,
            url: 'https://github.com/acme/api/compare/main...agent/readme',
          },
        ],
        changeRequests: [
          {
            url: 'https://github.com/acme/api/pull/7',
            number: 7,
            title: 'Add a README',
            state: 'open',
            pipeline: 'failed',
          },
        ],
        problem: null,
      },
    });
    const changes = within(await screen.findByRole('region', { name: 'Changes' }));
    expect(await changes.findByText('+13')).toBeTruthy();
    expect(changes.getByText('−2')).toBeTruthy();
    expect(changes.getByText('2 files')).toBeTruthy();
    // The change request first, the whole card its link, its CI in words and colour.
    const request = changes.getByRole('link', { name: /^Add a README/ });
    expect(request.getAttribute('href')).toBe('https://github.com/acme/api/pull/7');
    expect(within(request).getByText('api #7')).toBeTruthy();
    expect(within(request).getByText('CI failed')).toBeTruthy();
    // The branch opens on its commits and a way to the host.
    await user.click(changes.getByRole('button', { name: /^agent\/readme/ }));
    expect(changes.getByText('b2c3d4e')).toBeTruthy();
    expect(changes.getByText('Say how to run it')).toBeTruthy();
    expect(
      changes.getByRole('link', { name: 'Compare on the code host' }).getAttribute('href'),
    ).toBe('https://github.com/acme/api/compare/main...agent/readme');
  });

  it("answers its agent's question in place: an offered answer, then Send answer", async () => {
    const question = {
      id: 'q1',
      tool: 'ask_owner',
      input: { question: 'How small may the number be?', options: ['80%', '90%'] },
      runId: 'r3',
      agent: { id: 'a1', name: 'Payments backend' },
      task: { id: 'k1', title: 'Add a README', repository: null },
      createdAt: '2026-10-21T09:00:00Z',
    };
    const { calls, user } = renderTask({
      [`GET ${url}`]: task,
      'GET /api/approvals': { approvals: [question] },
      'POST /api/tool-calls/q1/answer': answer(200, {}),
    });
    const here = within(await screen.findByRole('region', { name: 'Waiting for you' }));
    expect(here.getByText('How small may the number be?')).toBeTruthy();
    expect(here.queryByRole('button', { name: 'Approve' })).toBeNull();
    await user.click(here.getByRole('button', { name: '90%' }));
    await user.type(here.getByRole('textbox', { name: 'Your answer' }), ', never less');
    await user.click(here.getByRole('button', { name: 'Send answer' }));
    expect(calls.find((call) => call.route === 'POST /api/tool-calls/q1/answer')?.body).toEqual({
      answer: '90%, never less',
    });
  });

  it("approves and denies its run's waiting steps in place, without a trip to Approvals", async () => {
    const waiting = (id: string, title: string) => ({
      id,
      tool: 'jira__Jira_mcp-jira_add_comment',
      input: { issue_key: 'PAY-164', comment: title },
      runId: 'r3',
      agent: { id: 'a1', name: 'Payments backend' },
      task: { id: 'k1', title: 'Add a README', repository: null },
      createdAt: '2026-10-21T09:00:00Z',
    });
    const other = {
      ...waiting('c9', 'Elsewhere'),
      task: { id: 'k9', title: 'Other', repository: null },
    };
    const { calls, user } = renderTask({
      [`GET ${url}`]: task,
      'GET /api/approvals': { approvals: [waiting('c1', 'First'), waiting('c2', 'Second'), other] },
      'POST /api/tool-calls/c1/approve': answer(200, {}),
      'POST /api/tool-calls/c2/deny': answer(200, {}),
    });
    const here = within(await screen.findByRole('region', { name: '2 steps wait for you' }));
    expect(here.getAllByRole('listitem')).toHaveLength(2);
    await user.click(here.getAllByRole('button', { name: 'Approve' })[0] as HTMLElement);
    expect(calls.some((call) => call.route === 'POST /api/tool-calls/c1/approve')).toBe(true);
    await user.click(here.getAllByRole('button', { name: 'Deny' })[1] as HTMLElement);
    const dialog = screen.getByRole('dialog', { name: 'Deny this request?' });
    await user.type(within(dialog).getByLabelText('Reason (optional)'), 'Not yet');
    await user.click(within(dialog).getByRole('button', { name: 'Deny' }));
    expect(calls.find((call) => call.route === 'POST /api/tool-calls/c2/deny')?.body).toEqual({
      reason: 'Not yet',
    });
  });

  it('shows what it asks for, where, and its life, each run opening its run page', async () => {
    const asked = {
      id: 'q1',
      runId: 'r2',
      question: 'How long may the README be?',
      answer: 'Under 80 lines',
      state: 'answered' as const,
      askedAt: '2026-10-21T09:05:00Z',
      answeredAt: '2026-10-21T09:06:00Z',
      answeredBy: 'Ann Admin',
    };
    renderTask({ [`GET ${url}`]: { ...task, questions: [asked] } });
    expect(await screen.findByRole('heading', { level: 1, name: 'Add a README' })).toBeTruthy();
    const about = within(screen.getByRole('complementary', { name: 'About this task' }));
    expect(about.getByRole('link', { name: 'Payments backend' }).getAttribute('href')).toBe(
      '/agents/a1',
    );
    // A narrow screen has the same as Linear's chips under the title.
    const chips = within(screen.getByRole('group', { name: 'About this task' }));
    expect(chips.getByRole('link', { name: 'Payments backend' })).toBeTruthy();
    expect(chips.getByRole('button', { name: 'Works in: ~/code/test-repo. Change' })).toBeTruthy();
    expect(about.getByText('~/code/test-repo').tagName).toBe('CODE');
    expect(screen.getByRole('heading', { level: 2, name: 'Changes' })).toBeTruthy();
    const request = screen.getByRole('link', { name: /^api #7/ });
    expect(request.getAttribute('href')).toBe('https://github.com/acme/api/pull/7');
    expect(within(request).getByText('Merged')).toBeTruthy();
    expect(within(request).getByText('CI failed')).toBeTruthy();
    expect(await screen.findByRole('heading', { level: 2, name: 'Done when' })).toBeTruthy();
    // The task's life by stages, oldest first: made, a run cancelled while queued, a run stopped,
    // with the question asked in it and the change request it opened folded under it.
    const activity = within(screen.getByRole('region', { name: 'Activity' }));
    expect(activity.getByText('2 runs')).toBeTruthy();
    const items = activity.getAllByRole('listitem').map((item) => item.textContent ?? '');
    expect(items).toEqual([
      expect.stringMatching(/^Ann Admin created the task · /),
      expect.stringMatching(/^Payments backend was to run it · cancelled while queued · /),
      expect.stringMatching(/^Payments backend ran it · stopped by turn limit after 14 min · /),
    ]);
    expect(items[2]).not.toContain('How long may the README be?');
    const fold = activity.getByRole('button', { name: '1 question · PR #7' });
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(fold);
    const stage = activity.getAllByRole('listitem')[2]?.textContent ?? '';
    expect(stage).toContain('Payments backend asked you');
    expect(stage).toContain('How long may the README be?');
    expect(stage).toContain('Ann Admin: «Under 80 lines»');
    expect(stage).toContain('Opened PR #7');
    const opened = activity.getAllByRole('link', { name: 'Open the run' });
    expect(opened.map((link) => link.getAttribute('href'))).toEqual(['/runs/r1', '/runs/r2']);
    expect(screen.getByRole('button', { name: 'Run again' })).toHaveProperty('disabled', false);
  });

  it('says who assigned it, and lists what its agent assigned with their state', async () => {
    renderTask({
      [`GET ${url}`]: {
        ...task,
        parent: { id: 'k0', title: 'Ship refunds', agent: 'CEO' },
        subtasks: [
          {
            id: 'k2',
            title: 'Build the refund API',
            agent: 'Head of Engineering',
            status: 'review',
            runStatus: 'done',
          },
          {
            id: 'k3',
            title: 'Design the refund screen',
            agent: 'Head of Product',
            status: 'open',
            runStatus: 'running',
          },
        ],
      },
    });
    expect((await screen.findByRole('link', { name: 'Ship refunds' })).getAttribute('href')).toBe(
      '/tasks/k0',
    );
    expect(screen.getByText(/CEO assigned this as part of/)).toBeTruthy();
    const assigned = within(screen.getByRole('region', { name: 'Assigned' }));
    expect(assigned.getByRole('link', { name: 'Build the refund API' }).getAttribute('href')).toBe(
      '/tasks/k2',
    );
    expect(assigned.getByText('In review')).toBeTruthy();
    expect(assigned.getByText('Running')).toBeTruthy();
  });

  it('threads comments with runs and their reports, and comments with a run', async () => {
    const commented = {
      ...task,
      runs: [run('r2', 'done', { summary: 'Built the **refund** screen.' })],
      comments: [
        {
          id: 'c1',
          body: 'The padding is off on a phone.',
          runId: null,
          createdAt: '2026-10-21T09:20:00Z',
          author: { kind: 'person', id: 'u1', name: 'Ann Admin' },
        },
      ],
    };
    const { calls, user } = renderTask({
      [`GET ${url}`]: commented,
      [`POST ${url}/comments`]: answer(201, { id: 'c2', run: { id: 'r3', status: 'queued' } }),
    });
    const feed = within(await screen.findByRole('region', { name: 'Activity' }));
    expect(await feed.findByText('refund')).toBeTruthy();
    const items = feed.getAllByRole('listitem').map((item) => item.textContent ?? '');
    expect(items.findIndex((text) => text.includes('Built the'))).toBeLessThan(
      items.findIndex((text) => text.includes('The padding is off')),
    );
    const form = within(screen.getByRole('form', { name: 'Comment' }));
    await user.type(form.getByRole('textbox', { name: 'Comment' }), 'Fix the padding.');
    await user.click(form.getByRole('button', { name: 'Comment and run' }));
    expect(calls.find((call) => call.route === `POST ${url}/comments`)?.body).toEqual({
      body: 'Fix the padding.',
      run: true,
    });
  });

  it('on a phone, opens the comment as a sheet from its bar and closes it once sent', async () => {
    const { calls, user } = renderTask({
      [`GET ${url}`]: task,
      [`POST ${url}/comments`]: answer(201, { id: 'c2', run: null }),
    });
    await user.click(await screen.findByRole('button', { name: `Write to ${task.agent.name}` }));
    const sheet = within(screen.getByRole('dialog', { name: 'Comment' }));
    await user.type(sheet.getByRole('textbox', { name: 'Comment' }), 'Looks good.');
    await user.click(sheet.getByRole('button', { name: 'Comment' }));
    expect(calls.find((call) => call.route === `POST ${url}/comments`)?.body).toEqual({
      body: 'Looks good.',
      run: false,
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('says what Jira refused when the task reported back', async () => {
    const refused = 'Jira: Jira can move PAY-12 to "In Progress", not to "Done"';
    renderTask({ [`GET ${url}`]: { ...task, source: 'jira', externalError: refused } });
    expect((await screen.findByText('Jira')).tagName).toBe('DT');
    expect(screen.getByText(refused)).toBeTruthy();
  });

  it('runs again only when no run is going and the agent is active, and says why not', async () => {
    const going = { ...task, runs: [run('r3', 'running', { endedAt: null }), ...task.runs] };
    const { calls, user } = renderTask({
      [`GET ${url}`]: going,
      [`POST ${url}/run`]: failure(409, 'run_in_progress', 'A run of this task is in progress.'),
    });
    const button = await screen.findByRole('button', { name: 'Run again' });
    expect(button).toHaveProperty('disabled', true);
    expect(button.getAttribute('aria-describedby')).toBeTruthy();
    expect(
      document.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toBe('Available when the current run ends.');
    await user.click(button);
    expect(calls.map((call) => call.route)).not.toContain(`POST ${url}/run`);
  });

  it('tells an archived agent from a task without runs', async () => {
    renderTask({
      [`GET ${url}`]: { ...task, agent: { ...task.agent, status: 'archived' }, runs: [] },
    });
    const button = await screen.findByRole('button', { name: 'Run' });
    expect(button).toHaveProperty('disabled', true);
    expect(screen.getByText('Unarchive the agent to run this task.')).toBeTruthy();
    expect(
      within(screen.getByRole('region', { name: 'Activity' })).getByText('0 runs'),
    ).toBeTruthy();
  });

  it('queues another run and shows it', async () => {
    let runs = task.runs;
    const { calls, user } = renderTask({
      [`GET ${url}`]: () => ({ json: { ...task, runs } }),
      [`POST ${url}/run`]: () => {
        const now = new Date().toISOString();
        const queued = { startedAt: null, endedAt: null, seat: null, createdAt: now };
        runs = [run('r3', 'queued', queued), ...runs];
        return { status: 201, json: { id: 'r3', status: 'queued' } };
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Run again' }));
    const activity = within(screen.getByRole('region', { name: 'Activity' }));
    expect(await activity.findByText('3 runs')).toBeTruthy();
    expect(activity.getAllByRole('listitem').at(-1)?.textContent).toMatch(
      /^Payments backend will run it once a computer takes it/,
    );
    // The button is disabled now, so focus moves to the run it queued.
    expect(document.activeElement?.getAttribute('href')).toBe('/runs/r3');
    expect(screen.getByRole('button', { name: 'Run again' })).toHaveProperty('disabled', true);
    expect(calls.filter((call) => call.route === 'GET /api/agents').length).toBeGreaterThan(1);
  });

  it('is marked as done and reopened', async () => {
    const { calls, user } = renderTask({
      [`GET ${url}`]: task,
      [`PATCH ${url}`]: (body) => ({ json: { ...task, ...(body as object) } }),
    });
    await user.click(await screen.findByRole('button', { name: 'Mark as done' }));
    await user.click(await screen.findByRole('button', { name: 'Reopen' }));
    expect(await screen.findByRole('button', { name: 'Mark as done' })).toBeTruthy();
    expect(calls.filter((call) => call.route === `PATCH ${url}`).map((call) => call.body)).toEqual([
      { status: 'done' },
      { status: 'open' },
    ]);
  });

  it('changes its title and description where they are read', async () => {
    const { calls, user } = renderTask({
      [`GET ${url}`]: task,
      [`PATCH ${url}`]: (body) => ({ json: { ...task, ...(body as object) } }),
    });
    // A click on the text opens its field; Enter saves a title.
    await user.click(await screen.findByRole('heading', { name: 'Add a README' }));
    const title = screen.getByRole('textbox', { name: 'Title' });
    await user.clear(title);
    await user.type(title, 'Add a README and a licence{Enter}');
    expect(await screen.findByRole('heading', { name: 'Add a README and a licence' })).toBeTruthy();

    // Escape puts the text back and saves nothing.
    await user.click(screen.getByRole('button', { name: 'Edit description' }));
    await user.type(screen.getByRole('textbox', { name: 'Description' }), ' Never mind.');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: 'Description' })).toBeNull();

    // A description takes Enter as a new line and saves when focus leaves it.
    await user.click(screen.getByText(/explains/));
    const description = screen.getByRole('textbox', { name: 'Description' });
    expect(screen.getByText(/The next run reads this/)).toBeTruthy();
    await user.type(description, '{Enter}Also a licence.');
    await user.tab();
    expect(await screen.findAllByText(/Also a licence/)).not.toHaveLength(0);
    expect(screen.queryByRole('textbox', { name: 'Description' })).toBeNull();
    expect(calls.filter((call) => call.route === `PATCH ${url}`).map((call) => call.body)).toEqual([
      { title: 'Add a README and a licence' },
      { body: `${task.body}\nAlso a licence.` },
    ]);
  });

  it('keeps an empty title in its field and says why', async () => {
    const { calls, user } = renderTask({ [`GET ${url}`]: task });
    await user.click(await screen.findByRole('heading', { name: 'Add a README' }));
    await user.clear(screen.getByRole('textbox', { name: 'Title' }));
    await user.keyboard('{Enter}');
    expect(screen.getByRole('alert').textContent).toBe('A task needs a title.');
    expect(calls.some((call) => call.route === `PATCH ${url}`)).toBe(false);
  });

  it("says so when the task is someone else's", async () => {
    renderTask({ [`GET ${url}`]: answer(404, { error: { code: 'not_found', message: 'Gone' } }) });
    expect(
      await screen.findByRole('heading', {
        name: "This task doesn't exist or isn't shared with you",
      }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'All tasks' }).getAttribute('href')).toBe('/tasks');
  });
});
