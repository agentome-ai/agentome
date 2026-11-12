import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../app';
import { admin, failure, mockApi } from '../test-api';
import type { TeamSummary } from './teams-data';

// Teams: the list, New team, and a team's page with its members, order and copy.

const owner = { id: 'u1', name: 'Ann Admin' };
const summary = (id: string, name: string, ownerOf = owner) => ({
  id,
  name,
  roleTitle: '',
  status: 'active' as const,
  owner: ownerOf,
  lastRun: null,
  createdAt: '2026-10-12T09:00:00Z',
});
const lead = summary('7f3a9c21-0000-4000-8000-000000000001', 'Payments backend');
const qa = summary('7f3a9c21-0000-4000-8000-0000000000a1', 'QA');
const front = summary('7f3a9c21-0000-4000-8000-0000000000a2', 'Frontend');
const stranger = summary('7f3a9c21-0000-4000-8000-0000000000a3', 'Theirs', {
  id: 'u2',
  name: 'Bo',
});
const ref = ({ id, name, roleTitle, status }: typeof lead) => ({ id, name, roleTitle, status });
const empty: TeamSummary = {
  id: 't1',
  name: 'Payments',
  mode: 'auto',
  lead: ref(lead),
  members: [],
  steps: [],
};
// The lead as its editor has it: the owner and the team_step policy matter here.
const leadAgent = { ...lead, tools: [], skills: [], mcpServers: [], projects: [] };

function renderAt(path: string, routes: Parameters<typeof mockApi>[0]) {
  const calls = mockApi({
    'GET /api/me': admin,
    'GET /api/agents': { agents: [lead, qa, front, stranger] },
    [`GET /api/agents/${lead.id}`]: leadAgent,
    ...routes,
  });
  const router = createMemoryRouter([{ path: '*', element: <App /> }], { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return { calls, router, user: userEvent.setup() };
}

// The server's answer to a change: the team as saved, its members by name.
const saved = (body: unknown) => {
  const changes = body as { mode?: TeamSummary['mode']; members?: string[]; steps?: unknown[] };
  const all = [qa, front];
  return {
    json: {
      ...empty,
      ...changes,
      members: (changes.members ?? []).map((id) => ref(all.find((a) => a.id === id) ?? qa)),
    },
  };
};

describe('a team', () => {
  it('gets members, switches to manual steps and names when each is done', async () => {
    let current: unknown = { members: [] };
    const { calls, user } = renderAt('/teams/t1', {
      'GET /api/teams/t1': empty,
      'PATCH /api/teams/t1': (body) => {
        current = body;
        return saved(current);
      },
    });
    const section = await screen.findByRole('region', { name: 'Members' });
    expect(within(section).getByText(/No members yet/)).toBeTruthy();
    const add = async (name: string) => {
      await user.click(within(section).getByRole('combobox'));
      // Only the lead owner's other active agents, never the lead or another person's.
      expect(screen.queryByRole('option', { name: /Theirs|Payments backend/ })).toBeNull();
      await user.click(await screen.findByRole('option', { name }));
    };
    await add('QA');
    await add('Frontend');
    const body = () => calls.findLast((call) => call.route === 'PATCH /api/teams/t1')?.body;
    expect(body()).toEqual({ mode: 'auto', members: [qa.id, front.id], steps: [] });

    // Who sets the order is a chip with its menu, as in Linear.
    await user.click(screen.getByRole('button', { name: 'Who sets the order: The lead decides' }));
    await user.click(screen.getByRole('menuitemradio', { name: /Steps you set/ }));
    expect(body()).toEqual({
      mode: 'manual',
      members: [qa.id, front.id],
      steps: [
        { agents: [qa.id], note: '' },
        { agents: [front.id], note: '' },
      ],
    });
    const steps = within(screen.getByRole('region', { name: 'Steps' }));
    const first = steps.getByRole('group', { name: 'Agents of step 1' });
    await user.click(within(first).getByRole('button', { name: 'Frontend' }));
    await user.click(steps.getByRole('button', { name: 'Actions for step 2' }));
    await user.click(screen.getByRole('menuitem', { name: 'Remove step' }));
    expect(body()).toMatchObject({ steps: [{ agents: [qa.id, front.id], note: '' }] });

    // When a step is done is said in place.
    await user.click(steps.getByText('Say what done looks like'));
    await user.type(
      steps.getByRole('textbox', { name: 'Done when, step 1' }),
      'Both screens are tested',
    );
    await user.keyboard('{Enter}');
    expect(body()).toMatchObject({ steps: [{ note: 'Both screens are tested' }] });

    await user.click(within(section).getByRole('button', { name: 'Actions for QA' }));
    await user.click(screen.getByRole('menuitem', { name: 'Remove from team' }));
    expect(body()).toEqual({
      mode: 'manual',
      members: [front.id],
      steps: [{ agents: [front.id], note: 'Both screens are tested' }],
    });
  });

  it('says why a change could not be saved', async () => {
    const { user } = renderAt('/teams/t1', {
      'GET /api/teams/t1': empty,
      'PATCH /api/teams/t1': failure(400, 'validation_failed', 'QA is archived'),
    });
    const section = await screen.findByRole('region', { name: 'Members' });
    await user.click(within(section).getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: 'QA' }));
    expect(await screen.findByText('QA is archived')).toBeTruthy();
  });

  it('is copied whole and opens the copy', async () => {
    const { router, user } = renderAt('/teams/t1', {
      'GET /api/teams/t1': empty,
      'POST /api/teams/t1/duplicate': { ...empty, id: 't2', name: 'Payments (copy)' },
      'GET /api/teams/t2': { ...empty, id: 't2', name: 'Payments (copy)' },
    });
    await user.click(await screen.findByRole('button', { name: 'Duplicate' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Payments (copy)' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/teams/t2');
  });
});

describe('Teams', () => {
  it('lists the teams, and New team makes one with its lead and opens it', async () => {
    const { calls, router, user } = renderAt('/teams?view=list', {
      'GET /api/teams': { teams: [{ ...empty, members: [ref(qa)] }] },
      'POST /api/teams': { ...empty, id: 't3', name: 'Checkout' },
      'GET /api/teams/t3': { ...empty, id: 't3', name: 'Checkout' },
    });
    const row = (await screen.findByRole('link', { name: 'Payments' })).closest('tr');
    expect(row?.textContent).toBe('PaymentsPayments backendQAThe lead decides');

    await user.click(screen.getByRole('button', { name: 'New team' }));
    const dialog = screen.getByRole('dialog', { name: 'New team' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Checkout');
    await user.click(within(dialog).getByRole('combobox', { name: 'Lead' }));
    await user.click(await screen.findByRole('option', { name: 'Payments backend' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create team' }));
    expect(calls.find((call) => call.route === 'POST /api/teams')?.body).toEqual({
      name: 'Checkout',
      leadId: lead.id,
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Checkout' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/teams/t3');
  });

  it('reads as the chart: a team whose lead is in another team sits under it', async () => {
    const company = { ...empty, id: 't0', name: 'Company', lead: ref(front), members: [ref(lead)] };
    renderAt('/teams?view=list', {
      'GET /api/teams': { teams: [{ ...empty, members: [ref(qa)] }, company] },
    });
    const links = await screen.findAllByRole('link', { name: /^(Company|Payments)/ });
    expect(links.map((link) => link.textContent)).toEqual(['Company', 'Payments, under Company']);
    expect(links[1]?.getAttribute('style')).toContain('padding-left: 1.25rem');
  });
});

// The chart: Frontend leads Company with Payments backend in it, who leads Payments with QA.
describe('the chart of the teams', () => {
  const payments = { ...empty, members: [ref(qa)] };
  const company = { ...empty, id: 't0', name: 'Company', lead: ref(front), members: [ref(lead)] };
  const chart = (routes: Parameters<typeof mockApi>[0] = {}) =>
    renderAt('/teams', { 'GET /api/teams': { teams: [payments, company] }, ...routes });

  it('reads from the top lead down, each lead with its team', async () => {
    chart();
    const tree = await screen.findByRole('list', { name: 'Chart of the teams' });
    const names = within(tree)
      .getAllByRole('link')
      .map((link) => link.textContent);
    expect(names).toEqual(['Frontend', 'Company', 'Payments backend', 'Payments', 'QA']);
    expect(screen.getByText('Every agent of yours is on the chart.')).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: "Payments backend's team" }));
    expect(within(tree).queryByRole('link', { name: 'QA' })).toBeNull();
    expect(within(tree).getByRole('link', { name: 'Payments, 1' })).toBeTruthy();
  });

  it('puts an agent under one with no team, which makes its team', async () => {
    const { calls, user } = chart({ 'POST /api/teams': { ...empty, id: 't9' } });
    await user.click(await screen.findByRole('combobox', { name: 'Put an agent under QA' }));
    await user.click(await screen.findByRole('option', { name: 'Frontend' }));
    await screen.findAllByRole('link', { name: 'QA' });
    expect(calls.find((call) => call.route === 'POST /api/teams')?.body).toEqual({
      name: 'QA team',
      leadId: qa.id,
      members: [front.id],
    });
  });

  it('moves an agent dragged onto another, out of the team it was in', async () => {
    const { calls } = chart({
      'PATCH /api/teams/t0': saved({}),
      'PATCH /api/teams/t1': saved({}),
    });
    const tree = await screen.findByRole('list', { name: 'Chart of the teams' });
    const row = (name: string) =>
      within(tree).getByRole('link', { name }).closest('[draggable]') as HTMLElement;
    fireEvent.dragStart(row('QA'), { dataTransfer: { setData: () => {}, effectAllowed: '' } });
    fireEvent.dragOver(row('Frontend'));
    fireEvent.drop(row('Frontend'));
    await waitFor(() =>
      expect(
        calls.filter((call) => call.route.startsWith('PATCH')).map((call) => call.body),
      ).toEqual([
        { members: [lead.id, qa.id], steps: [] },
        { members: [], steps: [] },
      ]),
    );
  });

  it('removes an agent from its team from its menu', async () => {
    const { calls, user } = chart({ 'PATCH /api/teams/t1': saved({}) });
    await user.click(await screen.findByRole('button', { name: 'Actions for QA' }));
    await user.click(screen.getByRole('menuitem', { name: 'Remove from Payments' }));
    await waitFor(() =>
      expect(calls.find((call) => call.route === 'PATCH /api/teams/t1')?.body).toEqual({
        members: [],
        steps: [],
      }),
    );
  });
});
