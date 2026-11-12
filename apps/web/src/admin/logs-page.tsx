import { ChevronRight, Pause, Play, Search, Waypoints, X } from 'lucide-react';
import { useCallback, useEffect, useId, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { type ApiError, api, asApiError, formatDate } from '../api';
import { ApiErrorState } from '../session';
import { frame, PageHeader } from '../shell/page-header';
import { EmptyState, LoadingState } from '../shell/states';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { Input } from '../ui/input';
import { RadioGroup, RadioSegment } from '../ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

// Admin → Logs: a month of the server's and the workers' lines, from a level up, by
// source, run, trace or text, newest first, with a live tail; a trace drawn as a waterfall.

export type LogEntry = {
  id: number;
  at: string;
  level: number;
  source: 'server' | 'worker';
  message: string;
  context: unknown;
  traceId: string | null;
  runId: string | null;
  seatId: string | null;
  span: string | null;
  durationMs: number | null;
};

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
type Level = (typeof LEVELS)[number];
const nameOf = (level: number): Level => LEVELS[Math.min(5, Math.max(0, level / 10 - 1))] ?? 'info';
// The colour of a level: what needs a look stands out, the chatter steps back.
const tone: Record<Level, string> = {
  trace: 'text-ink-3',
  debug: 'text-ink-3',
  info: 'text-ink-2',
  warn: 'text-waiting',
  error: 'text-failed',
  fatal: 'text-failed',
};
const LIVE_MS = 3000;
const PAGE = 100;

const clock = (iso: string) => {
  const at = new Date(iso);
  return `${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}.${String(at.getMilliseconds()).padStart(3, '0')}`;
};
const ms = (value: number) => (value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${value} ms`);

/**
 * A span's name as a phone shows it: "GET /api/tasks" is GET and its path, "mcp POST
 * https://jira/mcp" POST and jira/mcp; a name of another shape is all path.
 */
function callOf(span: string) {
  const words = span.split(' ');
  const at = words.findIndex((word) => /^[A-Z]+$/.test(word));
  if (at === -1) return { method: null, path: span };
  return {
    method: words[at],
    path: words
      .slice(at + 1)
      .join(' ')
      .replace(/^https?:\/\//, ''),
  };
}

/** What a request or a call answered, from the line's context: a request's or a call's status. */
function statusOf(context: unknown): number | null {
  if (typeof context !== 'object' || context === null) return null;
  const { res, status } = context as { res?: { statusCode?: unknown }; status?: unknown };
  const code = res?.statusCode ?? status;
  return typeof code === 'number' ? code : null;
}

// How long a span took on a scale a glance reads: 1 ms to 10 s, by tens.
const barOf = (value: number) => `${Math.min(100, (Math.log10(value + 1) / 4) * 100)}%`;

export function LogsPage() {
  const [params, setParams] = useSearchParams();
  const level = (params.get('level') as Level | null) ?? 'info';
  const source = params.get('source') ?? 'all';
  const run = params.get('run') ?? undefined;
  const q = params.get('q') ?? '';
  const [text, setText] = useState(q);
  const [entries, setEntries] = useState<LogEntry[]>();
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [error, setError] = useState<ApiError>();
  const [live, setLive] = useState(false);
  const [open, setOpen] = useState<number>();

  const query = useCallback(
    (extra: Record<string, string>) => {
      const search = new URLSearchParams({ level, limit: String(PAGE), ...extra });
      if (source !== 'all') search.set('source', source);
      if (run) search.set('run', run);
      if (q) search.set('q', q);
      return `/api/admin/logs?${search}`;
    },
    [level, q, run, source],
  );
  type Page = { entries: LogEntry[]; nextBefore: number | null };

  const load = useCallback(async () => {
    setError(undefined);
    try {
      const page = await api<Page>(query({}));
      setEntries(page.entries);
      setNextBefore(page.nextBefore);
    } catch (caught) {
      setError(asApiError(caught));
    }
  }, [query]);
  useEffect(() => {
    setEntries(undefined);
    void load();
  }, [load]);

  // Live: what came after the newest line on screen, every few seconds.
  const newest = entries?.[0]?.id ?? 0;
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      void api<Page>(query({ after: String(newest) })).then(
        (page) => page.entries.length && setEntries((was) => [...page.entries, ...(was ?? [])]),
        () => undefined,
      );
    }, LIVE_MS);
    return () => clearInterval(timer);
  }, [live, newest, query]);

  async function older() {
    if (nextBefore === null) return;
    try {
      const page = await api<Page>(query({ before: String(nextBefore) }));
      setEntries((was) => [...(was ?? []), ...page.entries]);
      setNextBefore(page.nextBefore);
    } catch (caught) {
      toast.error("Couldn't load older lines", { description: asApiError(caught).message });
    }
  }

  const set = (key: string, value: string | undefined) =>
    setParams(
      (was) => {
        const next = new URLSearchParams(was);
        if (value === undefined) next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: true },
    );

  return (
    <>
      <PageHeader
        title="Logs"
        crumbs={[{ label: 'Admin', to: '/admin' }]}
        actions={<ServerLevel />}
      />
      <div className={cn(frame.wide, 'grid grid-cols-[minmax(0,1fr)] gap-4 pt-4 pb-24')}>
        <p className="max-w-170 text-ink-2 max-md:hidden">
          The server’s and the computers’ log lines of the last month, newest first. A line with a
          time is a span: a request, or a call out to a code host, Jira or an MCP server. Open its
          trace to see everything that request did.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <RadioGroup
            aria-label="Level and above"
            value={level}
            onValueChange={(value) => set('level', value)}
            className="inline-flex rounded-md border border-line-strong p-0.5"
          >
            {(['trace', 'debug', 'info', 'warn', 'error'] as const).map((value) => (
              <RadioSegment key={value} value={value} className="capitalize">
                {value}
              </RadioSegment>
            ))}
          </RadioGroup>
          <RadioGroup
            aria-label="Source"
            value={source}
            onValueChange={(value) => set('source', value === 'all' ? undefined : value)}
            className="inline-flex rounded-md border border-line-strong p-0.5"
          >
            <RadioSegment value="all">All</RadioSegment>
            <RadioSegment value="server">Server</RadioSegment>
            <RadioSegment value="worker">Computers</RadioSegment>
          </RadioGroup>
          {run && (
            <span className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line-strong bg-raised pr-1 pl-2.5 text-ui">
              <span className="text-ink-3">Run</span>
              <Link to={`/runs/${run}`} className="font-mono text-small hover:underline">
                {run.slice(0, 8)}
              </Link>
              <Button
                size="icon-sm"
                variant="quiet"
                aria-label="Show every run"
                className="size-5"
                onClick={() => set('run', undefined)}
              >
                <X aria-hidden="true" className="size-3" />
              </Button>
            </span>
          )}
          <form
            role="search"
            className="relative min-w-60 flex-1 md:max-w-90"
            onSubmit={(event) => {
              event.preventDefault();
              set('q', text.trim() || undefined);
            }}
          >
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-2 left-2.5 size-4 text-ink-3"
            />
            <Input
              aria-label="Search the lines"
              placeholder="Search words, a path, an id"
              value={text}
              onChange={(event) => setText(event.target.value)}
              className="pl-8"
            />
          </form>
          <Button
            aria-pressed={live}
            onClick={() => setLive((was) => !was)}
            className="ml-auto aria-pressed:border-review/40 aria-pressed:text-review"
          >
            {live ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
            {live ? 'Live' : 'Go live'}
          </Button>
        </div>

        {!entries ? (
          error ? (
            <ApiErrorState title="Couldn't load the logs" error={error} onRetry={load} />
          ) : (
            <LoadingState label="Loading the logs" />
          )
        ) : entries.length === 0 ? (
          <EmptyState title="No lines match">
            Try a lower level, another source, or fewer words. Lines older than a month are gone.
          </EmptyState>
        ) : (
          <>
            <ol aria-label="Log lines" className="-mx-3 grid grid-cols-[minmax(0,1fr)]">
              {entries.map((entry) => (
                <Line
                  key={entry.id}
                  entry={entry}
                  open={open === entry.id}
                  onToggle={() => setOpen((was) => (was === entry.id ? undefined : entry.id))}
                />
              ))}
            </ol>
            {nextBefore !== null && (
              <Button className="justify-self-start" onClick={() => void older()}>
                Load older lines
              </Button>
            )}
          </>
        )}
      </div>
    </>
  );
}

/**
 * A line on a phone: a request or a call reads as its method, path and answer, with its
 * level, source, time taken and clock under it; another line as its words.
 */
function PhoneLine({ entry, level }: { entry: LogEntry; level: Level }) {
  const call = entry.span ? callOf(entry.span) : null;
  const status = statusOf(entry.context);
  return (
    <span className="grid gap-1 font-sans md:hidden">
      <span className="flex min-w-0 items-center gap-2">
        {call?.method && (
          <span className="shrink-0 rounded-sm bg-selected px-1 font-mono text-[11px] leading-4 font-semibold text-ink-2">
            {call.method}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-read font-medium text-ink">
          {call ? call.path : entry.message}
        </span>
        {status !== null && (
          <span
            className={cn(
              'shrink-0 font-mono text-small font-semibold',
              status >= 500 ? 'text-failed' : status >= 400 ? 'text-waiting' : 'text-review',
            )}
          >
            {status}
          </span>
        )}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-small text-ink-3">
        <span className={cn('font-medium', tone[level])}>{level}</span>
        <span aria-hidden="true">·</span>
        <span className="truncate">{entry.source === 'worker' ? 'Computer' : 'Server'}</span>
        {entry.durationMs !== null && (
          <span
            className={cn(
              'ml-2 inline-flex shrink-0 items-center gap-1.5 tabular-nums',
              entry.durationMs >= 3000 && 'text-waiting',
            )}
          >
            <span aria-hidden="true" className="h-1 w-8 overflow-hidden rounded-full bg-selected">
              <span
                className="block h-full rounded-full bg-current"
                style={{ width: barOf(entry.durationMs) }}
              />
            </span>
            {ms(entry.durationMs)}
          </span>
        )}
        <time dateTime={entry.at} className="ml-auto shrink-0 tabular-nums">
          {clock(entry.at).slice(0, 8)}
        </time>
      </span>
    </span>
  );
}

/** A log line: its time, level, source and words, its span's time; open for its context. */
function Line(props: { entry: LogEntry; open: boolean; onToggle: () => void; date?: boolean }) {
  const { entry } = props;
  const ids = useId();
  const level = nameOf(entry.level);
  return (
    <li
      className={cn(
        'border-b border-line font-mono text-[12.5px] leading-5',
        // On a phone what needs a look is marked at the edge.
        'max-md:border-l-2 max-md:border-l-transparent',
        level === 'warn' && 'max-md:border-l-waiting',
        (level === 'error' || level === 'fatal') && 'max-md:border-l-failed',
      )}
    >
      <button
        type="button"
        aria-expanded={props.open}
        aria-controls={props.open ? `${ids}-more` : undefined}
        onClick={props.onToggle}
        className="grid w-full grid-cols-[12px_92px_44px_64px_minmax(0,1fr)_auto] items-baseline gap-x-3 px-3 py-1.5 text-left hover:bg-hover max-md:block max-md:px-4 max-md:py-2.5 max-md:active:bg-hover"
      >
        <PhoneLine entry={entry} level={level} />
        <ChevronRight
          aria-hidden="true"
          className={cn(
            'size-3 translate-y-0.5 text-ink-3 transition-transform duration-120 max-md:hidden',
            props.open && 'rotate-90',
          )}
        />
        <time
          dateTime={entry.at}
          className="text-ink-3 tabular-nums max-md:hidden"
          title={formatDate(entry.at)}
        >
          {clock(entry.at)}
        </time>
        <span className={cn('uppercase max-md:hidden', tone[level])}>{level}</span>
        <span className="text-ink-3 max-md:hidden">
          {entry.source === 'worker' ? 'computer' : 'server'}
        </span>
        <span className="min-w-0 truncate max-md:hidden">
          {entry.span ? (
            <>
              <span className="text-ink">{entry.span}</span>{' '}
              <span className="text-ink-3">{entry.message}</span>
            </>
          ) : (
            entry.message
          )}
        </span>
        {entry.durationMs !== null && (
          <span
            className={cn(
              'tabular-nums max-md:hidden',
              entry.durationMs >= 3000 ? 'text-waiting' : 'text-ink-2',
            )}
          >
            {ms(entry.durationMs)}
          </span>
        )}
      </button>
      {props.open && (
        <div id={`${ids}-more`} className="grid gap-2 px-3 pb-3 pl-[39px] max-md:px-4">
          <div className="flex flex-wrap gap-x-4 gap-y-1 font-sans text-small text-ink-2">
            <span>{formatDate(entry.at)}</span>
            {entry.traceId && (
              <Link
                to={`/admin/logs/traces/${entry.traceId}`}
                className="inline-flex items-center gap-1 underline underline-offset-2"
              >
                <Waypoints aria-hidden="true" className="size-3.5" />
                Trace {entry.traceId.slice(0, 8)}
              </Link>
            )}
            {entry.runId && (
              <Link to={`/runs/${entry.runId}`} className="underline underline-offset-2">
                Run {entry.runId.slice(0, 8)}
              </Link>
            )}
            {entry.runId && (
              <Link
                to={`/admin/logs?run=${entry.runId}&level=debug`}
                className="underline underline-offset-2"
              >
                Every line of this run
              </Link>
            )}
          </div>
          {entry.context !== null && (
            <pre className="overflow-x-auto rounded-md border border-line bg-raised p-3 text-[12px] leading-5 whitespace-pre-wrap break-all text-ink-2">
              {JSON.stringify(entry.context, null, 2)}
            </pre>
          )}
        </div>
      )}
    </li>
  );
}

/** The server's level now, changed in place until the next start. */
function ServerLevel() {
  const [level, setLevel] = useState<Level>();
  useEffect(() => {
    api<{ level: Level }>('/api/admin/logs/level').then(
      (answer) => setLevel(answer.level),
      () => setLevel(undefined),
    );
  }, []);
  if (!level) return null;
  return (
    <Select
      value={level}
      onValueChange={(next) =>
        void api<{ level: Level }>('/api/admin/logs/level', {
          method: 'PUT',
          body: { level: next },
        }).then(
          (answer) => setLevel(answer.level),
          (caught: unknown) =>
            toast.error("Couldn't change the level", { description: asApiError(caught).message }),
        )
      }
    >
      <SelectTrigger aria-label="Server log level" className="h-8 w-auto gap-2 text-ui">
        <span className="text-ink-3">Server writes</span>
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {(['trace', 'debug', 'info', 'warn', 'error'] as const).map((value) => (
          <SelectItem key={value} value={value} description={levelHint[value]}>
            <span className="capitalize">{value}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const levelHint: Record<Exclude<Level, 'fatal'>, string> = {
  trace: 'Everything, for a short look',
  debug: 'Detail while something is being found',
  info: 'Requests and calls out: the usual',
  warn: 'What went wrong but went on',
  error: 'Failures only',
};

/** /admin/logs/traces/:id: what one request did, as a waterfall of its spans and lines. */
export function TracePage() {
  const { id = '' } = useParams();
  const [trace, setTrace] = useState<{ entries: LogEntry[] }>();
  const [error, setError] = useState<ApiError>();
  const [open, setOpen] = useState<number>();
  const load = useCallback(async () => {
    setError(undefined);
    try {
      setTrace(
        await api<{ entries: LogEntry[] }>(`/api/admin/logs/traces/${encodeURIComponent(id)}`),
      );
    } catch (caught) {
      setError(asApiError(caught));
    }
  }, [id]);
  useEffect(() => void load(), [load]);

  const crumbs = [
    { label: 'Admin', to: '/admin' },
    { label: 'Logs', to: '/admin/logs' },
  ];
  const title = `Trace ${id.slice(0, 8)}`;
  if (!trace) {
    return (
      <>
        <PageHeader title={title} crumbs={crumbs} />
        <div className={cn(frame.wide, 'pt-6')}>
          {error ? (
            <ApiErrorState title="Couldn't load the trace" error={error} onRetry={load} />
          ) : (
            <LoadingState label="Loading the trace" />
          )}
        </div>
      </>
    );
  }
  return (
    <>
      <PageHeader title={title} crumbs={crumbs} />
      <div className={cn(frame.wide, 'grid grid-cols-[minmax(0,1fr)] gap-6 pt-4 pb-24')}>
        {trace.entries.length === 0 ? (
          <EmptyState title="Nothing in this trace">
            Its lines may be older than a month, or were written below the level the server keeps.
          </EmptyState>
        ) : (
          <>
            <Waterfall entries={trace.entries} />
            <ol aria-label="Lines of the trace" className="-mx-3 grid grid-cols-[minmax(0,1fr)]">
              {trace.entries.map((entry) => (
                <Line
                  key={entry.id}
                  entry={entry}
                  open={open === entry.id}
                  onToggle={() => setOpen((was) => (was === entry.id ? undefined : entry.id))}
                />
              ))}
            </ol>
          </>
        )}
      </div>
    </>
  );
}

/**
 * The spans of a trace on one time axis: each bar starts when its work started (the line is
 * written as it ends, so its start is its time less its duration) and is as long as it took.
 */
function Waterfall({ entries }: { entries: LogEntry[] }) {
  const spans = entries
    .filter((entry) => entry.durationMs !== null && entry.span)
    .map((entry) => {
      const end = new Date(entry.at).getTime();
      return { entry, start: end - (entry.durationMs ?? 0), end };
    })
    // By when the work started: a request first, the calls it made under it.
    .sort((a, b) => a.start - b.start);
  if (spans.length === 0) return null;
  const from = Math.min(...spans.map((span) => span.start));
  const to = Math.max(...spans.map((span) => span.end));
  const total = Math.max(1, to - from);
  return (
    <section aria-label="Waterfall" className="grid gap-2">
      <p className="text-ink-2">
        {spans.length} {spans.length === 1 ? 'span' : 'spans'} over {ms(total)}, from{' '}
        {formatDate(new Date(from).toISOString())}
      </p>
      <div className="grid gap-1 rounded-lg border border-line bg-raised p-3">
        {spans.map(({ entry, start, end }) => {
          const left = ((start - from) / total) * 100;
          const width = Math.max(0.6, ((end - start) / total) * 100);
          const failed = entry.level >= 40;
          return (
            <div
              key={entry.id}
              className="grid grid-cols-[minmax(0,16rem)_minmax(0,1fr)_64px] items-center gap-3 text-small max-md:grid-cols-[minmax(0,1fr)_64px]"
            >
              <span
                className="truncate font-mono text-[12px] max-md:col-span-2"
                title={entry.span ?? ''}
              >
                {entry.span}
              </span>
              <span className="relative h-2.5 rounded-full bg-hover max-md:col-start-1">
                <span
                  className={cn(
                    'absolute inset-y-0 rounded-full',
                    failed ? 'bg-failed' : entry.source === 'worker' ? 'bg-done' : 'bg-running',
                  )}
                  style={{ left: `${left}%`, width: `${width}%` }}
                />
              </span>
              <span className="text-right text-ink-2 tabular-nums">
                {ms(entry.durationMs ?? 0)}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
