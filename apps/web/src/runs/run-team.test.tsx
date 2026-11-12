import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RunEvent } from './run-data';
import { RunTeam, teamWork } from './run-team';

// A lead that gives a developer two assignments and a tester one, and never calls the analyst:
// minutes from the run's start, as on the stand's PAY-164 run of 29.10.
const start = Date.parse('2026-10-29T23:13:00.000Z');
const at = (minutes: number) => new Date(start + minutes * 60_000).toISOString();
const team = [
  { key: 'analyst', agentId: 'a0000000-0000-4000-8000-000000000001', name: 'Analyst' },
  { key: 'developer', agentId: 'a0000000-0000-4000-8000-000000000002', name: 'Developer' },
  { key: 'tester', agentId: 'a0000000-0000-4000-8000-000000000003', name: 'Tester' },
];
const run = {
  agent: { id: 'a0000000-0000-4000-8000-000000000000', name: 'Delivery lead' },
  team,
  startedAt: at(0),
  endedAt: at(42),
};

let seq = 0;
function assignment(key: string, from: number, to: number, what: string, steps: number) {
  const id = `toolu_${key}_${from}`;
  const events: RunEvent[] = [
    {
      seq: seq++,
      at: at(from),
      type: 'tool_use',
      id,
      name: 'Agent',
      input: { subagent_type: key, description: what, prompt: '…' },
    },
  ];
  for (let i = 0; i < steps; i++) {
    events.push({
      seq: seq++,
      at: at(from + 0.1),
      type: 'tool_use',
      id: `${id}_${i}`,
      name: 'Read',
      input: { file_path: 'README.md' },
      parentToolUseId: id,
    });
  }
  events.push({
    seq: seq++,
    at: at(to),
    type: 'tool_result',
    toolUseId: id,
    output: 'Done',
    isError: false,
  });
  return events;
}
const events = [
  ...assignment('developer', 2, 4, 'PAY-164 plan', 8),
  ...assignment('developer', 5, 16, 'PAY-164 scaffold', 12),
  ...assignment('tester', 16, 19, 'PAY-164 tests before code', 8),
];

describe("a team run's work", () => {
  it('gives each member its assignments and the lead the time between them', () => {
    const work = teamWork(run, events, false, Date.now());
    const minutes = (ms: number) => ms / 60_000;
    expect(minutes(work?.total ?? 0)).toBe(42);
    expect(work?.lanes.map((lane) => lane.name)).toEqual(['Delivery lead', 'Developer', 'Tester']);
    const [lead, developer] = work?.lanes ?? [];
    expect(developer?.stints.map((s) => [minutes(s.from), minutes(s.to), s.steps])).toEqual([
      [2, 4, 8],
      [5, 16, 12],
    ]);
    // The developer hands straight to the tester at 16: no lead stint there.
    expect(lead?.stints.map((s) => [minutes(s.from), minutes(s.to)])).toEqual([
      [0, 2],
      [4, 5],
      [19, 42],
    ]);
    expect(work?.idle.map((member) => member.name)).toEqual(['Analyst']);
  });

  it("runs a live member's assignment to now", () => {
    const going = events.slice(0, -1);
    const now = Date.parse(at(18));
    const work = teamWork({ ...run, endedAt: null }, going, true, now);
    expect(work?.total).toBe(18 * 60_000);
    expect(work?.lanes[2]?.stints[0]?.to).toBe(18 * 60_000);
  });

  it('is nothing for a run without a team', () => {
    expect(teamWork({ ...run, team: undefined }, events, false, Date.now())).toBeUndefined();
  });

  it('shows who took part, how much, and who was not called', () => {
    const work = teamWork(run, events, false, Date.now());
    if (!work) throw new Error('no work');
    render(<RunTeam work={work} live={false} />);
    expect(screen.getByRole('heading', { name: 'Team' })).toBeTruthy();
    expect(screen.getByText(/^2 of 3/)).toBeTruthy();
    const lanes = screen.getAllByRole('listitem').map((item) => item.textContent);
    expect(lanes).toEqual([
      'DLDelivery lead26 min',
      'DDeveloper2× · 20 steps · 13 min',
      'TTester1× · 8 steps · 3 min',
    ]);
    expect(screen.getByText(/Not called in this run: Analyst/)).toBeTruthy();
  });
});
