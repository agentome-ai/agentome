import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../app';
import { admin, mockApi } from '../test-api';
import type { LogEntry } from './logs-page';

const entry = (id: number, extra: Partial<LogEntry> = {}): LogEntry => ({
  id,
  at: '2026-10-31T10:00:00.250Z',
  level: 30,
  source: 'server',
  message: 'request completed',
  context: null,
  traceId: 'a1b2c3d4e5f60718',
  runId: null,
  seatId: null,
  span: null,
  durationMs: null,
  ...extra,
});

const request = entry(3, {
  span: 'GET /api/tasks',
  durationMs: 42,
  context: { res: { statusCode: 200 } },
});
const call = entry(2, {
  message: 'outbound call',
  span: 'GET https://gitlab.example.com/api/v4/projects/7',
  durationMs: 3400,
  at: '2026-10-31T10:00:00.240Z',
});
const worker = entry(1, {
  source: 'worker',
  level: 40,
  message: 'the claim failed (The server answered 502.); trying again',
  traceId: null,
  runId: '7b5c6f1e-3d2a-4f6b-9a8c-1e2d3c4b5a69',
});

function renderLogs(path: string, routes: Parameters<typeof mockApi>[0]) {
  const calls = mockApi({
    'GET /api/me': admin,
    'GET /api/admin/logs/level': { level: 'info' },
    ...routes,
  });
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
  return { calls, user: userEvent.setup() };
}

describe('Admin → Logs', () => {
  it('lists the lines newest first with their level, source and time, and opens one', async () => {
    const { user } = renderLogs('/admin/logs', {
      'GET /api/admin/logs?level=info&limit=100': {
        entries: [request, call, worker],
        nextBefore: null,
      },
    });
    const lines = within(await screen.findByRole('list', { name: 'Log lines' }));
    const items = lines.getAllByRole('listitem');
    expect(items[0]?.textContent).toContain('GET /api/tasks');
    expect(items[0]?.textContent).toContain('42 ms');
    expect(items[1]?.textContent).toContain('3.4 s');
    expect(items[2]?.textContent).toContain('warn');
    expect(items[2]?.textContent).toContain('computer');

    await user.click(within(items[0] as HTMLElement).getByRole('button'));
    expect(lines.getByText(/"statusCode": 200/)).toBeTruthy();
    expect(lines.getByRole('link', { name: /Trace a1b2c3d4/ }).getAttribute('href')).toBe(
      '/admin/logs/traces/a1b2c3d4e5f60718',
    );
  });

  it('asks again from another level up, by source and by words', async () => {
    const empty = { entries: [], nextBefore: null };
    const { calls, user } = renderLogs('/admin/logs', {
      'GET /api/admin/logs?level=info&limit=100': empty,
      'GET /api/admin/logs?level=warn&limit=100': empty,
      'GET /api/admin/logs?level=warn&limit=100&source=worker': empty,
      'GET /api/admin/logs?level=warn&limit=100&source=worker&q=gitlab': empty,
    });
    expect(await screen.findByText('No lines match')).toBeTruthy();
    await user.click(screen.getByRole('radio', { name: 'warn' }));
    await user.click(screen.getByRole('radio', { name: 'Computers' }));
    await user.type(screen.getByRole('textbox', { name: 'Search the lines' }), 'gitlab{Enter}');
    expect(await screen.findByText('No lines match')).toBeTruthy();
    expect(calls.map((each) => each.route)).toContain(
      'GET /api/admin/logs?level=warn&limit=100&source=worker&q=gitlab',
    );
  });

  it("changes the server's level in place", async () => {
    const { calls, user } = renderLogs('/admin/logs', {
      'GET /api/admin/logs?level=info&limit=100': { entries: [], nextBefore: null },
      'PUT /api/admin/logs/level': { level: 'debug' },
    });
    await user.click(await screen.findByRole('combobox', { name: 'Server log level' }));
    await user.click(await screen.findByRole('option', { name: /debug/i }));
    expect(calls.find((each) => each.route === 'PUT /api/admin/logs/level')?.body).toEqual({
      level: 'debug',
    });
  });

  it('draws a trace as its spans on one time axis, then its lines', async () => {
    renderLogs('/admin/logs/traces/a1b2c3d4e5f60718', {
      'GET /api/admin/logs/traces/a1b2c3d4e5f60718': {
        traceId: 'a1b2c3d4e5f60718',
        entries: [call, request],
      },
    });
    const waterfall = within(await screen.findByRole('region', { name: 'Waterfall' }));
    expect(waterfall.getByText(/2 spans over/)).toBeTruthy();
    expect(waterfall.getByText('GET https://gitlab.example.com/api/v4/projects/7')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Lines of the trace' })).toBeTruthy();
  });
});
