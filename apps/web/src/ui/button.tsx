import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from './cn';

// shadcn/ui button, restyled: ink primary, and for approvals only the Sign-off "decision". The
// other answer, Deny, is the plain `secondary`: a row holds one colour, the answer's.
const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border border-transparent font-medium whitespace-nowrap transition-colors duration-120 disabled:cursor-not-allowed disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        // Disabled, it steps back to the page's own grey, not a half-transparent slab of ink.
        primary:
          'bg-ink text-ink-inverse hover:bg-primary-hover disabled:border-line-strong disabled:bg-selected disabled:text-ink-3 disabled:opacity-100',
        secondary: 'border-line-strong bg-raised text-ink hover:bg-hover',
        quiet: 'text-ink-2 hover:bg-hover hover:text-ink',
        // The approve of an agent that waits, as the empty Approvals draws it: a tint of the
        // Sign-off blue with its word in that blue, not a slab of it.
        decision: 'bg-accent-subtle text-accent-text hover:bg-accent-subtle-hover',
        danger: 'border-line-strong bg-raised text-failed hover:bg-hover',
      },
      size: {
        default: 'h-8 px-3',
        sm: 'h-7 px-2.5',
        icon: 'size-8 px-0',
        'icon-sm': 'size-7 px-0',
      },
    },
    compoundVariants: [{ variant: 'quiet', size: 'default', className: 'px-2.5' }],
    // Secondary by default: a screen has at most one primary button, so it is always explicit.
    defaultVariants: { variant: 'secondary', size: 'default' },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'button';
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export { Button, buttonVariants };
