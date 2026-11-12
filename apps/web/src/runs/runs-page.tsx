import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { AgentFilter } from '../agents/agent-filter';
import { useAgents } from '../agents/agents-data';
import { useRunEvents } from '../dashboard/plans';
import { type ApiError, api, asApiError, shortAgo, timeAgo } from '../api';
import { ApiErrorState } from '../session';
import { frame, PageHeader } from '../shell/page-header';
import { mainSections } from '../shell/sections';
import { EmptyState, LoadingState } from '../shell/states';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { Status } from '../ui/status';
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs';
import { Table, TableCell, TableHead, TableRow } from '../ui/table';
import { AgentCell, AgentTile, leadTile } from '../ui/tint';
import {
  formatTokensShort,
  formatUsd,
  formatWhen,
  type RunList,
  runDuration,
  runTitle,
} from './run-data';
import { LiveRunCard } from './live-run-card';

// Live first and by default, as Tasks opens on Open: the page is for what is going on now. A
// cancelled run is under All; Failed is what needs a look.
const views = { live: 'Live', done: 'Done', failed: 'Failed', all: 'All' } as const;
type View = keyof typeof views;
const LIVE = new Set(['queued', 'running', 'waiting_approval']);
const REFRESH_MS = 5_000;
// The sidebar's entry for /runs holds the copy of its empty state.
const empty = mainSections.find((section) => section.path === '/runs')?.empty;

// [label, <col> width, cell classes]. Narrow screens drop Computer, then Started; the <col> and
// its cells hide together, so the cells after them keep their columns. A phone lists the task over
// its status, agent and start, with the agent's tile before them.
const columns: [string, string, string][] = [
  ['Status', 'w-40 max-md:w-28', ''],
  ['Task', '', 'font-medium'],
  ['Agent', 'w-44 max-md:hidden', 'text-ink-2 max-md:order-1'],
  ['Computer', 'w-40 max-2xl:hidden', 'text-ink-2 max-2xl:hidden'],
  ['Started', 'w-40 max-lg:hidden', 'text-ink-2 md:max-lg:hidden max-md:order-2 max-md:ml-auto'],
  ['Duration', 'w-22 max-md:hidden', 'text-right text-ink-2 max-md:hidden'],
  ['Cost', 'w-28 max-md:hidden', 'text-right max-md:hidden'],
];

/** /runs: every run the person may read, newest first; ?agent, ?task and ?status filter it. */
export function RunsPage() {
  const [params, setParams] = useSearchParams();
  const [list, setList] = useState<RunList>();
  const [error, setError] = useState<ApiError>();
  const [more, setMore] = useState<'idle' | 'loading' | ApiError>('idle');
  const [attempt, setAttempt] = useState(0);
  // Which loaded list a Load more belongs to: one asked under other filters is dropped.
  const loaded = useRef(0);
  const filters = new URLSearchParams();
  const asked = params.get('status');
  // A task's runs open on all of them: the link from a run page means every run of the task.
  const view: View =
    asked && asked in views ? (asked as View) : params.has('task') ? 'all' : 'live';
  for (const name of ['agent', 'task']) {
    const value = params.get(name);
    if (value) filters.set(name, value);
  }
  if (view !== 'all') filters.set('status', view);
  const query = filters.toString();
  const url = (before?: string) => {
    const search = new URLSearchParams(filters);
    if (before) search.set('before', before);
    const text = search.toString();
    return text ? `/api/runs?${text}` : '/api/runs';
  };

  useEffect(() => {
    let current = true;
    loaded.current += 1;
    pages.current = 1;
    setList(undefined);
    setError(undefined);
    setMore('idle');
    api<RunList>(url()).then(
      (loaded) => current && setList(loaded),
      (caught: unknown) => current && setError(asApiError(caught)),
    );
    return () => {
      current = false;
    };
  }, [query, attempt]);

  // While a run goes, the list and the running runs' cards are read again every few seconds: a
  // card says what its agent is at now. A list with older pages loaded keeps them.
  const pages = useRef(1);
  const [tick, setTick] = useState(0);
  const anyLive = list?.runs.some((run) => LIVE.has(run.status)) ?? false;
  useEffect(() => {
    if (!anyLive) return;
    const timer = setInterval(() => setTick((n) => n + 1), REFRESH_MS);
    return () => clearInterval(timer);
  }, [anyLive]);
  useEffect(() => {
    if (tick === 0) return;
    const asked = loaded.current;
    api<RunList>(url()).then(
      (fresh) => {
        if (asked !== loaded.current) return;
        setList((shown) => {
          if (!shown || pages.current === 1) return fresh;
          const latest = new Map(fresh.runs.map((run) => [run.id, run]));
          return { ...shown, runs: shown.runs.map((run) => latest.get(run.id) ?? run) };
        });
      },
      // A missed refresh changes nothing on screen; the next one asks again.
      () => undefined,
    );
  }, [tick]);
  const running = list?.runs.filter((run) => run.status === 'running') ?? [];
  const events = useRunEvents(
    running.map((run) => run.id),
    tick,
  );

  async function loadMore(before: string) {
    const asked = loaded.current;
    setMore('loading');
    try {
      const next = await api<RunList>(url(before));
      if (asked !== loaded.current) return;
      setList(
        (shown) => shown && { runs: [...shown.runs, ...next.runs], nextBefore: next.nextBefore },
      );
      pages.current += 1;
      setMore('idle');
    } catch (caught) {
      if (asked === loaded.current) setMore(asApiError(caught));
    }
  }

  const { agents } = useAgents();
  const agent = params.get('agent') ?? 'all';
  const first = list?.runs[0];
  // An agent the sidebar's list lacks (archived, say) still names itself, from its runs.
  const agentOptions =
    agent === 'all' || agents.some((option) => option.id === agent)
      ? agents
      : [...agents, { id: agent, name: first?.agent.name ?? 'Another agent' }];
  const setFilter = (name: 'agent' | 'status', value: string) => {
    const next = new URLSearchParams(params);
    // Live is where the page opens, so it needs no address; All does.
    if (name === 'agent' ? value === 'all' : value === 'live') next.delete(name);
    else next.set(name, value);
    setParams(next);
  };
  const showAll = () => setParams({ status: 'all' });

  return (
    <>
      <PageHeader title="Runs" />
      <div className={cn('pt-4 pb-24', frame.wide)}>
        <div className="mb-4 flex flex-wrap items-center gap-3">
          {/* Status first, then agent: the order of the Tasks list. */}
          <Tabs value={view} onValueChange={(value) => setFilter('status', value)}>
            <TabsList aria-label="Runs to show">
              {Object.entries(views).map(([value, label]) => (
                <TabsTrigger key={value} value={value}>
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <AgentFilter
            value={agent}
            onChange={(value) => setFilter('agent', value)}
            options={agentOptions}
          />
          {/* A task has no filter of its own: its runs come from a link on the run page. */}
          {params.has('task') && (
            <>
              <span className="truncate text-ink-2">
                Runs of {first?.task?.title ?? 'one task'}
              </span>
              <Button variant="quiet" size="sm" onClick={showAll}>
                Show all runs
              </Button>
            </>
          )}
        </div>
        {error ? (
          <ApiErrorState
            title="Couldn't load runs"
            error={error}
            onRetry={() => setAttempt((n) => n + 1)}
          />
        ) : !list ? (
          <LoadingState label="Loading runs" />
        ) : list.runs.length === 0 ? (
          view === 'live' && filters.size === 1 ? (
            <EmptyState
              title="Nothing is running"
              preview="rows"
              action={<Button onClick={showAll}>Show all runs</Button>}
            >
              Runs that are queued, running or waiting for an approval show here.
            </EmptyState>
          ) : filters.size > 0 ? (
            <EmptyState
              title="No runs match these filters"
              action={<Button onClick={showAll}>Show all runs</Button>}
            >
              Pick another agent or status, or show all runs.
            </EmptyState>
          ) : (
            <EmptyState title={empty?.title ?? 'No runs yet'} preview="rows">
              {empty?.text}
            </EmptyState>
          )
        ) : (
          <>
            {running.length > 0 && (
              <div className="mb-3 grid gap-2.5 md:hidden">
                {running.map((run) => (
                  <LiveRunCard
                    key={run.id}
                    run={run}
                    events={events.get(run.id)}
                    now={Date.now()}
                  />
                ))}
              </div>
            )}
            <RunsTable list={list} />
            {list.nextBefore && (
              <div className="mt-4 flex items-center gap-3">
                <Button
                  disabled={more === 'loading'}
                  onClick={() => list.nextBefore && void loadMore(list.nextBefore)}
                >
                  Load more
                </Button>
                {typeof more === 'object' && (
                  <span role="alert" className="text-failed">
                    {more.message}
                  </span>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

function RunsTable({ list }: { list: RunList }) {
  const now = Date.now();
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
              {label}
            </TableHead>
          ))}
        </TableRow>
      </thead>
      <tbody>
        {list.runs.map((run) => {
          const cell = (column: number) => columns[column]?.[2];
          return (
            // The task link covers the row: the whole row opens the run, and it stays a link.
            // A running run is its card above on a phone.
            <TableRow
              key={run.id}
              data-card={run.status === 'running' || undefined}
              className="relative hover:bg-hover"
            >
              <TableCell data-lead className="md:hidden">
                <AgentTile id={run.agent.id} name={run.agent.name} className={leadTile} />
              </TableCell>
              <TableCell>
                <Status status={run.status} />
              </TableCell>
              <TableCell primary className={cell(1)}>
                <Link to={`/runs/${run.id}`} className="after:absolute after:inset-0">
                  {runTitle(run)}
                </Link>
              </TableCell>
              <TableCell className={cell(2)}>
                <AgentCell agent={run.agent} />
              </TableCell>
              <TableCell className={cell(3)}>{run.seat?.name}</TableCell>
              <TableCell className={cell(4)}>
                {run.startedAt && (
                  <span title={formatWhen(run.startedAt)}>
                    <span className="max-md:sr-only">{timeAgo(run.startedAt)}</span>
                    <span aria-hidden="true" className="md:hidden">
                      {shortAgo(run.startedAt)}
                    </span>
                  </span>
                )}
              </TableCell>
              <TableCell className={cell(5)}>{runDuration(run, now)}</TableCell>
              <TableCell className={cell(6)}>
                {run.cost.usd ? (
                  formatUsd(run.cost.usd)
                ) : run.cost.tokens > 0 ? (
                  <span className="text-ink-3">{formatTokensShort(run.cost.tokens)}</span>
                ) : null}
              </TableCell>
            </TableRow>
          );
        })}
      </tbody>
    </Table>
  );
}
