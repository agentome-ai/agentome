import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../app';
import { admin, answer, mockApi } from '../test-api';
import { models } from './agents-data';

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const summary = (id: string, name: string, lastRun: object | null = null) => ({
  id,
  name,
  roleTitle: 'Backend engineer',
  status: 'active',
  owner: { id: 'u1', name: 'Ann Admin' },
  lastRun,
  createdAt: '2026-10-12T09:00:00Z',
});
const templates = [
  ['t1', 'Backend developer', 'Backend engineer'],
  ['t2', 'Code reviewer', 'Code reviewer'],
  ['t3', 'QA engineer', 'Quality engineer'],
].map(([id, name, roleTitle]) => ({
  id,
  name,
  roleTitle,
  version: 1,
  description: `What ${name} does.`,
  modelPref: null,
}));

function renderAgents(routes: Parameters<typeof mockApi>[0]) {
  const calls = mockApi({ 'GET /api/me': admin, 'GET /api/templates': { templates }, ...routes });
  // A data router, as in main.tsx: a new agent opens in the editor, which needs one.
  render(
    <RouterProvider
      router={createMemoryRouter([{ path: '*', element: <App /> }], {
        initialEntries: ['/agents'],
      })}
    />,
  );
  return { calls, user: userEvent.setup() };
}

describe('Agents', () => {
  it('says what an agent at work is doing, and what one at rest did last', async () => {
    const run = (id: string, status: string, task: object | null) => ({
      id,
      taskId: 'k1',
      status,
      at: ago(4),
      task,
    });
    renderAgents({
      'GET /api/agents': {
        agents: [
          summary(
            'a1',
            'Checkout QA',
            run('r1', 'running', { title: 'Fix the flaky test', project: 'Payments' }),
          ),
          summary(
            'a2',
            'Docs writer',
            run('r2', 'waiting_approval', { title: 'Write the notes', project: null }),
          ),
          summary(
            'a3',
            'Reviewer',
            run('r3', 'done', { title: 'Review the change', project: 'Payments' }),
          ),
        ],
      },
    });
    const table = within(await screen.findByRole('table'));
    const cell = (agent: string) =>
      within(table.getByRole('link', { name: agent }).closest('tr') as HTMLElement);
    // The task opens its run; the row itself still opens the agent.
    const task = cell('Checkout QA').getByRole('link', { name: 'Fix the flaky test' });
    expect(task.getAttribute('href')).toBe('/runs/r1');
    expect(task.closest('td')?.textContent).toBe('Fix the flaky test in Payments');
    expect(cell('Docs writer').getByRole('link', { name: 'Write the notes' })).toBeTruthy();
    // A run that is over is a status and a time, as it was.
    expect(table.getByRole('link', { name: 'Reviewer' }).closest('tr')?.textContent).toContain(
      'Done, 4 min ago',
    );
    expect(cell('Reviewer').queryByRole('link', { name: 'Review the change' })).toBeNull();
  });

  it('lists the agents with their last run, and the sidebar shows the ones that need a look', async () => {
    renderAgents({
      'GET /api/agents': {
        agents: [
          {
            ...summary('a1', 'Payments backend', { status: 'done', at: ago(130) }),
            month: { accepted: 4, handed: 5, medianUsd: '1.2' },
          },
          summary('a2', 'Checkout QA', { status: 'running', at: ago(4) }),
          summary('a3', 'Docs writer'),
        ],
      },
    });
    const table = within(await screen.findByRole('table'));
    const link = table.getByRole('link', { name: 'Payments backend' });
    expect(link.getAttribute('href')).toBe('/agents/a1');
    expect(link.closest('tr')?.textContent).toBe(
      'Payments backendBackend engineerAnn Admin80% of 5$1.20Done, 2 h ago',
    );
    expect(table.getByRole('link', { name: 'Docs writer' }).closest('tr')?.textContent).toContain(
      'Never run',
    );
    // Without its task, as an older server answers, an agent at work reads as before.
    expect(table.getByRole('link', { name: 'Checkout QA' }).closest('tr')?.textContent).toContain(
      'Running, 4 min ago',
    );
    const sidebar = screen.getByRole('complementary', { name: 'Sidebar' });
    expect(within(sidebar).getByRole('link', { name: 'Checkout QA, Running' })).toBeTruthy();
    // A finished run is not news: the sidebar lists only what is alive, waiting or failed.
    expect(within(sidebar).queryByRole('link', { name: /Payments backend/ })).toBeNull();
  });

  it('starts empty with one way forward, and shows the archived agents on request', async () => {
    const { calls, user } = renderAgents({ 'GET /api/agents?archived=true': { agents: [] } });
    expect(await screen.findByRole('heading', { name: 'No agents yet' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'New agent' })).toHaveLength(1);
    await user.click(screen.getByRole('tab', { name: 'Archived' }));
    expect(await screen.findByRole('heading', { name: 'No archived agents' })).toBeTruthy();
    expect(calls.map((call) => call.route)).toContain('GET /api/agents?archived=true');
  });

  it('creates an agent from a template and opens it', async () => {
    const created = { ...summary('a9', 'Billing QA'), instructions: '', tools: [], people: [] };
    const { calls, user } = renderAgents({
      'POST /api/agents': answer(201, created),
      'GET /api/agents/a9': answer(404, { error: { code: 'not_found', message: 'Gone' } }),
    });
    await user.click(await screen.findByRole('button', { name: 'New agent' }));
    const dialog = screen.getByRole('dialog', { name: 'New agent' });
    const name = within(dialog).getByRole('textbox', { name: 'Name' }) as HTMLInputElement;
    const role = within(dialog).getByRole('textbox', { name: 'Role title' }) as HTMLInputElement;
    await within(dialog).findByRole('radio', { name: 'Backend developer' });
    expect(name.value).toBe('Backend developer');

    await user.click(within(dialog).getByRole('radio', { name: 'Code reviewer' }));
    expect([name.value, role.value]).toEqual(['Code reviewer', 'Code reviewer']);
    // What the person typed stays when they pick another template.
    await user.clear(name);
    await user.type(name, 'Billing QA');
    await user.click(within(dialog).getByRole('radio', { name: 'QA engineer' }));
    expect([name.value, role.value]).toEqual(['Billing QA', 'Quality engineer']);

    await user.click(within(dialog).getByRole('button', { name: 'Create agent' }));
    expect(calls.find((call) => call.route === 'POST /api/agents')?.body).toEqual({
      name: 'Billing QA',
      roleTitle: 'Quality engineer',
      templateId: 't3',
    });
    // The editor of the new agent opens.
    expect(await screen.findByRole('heading', { level: 1, name: 'Agent not found' })).toBeTruthy();
  });

  it('imports an agent from a file, after showing what it brings', async () => {
    const file = {
      format: 'agentome/agent@2',
      agent: {
        name: 'Contract reviewer',
        roleTitle: 'Legal',
        instructions: 'Read each contract against the playbook.',
        engine: 'claude-code',
        modelPref: null,
        budget: null,
        skills: [
          { content: '---\nname: review-contract\ndescription: Reviews a contract.\n---\n' },
        ],
        tools: [{ name: 'jira_add_comment', policy: 'allow' }],
        mcpServers: [{ name: 'docusign' }],
        template: null,
      },
      source: {
        name: 'knowledge-work-plugins',
        url: 'https://github.com/anthropics/knowledge-work-plugins',
        license: 'Apache-2.0',
      },
    };
    const { calls, user } = renderAgents({
      'POST /api/agents/import': answer(201, {
        agent: { id: 'a9', name: 'Contract reviewer' },
        skills: [{ name: 'review-contract', version: 1, added: true }],
        missingServers: ['docusign'],
      }),
      'GET /api/agents/a9': answer(404, { error: { code: 'not_found', message: 'Gone' } }),
    });
    await user.click(await screen.findByRole('button', { name: 'Import' }));
    const dialog = screen.getByRole('dialog', { name: 'Import an agent' });
    const input = dialog.querySelector<HTMLInputElement>('input[type="file"]')!;
    const json = { type: 'application/json' };
    await user.upload(input, new File(['notes'], 'notes.json', json));
    expect(within(dialog).getByRole('alert').textContent).toMatch(/notes.json isn't JSON/);
    expect(within(dialog).getByRole('button', { name: 'Import agent' })).toHaveProperty(
      'disabled',
      true,
    );

    await user.upload(input, new File([JSON.stringify(file)], 'contract.agent.json', json));
    expect(within(dialog).getByText('review-contract')).toBeTruthy();
    expect(within(dialog).getByText('docusign')).toBeTruthy();
    // What it will be told, and that the file's policies stay behind, before it is imported.
    expect(within(dialog).getByLabelText('Instructions in the file').textContent).toBe(
      'Read each contract against the playbook.',
    );
    expect(within(dialog).getByText(/a file’s policies are not imported/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Import agent' }));
    expect(calls.find((call) => call.route === 'POST /api/agents/import')?.body).toEqual(file);
    // A server the library lacks is said before the agent opens.
    const done = await screen.findByRole('dialog', { name: 'Contract reviewer is yours' });
    expect(within(done).getByText('docusign')).toBeTruthy();
    await user.click(within(done).getByRole('button', { name: 'Open the agent' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Agent not found' })).toBeTruthy();
  });

  it('asks for a name before it creates anything', async () => {
    const { calls, user } = renderAgents({});
    await user.click(await screen.findByRole('button', { name: 'New agent' }));
    const dialog = screen.getByRole('dialog', { name: 'New agent' });
    await user.click(await within(dialog).findByRole('radio', { name: 'Blank agent' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create agent' }));
    expect(within(dialog).getByText('Enter a name for the agent.')).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole('textbox', { name: 'Name' }));
    expect(calls.map((call) => call.route)).not.toContain('POST /api/agents');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'New agent' }));
  });
});

describe('the model picker', () => {
  it('offers only models the price table knows', () => {
    // Tests run in apps/web.
    const file = join(process.cwd(), '../../packages/costs/prices.json');
    const prices = JSON.parse(readFileSync(file, 'utf8')) as { models: Record<string, unknown> };
    for (const model of models) expect(Object.keys(prices.models)).toContain(model.id);
  });
});
