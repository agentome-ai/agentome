import { CornerDownRight } from 'lucide-react';
import { Link } from 'react-router';
import { Status } from '../ui/status';
import { AgentTile, leadTile } from '../ui/tint';
import {
  formatTokensShort,
  formatUsd,
  type RunEvent,
  type RunList,
  runDuration,
  runTitle,
} from './run-data';
import { doing, planOf } from './run-plan';

type Run = RunList['runs'][number];

/**
 * A running run on a phone's Runs: over the list, with what its agent is at this moment,
 * how many calls it has made and what it has cost so far. The whole card opens the run.
 */
export function LiveRunCard({
  run,
  events,
  now,
}: {
  run: Run;
  events: readonly RunEvent[] | undefined;
  now: number;
}) {
  // A call of the run's own, not one a subagent made inside it.
  const calls =
    events?.filter(
      (event) =>
        event.type === 'tool_use' && !('parentToolUseId' in event && event.parentToolUseId),
    ).length ?? 0;
  return (
    <article
      aria-label={`${runTitle(run)}, running`}
      className="relative rounded-xl border border-line bg-raised p-3.5 active:bg-hover"
    >
      <div className="flex items-center gap-3">
        <AgentTile id={run.agent.id} name={run.agent.name} className={leadTile} />
        <div className="min-w-0 flex-1">
          <Link
            to={`/runs/${run.id}`}
            className="block truncate text-[15px] leading-[22px] font-medium after:absolute after:inset-0"
          >
            {runTitle(run)}
          </Link>
          <div className="flex min-w-0 items-center gap-1.5 text-small text-ink-3">
            <Status status={run.status} className="gap-1.5">
              Running {runDuration(run, now)}
            </Status>
            <span aria-hidden="true">·</span>
            <span className="truncate">{run.agent.name}</span>
          </div>
        </div>
      </div>
      {events && (
        <p className="mt-3 flex min-w-0 items-center gap-2 text-ui text-ink-2">
          <CornerDownRight aria-hidden="true" className="size-3.5 shrink-0 text-running" />
          <span className="truncate">{doing(events, planOf(events))}…</span>
        </p>
      )}
      <div className="mt-3 flex justify-between border-t border-line pt-2.5 text-small text-ink-3 tabular-nums">
        <span>
          {calls} {calls === 1 ? 'step' : 'steps'}
        </span>
        <span>
          {run.cost.tokens > 0 && formatTokensShort(run.cost.tokens)}
          {run.cost.usd && ` · ${formatUsd(run.cost.usd)}`}
        </span>
      </div>
    </article>
  );
}
