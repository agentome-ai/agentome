import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from './cn';

// shadcn/ui radio group, restyled. "ask" paints the checked dot in Sign-off: the policy
// column where an agent will wait for a person.
const RadioGroup = RadioGroupPrimitive.Root;

function RadioGroupItem({
  className,
  tone,
  ...props
}: ComponentProps<typeof RadioGroupPrimitive.Item> & { tone?: 'ask' }) {
  return (
    <RadioGroupPrimitive.Item
      className={cn(
        'grid size-4 shrink-0 place-items-center rounded-full border border-line-control bg-raised disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-ink',
        tone === 'ask' && 'data-[state=checked]:border-accent',
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator
        className={cn('size-2 rounded-full bg-ink', tone === 'ask' && 'bg-accent')}
      />
    </RadioGroupPrimitive.Item>
  );
}

/** A radio drawn as a tab, for a choice of a few things side by side; arrow keys still move it. */
function RadioTab({ className, ...props }: ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      className={cn(
        'group flex h-10 items-center justify-center gap-2 rounded-lg border border-line-strong font-medium text-ink-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-ink data-[state=checked]:bg-raised data-[state=checked]:text-ink',
        className,
      )}
      {...props}
    />
  );
}

/**
 * A radio drawn as one segment of a few side by side, as a phone's segmented control: the
 * chosen one raised. "ask" colours the chosen word in Sign-off, as the dot does.
 */
function RadioSegment({
  className,
  tone,
  ...props
}: ComponentProps<typeof RadioGroupPrimitive.Item> & { tone?: 'ask' }) {
  return (
    <RadioGroupPrimitive.Item
      className={cn(
        'h-6 rounded-[5px] px-2.5 text-small text-ink-3 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-selected data-[state=checked]:font-medium data-[state=checked]:text-ink',
        tone === 'ask' && 'data-[state=checked]:text-accent',
        className,
      )}
      {...props}
    />
  );
}

export { RadioGroup, RadioGroupItem, RadioSegment, RadioTab };
