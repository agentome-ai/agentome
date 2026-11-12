import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { type ComponentProps, type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { Button } from './button';
import { cn } from './cn';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { menuItem, triggerVariants } from './select';

// A day picked in a month's grid, in the kit's Popover. Never a native date input: its popup is
// the browser's, in the browser's colours. Days are local dates at midnight; weeks start on
// Monday. The grid is the date picker of the ARIA practices: one day is in the tab order, the
// arrows move by a day and a week, Home and End to the ends of the week, Page Up and Page Down by
// a month.

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const day = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const addDays = (date: Date, days: number) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
/** The same day of another month, or that month's last day when it is shorter. */
function addMonths(date: Date, months: number) {
  const first = new Date(date.getFullYear(), date.getMonth() + months, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return new Date(first.getFullYear(), first.getMonth(), Math.min(date.getDate(), last));
}
const sameDay = (a: Date | undefined, b: Date) => a !== undefined && day(a).getTime() === +b;
/** Monday is 0. */
const weekday = (date: Date) => (date.getDay() + 6) % 7;
/** 24 Nov 2026, as dates read everywhere in the product. */
const short = (date: Date) =>
  `${date.getDate()} ${MONTHS[date.getMonth()]?.slice(0, 3)} ${date.getFullYear()}`;

export function Calendar(props: {
  value?: Date;
  onSelect: (day: Date) => void;
  /** The first and the last day that can be picked. */
  min?: Date;
  max?: Date;
}) {
  const min = props.min && day(props.min);
  const max = props.max && day(props.max);
  const within = (date: Date) => (!min || date >= min) && (!max || date <= max);
  const clamp = (date: Date) => (min && date < min ? min : max && date > max ? max : date);
  // The day the keyboard is on; its month is the one shown.
  const [focus, setFocus] = useState(() => clamp(day(props.value ?? new Date())));
  const grid = useRef<HTMLTableElement>(null);
  // Set by a key, so that only a move by the keyboard takes the focus along.
  const moved = useRef(false);
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    grid.current?.querySelector<HTMLButtonElement>('button[tabindex="0"]')?.focus();
  }, [focus]);
  const label = useId();
  const today = day(new Date());

  const first = new Date(focus.getFullYear(), focus.getMonth(), 1);
  const length = new Date(focus.getFullYear(), focus.getMonth() + 1, 0).getDate();
  const cells: (Date | null)[] = [
    ...Array.from({ length: weekday(first) }, () => null),
    ...Array.from({ length }, (_, index) => addDays(first, index)),
  ];
  const weeks = Array.from({ length: Math.ceil(cells.length / 7) }, (_, week) =>
    Array.from({ length: 7 }, (_, index) => cells[week * 7 + index] ?? null),
  );

  function onKeyDown(event: KeyboardEvent) {
    const steps: Record<string, Date> = {
      ArrowLeft: addDays(focus, -1),
      ArrowRight: addDays(focus, 1),
      ArrowUp: addDays(focus, -7),
      ArrowDown: addDays(focus, 7),
      Home: addDays(focus, -weekday(focus)),
      End: addDays(focus, 6 - weekday(focus)),
      PageUp: addMonths(focus, event.shiftKey ? -12 : -1),
      PageDown: addMonths(focus, event.shiftKey ? 12 : 1),
    };
    const next = steps[event.key];
    if (!next) return;
    event.preventDefault();
    moved.current = true;
    setFocus(clamp(next));
  }
  const turn = (months: number) => setFocus(clamp(addMonths(focus, months)));
  const lastOfPrevious = addDays(first, -1);
  const firstOfNext = addDays(first, length);

  return (
    <div className="p-2">
      <div className="flex items-center justify-between gap-2 pb-1">
        <Button
          variant="quiet"
          size="icon-sm"
          aria-label="Previous month"
          disabled={!within(lastOfPrevious)}
          onClick={() => turn(-1)}
        >
          <ChevronLeft aria-hidden="true" className="size-4" />
        </Button>
        <span id={label} aria-live="polite" className="font-medium">
          {MONTHS[focus.getMonth()]} {focus.getFullYear()}
        </span>
        <Button
          variant="quiet"
          size="icon-sm"
          aria-label="Next month"
          disabled={!within(firstOfNext)}
          onClick={() => turn(1)}
        >
          <ChevronRight aria-hidden="true" className="size-4" />
        </Button>
      </div>
      <table ref={grid} role="grid" aria-labelledby={label} onKeyDown={onKeyDown}>
        <thead>
          <tr>
            {WEEKDAYS.map((name) => (
              <th
                key={name}
                scope="col"
                abbr={name}
                className="size-8 text-small font-normal text-ink-3"
              >
                {name.slice(0, 2)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week, index) => (
            <tr key={index}>
              {week.map((date, column) => (
                <td
                  key={column}
                  role="gridcell"
                  aria-selected={date ? sameDay(props.value, date) : undefined}
                  className="p-0"
                >
                  {date && (
                    <button
                      type="button"
                      tabIndex={+date === +focus ? 0 : -1}
                      disabled={!within(date)}
                      aria-label={`${WEEKDAYS[weekday(date)]}, ${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`}
                      aria-current={+date === +today ? 'date' : undefined}
                      onClick={() => props.onSelect(date)}
                      onFocus={() => setFocus(date)}
                      className={cn(
                        'grid size-8 place-items-center rounded-md border border-transparent tabular-nums hover:bg-hover disabled:pointer-events-none disabled:text-ink-3 disabled:opacity-45 aria-[current=date]:border-line-strong',
                        sameDay(props.value, date) &&
                          'bg-ink font-medium text-ink-inverse hover:bg-primary-hover',
                      )}
                    >
                      {date.getDate()}
                    </button>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A field that holds a day or nothing: it reads as the kit's Select and opens the calendar.
 * `clearLabel` is the choice of no day, said in words under the grid, when a day is set.
 */
export function DateField({
  value,
  onChange,
  min,
  max,
  placeholder,
  clearLabel,
  className,
  ...control
}: {
  value: Date | undefined;
  onChange: (day: Date | undefined) => void;
  min?: Date;
  max?: Date;
  placeholder: string;
  clearLabel?: string;
} & Omit<ComponentProps<'button'>, 'value' | 'onChange'>) {
  const [open, setOpen] = useState(false);
  const pick = (next: Date | undefined) => {
    onChange(next);
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          {...control}
          className={cn(triggerVariants(), !value && 'text-ink-3', className)}
        >
          <span>{value ? short(value) : placeholder}</span>
          <CalendarDays aria-hidden="true" className="size-4 shrink-0 text-ink-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-auto p-0"
        // The keyboard starts on the day, not on the arrow of the month before it.
        onOpenAutoFocus={(event) => {
          const start = (event.currentTarget as HTMLElement).querySelector<HTMLElement>(
            '[role="grid"] button[tabindex="0"]',
          );
          if (!start) return;
          event.preventDefault();
          start.focus();
        }}
      >
        <Calendar value={value} min={min} max={max} onSelect={pick} />
        {value && clearLabel && (
          <div className="border-t border-line p-1">
            <button
              type="button"
              className={cn(menuItem, 'w-full hover:bg-hover')}
              onClick={() => pick(undefined)}
            >
              {clearLabel}
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
