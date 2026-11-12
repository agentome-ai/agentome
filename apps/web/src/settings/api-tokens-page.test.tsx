import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../app';
import { admin, mockApi } from '../test-api';

function renderTokens(routes: Parameters<typeof mockApi>[0]) {
  const calls = mockApi({ 'GET /api/me': admin, ...routes });
  render(
    <MemoryRouter initialEntries={['/settings/api-tokens']}>
      <App />
    </MemoryRouter>,
  );
  return { calls, user: userEvent.setup() };
}

describe('Settings, API tokens', () => {
  it('lists tokens, makes one that shows once with its command, and revokes', async () => {
    const { calls, user } = renderTokens({
      'GET /api/me/tokens': {
        tokens: [
          {
            id: 'k1',
            name: 'Old laptop',
            scope: 'read',
            createdAt: '2026-10-01T10:00:00Z',
            expiresAt: '2026-10-08T10:00:00Z',
            lastUsedAt: null,
          },
        ],
      },
      'POST /api/me/tokens': () => ({
        status: 201,
        json: {
          id: 'k2',
          name: 'Claude Code',
          scope: 'write',
          createdAt: '2026-10-24T10:00:00Z',
          expiresAt: null,
          lastUsedAt: null,
          token: 'tok_shown_once',
        },
      }),
      'DELETE /api/me/tokens/k1': () => ({ status: 204 }),
    });
    const list = await screen.findByRole('table', { name: 'Your tokens' });
    expect(within(list).getByText('Old laptop')).toBeTruthy();
    expect(within(list).getByText('Read only')).toBeTruthy();
    expect(within(list).getByText('Expired 8 Oct 2026')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'New token' }));
    const composer = screen.getByRole('dialog', { name: 'New token' });
    expect(within(composer).getByRole('button', { name: 'Create token' })).toHaveProperty(
      'disabled',
      true,
    );
    await user.type(within(composer).getByLabelText('Token name'), 'Claude Code');
    await user.click(within(composer).getByRole('button', { name: 'Create token' }));
    expect(await within(composer).findByText('tok_shown_once')).toBeTruthy();
    expect(within(composer).getByText(/claude mcp add --transport http agentome/)).toBeTruthy();
    expect(calls.find((call) => call.route === 'POST /api/me/tokens')?.body).toEqual({
      name: 'Claude Code',
      scope: 'write',
      expiresInDays: 30,
    });
    await user.click(within(composer).getByRole('button', { name: 'Done' }));

    expect(await within(list).findByText('Claude Code')).toBeTruthy();
    await user.click(within(list).getByRole('button', { name: 'Actions for Old laptop' }));
    await user.click(screen.getByRole('menuitem', { name: 'Revoke' }));
    expect(await screen.findByText('Claude Code')).toBeTruthy();
    expect(screen.queryByText('Old laptop')).toBeNull();
  });

  it('makes a token for a custom number of days, up to a year, to read only', async () => {
    const { calls, user } = renderTokens({
      'GET /api/me/tokens': { tokens: [] },
      'POST /api/me/tokens': () => ({
        status: 201,
        json: {
          id: 'k3',
          name: 'CI',
          scope: 'read',
          createdAt: '2026-10-24T10:00:00Z',
          expiresAt: '2027-01-22T10:00:00Z',
          lastUsedAt: null,
          token: 'tok_ci',
        },
      }),
    });
    await user.click(await screen.findByRole('button', { name: 'New token' }));
    const composer = screen.getByRole('dialog', { name: 'New token' });
    await user.type(within(composer).getByLabelText('Token name'), 'CI');
    await user.click(within(composer).getByRole('combobox', { name: 'Expires: 30 days' }));
    await user.click(await screen.findByRole('option', { name: 'Custom' }));
    const daysField = within(composer).getByLabelText('Days');
    await user.clear(daysField);
    await user.type(daysField, '400');
    expect(within(composer).getByText('A custom expiry is from 1 to 365 days.')).toBeTruthy();
    expect(within(composer).getByRole('button', { name: 'Create token' })).toHaveProperty(
      'disabled',
      true,
    );
    await user.clear(daysField);
    await user.type(daysField, '90');
    await user.click(within(composer).getByRole('combobox', { name: 'Access: Read and write' }));
    await user.click(await screen.findByRole('option', { name: /Read only/ }));
    await user.click(within(composer).getByRole('button', { name: 'Create token' }));
    expect(await within(composer).findByText('tok_ci')).toBeTruthy();
    expect(calls.find((call) => call.route === 'POST /api/me/tokens')?.body).toEqual({
      name: 'CI',
      scope: 'read',
      expiresInDays: 90,
    });
  });
});
