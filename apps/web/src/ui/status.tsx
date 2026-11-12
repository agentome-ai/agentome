import { useId, type ReactNode } from 'react';
import { cn } from './cn';

// The values of RunStatus in @agentome/shared, as the API sends them.
export type RunStatus = 'queued' | 'running' | 'waiting_approval' | 'done' | 'failed' | 'cancelled';

export const statusLabel: Record<RunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  waiting_approval: 'Waiting approval',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

// Shape first, color second: every marker reads without color, and each color has one meaning:
// working is amber, waiting for a person orange, done violet, broken red.
// [marker color, ring, the stroke drawn on the ring or cut out of the filled disc]
const marks: Record<RunStatus, [string, 'dashed' | 'faint' | 'solid' | 'filled', string]> = {
  queued: ['text-mark-muted', 'dashed', ''],
  running: ['text-running', 'faint', 'M7 1.75a5.25 5.25 0 0 1 0 10.5'],
  waiting_approval: ['text-waiting', 'solid', 'M5.6 5.1v3.8M8.4 5.1v3.8'],
  done: ['text-done', 'filled', 'M4.3 7.2l1.8 1.8 3.6-3.7'],
  failed: ['text-failed', 'filled', 'M5 5l4 4M9 5l-4 4'],
  cancelled: ['text-mark-muted', 'solid', 'M3.5 10.5l7-7'],
};
const stroke = { fill: 'none', strokeWidth: 1.5, strokeLinecap: 'round' } as const;

export function StatusMarker({ status, className }: { status: RunStatus; className?: string }) {
  const mask = useId();
  const [color, ring, path] = marks[status];
  return (
    <svg
      viewBox="0 0 14 14"
      aria-hidden="true"
      className={cn(
        'size-3.5 shrink-0',
        color,
        status === 'running' && 'animate-running',
        className,
      )}
    >
      {ring === 'filled' ? (
        <>
          <mask id={mask}>
            <rect width="14" height="14" fill="#fff" />
            <path d={path} {...stroke} stroke="#000" strokeWidth={1.6} />
          </mask>
          <circle cx="7" cy="7" r="6" fill="currentColor" mask={`url(#${mask})`} />
        </>
      ) : (
        <>
          {/* Butt caps: round ones would close the gaps of the dashed "queued" ring. */}
          <circle
            cx="7"
            cy="7"
            r="5.25"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeDasharray={ring === 'dashed' ? '2.06 2.06' : undefined}
            strokeOpacity={ring === 'faint' ? 0.3 : undefined}
          />
          {path && <path d={path} {...stroke} stroke="currentColor" />}
        </>
      )}
    </svg>
  );
}

// The word takes the status color only when someone has to act: waiting and failed.
const wordColor: Partial<Record<RunStatus, string>> = {
  waiting_approval: 'text-waiting',
  failed: 'text-failed',
  cancelled: 'text-ink-3',
};

/** A status marker with its word; never a colored pill. */
// A status with words in a one-line cell: the words, in a span, give way; the marker stays.
export const statusInCell = 'max-w-full [&>*:last-child]:truncate';

export function Status(props: { status: RunStatus; children?: ReactNode; className?: string }) {
  const { status, children, className } = props;
  return (
    <span
      className={cn('inline-flex items-center gap-2', wordColor[status] ?? 'text-ink-2', className)}
    >
      <StatusMarker status={status} />
      {children ?? statusLabel[status]}
    </span>
  );
}

/** Whether a computer is online: a dot, filled when it is, a ring when it is not. */
export function Presence(props: { online: boolean; children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2', props.className)}>
      <span
        aria-hidden="true"
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          props.online ? 'bg-ink' : 'border border-mark-muted',
        )}
      />
      {props.children}
    </span>
  );
}
