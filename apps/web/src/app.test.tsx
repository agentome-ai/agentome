import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from './app';
import { admin, failure, mockApi } from './test-api';

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
  return userEvent.setup();
}

describe('app shell', () => {
  // The dashboard asks for the runs going now and those finished today.
  const none = { runs: [], nextBefore: null };
  const dashboard = Object.fromEntries(
    ['waiting_approval', 'running', 'queued', 'done', 'failed'].map((status) => [
      `GET /api/runs?status=${status}&limit=100`,
      none,
    ]),
  );
  beforeEach(() => {
    mockApi({ 'GET /api/me': admin, 'GET /api/projects': { projects: [] }, ...dashboard });
  });

  it('renders the sidebar and the empty state of the page', async () => {
    renderAt('/');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    for (const name of ['Dashboard', 'Approvals', 'Agents', 'Tasks', 'Projects', 'Library']) {
      expect(within(nav).getByRole('link', { name })).toBeTruthy();
    }
    expect(screen.getByRole('link', { name: 'Admin' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeTruthy();
    expect(await screen.findByText('No agent at work, nothing waits for you.')).toBeTruthy();
  });

  it('counts the tasks in work next to Tasks, quietly', async () => {
    const task = (id: string, status: string | null) => ({
      id,
      latestRun: status ? { id: `r-${id}`, status, at: '2026-10-30T12:00:00Z' } : null,
    });
    mockApi({
      'GET /api/me': admin,
      ...dashboard,
      'GET /api/tasks?status=open&limit=100': {
        tasks: [
          task('a', 'running'),
          task('b', 'waiting_approval'),
          task('c', 'done'),
          task('d', null),
        ],
        nextBefore: null,
      },
    });
    renderAt('/');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    const tasks = within(nav).getByRole('link', { name: /^Tasks/ });
    const count = await within(tasks).findByText('2');
    // Read out as "2 in work", not the waiting colour of Approvals: nothing waits on the person.
    expect(tasks.textContent).toBe('Tasks2 in work');
    expect(count.className).toContain('text-ink-3');
  });

  it('opens the work of an agent at work, and the settings of the rest', async () => {
    const agent = (id: string, lastRun: object | null) => ({
      id,
      name: `Agent ${id}`,
      roleTitle: '',
      status: 'active',
      owner: { id: 'u1', name: 'Ann' },
      lastRun,
      createdAt: '2026-10-30T12:00:00Z',
    });
    const at = '2026-10-30T12:00:00Z';
    mockApi({
      'GET /api/me': admin,
      ...dashboard,
      'GET /api/agents': {
        agents: [
          agent('a', { id: 'r1', taskId: 't1', status: 'running', at }),
          agent('b', { id: 'r2', taskId: null, status: 'failed', at }),
          agent('c', { id: 'r3', taskId: 't3', status: 'done', at }),
        ],
      },
    });
    renderAt('/');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    const link = (name: string) => within(nav).findByRole('link', { name: new RegExp(`^${name}`) });
    expect((await link('Agent a')).getAttribute('href')).toBe('/tasks/t1');
    expect((await link('Agent b')).getAttribute('href')).toBe('/runs/r2');
    // A done run is not shown in the sidebar at all: the agent is on Agents.
    expect(within(nav).queryByRole('link', { name: /^Agent c/ })).toBeNull();
  });

  it('opens the command palette with ⌘K and goes to the chosen page', async () => {
    const user = renderAt('/');
    await screen.findByRole('navigation', { name: 'Main' });
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.keyboard('{Meta>}k{/Meta}');
    const palette = screen.getByRole('dialog', { name: 'Go to a page' });
    await user.type(within(palette).getByRole('combobox'), 'libr');
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Library' })).toBeTruthy();
  });

  it("opens the rest of the app from More in the tab bar, as an app's own screen", async () => {
    const user = renderAt('/');
    const tabs = within(await screen.findByRole('navigation', { name: 'Tabs' }));
    await user.click(tabs.getByRole('link', { name: 'More' }));
    expect(screen.getByRole('heading', { level: 1, name: 'More' })).toBeTruthy();
    // More stays lit for the pages it leads to; the tab bar's own pages are not repeated.
    expect(tabs.getByRole('link', { name: 'More' }).getAttribute('aria-current')).toBe('page');
    const more = within(screen.getByRole('main'));
    expect(more.queryByRole('link', { name: 'Runs' })).toBeNull();
    // The theme switches in place.
    await user.click(more.getByRole('radio', { name: 'Dark' }));
    expect(more.getByRole('radio', { name: 'Dark' }).getAttribute('aria-checked')).toBe('true');
    await user.click(more.getByRole('link', { name: 'Library' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Library' })).toBeTruthy();
    expect(tabs.getByRole('link', { name: 'More' }).getAttribute('aria-current')).toBe('page');
  });

  it('opens the palette with Ctrl+K too and collapses the sidebar with [', async () => {
    const user = renderAt('/agents');
    await screen.findByRole('navigation', { name: 'Main' });
    await user.keyboard('{Control>}k{/Control}');
    expect(screen.getByRole('dialog', { name: 'Go to a page' })).toBeTruthy();
    await user.keyboard('{Escape}');
    // The logo in full, then the mark alone in the rail.
    const logo = () =>
      within(screen.getByRole('complementary', { name: 'Sidebar' })).getByRole('img', {
        name: 'Agentome',
      });
    expect(logo().getAttribute('viewBox')).toBe('0 0 1065 200');
    await user.keyboard('[['); // [[ types a literal [
    expect(logo().getAttribute('viewBox')).toBe('0 0 270 200');
    expect(screen.getByRole('link', { name: 'Agents' }).textContent).toBe('');
  });

  it('switches the theme from the account menu and remembers it', async () => {
    const user = renderAt('/');
    const root = document.documentElement;
    await user.click(await screen.findByRole('button', { name: 'Ann Admin' }));
    await user.click(screen.getByRole('menuitemradio', { name: 'Dark' }));
    expect(root.dataset.theme).toBe('dark');
    expect(localStorage.getItem('agentome-theme')).toBe('dark');

    await user.click(screen.getByRole('button', { name: 'Ann Admin' }));
    expect(screen.getByRole('menuitemradio', { name: 'Dark' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    await user.click(screen.getByRole('menuitemradio', { name: 'System' }));
    expect(root.dataset.theme).toBeUndefined();
    expect(localStorage.getItem('agentome-theme')).toBeNull();
  });

  it('shows a page for an unknown address', async () => {
    renderAt('/nowhere');
    expect(await screen.findByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy();
  });
});

describe('the session', () => {
  it('sends a visitor without a session to sign-in, and back afterwards', async () => {
    mockApi({
      'GET /api/me': failure(401, 'unauthorized'),
      'POST /api/auth/sign-in/email': { user: admin },
    });
    const user = renderAt('/agents?view=all');
    await user.type(await screen.findByLabelText('Email'), 'ann@acme.com');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    mockApi({ 'GET /api/me': admin, 'POST /api/auth/sign-in/email': { user: admin } });
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Agents' })).toBeTruthy();
  });

  it('sends everyone to /setup before the setup', async () => {
    mockApi({
      'GET /api/me': failure(409, 'setup_required'),
      'GET /api/setup': { completed: false },
    });
    renderAt('/');
    expect(await screen.findByRole('heading', { level: 1, name: 'Set up Agentome' })).toBeTruthy();
  });

  it('shows the person in the account menu and signs them out', async () => {
    const calls = mockApi({ 'GET /api/me': admin, 'POST /api/auth/sign-out': { success: true } });
    const user = renderAt('/');
    await user.click(await screen.findByRole('button', { name: 'Ann Admin' }));
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Sign in to Agentome' }),
    ).toBeTruthy();
    expect(calls.map((call) => call.route)).toContain('POST /api/auth/sign-out');
  });

  it('says what happened when the server cannot be reached', async () => {
    mockApi({ 'GET /api/me': failure(0, 'network', "Couldn't reach the server.") });
    renderAt('/');
    expect((await screen.findByRole('alert')).textContent).toContain("Couldn't reach the server.");
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});
