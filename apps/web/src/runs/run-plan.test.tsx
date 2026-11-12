import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { RunEvent } from './run-data';
import { planOf, RunPlan } from './run-plan';

const at = '2026-10-29T18:00:00.000Z';
const todo = (content: string, status: string, activeForm = content) => ({
  content,
  status,
  activeForm,
});
const plan = (seq: number, todos: object[]): RunEvent => ({
  seq,
  at,
  type: 'tool_use',
  id: `plan-${seq}`,
  name: 'TodoWrite',
  input: { todos },
});
const read = (seq: number, file: string): RunEvent[] => [
  { seq, at, type: 'tool_use', id: `read-${seq}`, name: 'Read', input: { file_path: file } },
  {
    seq: seq + 1,
    at,
    type: 'tool_result',
    toolUseId: `read-${seq}`,
    output: 'text',
    isError: false,
  },
];

// A lead that plans two steps, reads the issue in the first, and is in the second.
const events: RunEvent[] = [
  { seq: 0, at, type: 'started', model: 'claude-opus-5-5', cliVersion: '2.1.280' },
  plan(1, [
    todo('Read PAY-164', 'in_progress', 'Reading PAY-164'),
    todo('Write the scenarios', 'pending'),
  ]),
  { seq: 2, at, type: 'tool_result', toolUseId: 'plan-1', output: 'ok', isError: false },
  ...read(3, 'issue.md'),
  { seq: 5, at, type: 'assistant_message', text: 'The issue is about labels.' },
  plan(6, [
    todo('Read PAY-164', 'completed', 'Reading PAY-164'),
    todo('Write the scenarios', 'in_progress', 'Writing the scenarios'),
  ]),
  ...read(7, 'spec.md'),
  {
    seq: 9,
    at,
    type: 'tool_use',
    id: 'bash-9',
    name: 'Bash',
    input: { command: 'pnpm test', description: 'Run the tests' },
  },
];

describe('the plan of a run', () => {
  it("is the agent's latest to-do list, each step with what was done while it was current", () => {
    const steps = planOf(events);
    expect(steps.map(({ content, status }) => [content, status])).toEqual([
      ['Read PAY-164', 'completed'],
      ['Write the scenarios', 'in_progress'],
    ]);
    expect(steps[0]?.events.map((event) => event.seq)).toEqual([3, 4, 5]);
    expect(steps[1]?.events.map((event) => event.seq)).toEqual([7, 8, 9]);
  });

  it('shows the checklist, what the agent does now, and opens a step on its work', async () => {
    render(<RunPlan events={events} steps={planOf(events)} live />);
    const section = within(screen.getByRole('region', { name: 'Plan' }));
    expect(section.getByText('1 of 2 done')).toBeTruthy();
    // The step in progress in its present tense, and under the list the call that runs now.
    expect(section.getByRole('button', { name: /Writing the scenarios/ })).toBeTruthy();
    expect(section.getByRole('status').textContent).toBe('Run the tests…');
    const first = section.getByRole('button', { name: /Read PAY-164/ });
    expect(first.textContent).toContain('2 actions');
    await userEvent.setup().click(first);
    expect(first.getAttribute('aria-expanded')).toBe('true');
    expect(section.getByText('The issue is about labels.')).toBeTruthy();
  });

  it('does not say the step in progress again under the list', () => {
    // No call is running: the step is all there is to say, and the list says it already.
    const between = events.slice(0, -1);
    render(<RunPlan events={between} steps={planOf(between)} live />);
    const section = within(screen.getByRole('region', { name: 'Plan' }));
    expect(section.getByRole('button', { name: /Writing the scenarios/ })).toBeTruthy();
    expect(section.queryByRole('status')).toBeNull();
  });

  it('says what goes on while no step is in progress, and shows no plan without one', () => {
    const noPlan = events.filter(
      (event) => !(event.type === 'tool_use' && event.name === 'TodoWrite'),
    );
    render(<RunPlan events={noPlan} steps={planOf(noPlan)} live />);
    expect(screen.queryByRole('heading', { name: 'Plan' })).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Run the tests…');
  });
});
