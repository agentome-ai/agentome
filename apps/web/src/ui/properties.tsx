import type { ReactNode } from 'react';
import { cn } from './cn';

/**
 * What a thing is, as label and value pairs: a run's facts, a task's. One style on every page,
 * labels in the third ink so the values lead.
 */
export function Properties({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <dl className={cn('grid grid-cols-[96px_minmax(0,1fr)] gap-x-4 gap-y-2', className)}>
      {children}
    </dl>
  );
}

export function Property({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <>
      <dt className="text-ink-3">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

/** A link inside text or a value: underlined at rest, so it reads as one without a hover. */
export const textLink = 'underline decoration-line-control underline-offset-2 hover:decoration-ink';
