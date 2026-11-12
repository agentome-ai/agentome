import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../app';
import { admin, failure, member, mockApi } from '../test-api';

const projects = {
  projects: [
    {
      id: 'p1',
      name: 'Payments',
      agentCount: 1,
      connectionCount: 1,
      createdAt: '2026-10-20T09:00:00Z',
    },
  ],
};
const github = {
  id: 'c1',
  project: { id: 'p1', name: 'Payments' },
  agent: null,
  kind: 'github',
  config: { owner: 'acme' },
  host: 'github.com',
  namespace: 'acme',
  accountLogin: null,
  lastTestedAt: null,
  syncedAt: null,
  syncError: null,
  createdAt: '2026-10-21T09:00:00Z',
};

function open(routes: Parameters<typeof mockApi>[0] = {}, who = admin) {
  const calls = mockApi({
    'GET /api/me': who,
    'GET /api/connections': { connections: [github] },
    'GET /api/projects': projects,
    ...routes,
  });
  render(
    <MemoryRouter initialEntries={['/admin/connections']}>
      <App />
    </MemoryRouter>,
  );
  return { calls, user: userEvent.setup() };
}

describe('connections', () => {
  it('answers whose account a host accepts, and never shows a token', async () => {
    const { user, calls } = open({
      'POST /api/connections/c1/test': { login: 'acme-bot', testedAt: '2026-10-22T08:00:00Z' },
      'GET /api/connections': () => ({
        json: {
          connections: [
            { ...github, accountLogin: 'acme-bot', lastTestedAt: '2026-10-22T08:00:00Z' },
          ],
        },
      }),
    });
    const row = await screen.findByRole('row', { name: /acme/ });
    // Whose token it is: the project's, for every agent on it.
    expect(row.textContent).toContain('Payments, every agent');
    expect(document.body.textContent).not.toMatch(/token_|ghp_|secret/i);

    await user.click(within(row).getByRole('button', { name: 'Actions for acme' }));
    await user.click(screen.getByRole('menuitem', { name: 'Check the token' }));
    expect(calls.some((call) => call.route === 'POST /api/connections/c1/test')).toBe(true);
    expect(await screen.findByText('acme-bot')).toBeTruthy();
  });

  it('says a token was refused without echoing it', async () => {
    const { user } = open({
      'POST /api/connections/c1/test': failure(
        400,
        'connection_unauthorized',
        'github.com does not accept this token',
      ),
    });
    const row = await screen.findByRole('row', { name: /acme/ });
    await user.click(within(row).getByRole('button', { name: 'Actions for acme' }));
    await user.click(screen.getByRole('menuitem', { name: 'Check the token' }));
    expect(await screen.findByText(/does not accept this token/)).toBeTruthy();
    expect(screen.getByText('Not checked yet')).toBeTruthy();
  });

  it('asks for what each host needs, and sends the config of the one chosen', async () => {
    const { user, calls } = open({
      'POST /api/connections': { json: github },
      'GET /api/projects/p1': {
        id: 'p1',
        name: 'Payments',
        agents: [{ id: 'a2', name: 'Docs bot', roleTitle: 'Writer', status: 'active' }],
        connections: [],
      },
    });
    await user.click(await screen.findByRole('button', { name: 'New connection' }));
    const dialog = screen.getByRole('dialog', { name: 'New connection' });
    expect(within(dialog).getByLabelText('Owner')).toBeTruthy();
    expect(within(dialog).queryByLabelText('Group')).toBeNull();

    await user.click(within(dialog).getByLabelText('GitLab'));
    expect(within(dialog).queryByLabelText('Owner')).toBeNull();
    await user.type(within(dialog).getByLabelText('GitLab address'), 'https://gitlab.acme.com');
    await user.type(within(dialog).getByLabelText('Group'), 'acme/platform');
    await user.type(within(dialog).getByLabelText('Token'), 'glpat-secret');
    await user.click(within(dialog).getByRole('button', { name: 'Connect' }));

    expect(calls.find((call) => call.route === 'POST /api/connections')?.body).toEqual({
      projectId: 'p1',
      config: { kind: 'gitlab', baseUrl: 'https://gitlab.acme.com', group: 'acme/platform' },
      token: 'glpat-secret',
    });
  });

  it('gives one agent of the project a token of its own', async () => {
    const { user, calls } = open({
      'POST /api/connections': { json: github },
      'GET /api/projects/p1': {
        id: 'p1',
        name: 'Payments',
        agents: [{ id: 'a2', name: 'Docs bot', roleTitle: 'Writer', status: 'active' }],
        connections: [],
      },
    });
    await user.click(await screen.findByRole('button', { name: 'New connection' }));
    const dialog = screen.getByRole('dialog', { name: 'New connection' });
    await user.click(within(dialog).getByRole('combobox', { name: 'For' }));
    await user.click(await screen.findByRole('option', { name: 'Docs bot only' }));
    await user.type(within(dialog).getByLabelText('Owner'), 'acme');
    await user.type(within(dialog).getByLabelText('Token'), 'github_pat_docs_bot');
    await user.click(within(dialog).getByRole('button', { name: 'Connect' }));
    expect(calls.find((call) => call.route === 'POST /api/connections')?.body).toMatchObject({
      agentId: 'a2',
      token: 'github_pat_docs_bot',
    });
  });

  it('connects Jira to one agent of the project, with a filter and the statuses to move to', async () => {
    const jira = {
      ...github,
      id: 'c2',
      kind: 'jira',
      agent: { id: 'a2', name: 'Docs bot' },
      host: 'jira.acme.com',
      namespace: 'project = DOC',
    };
    const { user, calls } = open({
      'GET /api/connections': { connections: [github, jira] },
      'POST /api/connections': { json: jira },
      'GET /api/projects/p1': {
        id: 'p1',
        name: 'Payments',
        agents: [{ id: 'a2', name: 'Docs bot', roleTitle: 'Writer', status: 'active' }],
        connections: [],
      },
    });
    expect(await screen.findByText(', issues to Docs bot')).toBeTruthy();
    await user.click(
      screen.getByRole('button', { name: 'Actions for jira.acme.com: project = DOC' }),
    );
    expect(screen.queryByRole('menuitem', { name: 'Webhook settings' })).toBeNull();
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: 'New connection' }));
    const dialog = screen.getByRole('dialog', { name: 'New connection' });
    await user.click(within(dialog).getByLabelText('Jira'));
    await user.type(within(dialog).getByLabelText('Jira address'), 'https://jira.acme.com');
    await user.type(within(dialog).getByLabelText('Project key'), 'DOC');
    await user.clear(within(dialog).getByLabelText('On merge'));
    await user.type(within(dialog).getByLabelText('On merge'), 'Closed');
    await user.type(within(dialog).getByLabelText('Token'), 'jira-pat');
    // The agent is not optional: nobody would get the issues.
    expect(within(dialog).getByRole('button', { name: 'Connect' })).toHaveProperty(
      'disabled',
      true,
    );
    await user.click(within(dialog).getByRole('combobox', { name: 'Issues go to' }));
    await user.click(await screen.findByRole('option', { name: 'Docs bot' }));
    await user.click(within(dialog).getByRole('button', { name: 'Connect' }));
    expect(calls.find((call) => call.route === 'POST /api/connections')?.body).toEqual({
      projectId: 'p1',
      agentId: 'a2',
      token: 'jira-pat',
      config: {
        kind: 'jira',
        baseUrl: 'https://jira.acme.com',
        projectKey: 'DOC',
        jql: '',
        inProgress: 'In Progress',
        inReview: 'In Review',
        done: 'Closed',
      },
    });
  });

  it('syncs Jira now, and says when the last poll failed', async () => {
    const jira = {
      ...github,
      id: 'c2',
      kind: 'jira',
      agent: { id: 'a2', name: 'Docs bot' },
      host: 'jira.acme.com',
      namespace: 'project = DOC',
      syncError: 'jira.acme.com answered 503',
    };
    const { user, calls } = open({
      'GET /api/connections': { connections: [jira] },
      'POST /api/connections/c2/sync': { json: { imported: 2, updated: 0 } },
    });
    expect(await screen.findByText('Sync failed')).toBeTruthy();
    await user.click(
      screen.getByRole('button', { name: 'Actions for jira.acme.com: project = DOC' }),
    );
    await user.click(screen.getByRole('menuitem', { name: 'Sync issues now' }));
    expect(calls.some((call) => call.route === 'POST /api/connections/c2/sync')).toBe(true);
  });

  it("hands the administrator the webhook's address and secret to paste into the host", async () => {
    const { user } = open({
      'GET /api/connections/c1/webhook': {
        url: 'https://agentome.acme.com/webhooks/github/c1',
        secret: 'a'.repeat(64),
      },
    });
    const row = await screen.findByRole('row', { name: /acme/ });
    await user.click(within(row).getByRole('button', { name: 'Actions for acme' }));
    await user.click(screen.getByRole('menuitem', { name: 'Webhook settings' }));
    expect(await screen.findByText('https://agentome.acme.com/webhooks/github/c1')).toBeTruthy();
    expect(screen.getByText('a'.repeat(64))).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy secret' })).toBeTruthy();
  });

  it('warns before deleting a connection, and says what stops working', async () => {
    const { user, calls } = open({ 'DELETE /api/connections/c1': { status: 204 } });
    const row = await screen.findByRole('row', { name: /acme/ });
    await user.click(within(row).getByRole('button', { name: 'Actions for acme' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete connection' }));
    const dialog = screen.getByRole('dialog', { name: /Delete the connection to acme/ });
    expect(dialog.textContent).toContain(
      'Agents of Payments without a token of their own stop reaching its repositories, and this token is erased',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Delete connection' }));
    expect(calls.some((call) => call.route === 'DELETE /api/connections/c1')).toBe(true);
  });

  it('asks for a project before a connection can belong to one', async () => {
    open({ 'GET /api/connections': { connections: [] }, 'GET /api/projects': { projects: [] } });
    expect(await screen.findByText('Create a project first')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New connection' })).toBeNull();
  });

  it('shows a member nothing but who to ask', async () => {
    open({}, member);
    expect(await screen.findByText('Only admins manage connections')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });
});
