import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { type ApiError, api, asApiError } from '../api';
import { formatDuration, formatUsd } from '../runs/run-data';
import { ApiErrorState } from '../session';
import { textLink } from '../ui/properties';

// How the agent does in the last 30 days, to change its instructions by what came of
// them: what was accepted, what came back and why, what a task costs and takes, and the tasks to
// read first. Accepted is any agent's measure; Merged only one's that opens change requests.

type Quality = {
  since: string;
  tasks: number;
  handed: number;
  accepted: number;
  firstTime: number;
  changeRequests: { merged: number; closed: number; open: number };
  returns: { total: number; tasks: number; person: number; ci: number; review: number };
  usd: { median: string | null; total: string | null };
  seconds: { work: number | null; toReview: number | null };
  runs: { ended: number; failed: number; limited: number };
  mostReturned: { id: string; title: string; returns: number; usd: string | null }[];
};

const percent = (part: number, whole: number) => Math.round((part / whole) * 100);
const times = (n: number) => (n === 1 ? 'once' : `${n} times`);
const duration = (seconds: number | null) =>
  seconds === null ? null : formatDuration(seconds * 1000);

/** A figure: its value large, what it counts small under it, and a meter when it is a share. */
type Figure = { label: string; value: string | null; detail?: ReactNode; share?: number };

/** The shares that say whether the agent's work lands; Merged only for one that opens change requests. */
function landing(q: Quality): Figure[] {
  const { merged, closed, open } = q.changeRequests;
  const decided = merged + closed;
  const figures: Figure[] = [
    {
      label: 'Accepted',
      value: q.handed ? `${percent(q.accepted, q.handed)}%` : null,
      share: q.handed ? q.accepted / q.handed : undefined,
      detail: q.handed
        ? `${q.accepted} of ${q.handed} handed over${q.handed > q.accepted ? `; ${q.handed - q.accepted} in review or back in work` : ''}`
        : undefined,
    },
    {
      label: 'At the first go',
      value: q.accepted ? `${percent(q.firstTime, q.accepted)}%` : null,
      share: q.accepted ? q.firstTime / q.accepted : undefined,
      detail: q.accepted ? `${q.firstTime} of ${q.accepted} accepted` : undefined,
    },
  ];
  if (decided + open > 0) {
    figures.push({
      label: 'Merged',
      value: decided ? `${percent(merged, decided)}%` : null,
      share: decided ? merged / decided : undefined,
      detail: `${decided ? `${merged} of ${decided} decided` : 'None decided'}${open ? `; ${open} still open` : ''}`,
    });
  }
  return figures;
}

/** What a task costs and takes, and how often a run fails. */
function effort(q: Quality): Figure[] {
  return [
    {
      label: 'Cost per task',
      value: q.usd.median === null ? null : formatUsd(q.usd.median),
      detail: q.usd.total ? `${formatUsd(q.usd.total)} in all` : undefined,
    },
    { label: 'Agent time per task', value: duration(q.seconds.work) },
    { label: 'Created to review', value: duration(q.seconds.toReview) },
    {
      label: 'Failed runs',
      value: q.runs.ended ? `${q.runs.failed} of ${q.runs.ended}` : null,
      detail: q.runs.limited ? `${q.runs.limited} on a limit` : undefined,
    },
  ];
}

/**
 * How a frame of figures lays out by the room the section has, not the screen's: the three
 * shares side by side once each fits, else one under another; the four costs in two pairs until
 * all four fit in a row. Rules part them either way.
 */
const layouts = {
  3: {
    frame: '@min-[420px]:grid-cols-3',
    cell: 'not-first:border-t @min-[420px]:not-first:border-t-0 @min-[420px]:not-first:border-l',
  },
  4: {
    frame: 'grid-cols-2 @min-[600px]:grid-cols-4',
    cell: 'even:border-l nth-[n+3]:border-t @min-[600px]:nth-[n+3]:border-t-0 @min-[600px]:not-first:border-l',
  },
};

/**
 * Figures side by side in one ruled frame, each value read after its label. A share's meter says
 * what its number says, so a screen reader is not told twice.
 */
function Figures({ label, figures, large }: { label: string; figures: Figure[]; large?: boolean }) {
  const layout = figures.length === 4 ? layouts[4] : layouts[3];
  return (
    <div className="@container">
      <dl
        aria-label={label}
        className={`grid overflow-hidden rounded-lg border border-line bg-raised ${figures.length === 2 ? '@min-[420px]:grid-cols-2' : layout.frame}`}
      >
        {figures.map((figure) => (
          <div
            key={figure.label}
            className={`grid content-start gap-1 border-line px-4 py-3.5 ${layout.cell}`}
          >
            <dt className="text-small text-ink-3">{figure.label}</dt>
            <dd className="grid gap-1.5">
              <span
                className={
                  large
                    ? 'text-[28px] leading-8 font-semibold tracking-[-0.03em] tabular-nums'
                    : 'text-[17px] leading-6 font-semibold tracking-[-0.01em] tabular-nums'
                }
              >
                {figure.value ?? <span className="text-ink-3">None</span>}
              </span>
              {figure.share !== undefined && (
                <span
                  aria-hidden="true"
                  className="block h-1 overflow-hidden rounded-full bg-selected"
                >
                  <span
                    className="block h-full rounded-full bg-done"
                    style={{ width: `${Math.round(figure.share * 100)}%` }}
                  />
                </span>
              )}
              {figure.detail && <span className="text-small text-ink-2">{figure.detail}</span>}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Why work came back, each reason in the colour of who sent it back. */
const REASONS = [
  ['person', 'by people', 'bg-waiting'],
  ['ci', 'for failed CI', 'bg-failed'],
  ['review', 'for a review', 'bg-review'],
] as const;

/** How often work came back, and one bar split by why; the legend under it says it in words. */
function CameBack({ returns }: { returns: Quality['returns'] }) {
  if (returns.total === 0) {
    return <p className="text-ink-2">Nothing came back after the agent handed it over.</p>;
  }
  const parts = REASONS.filter(([key]) => returns[key] > 0);
  return (
    <div className="grid gap-2.5">
      <p>
        <span className="font-semibold">{times(returns.total)}</span>
        <span className="text-ink-2">
          {' '}
          on {returns.tasks} {returns.tasks === 1 ? 'task' : 'tasks'}
        </span>
      </p>
      <span aria-hidden="true" className="flex h-2 gap-0.5 overflow-hidden rounded-full">
        {parts.map(([key, , color]) => (
          <span key={key} className={color} style={{ flexGrow: returns[key] }} />
        ))}
      </span>
      <ul className="flex flex-wrap gap-x-5 gap-y-1 text-small text-ink-2">
        {parts.map(([key, said, color]) => (
          <li key={key} className="flex items-center gap-1.5">
            <span aria-hidden="true" className={`size-2 rounded-full ${color}`} />
            <span className="tabular-nums">{returns[key]}</span> {said}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function QualitySection({ agentId }: { agentId: string }) {
  const [quality, setQuality] = useState<Quality>();
  const [error, setError] = useState<ApiError>();

  const load = useCallback(() => {
    setError(undefined);
    api<Quality>(`/api/agents/${agentId}/quality`).then(setQuality, (caught: unknown) =>
      setError(asApiError(caught)),
    );
  }, [agentId]);
  useEffect(load, [load]);

  // Quality is Enterprise: on Free the section says what it would show.
  if (error?.code === 'license_required') {
    return (
      <p className="text-ink-2">
        An agent&apos;s quality comes with a license key: what was accepted and what came back in
        the last 30 days, what a task costs and takes, and the tasks to read first.
      </p>
    );
  }
  if (error) return <ApiErrorState title="Couldn't count" error={error} onRetry={load} />;
  if (!quality) return <p className="text-ink-3">Counting the last 30 days…</p>;
  if (quality.tasks === 0 && quality.runs.ended === 0) {
    return (
      <p className="text-ink-2">
        No tasks in the last 30 days. Give the agent work, and here you see what was accepted, what
        came back and what a task costs.
      </p>
    );
  }
  return (
    <div className="grid gap-6">
      <div className="grid gap-3">
        <p className="text-small text-ink-3">The last 30 days</p>
        <Figures label="Whether its work lands" figures={landing(quality)} large />
        <Figures label="What a task costs and takes" figures={effort(quality)} />
      </div>
      <div className="grid gap-2">
        <h3 className="font-medium">Came back</h3>
        <CameBack returns={quality.returns} />
      </div>
      {quality.mostReturned.length > 0 && (
        <div className="grid gap-2">
          <h3 className="font-medium">Came back most</h3>
          <ul className="grid gap-1.5">
            {quality.mostReturned.map((task) => (
              <li key={task.id} className="flex min-w-0 items-baseline gap-3">
                <Link to={`/tasks/${task.id}`} className={`${textLink} truncate`}>
                  {task.title}
                </Link>
                <span className="ml-auto shrink-0 text-small text-ink-3">
                  {times(task.returns)}
                  {task.usd && `, ${formatUsd(task.usd)}`}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-small text-ink-3">
            A task came back when it ran again after the agent handed it over. Read these first:
            what people asked again is what the instructions miss. Money is at API prices.
          </p>
        </div>
      )}
    </div>
  );
}
