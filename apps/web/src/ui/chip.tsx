import type { ComponentProps } from 'react';
import { cn } from './cn';

// shadcn/ui badge, reshaped into a chip: something the agent has (a project, a skill, a seat).
// Never a status pill: a status is a marker and a word (Status).
function Chip({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center gap-1.5 rounded-sm border border-line-strong bg-raised px-2 text-small whitespace-nowrap [&>svg]:size-3 [&>svg]:text-ink-3',
        className,
      )}
      {...props}
    />
  );
}

/**
 * A field as Linear shows it under a title: its value with its icon, a button that opens its
 * menu, a link, or only the value.
 */
const fieldChip =
  'inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-md border border-line-strong bg-raised px-2.5 text-ui whitespace-nowrap transition-colors duration-120 [&>span]:min-w-0 [&>svg]:size-3.5 [&>svg]:shrink-0 [a&]:hover:bg-hover [button&]:hover:bg-hover aria-expanded:bg-hover';

export { Chip, fieldChip };
