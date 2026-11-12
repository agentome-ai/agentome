import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../app';
import { admin, failure, mockApi } from '../test-api';

async function renderPage(routes: Parameters<typeof mockApi>[0]) {
  const calls = mockApi({ 'GET /api/me': { ...admin, email: 'ann@acme.com' }, ...routes });
  render(
    <MemoryRouter initialEntries={['/settings/account']}>
      <App />
    </MemoryRouter>,
  );
  await screen.findByRole('heading', { name: 'Account' });
  // After a save the shell asks for the person again.
  const reloads = () => calls.filter((call) => call.route === 'GET /api/me').length - 1;
  const last = (route: string) => calls.filter((call) => call.route === route).at(-1);
  return { calls, last, reloads, user: userEvent.setup() };
}

describe('Settings, Account', () => {
  it('renames without a password', async () => {
    const { last, reloads, user } = await renderPage({
      'PATCH /api/me': { id: 'u1', name: 'Ann Lee', email: 'ann@acme.com', role: 'admin' },
    });
    const save = screen.getByRole('button', { name: 'Save changes' });
    expect(save.hasAttribute('disabled')).toBe(true);
    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'Ann Lee');
    // Only the password form asks for it: a new name needs no password.
    expect(screen.getAllByLabelText('Current password')).toHaveLength(1);
    await user.click(save);
    expect(last('PATCH /api/me')).toEqual({ route: 'PATCH /api/me', body: { name: 'Ann Lee' } });
    expect(reloads()).toBe(1);
    expect(screen.getByRole('status').textContent).toBe('Saved.');
  });

  it('asks for the current password for a new email, and says when it is wrong', async () => {
    const { last, reloads, user } = await renderPage({
      'PATCH /api/me': failure(400, 'invalid_password'),
    });
    expect(screen.getAllByLabelText('Current password')).toHaveLength(1);
    await user.clear(screen.getByLabelText('Email'));
    await user.type(screen.getByLabelText('Email'), 'ann@lee.com');
    const [forEmail] = screen.getAllByLabelText('Current password');
    const save = screen.getByRole('button', { name: 'Save changes' });
    expect(save.hasAttribute('disabled')).toBe(true);
    await user.type(forEmail as HTMLElement, 'not my password');
    await user.click(save);
    expect(last('PATCH /api/me')?.body).toEqual({
      name: 'Ann Admin',
      email: 'ann@lee.com',
      currentPassword: 'not my password',
    });
    expect(screen.getByRole('alert').textContent).toBe(
      'The current password is wrong. Check it, then try again.',
    );
    expect(reloads()).toBe(0);
  });

  it('changes the password and signs the other devices out', async () => {
    const { last, user } = await renderPage({ 'POST /api/auth/change-password': {} });
    const change = screen.getByRole('button', { name: 'Change password' });
    await user.type(screen.getByLabelText('Current password'), 'old long password');
    await user.type(screen.getByLabelText('New password'), 'short');
    expect(change.hasAttribute('disabled')).toBe(true);
    await user.type(screen.getByLabelText('New password'), ' but now long enough');
    await user.click(change);
    expect(last('POST /api/auth/change-password')).toEqual({
      route: 'POST /api/auth/change-password',
      body: {
        currentPassword: 'old long password',
        newPassword: 'short but now long enough',
        revokeOtherSessions: true,
      },
    });
    expect(screen.getByRole('status').textContent).toBe(
      'Password changed. Your other devices are signed out.',
    );
    expect((screen.getByLabelText('New password') as HTMLInputElement).value).toBe('');
  });
});
