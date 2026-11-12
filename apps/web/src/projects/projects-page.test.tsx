import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../app';
import { admin, answer, failure, member, mockApi } from '../test-api';

const payments = {
  id: 'p1',
  name: 'Payments',
  agentCount: 2,
  connectionCount: 1,
  createdAt: '2026-10-20T09:00:00Z',
};
const empty = {
  id: 'p2',
  name: 'Scratch',
  agentCount: 0,
  connectionCount: 0,
  createdAt: '2026-10-21T09:00:00Z',
};

const view = {
  ...payments,
  budget: { usdPerMonth: null, usdThisMonth: 3.2 },
  triggers: { onPipelineFailed: false, onReview: false, reviewer: null },
  description: 'The money path: checkout, refunds and the ledger.',
  goals: '',
  repositories: [],
  week: {
    runs: 4,
    ended: 4,
    done: 3,
    medianSeconds: 600,
    usd: '3.2',
    daily: [0, 0, 0, 1, 1, 1, 1],
  },
  agents: [{ id: 'a1', name: 'Payments backend', roleTitle: 'Backend engineer', status: 'active' }],
  connections: [
    {
      id: 'c1',
      kind: 'github',
      host: 'github.com',
      namespace: 'acme',
      accountLogin: 'acme-bot',
      agentName: null,
    },
    {
      id: 'c2',
      kind: 'gitlab',
      host: 'gitlab.acme.com',
      namespace: 'acme/platform',
      accountLogin: null,
      agentName: 'Payments backend',
    },
  ],
};

function open(path: string, routes: Parameters<typeof mockApi>[0] = {}, who = admin) {
  const calls = mockApi({
    'GET /api/me': who,
    'GET /api/projects/p1/knowledge': { sources: [] },
    ...routes,
  });
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
  return { calls, user: userEvent.setup() };
}

describe('the projects list', () => {
  it('switches on fixing failed pipelines for the project', async () => {
    const { user, calls } = open('/projects/p1', {
      'GET /api/projects/p1': view,
      'PATCH /api/projects/p1': {
        ...view,
        triggers: { ...view.triggers, onPipelineFailed: true },
      },
    });
    const fix = await screen.findByRole('switch', { name: 'Fix failed pipelines' });
    await user.click(fix);
    expect(calls.find((call) => call.route === 'PATCH /api/projects/p1')?.body).toEqual({
      onPipelineFailed: true,
    });
    expect(
      (await screen.findByRole('switch', { name: 'Fix failed pipelines' })).getAttribute(
        'aria-checked',
      ),
    ).toBe('true');
  });

  it("shows its devcontainer's services, and an admin approves exactly that list", async () => {
    const environment = {
      repository: 'https://github.com/acme/payments',
      devcontainer: '.devcontainer/devcontainer.json',
      services: [{ name: 'db', image: 'postgres:16', environment: {}, volumes: [] }],
      problems: ['mail: left out, it asks for privileged'],
      readAt: new Date().toISOString(),
      hash: 'c'.repeat(64),
      approved: false,
    };
    const withServices = {
      ...view,
      repositories: ['https://github.com/acme/payments'],
      environment,
    };
    const { user, calls } = open('/projects/p1', {
      'GET /api/projects/p1': withServices,
      'POST /api/projects/p1/environment/approve': {
        ...withServices,
        environment: { ...environment, approved: true },
      },
    });
    const list = await screen.findByRole('list', { name: 'Services' });
    expect(within(list).getByText('postgres:16')).toBeTruthy();
    expect(screen.getByText('mail: left out, it asks for privileged')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Approve services' }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve these services?' });
    await user.click(within(dialog).getByRole('button', { name: 'Approve services' }));
    expect(
      calls.find((call) => call.route === 'POST /api/projects/p1/environment/approve')?.body,
    ).toEqual({ hash: 'c'.repeat(64) });
    expect(await screen.findByText(/^Approved: people’s places run these/)).toBeTruthy();
  });

  it('offers a member no approval of the services', async () => {
    open(
      '/projects/p1',
      {
        'GET /api/projects/p1': {
          ...view,
          repositories: ['https://github.com/acme/payments'],
          environment: {
            repository: 'https://github.com/acme/payments',
            devcontainer: '.devcontainer/devcontainer.json',
            services: [{ name: 'db', image: 'postgres:16', environment: {}, volumes: [] }],
            problems: [],
            readAt: new Date().toISOString(),
            hash: 'c'.repeat(64),
            approved: false,
          },
        },
      },
      member,
    );
    await screen.findByRole('list', { name: 'Services' });
    expect(screen.queryByRole('button', { name: 'Approve services' })).toBeNull();
  });

  it('sets the project’s monthly limit from its chip', async () => {
    const { user, calls } = open('/projects/p1', {
      'GET /api/projects/p1': view,
      'PATCH /api/projects/p1': { ...view, budget: { usdPerMonth: 50, usdThisMonth: 3.2 } },
    });
    await user.click(
      await screen.findByRole('button', { name: /^Monthly limit: \$3\.20 this month/ }),
    );
    await user.type(screen.getByLabelText('Monthly limit, USD'), '50');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(calls.find((call) => call.route === 'PATCH /api/projects/p1')?.body).toEqual({
      usdPerMonth: 50,
    });
    expect(
      await screen.findByRole('button', { name: 'Monthly limit: $3.20 of $50.00 a month' }),
    ).toBeTruthy();
  });

  it('lists projects with what each one holds, and says when a project has none', async () => {
    open('/projects', { 'GET /api/projects': { projects: [payments, empty] } });
    const row = await screen.findByRole('row', { name: /Payments/ });
    expect(within(row).getByRole('link', { name: 'Payments' }).getAttribute('href')).toBe(
      '/projects/p1',
    );
    expect(row.textContent).toContain('2');
    // A phone's list has no column heads: its numbers say what they count.
    expect(row.textContent).toContain('2 agents');
    const scratch = screen.getByRole('row', { name: /Scratch/ });
    expect(scratch.textContent).toContain('None');
    expect(scratch.textContent).toContain('No connections');
  });

  it('invites an admin to create the first project, and tells a member who can', async () => {
    const { user, calls } = open('/projects', {
      'GET /api/projects': { projects: [] },
      'POST /api/projects': {
        json: {
          ...empty,
          description: '',
          goals: '',
          repositories: [],
          agents: [],
          connections: [],
        },
      },
    });
    expect(await screen.findByText('No projects yet')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'New project' }));
    const dialog = screen.getByRole('dialog', { name: 'New project' });
    await user.type(within(dialog).getByLabelText('Name'), 'Scratch');
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }));
    expect(calls.find((call) => call.route === 'POST /api/projects')?.body).toEqual({
      name: 'Scratch',
    });
  });

  it('lets a member make a project, which an admin connects', async () => {
    open('/projects', { 'GET /api/projects': { projects: [] } }, member);
    expect(await screen.findByText(/an admin connects it/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'New project' }).length).toBeGreaterThan(0);
  });

  it('says when the list could not be loaded, and retries', async () => {
    const { user, calls } = open('/projects', {
      'GET /api/projects': failure(503, 'internal', 'The database is not reachable'),
    });
    expect(await screen.findByText("Couldn't load projects")).toBeTruthy();
    expect(screen.getByText('The database is not reachable')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(calls.filter((call) => call.route === 'GET /api/projects')).toHaveLength(2);
  });
});

describe('a project', () => {
  it('shows what it is for, its agents, and whose account each host answers as', async () => {
    open('/projects/p1', {
      'GET /api/projects/p1': view,
      'GET /api/agents?all=true': { agents: [] },
    });
    expect(await screen.findByText(/The money path/)).toBeTruthy();
    const agents = within(screen.getByRole('list', { name: 'Agents' }));
    expect(agents.getByRole('link', { name: 'Payments backend' }).getAttribute('href')).toBe(
      '/agents/a1',
    );
    expect(agents.getByText('Backend engineer')).toBeTruthy();
    // The week of its tasks' runs.
    expect(screen.getByText('75%')).toBeTruthy();
    // The question a code host raises: whose name will the change request carry? An agent's
    // own token says whose it is.
    expect(screen.getByText('acme-bot')).toBeTruthy();
    expect(screen.getByText('gitlab.acme.com/acme/platform')).toBeTruthy();
    expect(screen.getByText('for Payments backend')).toBeTruthy();
  });

  it('lets an admin add an agent and take one off', async () => {
    const { user, calls } = open('/projects/p1', {
      'GET /api/projects/p1': view,
      'GET /api/agents?all=true': {
        agents: [
          { id: 'a1', name: 'Payments backend', status: 'active' },
          { id: 'a2', name: 'Checkout QA', status: 'active' },
        ],
      },
      'PUT /api/projects/p1/agents/a2': { status: 204 },
      'DELETE /api/projects/p1/agents/a1': { status: 204 },
    });
    await user.click(await screen.findByRole('button', { name: 'Actions for Payments backend' }));
    await user.click(screen.getByRole('menuitem', { name: 'Remove from project' }));
    expect(calls.some((call) => call.route === 'DELETE /api/projects/p1/agents/a1')).toBe(true);

    // The agents already on the project are not offered again.
    await user.click(screen.getByRole('combobox', { name: 'Add agent' }));
    expect(screen.queryByRole('option', { name: 'Payments backend' })).toBeNull();
    await user.click(screen.getByRole('option', { name: 'Checkout QA' }));
    expect(calls.some((call) => call.route === 'PUT /api/projects/p1/agents/a2')).toBe(true);
  });

  it('lets an admin fill in what the project is for', async () => {
    const { user, calls } = open('/projects/p1', {
      'GET /api/projects/p1': { ...view, description: '', goals: '' },
      'GET /api/agents?all=true': { agents: [] },
      'PATCH /api/projects/p1': view,
    });
    // An empty project says what the text is for, and a click on it opens its field.
    await user.click(await screen.findByText(/Add a description: what this project is for/));
    await user.type(screen.getByRole('textbox', { name: 'Description' }), 'The money path.');
    await user.tab();
    expect(calls.find((call) => call.route === 'PATCH /api/projects/p1')?.body).toEqual({
      description: 'The money path.',
    });
    expect(await screen.findByText(/The money path/)).toBeTruthy();
  });

  it('lets an admin delete a project after asking, and goes back to the list', async () => {
    const { user, calls } = open('/projects/p1', {
      'GET /api/projects/p1': view,
      'GET /api/agents?all=true': { agents: [] },
      'DELETE /api/projects/p1': () => ({ status: 204 }),
      'GET /api/projects': { projects: [empty] },
    });
    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete project…' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete Payments?' });
    expect(within(dialog).getByText(/Its tasks and runs stay/)).toBeTruthy();
    expect(within(dialog).getByText(/Webhooks that GitHub or GitLab sends/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Delete project' }));
    expect(calls.some((call) => call.route === 'DELETE /api/projects/p1')).toBe(true);
    expect(await screen.findByRole('link', { name: 'Scratch' })).toBeTruthy();
  });

  it('shows a member no controls on a project', async () => {
    open('/projects/p1', { 'GET /api/projects/p1': view }, member);
    expect(await screen.findByRole('link', { name: 'Payments backend' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Actions for/ })).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit name' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
    // The hosts are still there to read: a member needs to know where the work goes.
    expect(screen.getByText('acme-bot')).toBeTruthy();
  });
});

describe("a project's knowledge", () => {
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const [synced, failed] = [
    {
      id: 'k1',
      repository: 'https://github.com/acme/payments',
      paths: ['README.md', 'docs'],
      lastSyncAt: ago(5),
      lastSyncError: null,
      documents: 12,
    },
    {
      id: 'k2',
      repository: 'https://gitlab.acme.com/acme/platform/ledger',
      paths: ['docs/decisions'],
      lastSyncAt: ago(30),
      lastSyncError: 'gitlab.acme.com answered 401',
      documents: 3,
    },
  ];
  const sources = [synced, failed];

  it('says what each source holds and when it last synced, and lets an admin sync it now', async () => {
    const { user, calls } = open('/projects/p1', {
      'GET /api/projects/p1': view,
      'GET /api/agents?all=true': { agents: [] },
      'GET /api/projects/p1/knowledge': { sources },
      'POST /api/knowledge/k2/sync': failed,
    });
    const list = within(await screen.findByRole('list', { name: 'Knowledge sources' }));
    expect(list.getByText('github.com/acme/payments')).toBeTruthy();
    expect(list.getByText('12 documents, synced 5 min ago')).toBeTruthy();
    expect(list.getByText(/README.md, docs/)).toBeTruthy();
    expect(list.getByText('Sync failed 30 min ago')).toBeTruthy();
    expect(list.getByText('gitlab.acme.com answered 401')).toBeTruthy();
    await user.click(
      list.getByRole('button', { name: 'Actions for gitlab.acme.com/acme/platform/ledger' }),
    );
    await user.click(screen.getByRole('menuitem', { name: 'Sync now' }));
    expect(calls.some((call) => call.route === 'POST /api/knowledge/k2/sync')).toBe(true);
  });

  it("adds a source from one of the project's repositories and its paths", async () => {
    const { user, calls } = open('/projects/p1', {
      'GET /api/projects/p1': { ...view, repositories: ['https://github.com/acme/payments'] },
      'GET /api/agents?all=true': { agents: [] },
      'POST /api/projects/p1/knowledge': synced,
    });
    expect(await screen.findByText(/No knowledge yet. Add the docs/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Add a source' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a knowledge source' });
    // The main repository is chosen to begin with.
    expect(within(dialog).getByLabelText('Repository').textContent).toBe(
      'https://github.com/acme/payments',
    );
    await user.clear(within(dialog).getByLabelText('Paths'));
    await user.type(within(dialog).getByLabelText('Paths'), 'README.md, docs/guides ,');
    await user.click(within(dialog).getByRole('button', { name: 'Add and sync' }));
    expect(calls.find((call) => call.route === 'POST /api/projects/p1/knowledge')?.body).toEqual({
      repository: 'https://github.com/acme/payments',
      paths: ['README.md', 'docs/guides'],
    });
  });

  it('shows a member the sources without controls', async () => {
    open(
      '/projects/p1',
      { 'GET /api/projects/p1': view, 'GET /api/projects/p1/knowledge': { sources } },
      member,
    );
    expect(await screen.findByText('github.com/acme/payments')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Actions for/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add a source' })).toBeNull();
  });
});

describe("a project's repositories", () => {
  const repositories = ['https://github.com/acme/payments', 'https://github.com/acme/ledger'];

  it('are added, made main and removed by an admin, the whole list each time', async () => {
    const { user, calls } = open('/projects/p1', {
      'GET /api/projects/p1': { ...view, repositories },
      'GET /api/agents?all=true': { agents: [] },
      'PATCH /api/projects/p1': { ...view, repositories },
    });
    const section = within(
      (await screen.findByRole('heading', { name: 'Repositories' })).closest('section')!,
    );
    expect(section.getByText('Main')).toBeTruthy();
    await user.click(
      section.getByRole('button', { name: 'Actions for https://github.com/acme/ledger' }),
    );
    await user.click(screen.getByRole('menuitem', { name: 'Make main' }));
    expect(calls.findLast((call) => call.route === 'PATCH /api/projects/p1')?.body).toEqual({
      repositories: [repositories[1], repositories[0]],
    });
    await user.click(
      section.getByRole('button', { name: 'Actions for https://github.com/acme/payments' }),
    );
    await user.click(screen.getByRole('menuitem', { name: 'Remove' }));
    expect(calls.findLast((call) => call.route === 'PATCH /api/projects/p1')?.body).toEqual({
      repositories: [repositories[1]],
    });

    await user.click(section.getByRole('button', { name: 'Add repository' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Add a repository' }));
    await user.type(dialog.getByLabelText('URL'), ' https://github.com/acme/web ');
    await user.click(dialog.getByRole('button', { name: 'Add repository' }));
    expect(calls.findLast((call) => call.route === 'PATCH /api/projects/p1')?.body).toEqual({
      repositories: [...repositories, 'https://github.com/acme/web'],
    });
  });

  it('are listed for a member without controls', async () => {
    open('/projects/p1', { 'GET /api/projects/p1': { ...view, repositories } }, member);
    expect(await screen.findByText('github.com/acme/ledger')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Actions for/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add repository' })).toBeNull();
  });
});

describe("a project's team", () => {
  const team = { id: 't1', name: 'Refunds delivery', lead: { id: 'a1', name: 'Payments backend' } };

  it('lets an admin pick when the lead starts, and files a task that goes to it', async () => {
    const { calls, user } = open('/projects/p1', {
      'GET /api/projects/p1': { ...view, team, intake: 'manual' },
      'GET /api/projects': { projects: [payments] },
      'GET /api/teams': { teams: [{ ...team, mode: 'auto', members: [], steps: [] }] },
      'GET /api/agents': {
        agents: [{ id: 'a1', name: 'Payments backend', roleTitle: '', status: 'active' }],
      },
      'PATCH /api/projects/p1': { ...view, team, intake: 'auto' },
      'POST /api/tasks': answer(201, { task: { id: 'k9' }, run: null }),
      'GET /api/tasks/k9': failure(404, 'not_found', 'Task not found'),
    });
    // Who starts a task is a chip with its menu, as in Linear.
    await user.click(
      await screen.findByRole('button', { name: 'Who starts a task: A person starts it' }),
    );
    await user.click(screen.getByRole('menuitemradio', { name: /The lead takes it/ }));
    expect(calls.find((call) => call.route === 'PATCH /api/projects/p1')?.body).toEqual({
      intake: 'auto',
    });

    // New task is the composer of Tasks, the project and its team chosen; the lead now takes
    // the project's tasks at once, so Run now is on.
    await user.click(screen.getByRole('button', { name: 'New task' }));
    const dialog = screen.getByRole('dialog', { name: 'New task' });
    expect(
      await within(dialog).findByRole('combobox', { name: 'For: Refunds delivery' }),
    ).toBeTruthy();
    expect(within(dialog).getByRole('combobox', { name: 'Project: Payments' })).toBeTruthy();
    expect(
      within(dialog).getByRole('switch', { name: 'Run now' }).getAttribute('aria-checked'),
    ).toBe('true');
    await user.type(within(dialog).getByRole('textbox', { name: 'Title' }), 'Export refunds');
    await user.click(within(dialog).getByRole('button', { name: 'Create and run' }));
    expect(calls.find((call) => call.route === 'POST /api/tasks')?.body).toEqual({
      agentId: 'a1',
      projectId: 'p1',
      title: 'Export refunds',
      body: '',
      repository: null,
      run: true,
    });
    expect(await screen.findByRole('heading', { name: 'Task not found' })).toBeTruthy();
  });
});
