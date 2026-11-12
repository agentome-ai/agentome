import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '../test-api';
import { PlaceSection } from './place-section';
import { terminalUrl } from './place-terminal';

afterEach(() => vi.unstubAllGlobals());

const awake = {
  available: true,
  place: {
    seatId: 's1',
    state: 'awake',
    signedOut: ['claude-code'],
    lastSeenAt: null,
    agents: [{ id: 'a1', name: 'Backend developer' }],
  },
};

describe('Your place on the server', () => {
  it('is not shown on an installation without places', async () => {
    const calls = mockApi({ 'GET /api/me/place': { available: false, place: null } });
    const { container } = render(<PlaceSection />);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(container.textContent).toBe('');
  });

  it('is made with a button', async () => {
    const calls = mockApi({
      'GET /api/me/place': { available: true, place: null },
      'POST /api/me/place': () => ({ json: awake, status: 201 }),
    });
    render(<PlaceSection />);
    await userEvent.click(await screen.findByRole('button', { name: 'Make my place' }));
    expect(await screen.findByText('Awake')).toBeTruthy();
    expect(calls.map((call) => call.route)).toContain('POST /api/me/place');
    // Not signed in to Claude Code: it says so, and how.
    expect(screen.getByText(/Claude Code is not signed in there yet/)).toBeTruthy();
  });

  it('is put to sleep and woken, and deleted after asking', async () => {
    const asleep = { ...awake, place: { ...awake.place, state: 'asleep', signedOut: [] } };
    const calls = mockApi({
      'GET /api/me/place': awake,
      'POST /api/me/place/sleep': asleep,
      'POST /api/me/place/wake': awake,
      'DELETE /api/me/place': () => ({ status: 204 }),
    });
    const user = userEvent.setup();
    render(<PlaceSection />);
    await user.click(await screen.findByRole('button', { name: 'Put to sleep' }));
    expect(
      await screen.findByText(/Asleep: it wakes when one of your agents has work/),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Wake' }));
    expect(await screen.findByText('Awake')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Delete place' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete your place on the server?' });
    expect(calls.map((call) => call.route)).not.toContain('DELETE /api/me/place');
    await user.click(within(dialog).getByRole('button', { name: 'Delete place' }));
    await vi.waitFor(() =>
      expect(calls.map((call) => call.route)).toContain('DELETE /api/me/place'),
    );
  });
});

describe('the terminal of a place', () => {
  it('opens on the same host, over wss behind https', () => {
    expect(terminalUrl({ protocol: 'https:', host: 'agentome.example.com' })).toBe(
      'wss://agentome.example.com/api/me/place/terminal',
    );
    expect(terminalUrl({ protocol: 'http:', host: 'localhost:3000' })).toBe(
      'ws://localhost:3000/api/me/place/terminal',
    );
  });

  it('is offered with the place, first when Claude Code is not signed in there', async () => {
    mockApi({ 'GET /api/me/place': awake });
    render(<PlaceSection />);
    expect(await screen.findByRole('button', { name: 'Open terminal' })).toBeTruthy();
    expect(screen.getByText(/Open the terminal, run/)).toBeTruthy();
  });
});

describe('the working folders of a place', () => {
  it("start an agent's folders fresh after asking", async () => {
    const calls = mockApi({
      'GET /api/me/place': awake,
      'DELETE /api/me/place/folders/a1': () => ({ status: 204 }),
    });
    const user = userEvent.setup();
    render(<PlaceSection />);
    await user.click(await screen.findByRole('button', { name: 'Start fresh' }));
    const dialog = screen.getByRole('dialog', { name: "Start Backend developer's folders fresh?" });
    await user.click(within(dialog).getByRole('button', { name: 'Start fresh' }));
    await vi.waitFor(() =>
      expect(calls.map((call) => call.route)).toContain('DELETE /api/me/place/folders/a1'),
    );
  });
});
