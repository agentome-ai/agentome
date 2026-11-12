import type { ComponentProps } from 'react';
import { cn } from './cn';

// shadcn/ui input and textarea, restyled. The border meets 3:1 against every surface (WCAG 1.4.11).
// Focus is the border itself turned to ink and doubled, not the page's offset ring: a field
// that takes focus as a dialog opens would otherwise wear a heavy double frame.
const field =
  'w-full min-w-0 rounded-md border border-line-control bg-raised px-2.5 text-ink placeholder:text-ink-3 disabled:cursor-not-allowed disabled:opacity-45 aria-invalid:border-failed focus-visible:border-ink focus-visible:outline-1 focus-visible:outline-offset-0';

function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn(field, 'h-8', className)} {...props} />;
}

function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn(field, 'min-h-20 resize-y py-1.5', className)} {...props} />;
}

export { Input, Textarea };
