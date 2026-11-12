import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../app';
import { admin, answer, failure, mockApi } from '../test-api';
import { repositoryProblem } from './tasks-data';

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const agentOf = (id: string, name: string) => ({
  id,
  name,
  roleTitle: 'Backend engineer',
  status: 'active',
  owner: { id: 'u1', name: 'Ann Admin' },
  lastRun: null,
  createdAt: '2026-10-12T09:00:00Z',
});
const agents = [agentOf('a1', 'Payments backend'), agentOf('a2', 'Checkout QA')];
const summary = (
  id: string,
  title: string,
  agent = agents[0],
  latestRun: object | null = null,
) => ({
  id,
  title,
  agent: { id: agent?.id, name: agent?.name },
  status: 'open',
  source: 'manual',
  repository: '~/code/test-repo',
  createdBy: { id: 'u1', name: 'Ann Admin' },
  createdAt: ago(90),
  latestRun,
});
const page = (tasks: object[], nextBefore: string | null = null) => ({ tasks, nextBefore });
/** A project as its page reads it: its agents, its team and its repositories, main first. */
const projectOf = (
  id: string,
  name: string,
  on: typeof agents,
  repositories: string[] = [],
  team: object | null = null,
) => ({
  id,
  name,
  agentCount: on.length,
  connectionCount: 1,
  createdBy: 'u1',
  createdAt: ago(9),
  team,
  intake: 'manual',
  repositories,
  agents: on.map(({ id: agentId, name: agentName, roleTitle, status }) => ({
    id: agentId,
    name: agentName,
    roleTitle,
    status,
  })),
});
const payments = projectOf('p1', 'Payments', agents, [
  'https://github.com/acme/payments',
  'https://github.com/acme/ledger',
]);
const onPayments = (agent: (typeof agents)[number]) => ({
  ...agent,
  projects: [{ id: 'p1', name: 'Payments', hosts: ['github'], repositories: [] }],
});

/** The Tasks page, where the person has two agents, both on the one project Payments. */
function renderTasks(routes: Parameters<typeof mockApi>[0], entry: string | object = '/tasks') {
  const calls = mockApi({
    'GET /api/me': admin,
    'GET /api/agents': { agents },
    'GET /api/teams': { teams: [] },
    'GET /api/projects': { projects: [payments] },
    'GET /api/projects/p1': payments,
    'GET /api/agents/a1': onPayments(agents[0]!),
    'GET /api/agents/a2': onPayments(agents[1]!),
    ...routes,
  });
  const router = createMemoryRouter([{ path: '*', element: <App /> }], {
    initialEntries: [entry],
  });
  render(<RouterProvider router={router} />);
  return { calls, router, user: userEvent.setup() };
}

describe('Tasks', () => {
  it('lists the tasks with their latest run, filters them and loads more', async () => {
    const { calls, router, user } = renderTasks({
      'GET /api/tasks?status=open': page(
        [
          summary('k1', 'Add a README', agents[0], { id: 'r1', status: 'running', at: ago(4) }),
          summary('k2', 'Fix the flaky test', agents[1]),
        ],
        '2026-10-21T08:00:00.123456Z',
      ),
      'GET /api/tasks?status=open&before=2026-10-21T08%3A00%3A00.123456Z': page([
        summary('k3', 'Older'),
      ]),
      'GET /api/tasks?status=done': page([]),
      'GET /api/tasks?agent=a2&status=done': page([]),
    });
    const table = within(await screen.findByRole('table'));
    const link = table.getByRole('link', { name: 'Add a README' });
    expect(link.getAttribute('href')).toBe('/tasks/k1');
    // The agent's tile leads a phone's row, and its name follows the status there after a dot. On
    // a phone the run's time is short: "4m" in place of "4 min ago".
    expect(link.closest('tr')?.textContent).toBe(
      'PBAdd a README·PBPayments backendRunning4 min ago4m1 h ago',
    );
    expect(
      table.getByRole('link', { name: 'Fix the flaky test' }).closest('tr')?.textContent,
    ).toContain('Never run');

    await user.click(screen.getByRole('button', { name: 'Load more' }));
    // The last page takes the button with it: focus moves to the first task it brought.
    expect(document.activeElement).toBe(await screen.findByRole('link', { name: 'Older' }));
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();

    await user.click(screen.getByRole('tab', { name: 'Done' }));
    expect(await screen.findByRole('heading', { name: 'No done tasks' })).toBeTruthy();
    await user.click(screen.getByRole('combobox', { name: 'Agent' }));
    await user.click(await screen.findByRole('option', { name: 'Checkout QA' }));
    expect(await screen.findByRole('heading', { name: 'No done tasks' })).toBeTruthy();
    expect(router.state.location.search).toBe('?status=done&agent=a2');
    expect(calls.map((call) => call.route)).toContain('GET /api/tasks?agent=a2&status=done');
  });

  it('opens on the open tasks, and says what to do when there are none', async () => {
    renderTasks({ 'GET /api/tasks?status=open': page([]) });
    expect(await screen.findByRole('heading', { name: 'No open tasks' })).toBeTruthy();
    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent);
    expect(tabs).toEqual(['Open', 'In review', 'Done', 'All']);
    expect(
      screen.getByText(
        'Give an agent something to do: create a task, then run it on a connected computer.',
      ),
    ).toBeTruthy();
  });
});

/** Opens New task from the page's button, once the dialog has the person's agents. */
async function openNewTask(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'New task' }));
  const dialog = screen.getByRole('dialog', { name: 'New task' });
  return { dialog, agent: await within(dialog).findByRole('combobox', { name: /^For/ }) };
}

/** The chip that names where the task works: a folder on the computer or a repository. */
const repositoryChip = (dialog: HTMLElement) =>
  within(dialog).getByRole('button', { name: /^Where it works/ });

/** Types a path or URL into the repository's menu and takes it with Enter. */
async function chooseRepository(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
  where: string,
) {
  await user.click(repositoryChip(dialog));
  await user.type(screen.getByRole('combobox', { name: 'Folder path or repository URL' }), where);
  await user.keyboard('{Enter}');
}

describe('New task', () => {
  it('opens for the agent whose Run brought the person here, and opens the run it queued', async () => {
    const created = {
      task: { ...summary('k9', 'Add a README'), body: '', runs: [] },
      run: { id: 'r9' },
    };
    const { calls, router, user } = renderTasks(
      {
        'GET /api/tasks?agent=a2&status=open': page([]),
        'POST /api/tasks': answer(201, created),
        'GET /api/runs/r9': failure(404, 'not_found', 'Run not found'),
      },
      { pathname: '/tasks', search: '?agent=a2', state: { newTask: true } },
    );
    const dialog = await screen.findByRole('dialog', { name: 'New task' });
    const title = within(dialog).getByRole('textbox', { name: 'Title' });
    expect(document.activeElement).toBe(title);
    expect(await within(dialog).findByRole('combobox', { name: 'For: Checkout QA' })).toBeTruthy();
    expect(within(dialog).getByText(/No computer is connected yet/)).toBeTruthy();

    await user.type(title, 'Add a README');
    // Enter in the title goes on to the description: a title is one line.
    await user.keyboard('{Enter}');
    expect(document.activeElement).toBe(
      within(dialog).getByRole('textbox', { name: 'Description' }),
    );
    await user.keyboard('Say **how**.');
    await chooseRepository(user, dialog, '~/code/repo');
    expect(repositoryChip(dialog).getAttribute('aria-label')).toBe('Where it works: ~/code/repo');
    expect(within(dialog).getByRole('combobox', { name: 'Project: Payments' })).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Create and run' }));
    expect(calls.find((call) => call.route === 'POST /api/tasks')?.body).toEqual({
      agentId: 'a2',
      projectId: 'p1',
      title: 'Add a README',
      body: 'Say **how**.',
      repository: '~/code/repo',
      run: true,
    });
    expect(await screen.findByRole('heading', { name: 'Run not found' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/runs/r9');
  });

  it('creates a task without running it when Run now is cleared, and opens the task', async () => {
    const created = { task: { ...summary('k8', 'Later'), body: '', runs: [] }, run: null };
    const { calls, router, user } = renderTasks({
      'GET /api/tasks?status=open': page([summary('k1', 'Add a README')]),
      'POST /api/tasks': answer(201, created),
      'GET /api/tasks/k8': failure(404, 'not_found', 'Task not found'),
    });
    const { dialog, agent } = await openNewTask(user);
    expect(agent.getAttribute('aria-label')).toBe('For: Payments backend');
    await user.type(within(dialog).getByRole('textbox', { name: 'Title' }), 'Later');
    await user.click(within(dialog).getByRole('switch', { name: 'Run now' }));
    expect(within(dialog).getByText('The task waits until you run it')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Create task' }));
    expect(calls.find((call) => call.route === 'POST /api/tasks')?.body).toMatchObject({
      agentId: 'a1',
      projectId: 'p1',
      // The project's main repository is none of the task's own: it follows the project.
      repository: null,
      run: false,
    });
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/tasks/k8'));
  });

  it("starts in the project's main repository, offers its others, and keeps what was typed", async () => {
    const checkout = projectOf('p2', 'Checkout', agents, ['https://github.com/acme/checkout']);
    const { user } = renderTasks({
      'GET /api/tasks?status=open': page([summary('k1', 'Add a README')]),
      'GET /api/projects': { projects: [payments, checkout] },
      'GET /api/projects/p2': checkout,
    });
    const { dialog } = await openNewTask(user);
    // Two projects: the person picks one, and the task waits for it.
    const project = within(dialog).getByRole('combobox', { name: 'Project: none yet' });
    await user.click(project);
    await user.click(await screen.findByRole('option', { name: 'Payments' }));
    const chip = () => repositoryChip(dialog).getAttribute('aria-label');
    await vi.waitFor(() => expect(chip()).toBe('Where it works: https://github.com/acme/payments'));
    await user.click(repositoryChip(dialog));
    await user.click(await screen.findByRole('option', { name: 'acme/ledger' }));
    expect(chip()).toBe('Where it works: https://github.com/acme/ledger');

    // Another project: the chip follows it while it holds what was offered...
    await user.click(project);
    await user.click(screen.getByRole('option', { name: 'Checkout' }));
    await vi.waitFor(() => expect(chip()).toBe('Where it works: https://github.com/acme/checkout'));
    // ...and keeps what the person typed.
    await chooseRepository(user, dialog, '~/code/mine');
    await user.click(project);
    await user.click(screen.getByRole('option', { name: 'Payments' }));
    await user.click(repositoryChip(dialog));
    await user.clear(screen.getByRole('combobox', { name: 'Folder path or repository URL' }));
    expect(await screen.findByRole('option', { name: 'acme/ledger' })).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(chip()).toBe('Where it works: ~/code/mine');
  });

  it("offers only the project's agents, and says how to put one on it", async () => {
    const checkout = projectOf('p2', 'Checkout', []);
    const { user } = renderTasks({
      'GET /api/tasks?status=open': page([]),
      'GET /api/projects': { projects: [payments, checkout] },
      'GET /api/projects/p2': checkout,
    });
    const { dialog, agent } = await openNewTask(user);
    await user.click(within(dialog).getByRole('combobox', { name: 'Project: none yet' }));
    await user.click(await screen.findByRole('option', { name: 'Checkout' }));
    expect(await within(dialog).findByText(/None of your agents is on Checkout yet/)).toBeTruthy();
    expect(
      within(dialog).getByRole('link', { name: 'Add one on its page' }).getAttribute('href'),
    ).toBe('/projects/p2');
    expect(agent.textContent).toBe('Choose an agent or a team');
  });

  it('sends the person to make a project first when there is none', async () => {
    const { user } = renderTasks({
      'GET /api/tasks?status=open': page([]),
      'GET /api/projects': { projects: [] },
    });
    await user.click(await screen.findByRole('button', { name: 'New task' }));
    const dialog = screen.getByRole('dialog', { name: 'New task' });
    expect(await within(dialog).findByRole('link', { name: 'Create a project' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Create and run' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it("gives a team's task to its lead, and files a task in a project with its team", async () => {
    const delivery = {
      id: 't1',
      name: 'Delivery',
      mode: 'auto',
      lead: { id: 'a2', name: 'Checkout QA' },
      members: [],
      steps: [],
    };
    const teamed = projectOf('p1', 'Payments', agents, payments.repositories, {
      id: 't1',
      name: 'Delivery',
      lead: { id: 'a2', name: 'Checkout QA' },
    });
    const created = { task: { ...summary('k7', 'Ship refunds'), body: '', runs: [] }, run: null };
    const { calls, user } = renderTasks({
      'GET /api/tasks?status=open': page([]),
      'GET /api/teams': { teams: [delivery] },
      'GET /api/projects': { projects: [teamed] },
      'GET /api/projects/p1': teamed,
      'GET /api/tasks/folders': { folders: ['~/code/payments'] },
      'POST /api/tasks': answer(201, created),
    });
    const { dialog } = await openNewTask(user);
    // The only project is chosen, and it picks its team; its task starts in its main repository...
    expect(await within(dialog).findByRole('combobox', { name: 'Project: Payments' })).toBeTruthy();
    expect(await within(dialog).findByRole('combobox', { name: 'For: Delivery' })).toBeTruthy();
    const chip = () => repositoryChip(dialog).getAttribute('aria-label');
    await vi.waitFor(() => expect(chip()).toBe('Where it works: https://github.com/acme/payments'));
    // ...or in a folder of the person's, in its place: there is no "none" for a project's task.
    await user.click(repositoryChip(dialog));
    expect(await screen.findByRole('option', { name: /acme\/payments.*Main/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /No repository/ })).toBeNull();
    await user.click(await screen.findByRole('option', { name: '~/code/payments' }));
    expect(chip()).toBe('Where it works: ~/code/payments');
    expect(within(dialog).getByRole('combobox', { name: 'For: Delivery' })).toBeTruthy();
    await user.type(within(dialog).getByRole('textbox', { name: 'Title' }), 'Ship refunds');
    await user.click(within(dialog).getByRole('switch', { name: 'Run now' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create task' }));
    expect(calls.find((call) => call.route === 'POST /api/tasks')?.body).toMatchObject({
      agentId: 'a2',
      projectId: 'p1',
      repository: '~/code/payments',
      run: false,
    });
  });

  it('asks for a title and a repository the computer can use before it sends anything', async () => {
    const { calls, user } = renderTasks({
      'GET /api/tasks?status=open': page([]),
      'POST /api/tasks': failure(409, 'agent_archived', 'This agent is archived.'),
    });
    const { dialog, agent } = await openNewTask(user);
    // The repository's menu takes no path the computer can't use, and says why.
    await chooseRepository(user, dialog, 'code/repo');
    expect(screen.getByText(/Use a URL that starts with https:\/\//)).toBeTruthy();
    expect(
      screen.getByRole('option', { name: /Use code\/repo/ }).getAttribute('aria-disabled'),
    ).toBe('true');
    await user.keyboard('{Escape}');
    expect(repositoryChip(dialog).getAttribute('aria-label')).toBe(
      'Where it works: https://github.com/acme/payments',
    );

    await user.click(within(dialog).getByRole('button', { name: 'Create and run' }));
    expect(within(dialog).getByText('Enter a title for the task.')).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole('textbox', { name: 'Title' }));
    expect(calls.map((call) => call.route)).not.toContain('POST /api/tasks');

    // What only the server knows shows where it belongs.
    await user.type(within(dialog).getByRole('textbox', { name: 'Title' }), 'Wake up');
    await user.click(within(dialog).getByRole('button', { name: 'Create and run' }));
    expect(await within(dialog).findByText('This agent is archived.')).toBeTruthy();
    expect(document.activeElement).toBe(agent);
  });

  it('chooses no agent rather than another one when the one it opened for is gone', async () => {
    const { calls, user } = renderTasks(
      { 'GET /api/tasks?agent=a9': page([]) },
      { pathname: '/tasks', search: '?agent=a9', state: { newTask: true } },
    );
    const dialog = await screen.findByRole('dialog', { name: 'New task' });
    const agent = await within(dialog).findByRole('combobox', { name: /^For/ });
    expect(agent.textContent).toBe('Choose an agent or a team');
    await user.type(within(dialog).getByRole('textbox', { name: 'Title' }), 'Orphan');
    await user.click(within(dialog).getByRole('button', { name: 'Create and run' }));
    expect(
      within(dialog).getByText('Choose the agent or the team that does the task.'),
    ).toBeTruthy();
    expect(calls.map((call) => call.route)).not.toContain('POST /api/tasks');
  });

  it('says when the agents could not be loaded, and tries again', async () => {
    let fail = true;
    const { user } = renderTasks({
      'GET /api/tasks?status=open': page([]),
      'GET /api/agents': () =>
        fail
          ? { status: 500, json: { error: { code: 'internal', message: 'Internal error' } } }
          : { json: { agents } },
    });
    await user.click(await screen.findByRole('button', { name: 'New task' }));
    const dialog = screen.getByRole('dialog', { name: 'New task' });
    expect(await within(dialog).findByText("Couldn't load your agents")).toBeTruthy();
    fail = false;
    await user.click(within(dialog).getByRole('button', { name: 'Retry' }));
    expect(await within(dialog).findByRole('combobox', { name: /^For/ })).toBeTruthy();
  });

  it('sends the person to make an agent first when they have none', async () => {
    const { user } = renderTasks({
      'GET /api/agents': { agents: [] },
      'GET /api/tasks?status=open': page([]),
    });
    await user.click(await screen.findByRole('button', { name: 'New task' }));
    const dialog = screen.getByRole('dialog', { name: 'New task' });
    expect(await within(dialog).findByRole('link', { name: 'Create an agent' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Create and run' })).toHaveProperty(
      'disabled',
      true,
    );
  });
});

describe('the repository rule', () => {
  it('takes a URL without credentials or an absolute path, as the server does', () => {
    for (const ok of ['https://github.com/acme/repo.git', '/srv/repo', '~/code/repo']) {
      expect(repositoryProblem(ok), ok).toBeUndefined();
    }
    for (const wrong of [
      'code/repo',
      'git@github.com:acme/repo.git',
      'ssh://host/repo',
      'https://',
      'Https://github.com/acme/repo.git',
    ]) {
      expect(repositoryProblem(wrong), wrong).toMatch(/absolute path/);
    }
    for (const secret of [
      'https://ann:secret@github.com/acme/repo.git',
      'https://ann\\:secret@github.com/acme/repo.git',
    ]) {
      expect(repositoryProblem(secret), secret).toMatch(/without credentials/);
    }
  });
});
