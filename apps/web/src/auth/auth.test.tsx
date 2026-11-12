import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { admin, answer, failure, member, mockApi } from '../test-api';
import { InvitePage } from './invite-page';
import { LoginPage } from './login-page';
import { ResetPage } from './reset-page';
import { SetupPage } from './setup-page';

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname + location.search}</p>;
}

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/invite/:token" element={<InvitePage />} />
        <Route path="/reset-password" element={<ResetPage />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
  return userEvent.setup();
}

const where = async () => (await screen.findByTestId('where')).textContent;

describe('the sign-in page', () => {
  it('signs in with Keycloak when the server has it, back to the page that asked', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    const calls = mockApi({
      'GET /api/setup': { completed: true, keycloak: true },
      'POST /api/auth/sign-in/social': {
        url: 'https://sso.acme.com/realms/acme/auth',
        redirect: true,
      },
    });
    const user = renderAt('/login?next=%2Ftasks');
    await user.click(await screen.findByRole('button', { name: 'Sign in with Keycloak' }));
    expect(calls.find((call) => call.route === 'POST /api/auth/sign-in/social')?.body).toEqual({
      provider: 'keycloak',
      callbackURL: '/tasks',
      errorCallbackURL: '/login',
    });
    expect(assign).toHaveBeenCalledWith('https://sso.acme.com/realms/acme/auth');
    vi.unstubAllGlobals();
  });

  it('has no Keycloak button without Keycloak, and says why a Keycloak sign-in failed', async () => {
    mockApi({ 'GET /api/setup': { completed: true, keycloak: false } });
    renderAt('/login?error=ACCOUNT_DISABLED');
    expect(
      await screen.findByText('This account is disabled. Ask an admin to enable it.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign in with Keycloak' })).toBeNull();
  });

  it('signs in and goes back to the page that asked for it', async () => {
    const calls = mockApi({ 'POST /api/auth/sign-in/email': { user: admin } });
    const user = renderAt('/login?next=%2Fadmin%2Fpeople');
    await user.type(screen.getByLabelText('Email'), ' ann@acme.com ');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await where()).toBe('/admin/people');
    expect(calls.find((call) => call.route === 'POST /api/auth/sign-in/email')?.body).toEqual({
      email: 'ann@acme.com',
      password: 'correct horse battery',
    });
  });

  it('never follows a next address to another site', async () => {
    mockApi({ 'POST /api/auth/sign-in/email': { user: admin } });
    const user = renderAt('/login?next=%2F%2Fevil.example%2F');
    await user.type(screen.getByLabelText('Email'), 'ann@acme.com');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await where()).toBe('/');
  });

  it('says what to do when the password is wrong or the account is disabled', async () => {
    mockApi({ 'POST /api/auth/sign-in/email': failure(401, 'invalid_email_or_password') });
    const user = renderAt('/login');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByText('Enter an email address like ann@example.com.')).toBeTruthy();
    expect(screen.getByLabelText('Email').getAttribute('aria-invalid')).toBe('true');

    await user.type(screen.getByLabelText('Email'), 'ann@acme.com');
    await user.type(screen.getByLabelText('Password'), 'wrong password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The email or password is wrong. Check both, then try again.',
    );

    mockApi({
      'POST /api/auth/sign-in/email': failure(
        403,
        'account_disabled',
        'This account is disabled. Ask an admin to enable it.',
      ),
    });
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'This account is disabled. Ask an admin to enable it.',
    );
  });

  it('shows and hides the password', async () => {
    const user = renderAt('/login');
    const password = screen.getByLabelText('Password');
    expect(password.getAttribute('type')).toBe('password');
    await user.click(screen.getByRole('button', { name: 'Show password' }));
    expect(password.getAttribute('type')).toBe('text');
    await user.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(password.getAttribute('type')).toBe('password');
  });
});

describe('the setup page', () => {
  async function fill(user: ReturnType<typeof userEvent.setup>, confirm = 'correct horse battery') {
    await user.type(screen.getByLabelText('Setup code'), ' 1a2b-3c4d-5e6f-7a8b ');
    await user.type(screen.getByLabelText('Company name'), 'Acme');
    await user.type(screen.getByLabelText('Your name'), 'Ann Admin');
    await user.type(screen.getByLabelText('Email'), 'ann@acme.com');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.type(screen.getByLabelText('Confirm password'), confirm);
  }

  it('creates the company and the administrator, then opens the product', async () => {
    const calls = mockApi({
      'GET /api/setup': { completed: false },
      'POST /api/setup': answer(201, admin),
    });
    const user = renderAt('/setup');
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Create the administrator account' }));
    expect(await where()).toBe('/');
    expect(calls.at(-1)?.body).toEqual({
      code: '1a2b-3c4d-5e6f-7a8b',
      orgName: 'Acme',
      admin: { name: 'Ann Admin', email: 'ann@acme.com', password: 'correct horse battery' },
    });
  });

  it('checks the password length and the confirmation before sending', async () => {
    const calls = mockApi({ 'GET /api/setup': { completed: false } });
    const user = renderAt('/setup');
    await fill(user, 'something else entirely');
    await user.clear(screen.getByLabelText('Password'));
    await user.type(screen.getByLabelText('Password'), 'short');
    await user.click(screen.getByRole('button', { name: 'Create the administrator account' }));
    expect(screen.getByText('Use at least 12 characters.')).toBeTruthy();
    expect(screen.getByText("The passwords don't match.")).toBeTruthy();
    // Focus goes to the first field in error, so a screen reader reads its message.
    expect(document.activeElement).toBe(screen.getByLabelText('Password'));
    expect(calls.map((call) => call.route)).toEqual(['GET /api/setup']);
  });

  it("shows the server's answer to a wrong setup code under the field", async () => {
    const message = "This is not the setup code. Find it in the server's log.";
    mockApi({
      'GET /api/setup': { completed: false },
      'POST /api/setup': answer(400, {
        error: { code: 'validation_failed', message, details: [{ path: 'body/code', message }] },
      }),
    });
    const user = renderAt('/setup');
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Create the administrator account' }));
    expect(await screen.findByText(message)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText('Setup code'));
  });

  it('goes to the app on an installation that is set up, where a signed-in person stays', async () => {
    mockApi({ 'GET /api/setup': { completed: true } });
    renderAt('/setup');
    expect(await where()).toBe('/');
  });
});

describe('the page for a new password', () => {
  it('sets it with the link, then sends the person to sign in with it', async () => {
    const calls = mockApi({
      'GET /api/setup': { completed: true, keycloak: false },
      'POST /api/auth/reset-password': { status: true },
    });
    const user = renderAt('/reset-password#one-time-token');
    expect(screen.getByRole('heading', { name: 'Set a new password' })).toBeTruthy();
    // Checked here before anything is sent: too short, then not the same twice.
    await user.type(screen.getByLabelText('New password'), 'short');
    await user.type(screen.getByLabelText('Confirm password'), 'short');
    await user.click(screen.getByRole('button', { name: 'Set the password' }));
    expect(screen.getByText('Use at least 12 characters.')).toBeTruthy();
    await user.clear(screen.getByLabelText('New password'));
    await user.type(screen.getByLabelText('New password'), 'a new long password');
    await user.click(screen.getByRole('button', { name: 'Set the password' }));
    expect(screen.getByText("The passwords don't match.")).toBeTruthy();
    expect(calls.some((call) => call.route === 'POST /api/auth/reset-password')).toBe(false);

    await user.clear(screen.getByLabelText('Confirm password'));
    await user.type(screen.getByLabelText('Confirm password'), 'a new long password');
    await user.click(screen.getByRole('button', { name: 'Set the password' }));
    expect(await screen.findByRole('heading', { name: 'Sign in to Agentome' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe(
      'Your password is changed. Sign in with the new one.',
    );
    expect(calls.find((call) => call.route === 'POST /api/auth/reset-password')?.body).toEqual({
      token: 'one-time-token',
      newPassword: 'a new long password',
    });
  });

  it('says so when the link was used or has run out, and where a new one comes from', async () => {
    mockApi({
      'POST /api/auth/reset-password': failure(400, 'invalid_token', 'Invalid token'),
    });
    const user = renderAt('/reset-password#used-token');
    await user.type(screen.getByLabelText('New password'), 'a new long password');
    await user.type(screen.getByLabelText('Confirm password'), 'a new long password');
    await user.click(screen.getByRole('button', { name: 'Set the password' }));
    expect(
      await screen.findByRole('heading', { name: "This link doesn't work any more" }),
    ).toBeTruthy();
    expect(screen.getByText(/Ask whoever runs your Agentome for a new one/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/login');
  });
});

describe('a link for a new password without its secret', () => {
  it('is as good as a used one', () => {
    mockApi({});
    renderAt('/reset-password');
    expect(screen.getByRole('heading', { name: "This link doesn't work any more" })).toBeTruthy();
  });
});

describe('the invitation page', () => {
  it('creates the account with the role of the invitation', async () => {
    const calls = mockApi({
      'GET /api/invitations/abc': {
        valid: true,
        role: 'member',
        email: null,
        invitedBy: 'Ann Admin',
        orgName: 'Acme',
      },
      'POST /api/invitations/abc/accept': answer(201, member),
    });
    const user = renderAt('/invite/abc');
    expect(await screen.findByText('Ann Admin invited you to join Acme as a member.')).toBeTruthy();
    await user.type(screen.getByLabelText('Your name'), 'Bob Member');
    await user.type(screen.getByLabelText('Email'), 'bob@acme.com');
    await user.type(screen.getByLabelText('Password'), 'another long password');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await where()).toBe('/');
    expect(calls.at(-1)?.body).toEqual({
      name: 'Bob Member',
      email: 'bob@acme.com',
      password: 'another long password',
    });
  });

  it('keeps the address of an invitation made for one person', async () => {
    mockApi({ 'GET /api/invitations/abc': { valid: true, role: 'admin', email: 'dave@acme.com' } });
    renderAt('/invite/abc');
    const email = await screen.findByLabelText('Email');
    expect((email as HTMLInputElement).value).toBe('dave@acme.com');
    expect(email.hasAttribute('readonly')).toBe(true);
    expect(screen.getByText(/You're invited as an admin/)).toBeTruthy();
  });

  it('explains a link that no longer works', async () => {
    mockApi({ 'GET /api/invitations/abc': { valid: false, reason: 'expired' } });
    renderAt('/invite/abc');
    expect(
      await screen.findByRole('heading', { name: 'This invitation has expired' }),
    ).toBeTruthy();
  });

  it('puts an address that already has an account next to the email field', async () => {
    mockApi({
      'GET /api/invitations/abc': { valid: true, role: 'member', email: null },
      'POST /api/invitations/abc/accept': failure(
        409,
        'email_taken',
        'Someone already has an account.',
      ),
    });
    const user = renderAt('/invite/abc');
    await user.type(await screen.findByLabelText('Your name'), 'Bob Member');
    await user.type(screen.getByLabelText('Email'), 'bob@acme.com');
    await user.type(screen.getByLabelText('Password'), 'another long password');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Someone already has an account.')).toBeTruthy();
    expect(screen.getByLabelText('Email').getAttribute('aria-invalid')).toBe('true');
  });
});
