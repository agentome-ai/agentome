import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../app';
import { admin, answer, failure, member, mockApi } from '../test-api';

const people = {
  users: [
    { ...admin, disabledAt: null, createdAt: '2026-10-01T09:00:00Z' },
    { ...member, disabledAt: null, createdAt: '2026-10-02T09:00:00Z' },
  ],
};
const pending = {
  invitations: [
    {
      id: 'i1',
      role: 'member',
      email: null,
      invitedBy: 'Ann Admin',
      createdAt: '2026-10-21T09:00:00Z',
      expiresAt: '2026-10-28T09:00:00Z',
    },
  ],
};

function renderPeople(routes: Parameters<typeof mockApi>[0]) {
  const calls = mockApi({
    'GET /api/me': admin,
    'GET /api/users': people,
    'GET /api/invitations': pending,
    ...routes,
  });
  render(
    <MemoryRouter initialEntries={['/admin/people']}>
      <App />
    </MemoryRouter>,
  );
  return { calls, user: userEvent.setup() };
}

describe('Admin, People', () => {
  it('lists people and pending invitations, and marks the signed-in admin', async () => {
    renderPeople({});
    // The account menu shows the email too; the row is the one in the table.
    const ann = (await screen.findByRole('cell', { name: 'ann@acme.com' })).closest('tr');
    expect(ann && within(ann).getByText('You')).toBeTruthy();
    // Nobody can disable themselves, so the admin's row has no button.
    expect(ann && within(ann).queryByRole('button')).toBeNull();
    const invitation = screen.getByText('Anyone with the link').closest('tr');
    expect(invitation?.textContent).toContain('28 Oct 2026');
  });

  it('creates an invitation link for the chosen role', async () => {
    const { calls, user } = renderPeople({
      'POST /api/invitations': answer(201, {
        id: 'i2',
        url: 'http://agentome.test/invite/tok',
        expiresAt: '2026-10-28T09:00:00Z',
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'Invite someone' }));
    const dialog = screen.getByRole('dialog', { name: 'Invite someone' });
    await user.click(within(dialog).getByRole('combobox', { name: 'Role' }));
    await user.click(screen.getByRole('option', { name: /Admin/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Create link' }));
    const link = await within(dialog).findByLabelText('Invitation link');
    expect((link as HTMLInputElement).value).toBe('http://agentome.test/invite/tok');
    expect(calls.find((call) => call.route === 'POST /api/invitations')?.body).toEqual({
      role: 'admin',
    });
  });

  it('disables a person after asking, and revokes an invitation after asking', async () => {
    const { calls, user } = renderPeople({
      'PATCH /api/users/u2': { ...member, disabledAt: '2026-10-21T10:00:00Z' },
      'DELETE /api/invitations/i1': answer(204),
    });
    await user.click(await screen.findByRole('button', { name: 'Actions for Bob Member' }));
    await user.click(screen.getByRole('menuitem', { name: 'Disable' }));
    const confirm = screen.getByRole('dialog', { name: 'Disable Bob Member?' });
    await user.click(within(confirm).getByRole('button', { name: 'Disable' }));
    expect(calls.find((call) => call.route === 'PATCH /api/users/u2')?.body).toEqual({
      disabled: true,
    });

    await user.click(
      await screen.findByRole('button', {
        name: 'Actions for the invitation for anyone with the link',
      }),
    );
    await user.click(screen.getByRole('menuitem', { name: 'Revoke' }));
    const revoke = screen.getByRole('dialog', { name: 'Revoke the invitation link?' });
    await user.click(within(revoke).getByRole('button', { name: 'Revoke' }));
    expect(calls.map((call) => call.route)).toContain('DELETE /api/invitations/i1');
  });

  it('transfers everything a person owns to the one the admin picks', async () => {
    const { calls, user } = renderPeople({
      'POST /api/users/u2/transfer-agents': {
        transferred: [{ id: 'a1', name: 'Payments backend' }],
        returned: [],
        to: { id: 'u1', name: 'Ann Admin' },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Actions for Bob Member' }));
    await user.click(screen.getByRole('menuitem', { name: 'Transfer agents' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Transfer Bob Member’s agents' }));
    expect(dialog.getByRole('button', { name: 'Transfer' })).toHaveProperty('disabled', true);
    await user.click(dialog.getByRole('combobox', { name: 'New owner' }));
    // Not to the person the agents leave.
    expect(screen.queryByRole('option', { name: 'Bob Member' })).toBeNull();
    await user.click(screen.getByRole('option', { name: 'Ann Admin' }));
    await user.click(dialog.getByRole('button', { name: 'Transfer' }));
    // The dialog says what was done: the page behind it does not change.
    const done = within(await screen.findByRole('dialog', { name: '1 agent is Ann Admin’s now' }));
    expect(done.getByText('Payments backend.')).toBeTruthy();
    await user.click(done.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.find((call) => call.route === 'POST /api/users/u2/transfer-agents')?.body).toEqual(
      {
        to: 'u1',
      },
    );
  });

  it('tells a member that only admins manage people', async () => {
    renderPeople({ 'GET /api/me': member });
    expect(
      await screen.findByRole('heading', { name: 'Only admins can manage people' }),
    ).toBeTruthy();
  });

  it('goes to sign-in when the session ends while the page is open', async () => {
    renderPeople({ 'GET /api/users': failure(401, 'unauthorized') });
    expect(await screen.findByRole('heading', { name: 'Sign in to Agentome' })).toBeTruthy();
  });
});
