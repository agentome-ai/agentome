import { Check } from 'lucide-react';
import { Checkbox as CheckboxPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from './cn';

// shadcn/ui checkbox on Radix, restyled: a 16 px box with the field border, ink when checked.
function Checkbox({ className, ...props }: ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        'grid size-4 shrink-0 place-items-center rounded-sm border border-line-control bg-raised text-ink-inverse disabled:cursor-not-allowed disabled:opacity-45 data-[state=checked]:border-ink data-[state=checked]:bg-ink',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator>
        <Check className="size-3" strokeWidth={2.5} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
