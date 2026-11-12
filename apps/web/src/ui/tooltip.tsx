import { Tooltip as TooltipPrimitive } from 'radix-ui';
import type { ReactElement, ReactNode } from 'react';

// shadcn/ui tooltip, restyled. Only as the name of an icon button (the collapsed sidebar):
// never a hint, a tour or an explanation.
const TooltipProvider = TooltipPrimitive.Provider;

function Tooltip({ label, children }: { label: ReactNode; children: ReactElement }) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side="right"
          sideOffset={6}
          className="z-50 rounded-md bg-ink px-2 py-1 text-small text-ink-inverse"
        >
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

export { Tooltip, TooltipProvider };
