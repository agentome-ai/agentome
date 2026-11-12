import { Activity as ActivityIcon, ChevronRight } from 'lucide-react';
import { Link } from 'react-router';
import { timeAgo } from '../api';
import {
  failureText,
  formatUsd,
  runDuration,
  type RunList,
  type RunStatus,
  runTitle,
} from '../runs/run-data';
import { StatusMarker } from '../ui/status';

type Run = RunList['runs'][number];

// What the agents did lately, newest first: each run where it is now, said in words, with
// its task, how long and what it cost, or why it stopped.

const verbs: Partial<Record<RunStatus, string>> = {
  done: 'Run finished',
  failed: 'Run stopped',
  running: 'Run started',
  waiting_approval: 'Waiting for you',
  queued: 'Queued',
};

/** When the run last moved: its end, its start, or when it was queued. */
const movedAt = (run: Run) => run.endedAt ?? run.startedAt ?? run.createdAt;

function detail(run: Run) {
  if (run.status === 'failed') {
    return (run.errorCode && failureText(run.errorCode)) ?? 'The transcript says where.';
  }
  const parts = [runTitle(run), runDuration(run), run.cost.usd && formatUsd(run.cost.usd)];
  return parts.filter(Boolean).join(' · ');
}

export function RecentActivity({ runs, shown = 8 }: { runs: Run[]; shown?: number }) {
  const recent = [...runs]
    .sort((left, right) => Date.parse(movedAt(right)) - Date.parse(movedAt(left)))
    .slice(0, shown);
  return (
    <section aria-labelledby="activity-heading" className="rounded-xl border border-line bg-raised">
      <header className="flex items-center gap-2 border-b border-line px-4 py-3">
        <ActivityIcon aria-hidden="true" className="size-4 text-ink-2" />
        <h2 id="activity-heading" className="font-semibold">
          Recent activity
        </h2>
        <Link
          to="/runs"
          className="ml-auto inline-flex items-center gap-0.5 text-small text-ink-2 hover:text-ink"
        >
          All runs
          <ChevronRight aria-hidden="true" className="size-3.5" />
        </Link>
      </header>
      {recent.length ? (
        <ul className="divide-y divide-line">
          {recent.map((run) => (
            <li key={run.id}>
              <Link
                to={`/runs/${run.id}`}
                className="grid grid-cols-[28px_minmax(0,1fr)_auto] gap-3 px-4 py-3 hover:bg-hover"
              >
                <span className="grid size-7 place-items-center rounded-lg border border-line bg-paper">
                  <StatusMarker status={run.status} />
                </span>
                <span className="min-w-0">
                  <span className="block font-medium">{verbs[run.status] ?? 'Run'}</span>
                  <span className="block truncate text-small text-ink-2">{detail(run)}</span>
                  <span className="mt-1.5 inline-block rounded-sm border border-line bg-paper px-1.5 text-[11px] leading-4 text-ink-2">
                    {run.agent.name}
                  </span>
                </span>
                <span className="text-small whitespace-nowrap text-ink-3">
                  {timeAgo(movedAt(run))}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-4 py-6 text-ink-3">No runs yet.</p>
      )}
    </section>
  );
}
