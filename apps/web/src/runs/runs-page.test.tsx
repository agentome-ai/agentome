import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../app';
import { admin, mockApi } from '../test-api';
import type { RunList } from './run-data';

type Row = RunList['runs'][number];
const row = (id: string, fields: Partial<Row> = {}): Row => ({
  id,
  status: 'done',
  agent: { id: 'a1', name: 'Backend developer' },
  task: { id: 't1', title: `Task ${id}`, projectId: null },
  seat: { id: 's1', name: 'maria-mbp', owner: { id: 'u2', name: 'Maria Garcia' } },
  startedBy: { kind: 'user', user: { id: 'u1', name: 'Ann Admin' } },
  startedAt: '2026-10-21T10:00:00.000Z',
  endedAt: '2026-10-21T10:12:00.000Z',
  errorCode: null,
  createdAt: `2026-10-21T09:59:00.00000${id.length}Z`,
  cost: { usd: '0.418200', tokens: 61_840 },
  ...fields,
});

function renderRuns(routes: Parameters<typeof mockApi>[0], path = '/runs') {
  const calls = mockApi({ 'GET /api/me': admin, ...routes });
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
  return { calls, user: userEvent.setup() };
}

describe('the runs page', () => {
  it('lists runs with their status, duration and cost, each opening its run', async () => {
    renderRuns({
      'GET /api/runs?status=live': {
        runs: [
          row('r1', { status: 'running', endedAt: null, cost: { usd: null, tokens: 412_118 } }),
          row('r2', { status: 'failed' }),
          row('r3', {
            status: 'queued',
            seat: null,
            startedAt: null,
            endedAt: null,
            cost: { usd: null, tokens: 0 },
          }),
        ],
        nextBefore: null,
      },
      // The running run is at an edit it has not finished.
      'GET /api/runs/r1/events?after=-1': {
        events: [
          {
            seq: 0,
            at: '2026-10-21T10:01:00.000Z',
            type: 'tool_use',
            id: 'c0',
            name: 'Edit',
            input: { file_path: '/home/maria/runs/r1/repo/README.md' },
          },
        ],
        nextAfter: null,
      },
    });
    const link = await screen.findByRole('link', { name: 'Task r2' });
    expect(link.getAttribute('href')).toBe('/runs/r2');
    const failed = link.closest('tr');
    expect(failed && within(failed).getByText('Failed')).toBeTruthy();
    expect(failed?.textContent).toContain('12 min');
    expect(failed?.textContent).toContain('$0.42');
    // A running run is a card over the list on a phone, and a row on a wide screen.
    const [card, running] = screen.getAllByRole('link', { name: 'Task r1' });
    expect(running?.closest('tr')?.textContent).toContain('412K tokens');
    const live = card?.closest('article');
    expect(live?.textContent).toContain('412K tokens');
    expect(await within(live as HTMLElement).findByText('Editing README.md…')).toBeTruthy();
    expect(live?.textContent).toContain('1 step');
    expect(screen.getByRole('link', { name: 'Task r3' }).closest('tr')?.textContent).toContain(
      'Queued',
    );
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('filters by status through the address and loads more', async () => {
    const { calls, user } = renderRuns({
      'GET /api/runs?status=live': { runs: [row('r1')], nextBefore: null },
      'GET /api/runs?status=failed': { runs: [row('r2', { status: 'failed' })], nextBefore: 'c1' },
      'GET /api/runs?status=failed&before=c1': {
        runs: [row('r3', { status: 'failed' })],
        nextBefore: null,
      },
    });
    await screen.findByRole('link', { name: 'Task r1' });
    expect(screen.getByRole('tab', { name: 'Live' }).getAttribute('aria-selected')).toBe('true');
    await user.click(screen.getByRole('tab', { name: 'Failed' }));
    await screen.findByRole('link', { name: 'Task r2' });
    expect(screen.queryByRole('link', { name: 'Task r1' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByRole('link', { name: 'Task r3' });
    expect(screen.getByRole('link', { name: 'Task r2' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(calls.map((call) => call.route)).toContain('GET /api/runs?status=failed&before=c1');
  });

  it("filters by the person's agents, and names an agent the list lacks", async () => {
    const agent = (id: string, name: string) => ({ id, name, roleTitle: '', status: 'active' });
    const { calls, user } = renderRuns(
      {
        'GET /api/agents': { agents: [agent('a1', 'Backend developer'), agent('a2', 'Analyst')] },
        'GET /api/runs?agent=a9': {
          runs: [row('r9', { agent: { id: 'a9', name: 'Archived helper' } })],
          nextBefore: null,
        },
        'GET /api/runs?agent=a2': { runs: [], nextBefore: null },
      },
      '/runs?agent=a9&status=all',
    );
    const filter = await screen.findByRole('combobox', { name: 'Agent' });
    await screen.findByRole('link', { name: 'Task r9' });
    // Its tile's initials, then its name.
    expect(filter.textContent).toBe('AHArchived helper');
    await user.click(filter);
    await user.click(screen.getByRole('option', { name: 'Analyst' }));
    expect(
      await screen.findByRole('heading', { name: 'No runs match these filters' }),
    ).toBeTruthy();
    expect(calls.map((call) => call.route)).toContain('GET /api/runs?agent=a2');
  });

  it('names the task a list is scoped to, and shows all runs again', async () => {
    const { user } = renderRuns(
      {
        'GET /api/runs?task=t1': { runs: [row('r1')], nextBefore: null },
        'GET /api/runs': { runs: [row('r1'), row('r2')], nextBefore: null },
      },
      '/runs?task=t1',
    );
    expect(await screen.findByText('Runs of Task r1')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Show all runs' }));
    await screen.findByRole('link', { name: 'Task r2' });
    expect(screen.queryByText(/^Runs of/)).toBeNull();
  });

  it('says when nothing is running, and shows all runs', async () => {
    const { user } = renderRuns({
      'GET /api/runs?status=live': { runs: [], nextBefore: null },
      'GET /api/runs': { runs: [row('r1')], nextBefore: null },
    });
    expect(await screen.findByRole('heading', { name: 'Nothing is running' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Show all runs' }));
    await screen.findByRole('link', { name: 'Task r1' });
    expect(screen.getByRole('tab', { name: 'All' }).getAttribute('aria-selected')).toBe('true');
  });

  it('says what to do when there are no runs yet', async () => {
    renderRuns({ 'GET /api/runs': { runs: [], nextBefore: null } }, '/runs?status=all');
    expect(await screen.findByRole('heading', { name: 'No runs yet' })).toBeTruthy();
    expect(screen.getByText(/Run a task from an agent page/)).toBeTruthy();
  });
});
