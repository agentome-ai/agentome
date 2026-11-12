import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Calendar, DateField } from './calendar';

const on = (year: number, month: number, date: number) => new Date(year, month - 1, date);
const dayButton = (name: RegExp | string) => screen.getByRole('button', { name });

describe('Calendar', () => {
  it('shows the month of its day, weeks from Monday, and picks a day', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<Calendar value={on(2026, 11, 24)} onSelect={onSelect} />);
    expect(screen.getByText('November 2026')).toBeTruthy();
    const grid = screen.getByRole('grid', { name: 'November 2026' });
    expect(
      within(grid)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']);
    // 1 November 2026 is a Sunday: the last cell of the first week.
    const firstWeek = within(grid).getAllByRole('row')[1] as HTMLElement;
    expect(within(firstWeek).getAllByRole('gridcell').at(-1)?.textContent).toBe('1');
    const chosen = dayButton('Tuesday, 24 November 2026');
    expect(chosen.closest('td')?.getAttribute('aria-selected')).toBe('true');
    expect(chosen.tabIndex).toBe(0);

    await user.click(dayButton('Friday, 27 November 2026'));
    expect(onSelect).toHaveBeenCalledWith(on(2026, 11, 27));
  });

  it('keeps the days out of range off, and the months beyond them closed', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <Calendar
        value={on(2026, 11, 24)}
        min={on(2026, 11, 11)}
        max={on(2026, 12, 5)}
        onSelect={onSelect}
      />,
    );
    expect(dayButton('Tuesday, 10 November 2026')).toHaveProperty('disabled', true);
    expect(dayButton('Wednesday, 11 November 2026')).toHaveProperty('disabled', false);
    expect(screen.getByRole('button', { name: 'Previous month' })).toHaveProperty('disabled', true);
    await user.click(screen.getByRole('button', { name: 'Next month' }));
    expect(screen.getByText('December 2026')).toBeTruthy();
    expect(dayButton('Sunday, 6 December 2026')).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Next month' })).toHaveProperty('disabled', true);
  });

  it('moves by the keyboard: a day, a week, the ends of the week, a month, and stops at the range', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<Calendar value={on(2026, 11, 24)} min={on(2026, 11, 11)} onSelect={onSelect} />);
    const focused = () => document.activeElement?.getAttribute('aria-label');
    dayButton('Tuesday, 24 November 2026').focus();
    await user.keyboard('{ArrowRight}');
    expect(focused()).toBe('Wednesday, 25 November 2026');
    await user.keyboard('{ArrowDown}');
    expect(focused()).toBe('Wednesday, 2 December 2026');
    expect(screen.getByText('December 2026')).toBeTruthy();
    await user.keyboard('{Home}');
    expect(focused()).toBe('Monday, 30 November 2026');
    await user.keyboard('{End}');
    expect(focused()).toBe('Sunday, 6 December 2026');
    await user.keyboard('{PageDown}');
    expect(focused()).toBe('Wednesday, 6 January 2027');
    // Back past the first day that can be picked: it stops there.
    await user.keyboard('{PageUp}{PageUp}{PageUp}');
    expect(focused()).toBe('Wednesday, 11 November 2026');
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith(on(2026, 11, 11));
  });
});

describe('DateField', () => {
  function Field() {
    const [value, setValue] = useState<Date>();
    return (
      <DateField
        aria-label="Comes back"
        value={value}
        onChange={setValue}
        min={on(2026, 11, 11)}
        placeholder="Never"
        clearLabel="Never"
      />
    );
  }

  it('says its day, opens the calendar, and can be emptied again', async () => {
    const user = userEvent.setup();
    vi.useFakeTimers({ now: on(2026, 11, 10), toFake: ['Date'] });
    try {
      render(<Field />);
      const field = screen.getByRole('button', { name: 'Comes back' });
      expect(field.textContent).toBe('Never');
      await user.click(field);
      // Nothing is chosen: the first day that can be is where the keyboard starts.
      expect(dayButton('Wednesday, 11 November 2026').tabIndex).toBe(0);
      expect(document.activeElement).toBe(dayButton('Wednesday, 11 November 2026'));
      expect(screen.queryByRole('button', { name: 'Never' })).toBeNull();
      await user.click(dayButton('Tuesday, 24 November 2026'));
      expect(screen.queryByRole('grid')).toBeNull();
      expect(field.textContent).toBe('24 Nov 2026');

      await user.click(field);
      await user.click(screen.getByRole('button', { name: 'Never' }));
      expect(field.textContent).toBe('Never');
    } finally {
      vi.useRealTimers();
    }
  });
});
