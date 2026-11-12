import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { AgentFilter } from '../agents/agent-filter';
import { useAgents } from '../agents/agents-data';
import { type ApiError, api, asApiError, shortAgo, timeAgo } from '../api';
import { ApiErrorState } from '../session';
import { frame, PageHeader } from '../shell/page-header';
import { EmptyState, LoadingState } from '../shell/states';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { FormError } from '../ui/field';
import { Status, statusInCell, statusLabel } from '../ui/status';
import { Table, TableCell, TableHead, TableRow } from '../ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { AgentCell, AgentTile, leadTile } from '../ui/tint';
import { NewTaskDialog } from './new-task-dialog';
import { TaskStatusMark } from './task-status';
import { isInWork, type TaskPage, type TaskSummary } from './tasks-data';

// [label, <col> width, cell classes]: narrow screens drop Created first, then Agent. A phone keeps
// the task's own status, which the filter is about, its agent after it, and of the last run
// only its marker, on the right: a task stays open after a run is done, until someone marks it done.
const columns: [string, string, string][] = [
  ['Title', '', 'font-medium'],
  ['Agent', 'w-48 max-lg:hidden', 'text-ink-2 md:max-lg:hidden max-md:order-1'],
  ['Status', 'w-28', ''],
  ['Last run', 'w-60 max-md:w-14', 'max-md:order-2 max-md:ml-auto'],
  ['Created', 'w-32 max-xl:hidden', 'text-right text-ink-2 max-xl:hidden'],
];

// Open first and by default: the page is for what is still to do; All is the last resort.
const views = { open: 'Open', review: 'In review', done: 'Done', all: 'All' } as const;
type View = keyof typeof views;

/** The API's query for these filters, in a fixed order. */
function query(agent: string, view: View, before?: string | null) {
  const params = new URLSearchParams();
  if (agent) params.set('agent', agent);
  if (view !== 'all') params.set('status', view);
  if (before) params.set('before', before);
  const text = params.toString();
  return text ? `?${text}` : '';
}

/** Tasks: what the person's agents were given, filtered by agent and status, with New task. */
export function TasksPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const agent = params.get('agent') ?? '';
  const status = params.get('status');
  const view: View = status && status in views ? (status as View) : 'open';
  const { agents } = useAgents();
  // Run on an agent's sheet arrives here with the dialog open, once: Back or a reload of the
  // page shows the list.
  const [dialogOpen, setDialogOpen] = useState(
    (location.state as { newTask?: boolean } | null)?.newTask === true,
  );
  useEffect(() => {
    if (location.state) void navigate(location, { replace: true, state: null });
  }, [location, navigate]);

  const filters = query(agent, view);
  // Each first page starts a generation: Load more drops an answer from an earlier one, even
  // when the person has come back to the same filters since.
  const generation = useRef(0);
  const rows = useRef<HTMLDivElement>(null);
  const [list, setList] = useState<TaskPage>();
  const [error, setError] = useState<ApiError>();
  const [more, setMore] = useState<'loading' | ApiError>();
  const [attempt, setAttempt] = useState(0);
  // Only the answer for the filters on screen counts: a slow one for others is dropped.
  useEffect(() => {
    let current = true;
    generation.current += 1;
    setList(undefined);
    setError(undefined);
    setMore(undefined);
    api<TaskPage>(`/api/tasks${filters}`).then(
      (data) => current && setList(data),
      (caught: unknown) => current && setError(asApiError(caught)),
    );
    return () => {
      current = false;
    };
  }, [filters, attempt]);

  async function loadMore() {
    if (!list?.nextBefore || more === 'loading') return;
    const asked = generation.current;
    const count = list.tasks.length;
    setMore('loading');
    try {
      const next = await api<TaskPage>(`/api/tasks${query(agent, view, list.nextBefore)}`);
      if (generation.current !== asked) return;
      flushSync(() => {
        setList(
          (was) => was && { tasks: [...was.tasks, ...next.tasks], nextBefore: next.nextBefore },
        );
        setMore(undefined);
      });
      // The button goes with the last page: focus moves to the first task the page brought.
      rows.current?.querySelectorAll<HTMLElement>('tbody a')[count]?.focus();
    } catch (caught) {
      if (generation.current === asked) setMore(asApiError(caught));
    }
  }

  const filter = (key: 'agent' | 'status', value: string) =>
    setParams(
      (was) => {
        const next = new URLSearchParams(was);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  // The filter may name an agent the person's active agents do not, such as an archived one.
  const agentName =
    agents.find((item) => item.id === agent)?.name ??
    list?.tasks.find((task) => task.agent.id === agent)?.agent.name;
  const options = agents.map(({ id, name }) => ({ id, name }));
  if (agent && !agents.some((item) => item.id === agent)) {
    options.push({ id: agent, name: agentName ?? 'This agent' });
  }

  return (
    <>
      <PageHeader
        title="Tasks"
        actions={
          <NewTaskDialog
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            agentId={agent || undefined}
          />
        }
      />
      <div className={cn(frame.wide, 'pt-4 pb-24')}>
        <Tabs
          value={view}
          onValueChange={(value) => filter('status', value === 'open' ? '' : value)}
        >
          <div className="flex flex-wrap items-center gap-3">
            <TabsList aria-label="Tasks to show">
              {Object.entries(views).map(([value, label]) => (
                <TabsTrigger key={value} value={value}>
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
            <AgentFilter
              value={agent || 'all'}
              onChange={(value) => filter('agent', value === 'all' ? '' : value)}
              options={options}
            />
          </div>
          <TabsContent value={view} className="mt-4">
            {error ? (
              <ApiErrorState
                title="Couldn't load tasks"
                error={error}
                onRetry={() => setAttempt((n) => n + 1)}
              />
            ) : !list ? (
              <LoadingState label="Loading tasks" />
            ) : list.tasks.length === 0 ? (
              <EmptyState
                title={view === 'all' ? 'No tasks yet' : `No ${views[view].toLowerCase()} tasks`}
                preview="rows"
              >
                {view === 'done'
                  ? 'A task moves here when you mark it as done on its page.'
                  : view === 'review'
                    ? 'A task waits here for you once its run is done: mark it as done or run it again.'
                    : `Give ${agentName ?? 'an agent'} something to do: create a task, then run it on a connected computer.`}
              </EmptyState>
            ) : (
              <div ref={rows}>
                <TasksTable tasks={list.tasks} />
                {list.nextBefore && (
                  <div className="mt-4 flex items-center gap-3">
                    {/* Not disabled while it loads: focus would drop out of the page. */}
                    <Button onClick={() => void loadMore()}>Load more</Button>
                    {more && more !== 'loading' && <FormError>{more.message}</FormError>}
                  </div>
                )}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}

function TasksTable({ tasks }: { tasks: TaskSummary[] }) {
  return (
    <Table phoneList className="-mx-3 w-[calc(100%+24px)] table-fixed">
      <colgroup>
        {columns.map(([label, width]) => (
          <col key={label} className={width} />
        ))}
      </colgroup>
      <thead>
        <TableRow>
          {columns.map(([label, , className]) => (
            <TableHead key={label} className={className}>
              {label === 'Last run' ? (
                <>
                  <span className="max-md:sr-only">{label}</span>
                  <span aria-hidden="true" className="md:hidden">
                    Run
                  </span>
                </>
              ) : (
                label
              )}
            </TableHead>
          ))}
        </TableRow>
      </thead>
      <tbody>
        {tasks.map((task) => (
          // The title is the link; its ::after covers the row, so the whole row opens the task.
          <TableRow key={task.id} className="relative hover:bg-hover">
            <TableCell data-lead className="md:hidden">
              <AgentTile id={task.agent.id} name={task.agent.name} className={leadTile} />
            </TableCell>
            <TableCell primary className={columns[0]?.[2]}>
              <Link to={`/tasks/${task.id}`} className="after:absolute after:inset-0">
                {task.title}
              </Link>
            </TableCell>
            <TableCell className={columns[1]?.[2]}>
              <AgentCell agent={task.agent} />
            </TableCell>
            <TableCell className={columns[2]?.[2]}>
              <TaskStatusMark status={task.status} run={task.latestRun} className={statusInCell} />
            </TableCell>
            <TableCell className={columns[3]?.[2]}>
              {/* A run that goes is the status already: here only when it started. */}
              {isInWork(task) && task.latestRun ? (
                <span className="text-ink-2">
                  <span className="max-md:sr-only">{timeAgo(task.latestRun.at)}</span>
                  <span aria-hidden="true" className="md:hidden">
                    {shortAgo(task.latestRun.at)}
                  </span>
                </span>
              ) : task.latestRun ? (
                <Status status={task.latestRun.status} className={statusInCell}>
                  <span className="max-md:sr-only">
                    {statusLabel[task.latestRun.status]}, {timeAgo(task.latestRun.at)}
                  </span>
                </Status>
              ) : (
                <span className="text-ink-3">
                  <span className="max-md:sr-only">Never run</span>
                  <span aria-hidden="true" className="md:hidden">
                    –
                  </span>
                </span>
              )}
            </TableCell>
            <TableCell className={columns[4]?.[2]}>{timeAgo(task.createdAt)}</TableCell>
          </TableRow>
        ))}
      </tbody>
    </Table>
  );
}
