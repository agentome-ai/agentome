import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../app';
import { admin, answer, failure, mockApi } from '../test-api';
import type { Agent } from './agents-data';

const agent: Agent = {
  id: '7f3a9c21-0000-4000-8000-000000000001',
  name: 'Payments backend',
  roleTitle: 'Backend engineer',
  status: 'active',
  owner: { id: 'u1', name: 'Ann Admin' },
  lastRun: null,
  createdAt: '2026-10-12T09:00:00Z',
  instructions: '## Rules\n\nWrite the test first.',
  engine: 'claude-code',
  modelPref: null,
  runsOn: 'laptop',
  modelConnection: null,
  serverShell: false,
  budget: { maxTurns: 80 },
  runDefaults: { maxMinutes: 60, maxTurns: 50, maxTokens: 2_000_000 },
  copiedFromAgentId: null,
  template: { id: 't1', name: 'Backend developer', version: 2 },
  seat: null,
  people: [{ id: 'u1', name: 'Ann Admin', level: 'owner', validFrom: null, validUntil: null }],
  tools: [{ connector: 'Workspace', name: 'Bash', title: 'Run commands', policy: 'allow' }],
  memoryDocuments: 0,
  spend: { usdThisMonth: 0, limit: 250, reached: false, resumed: false },
  skills: [],
  mcpServers: [],
  projects: [],
};
const url = `/api/agents/${agent.id}`;

const quality = {
  since: '2026-10-03T12:00:00Z',
  tasks: 12,
  handed: 10,
  accepted: 8,
  firstTime: 5,
  changeRequests: { merged: 6, closed: 1, open: 1 },
  returns: { total: 4, tasks: 3, person: 2, ci: 1, review: 1 },
  usd: { median: '1.2', total: '18.4' },
  seconds: { work: 720, toReview: 3840 },
  runs: { ended: 30, failed: 2, limited: 1 },
  mostReturned: [{ id: 'k7', title: 'Retry webhooks', returns: 2, usd: '3' }],
};

function renderEditor(routes: Parameters<typeof mockApi>[0] = {}) {
  const calls = mockApi({
    'GET /api/me': admin,
    [`GET ${url}`]: agent,
    // A save answers with the agent as saved.
    [`PATCH ${url}`]: (body) => ({ json: { ...agent, ...(body as object) } }),
    [`GET ${url}/memory`]: { documents: [] },
    [`GET ${url}/schedules`]: { schedules: [] },
    [`GET ${url}/quality`]: quality,
    'GET /api/library/skills': { skills: [] },
    'GET /api/library/mcp': { servers: [] },
    'GET /api/teams': { teams: [] },
    ...routes,
  });
  // A data router, as in main.tsx: the editor holds navigations with useBlocker. The list was
  // the page before, for Back.
  const router = createMemoryRouter([{ path: '*', element: <App /> }], {
    initialEntries: ['/agents', `/agents/${agent.id}`],
    initialIndex: 1,
  });
  render(<RouterProvider router={router} />);
  return { calls, router, user: userEvent.setup() };
}

const sheet = () => screen.getByRole('complementary', { name: /^Agent sheet/ });
const nameField = () => screen.getByRole('textbox', { name: 'Name' });

describe('the agent editor', () => {
  it('adds a recurring task on weekdays at a time from the menu', async () => {
    const made = {
      id: 's1',
      title: 'Write the weekly release notes',
      body: '',
      days: [1, 2, 3, 4, 5],
      time: '10:30',
      timeZone: 'Europe/Moscow',
      enabled: true,
      when: 'Every weekday at 10:30',
      lastRunAt: null,
    };
    const { calls, user } = renderEditor({
      [`GET ${url}`]: {
        ...agent,
        projects: [{ id: 'p1', name: 'Payments', hosts: ['github'], repositories: [] }],
      },
      [`POST ${url}/schedules`]: () => ({ status: 201, json: made }),
    });
    await user.click(await screen.findByRole('button', { name: 'New schedule' }));
    const dialog = screen.getByRole('dialog', { name: 'New schedule' });
    // Its tasks are filed in the agent's project.
    expect(within(dialog).getByRole('combobox', { name: 'Project' }).textContent).toBe('Payments');
    await user.type(within(dialog).getByLabelText('Task'), 'Write the weekly release notes');
    await user.click(within(dialog).getByRole('combobox', { name: 'Time' }));
    await user.click(await screen.findByRole('option', { name: '10:30' }));
    await user.click(within(dialog).getByRole('button', { name: 'Add schedule' }));
    const body = calls.find((call) => call.route === `POST ${url}/schedules`)?.body as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      projectId: 'p1',
      title: 'Write the weekly release notes',
      days: [1, 2, 3, 4, 5],
      time: '10:30',
    });
    expect(await screen.findByText(/Every weekday at 10:30, Europe\/Moscow/)).toBeTruthy();
  });

  it('sends an agent on no project to one before it takes a schedule', async () => {
    const { user } = renderEditor();
    await user.click(await screen.findByRole('button', { name: 'New schedule' }));
    const dialog = screen.getByRole('dialog', { name: 'New schedule' });
    expect(within(dialog).getByText(/this agent is on none yet/)).toBeTruthy();
    expect(within(dialog).getByRole('link', { name: 'Add it to a project' })).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Add schedule' })).toBeNull();
  });

  it('lets the owner go on past a reached monthly limit for the month', async () => {
    const reached = { usdThisMonth: 251.2, limit: 250, reached: true, resumed: false };
    const { calls, user } = renderEditor({
      [`GET ${url}`]: { ...agent, spend: reached },
      [`POST ${url}/budget/resume`]: { ...agent, spend: { ...reached, resumed: true } },
    });
    const status = await screen.findByRole('status', { name: 'Spend this month' });
    expect(status.textContent).toContain('$251.20 of $250.00');
    await user.click(within(status).getByRole('button', { name: 'Continue this month' }));
    expect(calls.map((call) => call.route)).toContain(`POST ${url}/budget/resume`);
    expect((await screen.findByRole('status', { name: 'Spend this month' })).textContent).toContain(
      'let it go on past the limit',
    );
  });

  it('switches the agent to Codex, with a model Codex runs', async () => {
    const { calls, user } = renderEditor({ 'GET /api/models': { connections: [] } });
    await screen.findByRole('heading', { level: 1, name: 'Payments backend' });
    await user.click(await screen.findByRole('radio', { name: 'Codex' }));
    await user.click(screen.getByRole('combobox', { name: 'Model' }));
    expect(screen.queryByRole('option', { name: /Claude Opus/ })).toBeNull();
    await user.click(await screen.findByRole('option', { name: /GPT-5 Codex/ }));
    await user.keyboard('{Meta>}s{/Meta}');
    expect(calls.find((call) => call.route === `PATCH ${url}`)?.body).toEqual({
      modelPref: 'gpt-5-codex',
      engine: 'codex',
    });
  });

  it('sets the agent to work on the server, on a Claude model of a connection', async () => {
    const { calls, user } = renderEditor({
      'GET /api/models': {
        connections: [
          {
            id: 'mc1',
            name: 'OpenRouter',
            models: [
              { id: 'anthropic/claude-sonnet-4.5', engine: 'claude-code' },
              { id: 'openai/gpt-5', engine: 'codex' },
            ],
          },
        ],
      },
    });
    await screen.findByRole('heading', { level: 1, name: 'Payments backend' });
    await user.click(await screen.findByRole('radio', { name: 'Server' }));
    await user.click(screen.getByRole('combobox', { name: 'Model connection' }));
    await user.click(await screen.findByRole('option', { name: 'OpenRouter' }));
    await user.click(screen.getByRole('combobox', { name: 'Model' }));
    // Claude Code runs Claude models only: GPT is not offered here.
    expect(screen.queryByRole('option', { name: 'openai/gpt-5' })).toBeNull();
    await user.click(await screen.findByRole('option', { name: 'anthropic/claude-sonnet-4.5' }));
    // An admin sees the shell's switch, off.
    expect(screen.getByRole('switch', { name: 'Allow a shell on the server' })).toHaveProperty(
      'ariaChecked',
      'false',
    );
    await user.keyboard('{Meta>}s{/Meta}');
    expect(calls.find((call) => call.route === `PATCH ${url}`)?.body).toEqual({
      modelPref: 'anthropic/claude-sonnet-4.5',
      runsOn: 'server',
      modelConnectionId: 'mc1',
    });
  });

  it('shows the sections and the sheet of the agent', async () => {
    renderEditor();
    expect(await screen.findByRole('heading', { level: 1, name: 'Payments backend' })).toBeTruthy();
    const sections = screen.getByRole('navigation', { name: 'Sections' });
    expect(
      within(sections)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual([
      'Identity',
      'Instructions',
      'Skills',
      'Team',
      'Tools & policies',
      'Memory',
      'Schedules',
      'Access',
      'Budget',
      'Engine & model',
      'Quality',
    ]);
    expect(within(sheet()).getByRole('heading', { name: 'Payments backend' })).toBeTruthy();
    expect(within(sheet()).getByText('Backend developer')).toBeTruthy();
    // The platform's tools, read-only until the tool library.
    const bash = screen.getByRole('radiogroup', { name: 'Run commands' });
    expect(within(bash).getByRole('radio', { name: 'Allow' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(within(sheet()).getByRole('button', { name: 'Transfer ownership' })).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('opens the instructions as they read, with their source one tab away', async () => {
    const { user } = renderEditor();
    await screen.findByRole('heading', { level: 1, name: 'Payments backend' });
    const section = screen.getByRole('region', { name: 'Instructions' });
    expect(
      within(section).getByRole('tab', { name: 'Preview' }).getAttribute('aria-selected'),
    ).toBe('true');
    expect(await within(section).findByRole('heading', { name: 'Rules' })).toBeTruthy();
    expect(within(section).queryByRole('textbox')).toBeNull();
    await user.click(within(section).getByRole('tab', { name: 'Write' }));
    expect(within(section).getByRole('textbox', { name: 'Instructions' })).toHaveProperty(
      'value',
      '## Rules\n\nWrite the test first.',
    );
  });

  it('previews unsaved edits on the sheet, then saves them', async () => {
    const { calls, user } = renderEditor();
    await screen.findByRole('heading', { level: 1, name: 'Payments backend' });
    await user.clear(nameField());
    await user.type(nameField(), 'Billing backend');
    await user.type(screen.getByRole('textbox', { name: 'Monthly limit, USD' }), '250');
    expect(within(sheet()).getByRole('heading', { name: 'Billing backend' })).toBeTruthy();
    expect(within(sheet()).getByText('Limit $250 a month')).toBeTruthy();
    expect(screen.getByRole('status', { name: '' }).textContent).toBe('2 unsaved changes');
    // Run gives way to Save changes while there are edits.
    expect(within(sheet()).getByRole('button', { name: 'Run' }).className).not.toContain('bg-ink');

    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(calls.find((call) => call.route === `PATCH ${url}`)?.body).toEqual({
      name: 'Billing backend',
      budget: { maxTurns: 80, usdPerMonth: 250 },
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Billing backend' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    // No toast for a success; a screen reader hears it.
    expect(screen.getByRole('status', { name: '' }).textContent).toBe('Changes saved');
    // The sidebar learns the new name.
    expect(calls.filter((call) => call.route === 'GET /api/agents')).toHaveLength(2);
  });

  it('discards the edits back to the saved agent', async () => {
    const { calls, user } = renderEditor();
    await screen.findByRole('heading', { level: 1, name: 'Payments backend' });
    await user.type(nameField(), ' v2');
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect((nameField() as HTMLInputElement).value).toBe('Payments backend');
    expect(within(sheet()).getByRole('heading', { name: 'Payments backend' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(calls.map((call) => call.route)).not.toContain(`PATCH ${url}`);
  });

  it('keeps a budget it cannot save, and says why', async () => {
    const { calls, user } = renderEditor();
    await screen.findByRole('heading', { level: 1, name: 'Payments backend' });
    const turns = screen.getByRole('textbox', { name: 'Turns per run' });
    await user.clear(turns);
    await user.type(turns, 'eighty');
    expect(screen.getByText('Enter a whole number, or leave it empty.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(document.activeElement).toBe(turns);
    expect(calls.map((call) => call.route)).not.toContain(`PATCH ${url}`);
  });

  it('asks before leaving with unsaved edits, by a link or by Back', async () => {
    const { router, user } = renderEditor();
    await screen.findByRole('heading', { level: 1, name: 'Payments backend' });
    await user.type(nameField(), ' v2');
    const dashboard = within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', {
      name: 'Dashboard',
    });
    await user.click(dashboard);
    const ask = screen.getByRole('dialog', { name: 'Leave without saving?' });
    await user.click(within(ask).getByRole('button', { name: 'Keep editing' }));
    expect((nameField() as HTMLInputElement).value).toBe('Payments backend v2');
    expect(document.activeElement).toBe(dashboard);

    await act(() => router.navigate(-1));
    const back = screen.getByRole('dialog', { name: 'Leave without saving?' });
    await user.click(within(back).getByRole('button', { name: 'Keep editing' }));
    expect(router.state.location.pathname).toBe(`/agents/${agent.id}`);

    await user.click(
      within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', {
        name: 'Dashboard',
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Leave without saving' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboard' })).toBeTruthy();
  });

  it('previews the workspace a run gets', async () => {
    const { user } = renderEditor({
      [`GET ${url}/workspace-preview`]: {
        claudeMd: '# Payments backend\n\n## Instructions\n\nWrite the test first.',
        settings: { permissionMode: 'acceptEdits', allowedTools: ['Bash'] },
      },
    });
    await screen.findByRole('heading', { level: 1, name: 'Payments backend' });
    const open = within(sheet()).getByRole('button', { name: 'Preview workspace' });
    await user.click(open);
    const dialog = screen.getByRole('dialog', { name: 'Preview workspace' });
    expect((await within(dialog).findByText(/## Instructions/)).textContent).toContain(
      'Write the test first.',
    );
    await user.click(within(dialog).getByRole('tab', { name: 'Settings' }));
    expect(within(dialog).getByText(/"permissionMode": "acceptEdits"/)).toBeTruthy();
    // The dialog has no trigger of its own: Done hands focus back to the sheet's button.
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(document.activeElement).toBe(open);
  });

  it('archives after asking, and unarchives', async () => {
    const archived = { ...agent, status: 'archived' };
    const { calls, user } = renderEditor({
      [`POST ${url}/archive`]: archived,
      [`POST ${url}/unarchive`]: agent,
    });
    await screen.findByRole('heading', { level: 1, name: 'Payments backend' });
    await user.click(within(sheet()).getByRole('button', { name: 'Archive' }));
    const ask = screen.getByRole('dialog', { name: 'Archive Payments backend?' });
    await user.click(within(ask).getByRole('button', { name: 'Archive' }));
    expect(await screen.findByText(/This agent is archived/)).toBeTruthy();
    expect(within(sheet()).getByRole('button', { name: 'Run' })).toHaveProperty('disabled', true);

    await user.click(within(sheet()).getByRole('button', { name: 'Unarchive' }));
    expect(await within(sheet()).findByRole('button', { name: 'Archive' })).toBeTruthy();
    expect(calls.map((call) => call.route)).toEqual(
      expect.arrayContaining([`POST ${url}/archive`, `POST ${url}/unarchive`]),
    );
  });

  it('duplicates into a new agent, exports a file and runs it as a new task', async () => {
    const copy = { ...agent, id: 'copy-1', name: 'Payments backend (copy)' };
    const { user } = renderEditor({
      [`GET ${url}/export`]: { format: 'agentome/agent@1', agent: { name: agent.name } },
      [`POST ${url}/duplicate`]: answer(201, copy),
      'GET /api/agents/copy-1': copy,
      'GET /api/agents': { agents: [agent, copy] },
      'GET /api/tasks?agent=copy-1': { tasks: [], nextBefore: null },
      'GET /api/projects': {
        projects: [
          {
            id: 'p1',
            name: 'Payments',
            agentCount: 1,
            connectionCount: 0,
            createdBy: 'u1',
            createdAt: '2026-10-12T09:00:00Z',
          },
        ],
      },
    });
    // jsdom saves no files: the test sees the link the browser would follow.
    Object.assign(URL, { createObjectURL: () => 'blob:export', revokeObjectURL: () => {} });
    const save = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await screen.findByRole('heading', { level: 1, name: 'Payments backend' });
    await user.click(within(sheet()).getByRole('button', { name: 'Export' }));
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect((save.mock.contexts[0] as HTMLAnchorElement).href).toBe('blob:export');
    save.mockRestore();

    await user.click(within(sheet()).getByRole('button', { name: 'Duplicate' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Payments backend (copy)' }),
    ).toBeTruthy();
    // A run is a run of a task: Run opens New task on the Tasks page, for this agent.
    await user.click(within(sheet()).getByRole('button', { name: 'Run' }));
    const dialog = await screen.findByRole('dialog', { name: 'New task' });
    expect(
      await within(dialog).findByRole('combobox', { name: 'For: Payments backend (copy)' }),
    ).toBeTruthy();
    // The copy is on no project yet, and every task is filed in one.
    expect(
      await within(dialog).findByText(/Payments backend \(copy\) is on no project yet/),
    ).toBeTruthy();
    expect(within(dialog).getByRole('link', { name: 'Add it to one' })).toBeTruthy();
  });

  it('says so when an export fails, instead of saving the error as the file', async () => {
    const { user } = renderEditor({
      [`GET ${url}/export`]: failure(401, 'unauthorized', 'Sign in to continue'),
    });
    await screen.findByRole('heading', { level: 1, name: 'Payments backend' });
    await user.click(within(sheet()).getByRole('button', { name: 'Export' }));
    expect(await screen.findByText("Couldn't export Payments backend")).toBeTruthy();
    expect(screen.getByText('Sign in to continue')).toBeTruthy();
  });

  it("says so when the agent is someone else's", async () => {
    renderEditor({ [`GET ${url}`]: failure(404, 'not_found', 'Agent not found') });
    expect(
      await screen.findByRole('heading', {
        name: "This agent doesn't exist or isn't shared with you",
      }),
    ).toBeTruthy();
  });
});

describe('the skills section', () => {
  const librarySkill = (id: string, name: string, version: number) => ({
    id,
    name,
    description: `Writes ${name}`,
    version,
    owner: { id: 'u1', name: 'Ann Admin' },
    visibility: 'org',
    createdAt: new Date().toISOString(),
  });

  it('adds a skill from the library, and moves one on to its newest version', async () => {
    const { calls, user } = renderEditor({
      [`GET ${url}`]: { ...agent, skills: [{ id: 's1', name: 'code-review', version: '1' }] },
      'GET /api/library/skills': {
        skills: [librarySkill('s2', 'code-review', 2), librarySkill('s3', 'release-notes', 1)],
      },
      [`PUT ${url}/skills`]: (body) => ({
        json: {
          skills: (body as { skills: string[] }).skills.map((id) =>
            id === 's3'
              ? librarySkill('s3', 'release-notes', 1)
              : librarySkill(id, 'code-review', id === 's2' ? 2 : 1),
          ),
        },
      }),
    });
    const section = await screen.findByRole('region', { name: 'Skills' });
    await user.click(await within(section).findByRole('button', { name: 'Move to version 2' }));
    expect(calls.findLast((call) => call.route === `PUT ${url}/skills`)?.body).toEqual({
      skills: ['s2'],
    });
    await user.click(within(section).getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: /release-notes/ }));
    expect(calls.findLast((call) => call.route === `PUT ${url}/skills`)?.body).toEqual({
      skills: ['s2', 's3'],
    });
    expect(within(sheet()).getAllByText(/release-notes/).length).toBeGreaterThan(0);
  });
});

describe("the agent's teams", () => {
  const ref = (id: string, name: string) => ({ id, name, roleTitle: '', status: 'active' });
  const team = (id: string, name: string, lead: object, members: object[]) => ({
    id,
    name,
    mode: 'auto',
    lead,
    members,
    steps: [],
  });

  it('names the team it leads and the ones it is in, each a link', async () => {
    const self = ref(agent.id, agent.name);
    renderEditor({
      'GET /api/teams': {
        teams: [
          team('t1', 'Payments', self, [ref('a2', 'QA')]),
          team('t2', 'Checkout', ref('a3', 'Lead'), [self]),
        ],
      },
    });
    const section = await screen.findByRole('region', { name: 'Team' });
    expect((await within(section).findByText(/^Leads/)).textContent).toBe(
      'Leads Payments, with QA.',
    );
    expect(within(section).getByRole('link', { name: 'Checkout' }).getAttribute('href')).toBe(
      '/teams/t2',
    );
    expect(within(section).queryByRole('button', { name: 'Create a team it leads' })).toBeNull();
  });

  it('offers a team to one that leads none', async () => {
    renderEditor();
    const section = await screen.findByRole('region', { name: 'Team' });
    expect(await within(section).findByText(/leads no team/)).toBeTruthy();
    expect(within(section).getByRole('button', { name: 'Create a team it leads' })).toBeTruthy();
  });
});

describe("the agent's MCP servers", () => {
  it('adds a server from the library, and its tools join the policies, asking first', async () => {
    let given: string[] = [];
    const tracker = {
      id: 'm1',
      name: 'tracker',
      description: '',
      url: 'https://mcp.acme.com/mcp',
      hasAuthorization: true,
      tools: [],
      checkedAt: new Date().toISOString(),
      owner: null,
      visibility: 'org',
    };
    const { calls, user } = renderEditor({
      [`GET ${url}`]: () => ({
        json: given.length
          ? {
              ...agent,
              mcpServers: [{ id: 'm1', name: 'tracker' }],
              tools: [
                ...agent.tools,
                {
                  connector: 'tracker',
                  name: 'tracker__create_issue',
                  title: 'Create an issue',
                  policy: 'ask',
                },
              ],
            }
          : agent,
      }),
      'GET /api/library/mcp': { servers: [tracker] },
      [`PUT ${url}/mcp`]: (body) => {
        given = (body as { servers: string[] }).servers;
        return { json: { servers: [tracker] } };
      },
    });
    const section = await screen.findByRole('region', { name: 'Tools & policies' });
    await user.click(within(section).getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: 'tracker' }));
    expect(calls.findLast((call) => call.route === `PUT ${url}/mcp`)?.body).toEqual({
      servers: ['m1'],
    });
    const group = await within(section).findByRole('group', { name: 'tracker' });
    expect(within(group).getByText('tracker, MCP server')).toBeTruthy();
    const policy = within(group).getByRole('radiogroup', { name: 'Create an issue' });
    expect(
      within(policy).getByRole('radio', { name: 'Ask owner' }).getAttribute('aria-checked'),
    ).toBe('true');
  });
});

describe('auto and manual', () => {
  it('switches every tool at once and says which mode the tools are in', async () => {
    const tool = (name: string, policy: string) => ({
      connector: 'Code host',
      name,
      title: name,
      policy,
    });
    const mixed = [
      tool('memory_read', 'allow'),
      tool('code_host_open_change_request', 'ask'),
      tool('memory_write', 'deny'),
    ];
    const allowed = [
      tool('memory_read', 'allow'),
      tool('code_host_open_change_request', 'allow'),
      tool('memory_write', 'deny'),
    ];
    const { calls, user } = renderEditor({
      [`GET ${url}`]: { ...agent, tools: mixed },
      [`PUT ${url}/tools`]: { ...agent, tools: allowed },
    });
    const section = await screen.findByRole('region', { name: 'Tools & policies' });
    expect(within(section).getByText(/Some tools ask you first/)).toBeTruthy();
    const switcher = within(section).getByRole('group', { name: 'Approvals' });
    await user.click(within(switcher).getByRole('button', { name: 'Auto' }));
    expect(calls.find((call) => call.route === `PUT ${url}/tools`)?.body).toEqual({
      policy: 'allow',
    });
    expect(await within(section).findByText(/Every tool runs without asking/)).toBeTruthy();
    expect(
      within(switcher).getByRole('button', { name: 'Auto' }).getAttribute('aria-pressed'),
    ).toBe('true');
  });
});

describe('the memory section', () => {
  const doc = (version: number, content: string, by: object) => ({
    path: 'MEMORY.md',
    version,
    content,
    updatedAt: new Date(Date.now() - version * 60_000).toISOString(),
    updatedBy: by,
  });
  const byRun = { kind: 'run', id: 'r9' };
  const byAnn = { kind: 'user', id: 'u1', name: 'Ann Admin' };

  it('opens a document, shows what changed since the version before, and reverts', async () => {
    const versions = [
      doc(2, '# Payments\n\nFreeze time in retry tests.\n', byRun),
      doc(1, '# Payments\n', byAnn),
    ];
    const { calls, user } = renderEditor({
      [`GET ${url}/memory`]: { documents: [versions[0]] },
      [`GET ${url}/memory/versions?path=MEMORY.md`]: { path: 'MEMORY.md', versions },
      [`POST ${url}/memory/revert`]: { ...doc(3, '# Payments\n', byAnn) },
    });
    const memory = await screen.findByRole('region', { name: 'Memory' });
    await user.click(await within(memory).findByRole('button', { name: /MEMORY.md/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Version 2, by a/)).toBeTruthy();
    expect(within(dialog).getByRole('link', { name: 'run' }).getAttribute('href')).toBe('/runs/r9');

    await user.click(within(dialog).getByRole('tab', { name: 'History' }));
    const changes = await within(dialog).findByLabelText('Changes');
    expect(changes.textContent).toContain('+ Freeze time in retry tests.');
    expect(changes.textContent).toContain('  # Payments');
    await user.click(within(dialog).getByRole('button', { name: /^Version 1/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Revert to version 1' }));
    expect(calls.find((call) => call.route === `POST ${url}/memory/revert`)?.body).toEqual({
      path: 'MEMORY.md',
      version: 1,
    });
  });

  it('adds a document from the version it does not have yet', async () => {
    const { calls, user } = renderEditor({
      [`PUT ${url}/memory`]: { ...doc(1, 'Pinned at 19.2.', byAnn), path: 'memory/stripe.md' },
    });
    const memory = await screen.findByRole('region', { name: 'Memory' });
    expect(within(memory).getByText(/^No memory yet/)).toBeTruthy();
    await user.click(within(memory).getByRole('button', { name: 'Add a document' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a memory document' });
    await user.clear(within(dialog).getByLabelText('Path'));
    await user.type(within(dialog).getByLabelText('Path'), 'memory/stripe.md');
    await user.type(within(dialog).getByLabelText('Text'), 'Pinned at 19.2.');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(calls.find((call) => call.route === `PUT ${url}/memory`)?.body).toEqual({
      path: 'memory/stripe.md',
      content: 'Pinned at 19.2.',
      baseVersion: 0,
    });
  });
});

describe('the policy matrix', () => {
  it('saves one choice at a time, and the last one wins', async () => {
    const tool = 'code_host_open_change_request';
    const withTool: Agent = {
      ...agent,
      tools: [
        ...agent.tools,
        { connector: 'Code host', name: tool, title: 'Open a change request', policy: 'ask' },
      ],
    };
    // The first save waits until the test lets it go; the choices after it wait behind it.
    let releaseFirst = () => {};
    const first = new Promise<void>((resolve) => (releaseFirst = resolve));
    const sent: string[] = [];
    const { user } = renderEditor({
      [`GET ${url}`]: withTool,
      [`PUT ${url}/tools/${tool}`]: async (body) => {
        const { policy } = body as { policy: string };
        sent.push(policy);
        if (sent.length === 1) await first;
        return {
          json: {
            ...withTool,
            tools: withTool.tools.map((item) => (item.name === tool ? { ...item, policy } : item)),
          },
        };
      },
    });
    const group = await screen.findByRole('radiogroup', { name: 'Open a change request' });
    const radio = (name: string) => within(group).getByRole('radio', { name });
    await user.click(radio('Allow'));
    await user.click(radio('Deny'));
    await user.click(radio('Ask owner'));
    expect(radio('Ask owner').getAttribute('aria-checked')).toBe('true');
    expect(sent).toEqual(['allow']);
    await act(async () => releaseFirst());
    // Deny went stale while it waited, so it is never sent; the server ends with the last one.
    await vi.waitFor(() => expect(sent).toEqual(['allow', 'ask']));
    await act(async () => {});
    expect(radio('Ask owner').getAttribute('aria-checked')).toBe('true');
  });

  it('shows the last 30 days of quality, and the tasks that came back most', async () => {
    renderEditor();
    const section = within(await screen.findByRole('region', { name: 'Quality' }));
    // A figure is its value, then what it counts; a share's meter is hidden from a reader.
    const said = async (label: string) =>
      (await section.findByText(label, { selector: 'dt' })).nextElementSibling?.textContent;
    expect(await said('Accepted')).toBe('80%8 of 10 handed over; 2 in review or back in work');
    expect(await said('At the first go')).toBe('63%5 of 8 accepted');
    expect(await said('Merged')).toBe('86%6 of 7 decided; 1 still open');
    expect(await said('Cost per task')).toBe('$1.20$18.40 in all');
    expect(await said('Created to review')).toBe('1 h 04 min');
    expect(await said('Failed runs')).toBe('2 of 301 on a limit');
    expect(section.getByText('4 times').parentElement?.textContent).toBe('4 times on 3 tasks');
    expect(section.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      '2 by people',
      '1 for failed CI',
      '1 for a review',
      expect.stringContaining('Retry webhooks'),
    ]);
    expect(section.getByRole('link', { name: 'Retry webhooks' }).getAttribute('href')).toBe(
      '/tasks/k7',
    );
  });

  it('on Free, keeps the server, a monthly limit and quality for a license key', async () => {
    renderEditor({
      'GET /api/license': {
        status: 'free',
        enterprise: false,
        installationId: '3f2a-91c0-7be4-55d1',
        id: null,
        company: null,
        expiresAt: null,
        graceEndsAt: null,
        agents: { limit: null, active: 2, peak: 2 },
        over: [],
      },
      'GET /api/models': { connections: [{ id: 'mc1', name: 'OpenRouter', models: [] }] },
      [`GET ${url}/quality`]: failure(
        403,
        'license_required',
        "An agent's quality needs a license key.",
      ),
    });
    expect(await screen.findByText(/Agents on the server need a license key/)).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Server' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('textbox', { name: 'Monthly limit, USD' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByText(/A monthly limit needs a license key/)).toBeTruthy();
    const section = within(screen.getByRole('region', { name: 'Quality' }));
    expect(await section.findByText(/quality comes with a license key/)).toBeTruthy();
  });

  it('transfers the agent to a colleague until a day, and leaves for the list', async () => {
    const until: string[] = [];
    const { calls, router, user } = renderEditor({
      'GET /api/people': {
        people: [
          { id: 'u1', name: 'Ann Admin' },
          { id: 'u2', name: 'Maria Garcia' },
        ],
      },
      [`POST ${url}/transfer`]: (body) => {
        until.push((body as { until: string }).until);
        return {
          json: {
            transferred: [{ id: agent.id, name: agent.name }],
            to: { id: 'u2', name: 'Maria Garcia' },
            until: (body as { until: string }).until,
          },
        };
      },
    });
    const pass = await screen.findByRole('complementary', { name: /^Agent sheet/ });
    await user.click(within(pass).getByRole('button', { name: 'Transfer ownership' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Transfer Payments backend' }));
    // For good until a day is chosen: the button says what losing the agent is.
    expect(dialog.getByRole('button', { name: 'Transfer' })).toHaveProperty('disabled', true);
    expect(dialog.getByText(/You lose access to it/)).toBeTruthy();

    await user.click(dialog.getByRole('combobox', { name: 'New owner' }));
    // The owner is not among the people it can go to.
    expect(screen.queryByRole('option', { name: 'Ann Admin' })).toBeNull();
    await user.click(screen.getByRole('option', { name: 'Maria Garcia' }));
    // Any day from tomorrow on, picked in the calendar: here the last day it shows.
    const field = dialog.getByRole('button', { name: 'Comes back' });
    expect(field.textContent).toBe('Never: it is theirs for good');
    await user.click(field);
    const days = within(screen.getByRole('grid'))
      .getAllByRole('button')
      .filter((button) => !(button as HTMLButtonElement).disabled);
    await user.click(days.at(-1) as HTMLElement);
    expect(field.textContent).toMatch(/^\d{1,2} \w{3} \d{4}$/);
    expect(dialog.getByText(/its runs go to Maria Garcia's computer/)).toBeTruthy();
    expect(dialog.getByText(/Then it comes back to you by itself/)).toBeTruthy();
    await user.click(dialog.getByRole('button', { name: 'Transfer' }));

    await screen.findByRole('heading', { name: 'Agents' });
    expect(router.state.location.pathname).toBe('/agents');
    expect(calls.find((call) => call.route === `POST ${url}/transfer`)?.body).toMatchObject({
      to: 'u2',
    });
    // The start of the day that was picked, where the person is.
    const picked = new Date(until[0] ?? '');
    expect(picked.getTime()).toBeGreaterThan(Date.now());
    expect([picked.getHours(), picked.getMinutes(), picked.getSeconds()]).toEqual([0, 0, 0]);
  });

  it('offers only to return an agent that is here until a day', async () => {
    const lent = {
      ...agent,
      people: [
        {
          id: 'u2',
          name: 'Maria Garcia',
          level: 'owner',
          validFrom: '2026-11-24T09:00:00Z',
          validUntil: null,
        },
        {
          id: 'u1',
          name: 'Ann Admin',
          level: 'owner',
          validFrom: null,
          validUntil: '2026-11-24T09:00:00Z',
        },
      ],
    };
    const { calls, user } = renderEditor({
      [`GET ${url}`]: lent,
      [`POST ${url}/transfer`]: {
        transferred: [{ id: agent.id, name: agent.name }],
        to: { id: 'u2', name: 'Maria Garcia' },
        until: null,
      },
    });
    const pass = await screen.findByRole('complementary', { name: /^Agent sheet/ });
    await user.click(within(pass).getByRole('button', { name: 'Transfer ownership' }));
    const dialog = within(
      await screen.findByRole('dialog', { name: 'Return Payments backend to Maria Garcia?' }),
    );
    expect(dialog.getByText(/It is with you until 24 Nov 2026/)).toBeTruthy();
    await user.click(dialog.getByRole('button', { name: 'Return now' }));
    await screen.findByRole('heading', { name: 'Agents' });
    expect(calls.find((call) => call.route === `POST ${url}/transfer`)?.body).toEqual({ to: 'u2' });
  });

  it('leaves Merged out for an agent that opens no change request', async () => {
    renderEditor({
      [`GET ${url}/quality`]: {
        ...quality,
        changeRequests: { merged: 0, closed: 0, open: 0 },
      },
    });
    const section = within(await screen.findByRole('region', { name: 'Quality' }));
    await section.findByText('Accepted', { selector: 'dt' });
    expect(section.queryByText('Merged', { selector: 'dt' })).toBeNull();
  });
});
