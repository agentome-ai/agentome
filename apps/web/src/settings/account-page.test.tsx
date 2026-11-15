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

  it('turns on two-step sign-in: the password, the app, its first code, then backup codes', async () => {
    const uri = 'otpauth://totp/Agentome:ann%40acme.com?secret=JBSWY3DPEHPK3PXP&issuer=Agentome';
    const { last, user } = await renderPage({
      'GET /api/me/two-factor': { available: true, enabled: false },
      'POST /api/auth/two-factor/enable': {
        totpURI: uri,
        backupCodes: ['aaaaa-bbbbb', 'ccccc-ddddd'],
      },
      'POST /api/auth/two-factor/verify-totp': { status: true },
    });
    await user.click(await screen.findByRole('button', { name: 'Turn on' }));
    await user.type(screen.getByLabelText('Your password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(last('POST /api/auth/two-factor/enable')?.body).toEqual({
      password: 'correct horse battery',
    });
    expect(
      await screen.findByRole('img', { name: 'QR code for your authenticator app' }),
    ).toBeTruthy();
    expect(screen.getByText('JBSWY3DPEHPK3PXP')).toBeTruthy();
    await user.type(screen.getByLabelText('Code from the app'), '12a3456');
    await user.click(screen.getByRole('button', { name: 'Turn on' }));
    expect(last('POST /api/auth/two-factor/verify-totp')?.body).toEqual({ code: '123456' });
    const list = await screen.findByRole('list', { name: 'Backup codes' });
    expect(list.textContent).toBe('aaaaa-bbbbbccccc-ddddd');
  });

  it('shows nothing of it to someone whom Keycloak alone signs in', async () => {
    await renderPage({ 'GET /api/me/two-factor': { available: false, enabled: false } });
    await screen.findByRole('heading', { name: 'Password' });
    expect(screen.queryByRole('heading', { name: 'Two-step sign-in' })).toBeNull();
  });

  it('keeps an admin from turning it off', async () => {
    await renderPage({ 'GET /api/me/two-factor': { available: true, enabled: true } });
    expect(await screen.findByRole('button', { name: 'New backup codes' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Turn off' })).toBeNull();
  });
});

describe('an admin without the second step', () => {
  it('is sent to set it up before anything else', async () => {
    mockApi({ 'GET /api/me': failure(403, 'two_factor_required') });
    render(
      <MemoryRouter initialEntries={['/agents']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'Set up two-step sign-in' })).toBeTruthy();
  });
});
