import { Link } from 'react-router';
import { timeAgo } from '../api';
import type { ProjectListItem } from '../projects/projects-data';
import { formatDuration, formatUsd, type RunList, runTitle } from '../runs/run-data';
import { cn } from '../ui/cn';
import { type RunStatus, StatusMarker, statusLabel } from '../ui/status';
import { initials, tintOf } from '../ui/tint';
import { PlanLine } from './plan-line';
import type { Progress } from './plans';

type Run = RunList['runs'][number];

// The project as a card: its runs of the week day by day and four numbers, then who works
// on it now, each agent with its task and plan; a project at rest says who ran what last. The
// dashboard showed agents before, but the owner reads the work by project.

const pill: Partial<Record<RunStatus, string>> = {
  running: 'text-running',
  waiting_approval: 'text-waiting',
  queued: 'text-ink-2',
};

/** The run's state as a pill: the state's colour on a tint of it, the word beside the marker. */
export function StatePill({ status }: { status: RunStatus | 'idle' }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full border border-current/25 bg-current/8 px-2 text-small font-medium',
        status === 'idle' ? 'text-ink-3' : (pill[status] ?? 'text-ink-2'),
      )}
    >
      {status !== 'idle' && <StatusMarker status={status} className="size-3" />}
      {status === 'idle' ? 'Idle' : statusLabel[status]}
    </span>
  );
}

/** The week's runs by day, as a line over a soft fill: the shape, not the numbers. */
function Spark({ daily }: { daily: number[] }) {
  const top = Math.max(1, ...daily);
  const points = daily.map((value, index) => [
    (index / Math.max(1, daily.length - 1)) * 120,
    30 - (value / top) * 26,
  ]);
  const line = points.map(([x, y], index) => `${index ? 'L' : 'M'}${x} ${y}`).join(' ');
  return (
    <svg
      role="img"
      aria-label={`Runs a day this week: ${daily.join(', ')}`}
      viewBox="0 0 120 32"
      preserveAspectRatio="none"
      className="h-10 w-full text-ink-2"
    >
      <path d={`${line} L120 32 L0 32 Z`} className="fill-current opacity-10" />
      <path
        d={line}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function Num({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-small text-ink-3">{label}</dt>
      <dd className="truncate text-[17px] leading-6 font-semibold tracking-[-0.01em]">{value}</dd>
    </div>
  );
}

export type ProjectRuns = { project: ProjectListItem | null; runs: Run[] };

/** The state that comes first among the project's runs: waiting, running, queued. */
function stateOf(runs: Run[]): RunStatus | 'idle' {
  for (const status of ['waiting_approval', 'running', 'queued'] as const) {
    if (runs.some((run) => run.status === status)) return status;
  }
  return 'idle';
}

/** One run at work: the agent, its task, when it started or that it waits, and its plan. */
function Work({ run, plan }: { run: Run; plan?: Progress | null }) {
  return (
    <li className="grid grid-cols-[minmax(0,1fr)] gap-0.5">
      <div className="flex min-w-0 items-baseline gap-2">
        <span
          aria-hidden="true"
          className={cn(
            'grid size-5 shrink-0 translate-y-0.5 place-items-center self-start rounded-md bg-current/15 text-[10px] font-semibold',
            tintOf(run.agent.id),
          )}
        >
          {initials(run.agent.name)}
        </span>
        <b className="min-w-0 flex-1 truncate font-medium text-ink">{run.agent.name}</b>
        {run.status === 'waiting_approval' ? (
          <span className="shrink-0 text-waiting">waits for you</span>
        ) : (
          <span className="shrink-0 text-ink-3">
            {run.status === 'queued' ? 'queued' : timeAgo(run.startedAt ?? run.createdAt)}
          </span>
        )}
      </div>
      {/* The task on a line of its own: beside the name a card 300 px wide cut it to a word. */}
      <div className="grid grid-cols-[minmax(0,1fr)] pl-7">
        <Link to={`/runs/${run.id}`} className="truncate text-ink-2 hover:text-ink hover:underline">
          {runTitle(run)}
        </Link>
        <PlanLine progress={plan} />
      </div>
    </li>
  );
}

export function ProjectCard(props: {
  item: ProjectRuns;
  plans: ReadonlyMap<string, Progress | null>;
}) {
  const { project, runs } = props.item;
  const week = project?.week;
  const name = project?.name ?? 'Outside projects';
  const last = project?.lastRun;
  return (
    <article
      aria-label={name}
      // One column no wider than the card: a run's long task or plan step is cut on its line
      // instead of widening the card past a phone's screen.
      className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-3 rounded-xl border border-line bg-raised p-4"
    >
      <header className="grid grid-cols-[36px_minmax(0,1fr)] items-center gap-3">
        <span
          aria-hidden="true"
          className={cn(
            'grid size-9 place-items-center rounded-lg bg-current/15 text-ui font-semibold',
            project ? tintOf(project.id) : 'text-ink-3',
          )}
        >
          {initials(name)}
        </span>
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            {project ? (
              <Link
                to={`/projects/${project.id}`}
                className="truncate text-read font-semibold hover:underline"
              >
                {name}
              </Link>
            ) : (
              <span className="truncate text-read font-semibold">{name}</span>
            )}
            <StatePill status={stateOf(runs)} />
          </div>
          <p className="truncate text-small text-ink-2">
            {project
              ? project.team
                ? `${project.team.name} · ${project.agentCount} ${project.agentCount === 1 ? 'agent' : 'agents'}`
                : `${project.agentCount} ${project.agentCount === 1 ? 'agent' : 'agents'}`
              : 'Tasks of no project'}
          </p>
        </div>
      </header>
      {week && <Spark daily={week.daily} />}
      {week && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5">
          <Num label="Runs this week" value={String(week.runs)} />
          <Num
            label="Done"
            value={week.ended ? `${Math.round((week.done / week.ended) * 100)}%` : '—'}
          />
          <Num
            label="Median run"
            value={week.medianSeconds === null ? '—' : formatDuration(week.medianSeconds * 1000)}
          />
          <Num label="Cost" value={week.usd === null ? '—' : formatUsd(week.usd)} />
        </dl>
      )}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-1 border-t border-line pt-3 text-small">
        {runs.length > 0 ? (
          <ul aria-label={`At work on ${name}`} className="grid grid-cols-[minmax(0,1fr)] gap-2.5">
            {runs.map((run) => (
              <Work key={run.id} run={run} plan={props.plans.get(run.id)} />
            ))}
          </ul>
        ) : last ? (
          <p className="truncate text-ink-3">
            Last: <span className="text-ink-2">{last.agent.name}</span>{' '}
            <Link to={`/runs/${last.id}`} className="hover:text-ink hover:underline">
              {last.task.title}
            </Link>
            , {statusLabel[last.status].toLowerCase()} {timeAgo(last.at)}
          </p>
        ) : (
          <p className="text-ink-3">No runs yet</p>
        )}
      </div>
    </article>
  );
}
