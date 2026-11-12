import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../app';
import { admin, failure, mockApi } from '../test-api';
import instructionsRun from './fixtures/run-c6fb25fe.json';
import changelogRun from './fixtures/run-ee2e51b8.json';
import type { RunDetail, RunEvent } from './run-data';

/** EventSource as the page uses it, driven by the test: emit() is the server talking. */
class FakeEventSource {
  static opened: FakeEventSource[] = [];
  closed = false;
  private listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();
  constructor(readonly url: string) {
    FakeEventSource.opened.push(this);
  }
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data?: unknown) {
    const message = new MessageEvent(type, { data: JSON.stringify(data) });
    act(() => this.listeners.get(type)?.forEach((listener) => listener(message)));
  }
}
const latest = () => FakeEventSource.opened.at(-1) as FakeEventSource;

const run: RunDetail = {
  id: 'r1',
  status: 'running',
  agent: { id: 'a1', name: 'Backend developer' },
  task: { id: 't1', title: 'Add a README', projectId: null },
  seat: { id: 's1', name: 'maria-mbp', owner: { id: 'u2', name: 'Maria Garcia' } },
  startedBy: { kind: 'user', user: { id: 'u1', name: 'Ann Admin' } },
  startedAt: '2026-10-21T10:00:00.000Z',
  endedAt: null,
  errorCode: null,
  createdAt: '2026-10-21T09:59:00.000000Z',
  limits: { maxMinutes: 60, maxTurns: 50, maxTokens: 2_000_000 },
  cancelRequestedAt: null,
  artifacts: [],
  toolCalls: [],
  cost: { rows: [], totalUsd: null, unpriced: false },
};
const at = '2026-10-21T10:00:01.000Z';
const message = (seq: number, text: string): RunEvent => ({
  seq,
  at,
  type: 'assistant_message',
  text,
});

function renderRun(routes: Parameters<typeof mockApi>[0]) {
  const calls = mockApi({ 'GET /api/me': admin, ...routes });
  render(
    <MemoryRouter initialEntries={['/runs/r1']}>
      <App />
    </MemoryRouter>,
  );
  return { calls, user: userEvent.setup({ advanceTimers: vi.advanceTimersByTime }) };
}

beforeEach(() => {
  FakeEventSource.opened = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the run page', () => {
  it('shows the run and its transcript live, and reloads it when it ends', async () => {
    let detail = run;
    renderRun({ 'GET /api/runs/r1': () => ({ json: detail }) });
    expect(await screen.findByRole('heading', { level: 1, name: 'Add a README' })).toBeTruthy();
    const facts = screen.getByRole('region', { name: 'Run details' });
    expect(
      within(facts).getByRole('link', { name: 'Backend developer' }).getAttribute('href'),
    ).toBe('/agents/a1');
    expect(within(facts).getByRole('link', { name: 'Open the task' }).getAttribute('href')).toMatch(
      /^\/tasks\//,
    );
    expect(within(facts).getByText('Maria Garcia')).toBeTruthy();
    expect(within(facts).getByText('Running')).toBeTruthy();

    const source = latest();
    expect(source.url).toBe('/api/runs/r1/stream?after=-1');
    source.emit('status', { status: 'running' });
    expect(
      screen.getByText("Waiting for the first events from Maria Garcia's computer."),
    ).toBeTruthy();
    source.emit('run', message(0, 'Reading the **repository**.'));
    expect((await screen.findByText('repository')).tagName).toBe('STRONG');

    detail = { ...run, status: 'done', endedAt: '2026-10-21T10:09:00.000Z' };
    source.emit('status', { status: 'done' });
    expect(await within(facts).findByText('Done')).toBeTruthy();
    expect(source.closed).toBe(true);
    expect(screen.queryByRole('button', { name: 'Cancel run' })).toBeNull();
    expect(within(facts).getByText('9 min')).toBeTruthy();
  });

  it('folds the transcript under a plan, and unfolds it on a click', async () => {
    renderRun({ 'GET /api/runs/r1': () => ({ json: run }) });
    await screen.findByRole('heading', { level: 1, name: 'Add a README' });
    const source = latest();
    source.emit('status', { status: 'running' });
    source.emit('run', message(0, 'Reading the repository.'));
    // Without a plan the transcript is the page.
    expect(await screen.findByText('Reading the repository.')).toBeTruthy();
    source.emit('run', {
      seq: 1,
      at,
      type: 'tool_use',
      id: 'p1',
      name: 'TaskCreate',
      input: { subject: 'Write the README' },
    });
    const toggle = await screen.findByRole('button', { name: 'Transcript' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Reading the repository.')).toBeNull();
    expect(screen.getByText('1 action')).toBeTruthy();
    await userEvent.setup().click(toggle);
    expect(screen.getByText('Reading the repository.')).toBeTruthy();
  });

  it('shows a wait for approval under the gateway call, then who decided it', async () => {
    const tool = 'code_host_open_change_request';
    const call = { tool, reason: null, decidedBy: null, createdAt: at };
    let detail: RunDetail = {
      ...run,
      status: 'waiting_approval',
      toolCalls: [{ ...call, decision: 'pending' }],
    };
    renderRun({ 'GET /api/runs/r1': () => ({ json: detail }) });
    await screen.findByRole('heading', { level: 1, name: 'Add a README' });
    const source = latest();
    source.emit('status', { status: 'waiting_approval' });
    source.emit('run', {
      seq: 0,
      at,
      type: 'tool_use',
      id: 'toolu_1',
      name: `mcp__agentome__${tool}`,
      input: { branch: 'agent/readme', title: 'Add a README' },
    } satisfies RunEvent);
    expect(await screen.findByText("Waiting for the owner's approval")).toBeTruthy();

    detail = {
      ...run,
      toolCalls: [
        {
          ...call,
          decision: 'denied',
          reason: 'Open it as a draft first.',
          decidedBy: { id: 'u1', name: 'Ann Admin' },
        },
      ],
    };
    source.emit('status', { status: 'running' });
    expect(await screen.findByText('Denied by Ann Admin: Open it as a draft first')).toBeTruthy();
    expect(screen.queryByText("Waiting for the owner's approval")).toBeNull();
  });

  it('comes back after a drop from the last event it has, saying so once a retry fails', async () => {
    renderRun({ 'GET /api/runs/r1': run });
    await screen.findByRole('heading', { level: 1, name: 'Add a README' });
    const first = latest();
    first.emit('run', message(4, 'Before the drop.'));
    await screen.findByText('Before the drop.');
    first.emit('error');
    expect(first.closed).toBe(true);
    expect(screen.queryByText('Reconnecting…')).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(1000));
    const second = latest();
    expect(second.url).toBe('/api/runs/r1/stream?after=4');
    // Opened and failed before anything came: a failed retry, so the next waits longer.
    second.emit('open');
    second.emit('error');
    expect(await screen.findByText('Reconnecting…')).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(FakeEventSource.opened).toHaveLength(2);
    await act(() => vi.advanceTimersByTimeAsync(1000));
    const third = latest();
    expect(FakeEventSource.opened).toHaveLength(3);
    // The same event again, from a stream that resent it, shows once.
    third.emit('run', message(4, 'Before the drop.'));
    third.emit('run', message(5, 'After the drop.'));
    await screen.findByText('After the drop.');
    expect(screen.getAllByText('Before the drop.')).toHaveLength(1);
    expect(screen.queryByText('Reconnecting…')).toBeNull();
  });

  it('cancels after asking, and then says the cancel is requested', async () => {
    let detail = run;
    const { calls, user } = renderRun({
      'GET /api/runs/r1': () => ({ json: detail }),
      'POST /api/runs/r1/cancel': () => {
        detail = { ...run, cancelRequestedAt: '2026-10-21T10:05:00.000Z' };
        return { json: { status: 'running', cancelRequested: true } };
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Cancel run' }));
    const dialog = screen.getByRole('dialog', { name: 'Cancel this run of Backend developer?' });
    expect(within(dialog).getByText(/Claude Code stops on Maria Garcia's computer/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel run' }));
    const requested = await screen.findByRole('button', { name: 'Cancel requested' });
    expect(requested.getAttribute('aria-disabled')).toBe('true');
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(requested);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.filter((call) => call.route === 'POST /api/runs/r1/cancel')).toHaveLength(1);
  });

  it('keeps the dialog open with the reason when the cancel fails', async () => {
    const { user } = renderRun({
      'GET /api/runs/r1': { ...run, status: 'queued', seat: null, startedAt: null },
      'POST /api/runs/r1/cancel': failure(404, 'not_found', 'Run not found'),
    });
    await user.click(await screen.findByRole('button', { name: 'Cancel run' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('It leaves the queue and never starts.')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel run' }));
    expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', 'Run not found');
    await user.click(within(dialog).getByRole('button', { name: 'Keep it queued' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('waits for a computer while queued', async () => {
    renderRun({ 'GET /api/runs/r1': { ...run, status: 'queued', seat: null, startedAt: null } });
    await screen.findByRole('heading', { level: 1, name: 'Add a README' });
    latest().emit('status', { status: 'queued' });
    expect(screen.getByText('Waiting for a computer to pick this run up.')).toBeTruthy();
    expect(screen.getByText('Not picked up yet')).toBeTruthy();
  });

  it('cancels a queued run at once and leaves the focus on its status', async () => {
    const queued: RunDetail = { ...run, status: 'queued', seat: null, startedAt: null };
    let detail = queued;
    const { user } = renderRun({
      'GET /api/runs/r1': () => ({ json: detail }),
      'POST /api/runs/r1/cancel': () => {
        detail = { ...queued, status: 'cancelled', endedAt: '2026-10-21T10:01:00.000Z' };
        return { json: { status: 'cancelled', cancelRequested: true } };
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Cancel run' }));
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel run' }),
    );
    expect(await screen.findByText('Cancelled')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Cancel/ })).toBeNull();
    // Radix hands focus back a tick after the dialog closes.
    await waitFor(() => expect(document.activeElement?.id).toBe('run-status'));
  });

  it('shows artifacts and the cost of a finished run', async () => {
    const { user } = renderRun({
      'GET /api/runs/r1': {
        ...run,
        status: 'done',
        endedAt: '2026-10-21T10:09:00.000Z',
        artifacts: [
          {
            id: 'x1',
            kind: 'branch',
            ref: 'agent/readme',
            meta: {
              commits: [{ sha: '4f2a9c1d8e', subject: 'Add a README' }],
              pushedTo: 'javascript:alert(1)',
            },
          },
          {
            id: 'x2',
            kind: 'change_request',
            ref: 'https://git.example.com/team/repo/-/merge_requests/7',
            meta: { state: 'open', pipeline: 'failed', review: 'changes_requested' },
          },
          { id: 'x3', kind: 'report', ref: 'result', meta: { text: 'Added **README.md**.' } },
        ],
        cost: {
          rows: [
            {
              model: 'claude-sonnet-5',
              tokensIn: 1200,
              tokensOut: 300,
              tokensCacheRead: 5000,
              tokensCacheWrite: 0,
              usd: '0.041800',
            },
            {
              model: 'claude-made-up',
              tokensIn: 10,
              tokensOut: 2,
              tokensCacheRead: 0,
              tokensCacheWrite: 0,
              usd: null,
            },
          ],
          totalUsd: '0.041800',
          unpriced: true,
        },
      },
    });
    const artifacts = await screen.findByRole('region', { name: 'Artifacts' });
    const report = within(artifacts).getAllByRole('listitem')[0] as HTMLElement;
    // Whether the report is the transcript's last answer is known once the transcript is in.
    expect(report.textContent).toBe('Report');
    latest().emit('status', { status: 'done' });
    expect(within(report).getByText('README.md').tagName).toBe('STRONG');
    // The branch and the merge request are the task page's cards; the commits open from it.
    await user.click(within(artifacts).getByRole('button', { name: /agent\/readme/ }));
    expect(within(artifacts).getByText('4f2a9c1')).toBeTruthy();
    // A pushedTo that is not http(s) stays text; the merge request is a link.
    expect(within(artifacts).getByText('javascript:alert(1)').closest('a')).toBeNull();
    const request = within(artifacts).getByRole('link');
    expect(request.getAttribute('href')).toBe(
      'https://git.example.com/team/repo/-/merge_requests/7',
    );
    expect(request.textContent).toBe(
      'repo !7https://git.example.com/team/repo/-/merge_requests/7CI failedChanges requested',
    );

    const cost = screen.getByRole('region', { name: 'Cost' });
    // The total is the line; the models are behind By model.
    expect(within(cost).getAllByText('$0.04')).toHaveLength(1);
    expect(within(cost).queryByText('No price')).toBeNull();
    await user.click(within(cost).getByRole('button', { name: 'By model' }));
    expect(within(cost).getAllByText('$0.04')).toHaveLength(2);
    expect(within(cost).getByText('No price')).toBeTruthy();
    // Compact on its line, exact in its title.
    expect(within(cost).getByTitle('1,200 in, 300 out, 5,000 cache read').textContent).toBe(
      '1.2K in, 300 out, 5K cache read',
    );
    expect(within(cost).getByText(/Estimate at API list prices/)).toBeTruthy();
  });

  it('points the report of a live run at its final answer, and lists commits kept nowhere', async () => {
    const { user } = renderRun({
      'GET /api/runs/r1': { ...changelogRun.run, id: 'r1' } as RunDetail,
    });
    const artifacts = await screen.findByRole('region', { name: 'Artifacts' });
    const source = latest();
    for (const event of changelogRun.events) source.emit('run', event);
    source.emit('status', { status: 'done' });
    const [report, commits] = within(artifacts).getAllByRole('listitem') as HTMLElement[];

    const link = within(report as HTMLElement).getByRole('link', {
      name: 'The final answer, shown under Result',
    });
    expect(link.getAttribute('href')).toBe('#final-answer');
    // A done run leads with its answer, under Result, focusable for the keyboard.
    const answer = screen.getByRole('region', { name: 'Result' });
    expect(answer.id).toBe('final-answer');
    expect(answer.textContent).toMatch(/^ResultI created CHANGELOG/);
    expect(answer.tabIndex).toBe(-1);
    // The answer is in the page once: the transcript points up to it.
    expect(screen.getAllByText(/^I didn't add version entries/)).toHaveLength(1);
    // In place: the browser's own jump would leave a history entry the router cannot hold.
    await user.click(link);
    expect(document.activeElement).toBe(answer);
    expect(window.location.hash).toBe('');

    // Not pushed: no branch by that name exists anywhere, so none is named.
    expect(commits?.textContent).toBe('Commits1 commitNot pushed');
  });

  it('links a report cut at 20,000 characters, and shows the report of a run not done', async () => {
    const long = `${'All checks pass. '.repeat(1_500)}The end.`;
    const answered = (status: RunDetail['status'], text: string): RunDetail => ({
      ...run,
      status,
      endedAt: '2026-10-21T10:09:00.000Z',
      artifacts: [{ id: 'x1', kind: 'report', ref: 'result', meta: { text } }],
    });
    renderRun({ 'GET /api/runs/r1': answered('done', long.slice(0, 20_000)) });
    const artifacts = await screen.findByRole('region', { name: 'Artifacts' });
    latest().emit('run', message(0, long));
    latest().emit('status', { status: 'done' });
    expect(within(artifacts).getByRole('link', { name: /^The final answer/ })).toBeTruthy();
    cleanup();

    // A failed run's report is the error, not an answer: shown at once, though it repeats.
    const error = 'Failed to authenticate. API Error: 401';
    renderRun({ 'GET /api/runs/r1': answered('failed', error) });
    const failed = await screen.findByRole('region', { name: 'Artifacts' });
    expect(within(failed).getByText(error)).toBeTruthy();
    latest().emit('run', message(0, error));
    latest().emit('status', { status: 'failed' });
    expect(within(failed).queryByRole('link')).toBeNull();
  });

  it('names the branch and the repository it was pushed to', async () => {
    const [branch, report] = changelogRun.run.artifacts;
    const pushed = {
      ...branch,
      meta: { ...branch?.meta, pushedTo: '/Users/maria/code/test-repo' },
    };
    renderRun({
      'GET /api/runs/r1': {
        ...changelogRun.run,
        id: 'r1',
        artifacts: [pushed, report],
      } as RunDetail,
    });
    const artifacts = await screen.findByRole('region', { name: 'Artifacts' });
    expect(within(artifacts).getAllByRole('listitem')[1]?.textContent).toBe(
      'agentome/ee2e51b8-5a0c-4fa5-92af-42289c6608961 commit·test-repo',
    );
  });

  it('shows the report itself when the transcript cannot load, and keeps it on a retry', async () => {
    renderRun({ 'GET /api/runs/r1': { ...instructionsRun.run, id: 'r1' } as RunDetail });
    const artifacts = await screen.findByRole('region', { name: 'Artifacts' });
    latest().emit('error');
    await act(() => vi.advanceTimersByTimeAsync(1000));
    latest().emit('error');
    expect(await within(artifacts).findByText(/^# Backend developer/)).toBeTruthy();
    expect(within(artifacts).queryByRole('link')).toBeNull();
    // The retry gets through: the card keeps the text until the transcript says otherwise.
    await act(() => vi.advanceTimersByTimeAsync(2000));
    const retry = latest();
    retry.emit('run', instructionsRun.events[0]);
    expect(within(artifacts).getByText(/^# Backend developer/)).toBeTruthy();
    for (const event of instructionsRun.events.slice(1)) retry.emit('run', event);
    retry.emit('status', { status: 'done' });
    expect(within(artifacts).getByRole('link', { name: /^The final answer/ })).toBeTruthy();
  });

  it('says a run is not priced yet', async () => {
    renderRun({
      'GET /api/runs/r1': {
        ...run,
        status: 'failed',
        errorCode: 'orphaned',
        endedAt: '2026-10-21T10:09:00.000Z',
        cost: {
          rows: [
            {
              model: 'claude-sonnet-5',
              tokensIn: 5,
              tokensOut: 1,
              tokensCacheRead: 0,
              tokensCacheWrite: 0,
              usd: null,
            },
          ],
          totalUsd: null,
          unpriced: true,
        },
      },
    });
    expect(await screen.findByText('Not priced yet')).toBeTruthy();
    expect(screen.queryByText('No price')).toBeNull();
    expect(screen.getByText(/^The computer stopped responding/)).toBeTruthy();
  });

  it('tells a person the run is not there for them', async () => {
    renderRun({ 'GET /api/runs/r1': failure(404, 'not_found', 'Run not found') });
    expect(await screen.findByRole('heading', { name: 'Run not found' })).toBeTruthy();
    expect(FakeEventSource.opened).toHaveLength(0);
  });
});
