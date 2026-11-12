import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../app';
import { sidebarSeat, type Seat } from './seats-data';

const now = Date.now();
const seconds = (n: number) => new Date(now - n * 1000).toISOString();

const busy: Seat = {
  id: 's1',
  name: 'maria-mbp',
  owner: { id: 'u2', name: 'Maria Garcia' },
  kind: 'subscription-laptop',
  status: 'active',
  lastSeenAt: seconds(20),
  idleMinutes: 15,
  activeRun: { id: 'r1', agentName: 'Backend developer', startedAt: seconds(300) },
  updateCommand: null,
  signedOut: [],
  platform: null,
  sandbox: { none: false, allowedAt: null },
};
const idle: Seat = {
  ...busy,
  id: 's2',
  name: 'build-box',
  kind: 'api-server',
  lastSeenAt: seconds(3 * 3600),
  activeRun: null,
};
const revoked: Seat = { ...idle, id: 's3', name: 'old-laptop', status: 'revoked' };

type Call = { method: string; url: string; body: unknown };

/** A fake API: answers GET /api/seats with `seats` and records every call. */
const INSTALLER = 'curl -fsSL https://agentome.example.com/connect | sh -s -- K7QX-M2PH';
const CHECKOUT =
  'pnpm --filter @agentome/worker connect K7QX-M2PH --server https://agentome.example.com';

function serve(
  seats: Seat[] | Error,
  command = INSTALLER,
  {
    role = 'member',
    windowsCommand = null,
  }: { role?: string; windowsCommand?: string | null } = {},
) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      // The shell asks who is signed in before it shows a page.
      if (url === '/api/me') {
        return Response.json({ id: 'u1', name: 'Maria', email: 'maria@acme.com', role });
      }
      // And for the agents of the sidebar.
      if (url === '/api/agents') return Response.json({ agents: [] });
      // And for the license, for its banner.
      if (url === '/api/license') return Response.json({ status: 'valid' });
      if (url === '/api/approvals') return Response.json({ approvals: [] });
      if (url.startsWith('/api/tasks?')) return Response.json({ tasks: [], nextBefore: null });
      const method = init.method ?? 'GET';
      calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (method === 'GET') {
        if (seats instanceof Error) {
          const error = { error: { code: 'unauthorized', message: seats.message } };
          return Response.json(error, { status: 401 });
        }
        return Response.json(seats);
      }
      if (url === '/api/seats/pairing-codes') {
        return Response.json({
          code: 'K7QX-M2PH',
          expiresAt: '2026-10-21T14:32:00Z',
          command,
          windowsCommand,
          checkout: command === CHECKOUT,
        });
      }
      if (method === 'PATCH' || method === 'PUT') return Response.json(idle);
      return new Response(null, { status: 204 });
    }),
  );
  return calls;
}

function renderSeats() {
  render(
    <MemoryRouter initialEntries={['/admin/computers']}>
      <App />
    </MemoryRouter>,
  );
  return userEvent.setup();
}

afterEach(() => vi.unstubAllGlobals());

describe('Admin, Computers', () => {
  it('lists the seats with their state, and shows the busy one in the sidebar', async () => {
    serve([busy, idle, revoked]);
    renderSeats();
    expect(await screen.findByRole('heading', { level: 1, name: 'Computers' })).toBeTruthy();
    const rows = await screen.findAllByRole('row');
    const text = rows.map((row) => row.textContent);
    expect(text[1]).toBe('maria-mbp, Person’s computerOnlineJust nowRunning Backend developer');
    expect(text[2]).toBe('build-box, API serverOffline3 h ago');
    expect(text[3]).toContain('old-laptop, API serverRevoked');
    // A revoked seat keeps one action: to be removed from the list.
    expect(
      within(rows[3] as HTMLElement).getByRole('button', { name: 'Actions for old-laptop' }),
    ).toBeTruthy();
  });

  it('starts empty with the one action that matters', async () => {
    serve([]);
    renderSeats();
    expect(await screen.findByRole('heading', { name: 'No computers connected' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Connect a computer' })).toHaveLength(1);
  });

  it('says what went wrong when the seats do not load, and retries', async () => {
    const calls = serve(new Error('Sign in to continue.'));
    const user = renderSeats();
    expect(await screen.findByText("Couldn't load the computers")).toBeTruthy();
    expect(screen.getByText('Sign in to continue.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(calls.filter((call) => call.method === 'GET')).toHaveLength(2);
  });

  it('connects a computer with a one-time code and a command to copy', async () => {
    const calls = serve([idle]);
    // user-event puts a clipboard of its own on navigator.
    const user = renderSeats();
    await user.click(await screen.findByRole('button', { name: 'Connect a computer' }));
    const dialog = screen.getByRole('dialog', { name: 'Connect a computer' });
    expect(await within(dialog).findByText('K7QX-M2PH')).toBeTruthy();
    expect(within(dialog).getByText(/signed in with your own subscription/)).toBeTruthy();
    expect(within(dialog).getByText(/Works once, until \d\d:\d\d/)).toBeTruthy();
    expect(
      within(dialog).getByText(/needs Node.js 20 or later and Claude Code or Codex/),
    ).toBeTruthy();
    expect(within(dialog).getByText(INSTALLER)).toBeTruthy();
    expect(within(dialog).queryByText('Run it in a checkout of the repository.')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Copy command' }));
    expect(await navigator.clipboard.readText()).toBe(INSTALLER);
    expect(within(dialog).getByRole('button', { name: 'Copied' })).toBeTruthy();
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('says that the command of a server run from a checkout needs a checkout', async () => {
    serve([idle], CHECKOUT);
    const user = renderSeats();
    await user.click(await screen.findByRole('button', { name: 'Connect a computer' }));
    const dialog = screen.getByRole('dialog', { name: 'Connect a computer' });
    expect(await within(dialog).findByText(CHECKOUT)).toBeTruthy();
    expect(within(dialog).getByText('Run it in a checkout of the repository.')).toBeTruthy();
  });

  it('says that a worker is out of date and gives the command that updates it', async () => {
    const UPDATE = 'curl -fsSL https://agentome.example.com/connect | sh -s -- update';
    const old = { ...busy, id: 's4', name: 'ann-mbp', activeRun: null, updateCommand: UPDATE };
    const seat = { ...idle, updateCommand: 'docker compose --profile server-seat up -d' };
    serve([old, seat]);
    const user = renderSeats();
    const rows = await screen.findAllByRole('row');
    expect(rows[1]?.textContent).toBe('ann-mbp, Person’s computerOnlineJust nowWorker out of date');
    await user.click(screen.getByRole('button', { name: 'Actions for ann-mbp' }));
    await user.click(screen.getByRole('menuitem', { name: 'Update the worker' }));
    const dialog = screen.getByRole('dialog', { name: 'Update the worker on ann-mbp' });
    expect(within(dialog).getByText(/when it has no run in progress/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Copy command' }));
    expect(await navigator.clipboard.readText()).toBe(UPDATE);
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));

    await user.click(screen.getByRole('button', { name: 'Actions for build-box' }));
    await user.click(screen.getByRole('menuitem', { name: 'Update the worker' }));
    const image = screen.getByRole('dialog', { name: 'Update the worker on build-box' });
    expect(within(image).getByText(/older image than the server/)).toBeTruthy();
    expect(within(image).getByText('docker compose --profile server-seat up -d')).toBeTruthy();
  });

  it('says which engine is not signed in on a computer that is online', async () => {
    const out = { ...busy, id: 's5', name: 'ann-mbp', activeRun: null };
    serve([
      { ...out, signedOut: ['claude-code'] },
      { ...out, id: 's6', name: 'lee-mbp', signedOut: ['claude-code', 'codex'] },
      // What an offline computer said at its last claim is as old as that claim.
      { ...idle, signedOut: ['codex'] },
    ]);
    renderSeats();
    const text = (await screen.findAllByRole('row')).map((row) => row.textContent);
    expect(text[1]).toBe('ann-mbp, Person’s computerOnlineJust nowClaude Code is not signed in');
    expect(text[2]).toBe(
      'lee-mbp, Person’s computerOnlineJust nowClaude Code and Codex are not signed in',
    );
    expect(text[3]).toBe('build-box, API serverOffline3 h ago');
    // The New task dialog names the person's computer with the same line.
    expect(sidebarSeat([{ ...out, signedOut: ['claude-code'] }])?.activity).toBe(
      'Claude Code is not signed in',
    );
  });

  it('gives a Windows computer its own command, in PowerShell', async () => {
    const WINDOWS =
      '& ([scriptblock]::Create((irm -UseBasicParsing https://agentome.example.com/connect.ps1))) K7QX-M2PH';
    serve([idle], INSTALLER, { windowsCommand: WINDOWS });
    const user = renderSeats();
    await user.click(await screen.findByRole('button', { name: 'Connect a computer' }));
    const dialog = screen.getByRole('dialog', { name: 'Connect a computer' });
    expect(await within(dialog).findByText(INSTALLER)).toBeTruthy();
    await user.click(within(dialog).getByRole('tab', { name: 'Windows' }));
    expect(within(dialog).getByText(WINDOWS)).toBeTruthy();
    expect(
      within(dialog).getByText(/Windows has no sandbox for the agent’s commands/),
    ).toBeTruthy();
  });

  it('lets an admin allow a Windows computer to run without a sandbox, after saying what that means', async () => {
    const windows = {
      ...busy,
      id: 's7',
      name: 'maria-vdi',
      activeRun: null,
      platform: 'win32',
      sandbox: { none: true, allowedAt: null },
    };
    const calls = serve([windows], INSTALLER, { role: 'admin' });
    const user = renderSeats();
    const rows = await screen.findAllByRole('row');
    expect(rows[1]?.textContent).toBe(
      'maria-vdi, Person’s computerOnlineJust nowWaiting for an admin',
    );
    await user.click(screen.getByRole('button', { name: 'Actions for maria-vdi' }));
    await user.click(screen.getByRole('menuitem', { name: 'Allow runs without a sandbox' }));
    const dialog = screen.getByRole('dialog', {
      name: 'Allow runs without a sandbox on maria-vdi?',
    });
    expect(within(dialog).getByText(/reach any address it reaches/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Allow runs' }));
    expect(calls).toContainEqual({
      method: 'PUT',
      url: '/api/seats/s7/sandbox',
      body: { allowed: true },
    });
  });

  it('offers a member no say over the sandbox of a Windows computer', async () => {
    const windows = { ...busy, id: 's8', name: 'ann-vdi', activeRun: null, platform: 'win32' };
    serve([{ ...windows, sandbox: { none: true, allowedAt: null } }]);
    const user = renderSeats();
    await user.click(await screen.findByRole('button', { name: 'Actions for ann-vdi' }));
    expect(screen.queryByRole('menuitem', { name: /without a sandbox/ })).toBeNull();
  });

  it('removes a revoked seat from the list after asking', async () => {
    const calls = serve([idle, revoked]);
    const user = renderSeats();
    await user.click(await screen.findByRole('button', { name: 'Actions for old-laptop' }));
    expect(screen.queryByRole('menuitem', { name: 'Settings' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Update the worker' })).toBeNull();
    await user.click(screen.getByRole('menuitem', { name: 'Remove from the list' }));
    expect(screen.getByRole('dialog', { name: 'Remove old-laptop from the list?' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(calls).toContainEqual({ method: 'POST', url: '/api/seats/s3/remove', body: undefined });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('changes the name and the idle time of a seat', async () => {
    const calls = serve([idle]);
    const user = renderSeats();
    await user.click(await screen.findByRole('button', { name: 'Actions for build-box' }));
    await user.click(screen.getByRole('menuitem', { name: 'Settings' }));
    const field = screen.getByRole('textbox', { name: 'Name' });
    await user.clear(field);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('Enter a name for this computer.')).toBeTruthy();
    await user.type(field, 'Build server');
    const minutes = screen.getByRole('textbox', { name: 'Idle time, minutes' });
    await user.clear(minutes);
    await user.type(minutes, '600');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('Idle time is a whole number of minutes from 5 to 120.')).toBeTruthy();
    await user.clear(minutes);
    await user.type(minutes, '45');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(calls).toContainEqual({
      method: 'PATCH',
      url: '/api/seats/s2',
      body: { name: 'Build server', idleMinutes: 45 },
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('revokes a seat after saying what happens to its run', async () => {
    const calls = serve([busy]);
    const user = renderSeats();
    await user.click(await screen.findByRole('button', { name: 'Actions for maria-mbp' }));
    await user.click(screen.getByRole('menuitem', { name: 'Revoke seat' }));
    const dialog = screen.getByRole('dialog', { name: 'Revoke maria-mbp?' });
    expect(within(dialog).getByText(/its run of Backend developer is cancelled/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Revoke seat' }));
    expect(calls).toContainEqual({ method: 'DELETE', url: '/api/seats/s1', body: undefined });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
