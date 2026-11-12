import { Switch as SwitchPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from './cn';

// shadcn/ui switch on Radix, restyled: on is ink, as the primary button is, off is a rule.
function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'inline-flex h-4 w-7 shrink-0 items-center rounded-full bg-line-strong p-0.5 transition-colors duration-120 disabled:cursor-not-allowed disabled:opacity-45 data-[state=checked]:bg-ink',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="size-3 rounded-full bg-ink-3 transition-transform duration-120 data-[state=checked]:translate-x-3 data-[state=checked]:bg-ink-inverse" />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
