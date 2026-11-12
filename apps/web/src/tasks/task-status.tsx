import { useId } from 'react';
import { cn } from '../ui/cn';
import { type RunStatus, Status } from '../ui/status';
import { type TaskStatus, taskStatusLabel } from './tasks-data';

// A task's status in the runs' marker language (ui/status): shape first, colour second. Open is
// an empty ring; In review is half filled in green, the colour of a task a person should look
// at; Done is the filled disc with a check, violet as a done run. Never a coloured pill.
const check = 'M4.3 7.2l1.8 1.8 3.6-3.7';

function TaskStatusMarker({ status }: { status: TaskStatus }) {
  const mask = useId();
  return (
    <svg
      viewBox="0 0 14 14"
      aria-hidden="true"
      className={cn(
        'size-3.5 shrink-0',
        status === 'open' && 'text-mark-muted',
        status === 'review' && 'text-review',
        status === 'done' && 'text-done',
      )}
    >
      {status === 'done' ? (
        <>
          {/* The check is cut out of the disc, so it reads on any row's ground. */}
          <mask id={mask}>
            <rect width="14" height="14" fill="#fff" />
            <path d={check} fill="none" stroke="#000" strokeWidth={1.6} strokeLinecap="round" />
          </mask>
          <circle cx="7" cy="7" r="6" fill="currentColor" mask={`url(#${mask})`} />
        </>
      ) : (
        <>
          <circle cx="7" cy="7" r="5.25" fill="none" stroke="currentColor" strokeWidth={1.5} />
          {status === 'review' && <path d="M7 1.75a5.25 5.25 0 0 0 0 10.5z" fill="currentColor" />}
        </>
      )}
    </svg>
  );
}

/** A run that is not over yet: while one goes, the task reads as the run does. */
const going: Partial<Record<RunStatus, string>> = {
  queued: 'Queued',
  running: 'Running',
  waiting_approval: 'Waiting for you',
};

/**
 * The task's status, or its run's while one is queued, running or waiting for the person: Open
 * beside a run at work read as if nothing were happening.
 */
export function TaskStatusMark({
  status,
  run,
  className,
}: {
  status: TaskStatus;
  run?: { status: RunStatus } | null;
  className?: string;
}) {
  const live = run ? going[run.status] : undefined;
  if (run && live) {
    return (
      <Status status={run.status} className={className}>
        <span>{live}</span>
      </Status>
    );
  }
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2',
        status === 'review' ? 'text-review' : 'text-ink-2',
        className,
      )}
    >
      <TaskStatusMarker status={status} />
      <span>{taskStatusLabel[status]}</span>
    </span>
  );
}
