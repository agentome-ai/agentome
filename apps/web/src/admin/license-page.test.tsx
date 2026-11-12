import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../app';
import { admin, failure, member, mockApi } from '../test-api';

const free = {
  status: 'free',
  enterprise: false,
  installationId: '3f2a-91c0-7be4-55d1',
  id: null,
  company: null,
  expiresAt: null,
  graceEndsAt: null,
  agents: { limit: null, active: 4, peak: 4 },
  over: [],
};
const licensed = {
  ...free,
  status: 'valid',
  enterprise: true,
  id: 'l-2027',
  company: 'Acme',
  expiresAt: '2027-11-02T23:59:59.999Z',
  graceEndsAt: '2027-11-16T23:59:59.999Z',
  agents: { limit: 3, active: 4, peak: 4 },
};
const readOnly = { ...free, status: 'read_only', over: ['agents', 'server_agents'] };

function renderAt(path: string, routes: Parameters<typeof mockApi>[0], me = admin) {
  const calls = mockApi({ 'GET /api/me': me, ...routes });
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
  return { calls, user: userEvent.setup() };
}

describe('Admin, License', () => {
  it('shows Free and its installation ID, takes a key and says whom it is licensed to', async () => {
    const { calls, user } = renderAt('/admin/license', {
      'GET /api/license': free,
      'PUT /api/admin/license': licensed,
    });
    expect(await screen.findByRole('heading', { name: 'Free' })).toBeTruthy();
    expect(screen.getByText('3f2a-91c0-7be4-55d1')).toBeTruthy();
    expect(screen.getByText(/of 5 on Free/)).toBeTruthy();
    await user.type(screen.getByLabelText('License key'), 'agentome-license-v1.abc.def');
    await user.click(screen.getByRole('button', { name: 'Apply key' }));
    expect(await screen.findByRole('heading', { name: 'Licensed to Acme' })).toBeTruthy();
    expect(calls.find((call) => call.route === 'PUT /api/admin/license')?.body).toEqual({
      key: 'agentome-license-v1.abc.def',
    });
    expect(screen.getByText('The new key is in. It works at once.')).toBeTruthy();
    // Over the plan is said, never enforced.
    expect(screen.getByText(/Over the plan by 1/)).toBeTruthy();
  });

  it('says what is wrong with a key it refuses', async () => {
    const { user } = renderAt('/admin/license', {
      'GET /api/license': free,
      'PUT /api/admin/license': failure(
        400,
        'invalid_license',
        'This license key was not issued for Agentome, or it was changed.',
      ),
    });
    await user.type(await screen.findByLabelText('License key'), 'agentome-license-v1.x.y');
    await user.click(screen.getByRole('button', { name: 'Apply key' }));
    expect(
      await screen.findByText('This license key was not issued for Agentome, or it was changed.'),
    ).toBeTruthy();
  });

  it('says where a read-only installation is over Free and how to cut back', async () => {
    renderAt('/admin/license', { 'GET /api/license': readOnly });
    expect(await screen.findByText('Read-only: over Free without a license key')).toBeTruthy();
    expect(screen.getByText('More than 5 active agents')).toBeTruthy();
    expect(screen.getByText('Agents on the server')).toBeTruthy();
    expect(screen.getByText(/or cut back to Free/)).toBeTruthy();
  });
});

describe('the license banner', () => {
  it('says nothing while the license holds, nor on Free', async () => {
    for (const license of [licensed, free]) {
      const { calls } = renderAt('/approvals', {
        'GET /api/license': license,
        'GET /api/approvals': { approvals: [] },
      });
      await screen.findByRole('heading', { name: 'Approvals' });
      await waitFor(() =>
        expect(calls.some((call) => call.route === 'GET /api/license')).toBe(true),
      );
      // Other parts of the page have live regions of their own: the banner is known by its words.
      expect(screen.queryByText(/read-only|license ended/i)).toBeNull();
      cleanup();
    }
  });

  it('tells a member that Agentome is read-only and whom to ask', async () => {
    renderAt(
      '/approvals',
      {
        'GET /api/license': readOnly,
        'GET /api/approvals': { approvals: [] },
      },
      member,
    );
    expect(await screen.findByText('Agentome is read-only.')).toBeTruthy();
    expect(screen.getByText(/over Free without a license key/)).toBeTruthy();
    expect(screen.getByText(/Ask an admin/)).toBeTruthy();
  });

  it('shows an admin, in the grace, what happens when it ends and where to add a key', async () => {
    renderAt('/approvals', {
      'GET /api/license': { ...licensed, status: 'grace', over: ['teams'] },
      'GET /api/approvals': { approvals: [] },
    });
    expect(await screen.findByText(/turns read-only, being over Free/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Add a new license key' }).getAttribute('href')).toBe(
      '/admin/license',
    );
  });
});
