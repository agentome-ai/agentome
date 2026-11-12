import { ChevronRight } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { isOnline, useSeats } from '../admin/seats-data';
import { useAgents } from '../agents/agents-data';
import { type ApiError, api, asApiError, timeAgo } from '../api';
import { WaitingHere } from '../approvals/waiting-here';
import { useApprovals } from '../approvals/approvals-data';
import { failureText, formatUsd, type RunList, type RunStatus, runTitle } from '../runs/run-data';
import type { ProjectListItem } from '../projects/projects-data';
import type { TaskPage, TaskSummary } from '../tasks/tasks-data';
import { Button } from '../ui/button';
import { ApiErrorState } from '../session';
import { frame, PageHeader } from '../shell/page-header';
import { LoadingState } from '../shell/states';
import { cn } from '../ui/cn';
import { textLink } from '../ui/properties';
import { StatusMarker } from '../ui/status';
import { RecentActivity } from './activity';
import { ProjectCard, type ProjectRuns } from './project-card';
import { usePlans } from './plans';

// Runs start and end on their own: the page asks again this often.
const REFRESH_MS = 15_000;
const ASKED: RunStatus[] = ['waiting_approval', 'running', 'queued', 'done', 'failed'];
/** Cards on the page: the projects at work, then the busiest of the week; the rest on Projects. */
const CARDS = 6;

type Runs = Record<RunStatus, RunList['runs']>;
type Run = RunList['runs'][number];

/**
 * /: the day in four numbers; what waits for the person (calls to decide, work to review); the
 * projects as cards, each with its week and which agents work on it now; what failed
 * today; what happened lately.
 */
export function DashboardPage() {
  const [runs, setRuns] = useState<Partial<Runs>>();
  // The statuses whose list came back as a full page: there are more runs than it holds.
  const [cut, setCut] = useState<ReadonlySet<RunStatus>>(new Set());
  const [review, setReview] = useState<TaskSummary[]>([]);
  const [moreReview, setMoreReview] = useState(false);
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [error, setError] = useState<ApiError>();
  const { agents } = useAgents();
  const { seats } = useSeats();
  const { approvals } = useApprovals();
  const load = useCallback(async () => {
    try {
      const [inReview, listed, ...lists] = await Promise.all([
        api<TaskPage>('/api/tasks?status=review&limit=20'),
        api<{ projects: ProjectListItem[] }>('/api/projects'),
        ...ASKED.map((status) => api<RunList>(`/api/runs?status=${status}&limit=100`)),
      ]);
      setReview(inReview.tasks);
      setMoreReview(inReview.nextBefore !== null);
      setProjects(listed.projects);
      setRuns(Object.fromEntries(ASKED.map((status, index) => [status, lists[index]?.runs])));
      setCut(new Set(ASKED.filter((_, index) => lists[index]?.nextBefore != null)));
      setError(undefined);
    } catch (caught) {
      setError(asApiError(caught));
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  // A queued run has no plan yet; the others' plans are read again with each refresh.
  const started = [...(runs?.waiting_approval ?? []), ...(runs?.running ?? [])];
  const plans = usePlans(
    started.map((run) => run.id),
    runs,
  );
  const header = <PageHeader title="Dashboard" />;
  // A refresh that fails keeps what the page showed; only the first answer decides.
  if (!runs) {
    return (
      <>
        {header}
        <div className={cn(frame.wide, 'pt-6')}>
          {error ? (
            <ApiErrorState title="Couldn't load runs" error={error} onRetry={load} />
          ) : (
            <LoadingState label="Loading runs" />
          )}
        </div>
      </>
    );
  }
  // Waiting for a person first: that is the one thing on the page that cannot wait.
  const now = [...(runs.waiting_approval ?? []), ...(runs.running ?? []), ...(runs.queued ?? [])];
  const midnight = new Date().setHours(0, 0, 0, 0);
  const ended = (status: 'done' | 'failed', from: number, to = Infinity) =>
    (runs[status] ?? []).filter((run) => {
      const at = run.endedAt ? Date.parse(run.endedAt) : NaN;
      return at >= from && at < to;
    });
  // A page holds a hundred runs, newest first. When it is full and its oldest run still ended
  // inside the stretch, the stretch has more runs than the page: the count is a floor, and says so.
  const floor = (status: 'done' | 'failed', from: number) => {
    const oldest = runs[status]?.at(-1)?.endedAt;
    return cut.has(status) && oldest != null && Date.parse(oldest) >= from;
  };
  const atLeast = (count: number, more: boolean) => (more ? `${count}+` : count);
  const done = ended('done', midnight);
  const doneYesterday = ended('done', midnight - 86_400_000, midnight);
  const failedRuns = ended('failed', midnight);
  const failed = failures(failedRuns, [...now, ...(runs.done ?? [])]);
  // The agents at work, for the sentence: an agent counts once whatever it runs.
  const busy = new Set(now.map((run) => run.agent.id));
  const cards = projectCards(projects, now);
  const weekUsd = agents.reduce((sum, agent) => sum + Number(agent.week?.usd ?? 0), 0);
  const waiting = approvals?.length ?? 0;
  const working = busy.size;
  return (
    <>
      {header}
      <div className={cn(frame.wide, 'grid gap-6 pt-6 pb-24')}>
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
          <p className="text-read text-ink-2">{sentence(working, waiting + review.length)}</p>
          <Online seats={seats} />
        </div>
        <dl className="grid grid-cols-2 overflow-hidden rounded-xl border border-line bg-raised lg:grid-cols-4">
          <Stat
            label="Done today"
            value={atLeast(done.length, floor('done', midnight))}
            note={
              // A page that does not reach back to yesterday says nothing of yesterday.
              floor('done', midnight)
                ? `latest ${done.length} counted`
                : `${atLeast(doneYesterday.length, floor('done', midnight - 86_400_000))} yesterday`
            }
            to="/runs?status=done"
          />
          <Stat
            label="Ready for review"
            value={atLeast(review.length, moreReview)}
            note={review[0]?.changeRequest ? changeName(review[0].changeRequest.url) : 'tasks'}
            to="/tasks?status=review"
          />
          <Stat
            label="Failed today"
            value={atLeast(failed.length, floor('failed', midnight))}
            note={
              failedRuns.length > failed.length
                ? `${atLeast(failedRuns.length, floor('failed', midnight))} runs`
                : failed.length
                  ? 'see below'
                  : 'none'
            }
            to="/runs?status=failed"
          />
          <Stat
            label="This week"
            value={formatUsd(String(weekUsd))}
            note="at API prices"
            to="/agents"
          />
        </dl>
        <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6">
            {/* What only the person can move: the agents' questions and calls. */}
            <WaitingHere which={() => true} withTask className="" />
            <section
              aria-labelledby="projects-heading"
              className="grid grid-cols-[minmax(0,1fr)] gap-3"
            >
              <div className="flex items-baseline gap-2">
                <h2 id="projects-heading" className="text-section">
                  Projects
                </h2>
                <span className="text-small text-ink-3">
                  {projects.length
                    ? `${projects.filter((project) => project.week.runs > 0).length} of ${projects.length} ran this week`
                    : ''}
                </span>
                <Link
                  to="/projects"
                  className="ml-auto inline-flex items-center gap-0.5 text-small text-ink-2 hover:text-ink"
                >
                  All projects
                  <ChevronRight aria-hidden="true" className="size-3.5" />
                </Link>
              </div>
              {cards.length ? (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-3">
                  {cards.map((item) => (
                    <ProjectCard key={item.project?.id ?? 'none'} item={item} plans={plans} />
                  ))}
                </div>
              ) : (
                <p className="text-ink-2">
                  {projects.length
                    ? 'No project ran this week. Give an agent a task on '
                    : 'No projects yet. Create one on '}
                  <Link
                    to={projects.length ? '/tasks' : '/projects'}
                    className="font-medium text-ink underline underline-offset-2"
                  >
                    {projects.length ? 'Tasks' : 'Projects'}
                  </Link>
                  .
                </p>
              )}
            </section>
          </div>
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6">
            {review.length > 0 && <ReadyForReview tasks={review} onChanged={load} />}
            {failed.length > 0 && <FailedToday failures={failed} onChanged={load} />}
            <RecentActivity runs={Object.values(runs).flat()} />
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * The projects to show: those at work first, the ones waiting for the person before the ones
 * running, then the busiest of the week; a project that did not run this week has no card. The
 * runs of tasks outside every project have a card of their own while they go.
 */
function projectCards(projects: ProjectListItem[], now: Run[]): ProjectRuns[] {
  const order: RunStatus[] = ['waiting_approval', 'running', 'queued'];
  const rank = (runs: Run[]) => {
    const first = runs.map((run) => order.indexOf(run.status)).sort()[0];
    return first ?? order.length;
  };
  const known = new Set(projects.map((project) => project.id));
  const items: ProjectRuns[] = projects
    .map((project) => ({
      project,
      runs: now.filter((run) => run.task?.projectId === project.id),
    }))
    .filter(({ project, runs }) => runs.length > 0 || project.week.runs > 0);
  const outside = now.filter((run) => !run.task?.projectId || !known.has(run.task.projectId));
  if (outside.length) items.push({ project: null, runs: outside });
  return items
    .sort(
      (left, right) =>
        rank(left.runs) - rank(right.runs) ||
        (right.project?.week.runs ?? 0) - (left.project?.week.runs ?? 0),
    )
    .slice(0, CARDS);
}

/** "2 agents at work, 3 things wait for you." */
function sentence(working: number, waiting: number) {
  const agents =
    working === 0 ? 'No agent at work' : `${working} ${working === 1 ? 'agent' : 'agents'} at work`;
  const things =
    waiting === 0
      ? 'nothing waits for you'
      : `${waiting} ${waiting === 1 ? 'thing waits' : 'things wait'} for you`;
  return `${agents}, ${things}.`;
}

/** Whose computers can take a run, as a pill: the people, not the machines. */
function Online({ seats }: { seats: ReturnType<typeof useSeats>['seats'] }) {
  if (seats === null) return null;
  const active = (seats ?? []).filter((seat) => seat.status === 'active');
  const online = [
    ...new Set(active.filter((seat) => isOnline(seat)).map((seat) => seat.owner.name)),
  ];
  const words = online.length
    ? `Online: ${online.join(', ')}`
    : active.length
      ? 'No one online'
      : 'No computer connected';
  return (
    <Link
      to="/admin/computers"
      className={cn(
        'inline-flex h-6 items-center gap-1.5 rounded-full border border-current/25 bg-current/8 px-2.5 text-small font-medium',
        online.length ? 'text-review' : 'text-ink-3',
      )}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {words}
    </Link>
  );
}

function Stat(props: { label: string; value: ReactNode; note: string; to: string }) {
  return (
    <Link
      to={props.to}
      className="border-line px-4 py-3.5 hover:bg-hover max-lg:nth-[-n+2]:border-b max-lg:odd:border-r lg:not-last:border-r"
    >
      <dt className="text-small text-ink-2">{props.label}</dt>
      <dd className="mt-1 flex items-baseline gap-2">
        <span className="text-[22px] leading-7 font-semibold tracking-[-0.02em]">
          {props.value}
        </span>
        <span className="truncate text-small text-ink-3">{props.note}</span>
      </dd>
    </Link>
  );
}

/** A block of the dashboard: a heading with its count over rows. */
function Panel(props: { id: string; title: string; count: number; children: ReactNode }) {
  return (
    <section aria-labelledby={props.id} className="rounded-xl border border-line bg-raised">
      <h2
        id={props.id}
        className="flex items-center gap-2 border-b border-line px-4 py-3 font-semibold"
      >
        {props.title}
        <span className="text-small font-normal text-ink-3">{props.count}</span>
      </h2>
      <ul className="grid divide-y divide-line">{props.children}</ul>
    </section>
  );
}

/** "PR #42" or "MR !304", from the address: GitLab says merge request and numbers with "!". */
function changeName(url: string) {
  const gitlab = /\/-\/merge_requests\/(\d+)/.exec(url);
  if (gitlab) return `MR !${gitlab[1]}`;
  const github = /\/pull\/(\d+)/.exec(url);
  return github ? `PR #${github[1]}` : 'Change request';
}

// As on the task and the run: a passed pipeline on an open change request is what makes it ready
// for review, so it has the review colour, not the colour of what is done.
const pipelineWords = {
  success: ['CI passed', 'text-review'],
  failed: ['CI failed', 'text-failed'],
  running: ['CI running', 'text-ink-2'],
} as const;

/** One thing on the dashboard to act on: a marker, who and when, what, and its buttons under it. */
function Item(props: {
  status: RunStatus;
  who: string;
  title: ReactNode;
  children?: ReactNode;
  actions: ReactNode;
}) {
  return (
    <li className="grid grid-cols-[28px_minmax(0,1fr)] gap-x-3 px-4 py-3.5">
      <span className="grid size-7 place-items-center rounded-lg border border-line bg-paper">
        <StatusMarker status={props.status} />
      </span>
      <div className="min-w-0">
        <p className="text-small text-ink-3">{props.who}</p>
        <p className="font-medium wrap-anywhere">{props.title}</p>
        {props.children}
        <div className="mt-2.5 flex flex-wrap gap-2">{props.actions}</div>
      </div>
    </li>
  );
}

/** Asks the server, then the page again; a refusal says why in a toast. */
function useAct(onChanged: () => Promise<void>) {
  const [busy, setBusy] = useState<string>();
  const act = async (key: string, failed: string, call: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(key);
    try {
      await call();
      await onChanged();
    } catch (caught) {
      toast.error(failed, { description: asApiError(caught).message });
    } finally {
      setBusy(undefined);
    }
  };
  return { busy, act };
}

/** Tasks the agents finished and handed over: the person reads the work and closes or reruns. */
function ReadyForReview(props: { tasks: TaskSummary[]; onChanged: () => Promise<void> }) {
  const { busy, act } = useAct(props.onChanged);
  return (
    <Panel id="review-heading" title="Ready for your review" count={props.tasks.length}>
      {props.tasks.map((task) => {
        const change = task.changeRequest;
        const pipeline =
          change?.pipeline && change.pipeline !== 'none'
            ? pipelineWords[change.pipeline]
            : undefined;
        const finished = task.latestRun ? `finished ${timeAgo(task.latestRun.at)}` : 'finished';
        return (
          <Item
            key={task.id}
            status="done"
            who={`${task.agent.name} ${finished}`}
            title={
              <Link to={`/tasks/${task.id}`} className="hover:underline">
                {task.title}
              </Link>
            }
            actions={
              <>
                <Button
                  size="sm"
                  disabled={busy !== undefined}
                  onClick={() =>
                    void act(`run-${task.id}`, "Couldn't run the task again", () =>
                      api(`/api/tasks/${task.id}/run`, { method: 'POST' }),
                    )
                  }
                >
                  Run again
                </Button>
                <Button
                  size="sm"
                  disabled={busy !== undefined}
                  onClick={() =>
                    void act(`done-${task.id}`, "Couldn't mark the task as done", () =>
                      api(`/api/tasks/${task.id}`, { method: 'PATCH', body: { status: 'done' } }),
                    )
                  }
                >
                  Mark done
                </Button>
              </>
            }
          >
            {change && (
              <p className="mt-1 flex flex-wrap gap-x-3 text-small text-ink-3">
                <a href={change.url} target="_blank" rel="noreferrer" className={textLink}>
                  {changeName(change.url)}
                </a>
                {change.state === 'draft' && <span>draft</span>}
                {change.state === 'merged' && <span>merged</span>}
                {pipeline && <span className={pipeline[1]}>{pipeline[0]}</span>}
              </p>
            )}
          </Item>
        );
      })}
    </Panel>
  );
}

type Failure = { run: Run; times: number };

/**
 * Today's failures, one a task: its latest run, and how many of its runs failed today. A task
 * run again since is off the list: its new run says how it goes. A run without a task is its own.
 */
function failures(failed: Run[], later: Run[]): Failure[] {
  const endOf = (run: Run) => Date.parse(run.endedAt ?? run.createdAt);
  const byTask = new Map<string, Failure>();
  for (const run of [...failed].sort((left, right) => endOf(right) - endOf(left))) {
    const key = run.task?.id ?? run.id;
    const seen = byTask.get(key);
    if (seen) seen.times += 1;
    else byTask.set(key, { run, times: 1 });
  }
  return [...byTask.values()].filter(
    ({ run }) =>
      !run.task ||
      !later.some(
        (other) => other.task?.id === run.task?.id && Date.parse(other.createdAt) > endOf(run),
      ),
  );
}

/** Today's failed tasks, each with its reason in words and a way to try again. */
function FailedToday(props: { failures: Failure[]; onChanged: () => Promise<void> }) {
  const { busy, act } = useAct(props.onChanged);
  return (
    <Panel id="failed-heading" title="Failed today" count={props.failures.length}>
      {props.failures.map(({ run, times }) => {
        const task = run.task;
        return (
          <Item
            key={run.id}
            status="failed"
            who={`${run.agent.name}, ${timeAgo(run.endedAt ?? run.createdAt)}${times > 1 ? ` · failed ${times} times today` : ''}`}
            title={
              <Link to={`/runs/${run.id}`} className="hover:underline">
                {runTitle(run)}
              </Link>
            }
            actions={
              task && (
                <Button
                  size="sm"
                  disabled={busy !== undefined}
                  onClick={() =>
                    void act(run.id, "Couldn't run the task again", () =>
                      api(`/api/tasks/${task.id}/run`, { method: 'POST' }),
                    )
                  }
                >
                  Run again
                </Button>
              )
            }
          >
            <p className="mt-0.5 text-ink-2">
              {(run.errorCode && failureText(run.errorCode)) ??
                'The run failed; its transcript says where.'}
            </p>
          </Item>
        );
      })}
    </Panel>
  );
}
