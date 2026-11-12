import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { backendDeveloper, newAgent } from '../styleguide/mock';
import { AgentSheet } from './agent-sheet';

const sheet = () => screen.getByRole('complementary', { name: /^Agent sheet/ });
const density = () => sheet().parentElement?.dataset.density;

describe('AgentSheet', () => {
  it('summarizes tools by policy and connector', () => {
    render(<AgentSheet {...backendDeveloper} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Backend developer' })).toBeTruthy();
    expect(screen.getByRole('img', { name: '13 tools: 8 can, 3 ask owner, 2 never' })).toBeTruthy();
    const jira = screen.getByRole('rowheader', { name: 'Jira' }).closest('tr');
    expect(jira?.textContent).toBe('Jira12');
    expect(screen.getByText('$2.40–$6.10 per task')).toBeTruthy();
    expect(
      screen.getByText('CLAUDE.md, 4 skills, 11 tools and 3 memory documents go into each run.'),
    ).toBeTruthy();
  });

  it('lists every tool on request and marks the unsaved one', async () => {
    const user = userEvent.setup();
    render(<AgentSheet {...backendDeveloper} />);
    const showAll = screen.getByRole('button', { name: 'Show all 13 tools' });
    await user.click(showAll);
    expect(showAll.getAttribute('aria-expanded')).toBe('true');
    const item = screen.getByText('Comment on an issue').closest('li');
    expect(item?.textContent).toContain('Unsaved');
  });

  it('makes Run primary only when there are no unsaved changes', () => {
    const { rerender } = render(<AgentSheet {...backendDeveloper} />);
    expect(screen.getByRole('button', { name: 'Run' }).className).not.toContain('bg-ink');
    rerender(<AgentSheet {...backendDeveloper} unsavedChanges={false} />);
    expect(screen.getByRole('button', { name: 'Run' }).className).toContain('bg-ink');
  });

  it('reports the action a person picks', async () => {
    const onAction = vi.fn();
    const user = userEvent.setup();
    render(<AgentSheet {...backendDeveloper} onAction={onAction} />);
    await user.click(screen.getByRole('button', { name: 'Transfer ownership' }));
    expect(onAction).toHaveBeenCalledWith('transfer');
  });

  it('switches to the compact density when the pass is taller than the window, and back', () => {
    render(<AgentSheet {...backendDeveloper} />);
    expect(density()).toBe('pass');

    // jsdom has no layout: give the panel a max height and a taller pass, as a short window would.
    const panel = sheet();
    panel.style.maxHeight = '500px';
    Object.defineProperty(panel, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(panel, 'scrollHeight', { configurable: true, value: 900 });
    act(() => void window.dispatchEvent(new Event('resize')));
    expect(density()).toBe('compact');

    // A taller window: the pass fits again, so the panel is as tall as its content.
    panel.style.maxHeight = '1000px';
    Object.defineProperty(panel, 'clientHeight', { configurable: true, value: 900 });
    act(() => void window.dispatchEvent(new Event('resize')));
    expect(density()).toBe('pass');
  });

  it('keeps its density while a list is open', async () => {
    const user = userEvent.setup();
    render(<AgentSheet {...backendDeveloper} />);
    const panel = sheet();
    const showAll = screen.getByRole('button', { name: 'Show all 13 tools' });
    await user.click(showAll);
    // The open list makes the panel overflow; the sheet must not fold under the reader.
    panel.style.maxHeight = '500px';
    Object.defineProperty(panel, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(panel, 'scrollHeight', { configurable: true, value: 900 });
    act(() => void window.dispatchEvent(new Event('resize')));
    expect(density()).toBe('pass');
    await user.click(screen.getByRole('button', { name: 'Hide the list' }));
    act(() => void window.dispatchEvent(new Event('resize')));
    expect(density()).toBe('compact');
  });

  it('opens a compact row to the same details', async () => {
    const user = userEvent.setup();
    render(<AgentSheet {...backendDeveloper} />);
    const access = screen.getByRole('button', { name: /^Access/ });
    expect(access.getAttribute('aria-expanded')).toBe('false');
    await user.click(access);
    expect(access.getAttribute('aria-expanded')).toBe('true');
    const details = document.getElementById(access.getAttribute('aria-controls') ?? '');
    expect(within(details as HTMLElement).getByText('until 3 Nov')).toBeTruthy();
  });

  it('shows the empty states of a new agent', () => {
    render(<AgentSheet {...newAgent} />);
    expect(screen.getByText('Never run')).toBeTruthy();
    expect(screen.getAllByText('No runs yet').length).toBeGreaterThan(0);
    expect(screen.getByText('Limit $100 a month')).toBeTruthy();
    expect(screen.getByText('Not shared with anyone')).toBeTruthy();
    expect(screen.getByText('No skills yet')).toBeTruthy();
    expect(screen.getAllByText('No projects').length).toBeGreaterThan(0);
    expect(screen.getByText('No computer connected')).toBeTruthy();
    expect(screen.getByText('CLAUDE.md and 1 tool go into each run.')).toBeTruthy();
  });
});
