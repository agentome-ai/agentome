import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ChevronRight } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { type ApiError, api, asApiError } from '../api';
import { ApiErrorState, useMe } from '../session';
import { frame, PageHeader } from '../shell/page-header';
import { textLink } from '../ui/properties';
import { EmptyState, LoadingState } from '../shell/states';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import * as D from '../ui/dialog';
import { FormError } from '../ui/field';
import { jumpTo, Markdown } from '../ui/markdown';
import { Status } from '../ui/status';
import {
  type Artifact,
  formatTokensShort,
  formatUsd,
  formatWhen,
  httpUrl,
  isLive,
  type RunDetail,
  runDuration,
  type RunEvent,
  runTitle,
  type RunStatus,
  tokenParts,
  tokenPartsShort,
} from './run-data';
import { type Connection, useRunStream } from './run-stream';
import { WaitingHere } from '../approvals/waiting-here';
import { Disclosure, type FinalAnswer, finalAnswer, Transcript } from './transcript';
import { planOf, RunPlan } from './run-plan';
import { BranchCard, type Request, RequestCard } from '../tasks/task-changes';
import { RunTeam, TeamTiles, type TeamWork, teamWork } from './run-team';
import { failureText } from './run-data';

/** /runs/:id: what a run did, does now, left behind and cost; Cancel while it can stop. */
export function RunPage() {
  const { id = '' } = useParams();
  const [run, setRun] = useState<RunDetail>();
  const [error, setError] = useState<ApiError>();
  // Reloads overlap when statuses come fast (queued, running, done): the last one asked wins.
  const asked = useRef(0);
  const load = useCallback(async () => {
    const ask = ++asked.current;
    try {
      // Encoded: an address like /runs/..%2Fagents must not reach another API path.
      const loaded = await api<RunDetail>(`/api/runs/${encodeURIComponent(id)}`);
      if (ask !== asked.current) return;
      setRun(loaded);
      setError(undefined);
    } catch (caught) {
      if (ask === asked.current) setError(asApiError(caught));
    }
  }, [id]);
  useEffect(() => {
    setRun(undefined);
    setError(undefined);
    // The router keeps the scroll of the page the person came from, a long list say.
    window.scrollTo({ top: 0 });
    void load();
  }, [load]);

  const crumbs = [{ label: 'Runs', to: '/runs' }];
  // Not a run id at all (validation_failed) reads the same as someone else's run.
  if (error?.code === 'not_found' || error?.code === 'validation_failed') {
    return (
      <>
        <PageHeader title="Run" crumbs={crumbs} width="pair" />
        <EmptyState
          title="Run not found"
          action={
            <Button asChild>
              <Link to="/runs">Go to runs</Link>
            </Button>
          }
        >
          The link may be wrong, or the run belongs to an agent you don't have access to.
        </EmptyState>
      </>
    );
  }
  // A reload that fails while the page shows the run keeps it: the stream says it reconnects.
  if (error && (!run || error.code === 'unauthorized')) {
    return (
      <>
        <PageHeader title="Run" crumbs={crumbs} width="pair" />
        <div className={frame.pair}>
          <ApiErrorState title="Couldn't load the run" error={error} onRetry={load} />
        </div>
      </>
    );
  }
  if (!run) {
    return (
      <>
        <PageHeader title="Run" crumbs={crumbs} width="pair" />
        <div className={cn('pt-6', frame.pair)}>
          <LoadingState label="Loading the run" />
        </div>
      </>
    );
  }
  return <RunView key={run.id} run={run} reload={load} />;
}

function RunView({ run, reload }: { run: RunDetail; reload: () => Promise<void> }) {
  const me = useMe();
  const status = useRef(run.status);
  status.current = run.status;
  const { events, connection } = useRunStream(run.id, (next) => {
    if (next !== status.current) void reload();
  });
  const live = isLive(run.status);
  const steps = useMemo(() => planOf(events), [events]);
  // Under a plan the transcript is folded: each step of the plan opens on what was done in it.
  const [unfolded, setUnfolded] = useState<boolean>();
  const shown = unfolded ?? steps.length === 0;
  const { following, jump } = useFollow(live && shown, events.length);
  const answer = useFinalAnswer(run.status, events, connection);
  // A done run leads with what it came to; the transcript then points up to it.
  const result = answer !== 'pending' ? answer : undefined;
  const now = useNow(live ? 10_000 : null);
  const work = useMemo(() => teamWork(run, events, live, now), [run, events, live, now]);

  return (
    <>
      <PageHeader
        title={runTitle(run)}
        width="pair"
        crumbs={[{ label: 'Runs', to: '/runs' }]}
        actions={
          <>
            {/* What the server and the computer logged for this run: an admin's. */}
            {me.role === 'admin' && (
              <Button variant="quiet" asChild>
                <Link to={`/admin/logs?run=${run.id}&level=debug`}>Logs</Link>
              </Button>
            )}
            <CancelRun run={run} onCancelled={reload} />
          </>
        }
      />
      <div
        className={cn(
          // One reading column for the facts, the result, the team, the plan and the transcript,
          // and the results beside it: with a column as wide as the page the facts card ran
          // 400 px past everything under it.
          'grid grid-cols-[minmax(0,1fr)] gap-x-12 gap-y-8 pt-6 pb-24 lg:grid-cols-[minmax(0,820px)_300px] 2xl:grid-cols-[minmax(0,820px)_340px]',
          frame.pair,
        )}
      >
        {/* The facts first, the result under them, on a phone and a wide screen alike:
            a person reads who ran it and how it ended before what it came to. */}
        <Facts run={run} work={work} />
        {result && <RunResult answer={result} />}
        <aside
          aria-label="About this run"
          className={cn(
            'min-w-0 lg:sticky lg:top-19 lg:col-start-2 lg:row-start-1 lg:max-h-[calc(100dvh-108px)] lg:self-start lg:overflow-y-auto',
            result ? 'lg:row-span-3' : 'lg:row-span-2',
          )}
        >
          {/* A live run has neither yet: one line says so, rather than two empty sections. */}
          {live && run.artifacts.length === 0 && run.cost.rows.length === 0 ? (
            <Section id="results" title="Results">
              <p className="text-ink-3">
                The branch, the report and the cost show up here when the run finishes.
              </p>
            </Section>
          ) : (
            <>
              <Artifacts artifacts={run.artifacts} live={live} answer={answer} />
              <Cost run={run} live={live} />
            </>
          )}
        </aside>
        <section
          aria-labelledby="transcript"
          className={cn('min-w-0 lg:col-start-1', result ? 'lg:row-start-3' : 'lg:row-start-2')}
        >
          <WaitingHere which={(call) => call.runId === run.id} />
          {work && <RunTeam work={work} live={live} />}
          <RunPlan
            events={events}
            steps={steps}
            live={live}
            toolCalls={run.toolCalls}
            team={run.team}
          />
          <div className={cn('flex items-baseline gap-3', shown && 'mb-4')}>
            <h2 id="transcript" className="text-section">
              {steps.length > 0 ? (
                <button
                  type="button"
                  aria-expanded={shown}
                  onClick={() => setUnfolded(!shown)}
                  className="-mx-2 flex h-8 items-center gap-2 rounded-md px-2 hover:bg-hover"
                >
                  <ChevronRight
                    aria-hidden="true"
                    className={cn(
                      'size-3.5 text-ink-3 transition-transform duration-120',
                      shown && 'rotate-90',
                    )}
                  />
                  Transcript
                </button>
              ) : (
                'Transcript'
              )}
            </h2>
            {!shown && <span className="text-small text-ink-3">{callsIn(events)}</span>}
            {connection === 'reconnecting' && (
              <span role="status" className="text-small text-ink-3">
                Reconnecting…
              </span>
            )}
          </div>
          {!shown ? null : events.length === 0 ? (
            <NoEvents run={run} connection={connection} />
          ) : (
            <Transcript
              events={events}
              live={live}
              answerAbove={result?.seq}
              toolCalls={run.toolCalls}
              team={run.team}
              settled={run.status === 'done'}
            />
          )}
          {shown && live && !following && (
            <div className="sticky bottom-6 mt-6 flex justify-center">
              <Button size="sm" className="shadow-overlay" onClick={jump}>
                Jump to latest
              </Button>
            </div>
          )}
        </section>
      </div>
    </>
  );
}

/**
 * What a done run came to: the agent's final answer, at the top. A long one shows its start,
 * with a button for the rest, so that the plan and the transcript stay within reach.
 */
function RunResult({ answer }: { answer: FinalAnswer }) {
  const body = useRef<HTMLDivElement>(null);
  const [whole, setWhole] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const element = body.current;
    if (element && !whole) setLong(element.scrollHeight > element.clientHeight + 1);
  }, [answer.text, whole]);
  return (
    <section
      id="final-answer"
      tabIndex={-1}
      aria-labelledby="result"
      // Below the sticky page header when the report card's link scrolls here.
      className="min-w-0 scroll-mt-19 outline-none lg:col-start-1 lg:row-start-2 md:scroll-mt-21"
    >
      <h2 id="result" className="mb-3 text-section">
        Result
      </h2>
      <div
        ref={body}
        className={cn(
          'max-w-205 border-l-2 border-done pl-4',
          !whole && 'max-h-80 overflow-hidden',
        )}
      >
        <Markdown>{answer.text}</Markdown>
      </div>
      {(long || whole) && (
        <button
          type="button"
          aria-expanded={whole}
          onClick={() => setWhole(!whole)}
          className={cn('mt-2 ml-4.5 text-small', textLink)}
        >
          {whole ? 'Show less' : 'Show the whole answer'}
        </button>
      )}
    </section>
  );
}

/**
 * Keeps the newest event in view while the run is live, until the person scrolls up to read;
 * scrolling back to the bottom, or Jump to latest, follows again.
 */
/** "48 actions": the agent's own calls, as a step of the plan counts them. */
function callsIn(events: readonly RunEvent[]) {
  const calls = events.filter((event) => event.type === 'tool_use' && !event.parentToolUseId);
  return `${calls.length} ${calls.length === 1 ? 'action' : 'actions'}`;
}

function useFollow(live: boolean, count: number) {
  const [following, setFollowing] = useState(true);
  useEffect(() => {
    const onScroll = () => {
      const { scrollHeight } = document.documentElement;
      setFollowing(window.innerHeight + window.scrollY >= scrollHeight - 48);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  const toBottom = () => window.scrollTo({ top: document.documentElement.scrollHeight });
  useLayoutEffect(() => {
    if (live && following && count > 0) toBottom();
  }, [live, following, count]);
  return {
    following,
    jump: () => {
      setFollowing(true);
      toBottom();
    },
  };
}

/**
 * The answer a done run's transcript ends with, which its report repeats as a rule. Told once
 * the whole transcript is in, or will not come: until then `pending`, so that the report card
 * does not flash the text it then replaces. A retry that goes live again keeps what was told.
 * Nothing for a run that is not done: its report is an error or a run cut short, not an answer.
 */
function useFinalAnswer(status: RunStatus, events: RunEvent[], connection: Connection) {
  const settled = connection === 'ended' || connection === 'reconnecting';
  const [told, setTold] = useState(settled);
  useEffect(() => {
    if (settled) setTold(true);
  }, [settled]);
  return useMemo(() => {
    if (status !== 'done') return undefined;
    return settled || told ? finalAnswer(events) : 'pending';
  }, [status, settled, told, events]);
}

// The worker cuts a report at 20,000 characters (MAX_TEXT, apps/worker/src/run.ts), while the
// transcript keeps the whole answer: a report of that length repeats the answer's beginning.
const REPORT_MAX = 20_000;

function repeatsAnswer({ kind, meta }: Artifact, answer: FinalAnswer) {
  if (kind !== 'report' || typeof meta.text !== 'string') return false;
  const text = meta.text.trim();
  return text === answer.text || (meta.text.length === REPORT_MAX && answer.text.startsWith(text));
}

function NoEvents({ run, connection }: { run: RunDetail; connection: Connection }) {
  const text =
    connection === 'connecting'
      ? 'Loading the transcript…'
      : run.status === 'queued'
        ? 'Waiting for a computer to pick this run up.'
        : isLive(run.status)
          ? `Waiting for the first events from ${run.seat ? `${run.seat.owner.name}'s computer` : 'the computer'}.`
          : run.startedAt
            ? 'The computer sent no events before the run ended.'
            : 'This run was cancelled before a computer picked it up.';
  return <p className="text-ink-2">{text}</p>;
}

const limitHit: Record<string, true> = { timeout: true, max_turns: true, token_limit: true };

const starters = { cron: 'Schedule', webhook: 'Webhook', agent: 'Another agent', user: 'Someone' };

/** Who ran it, how it ended and how long it took: a panel over the result. */
function Facts({ run, work }: { run: RunDetail; work: TeamWork | undefined }) {
  const now = useNow(run.startedAt && !run.endedAt ? 10_000 : null);
  const duration = runDuration(run, now);
  const failure = run.status === 'failed' && run.errorCode;
  const { limits } = run;
  return (
    <section
      aria-label="Run details"
      className="min-w-0 rounded-xl border border-line bg-raised px-4 py-3.5 lg:col-start-1 lg:row-start-1"
    >
      {/* Focusable for the Cancel of a queued run: its button goes away with the queue. */}
      <div id="run-status" tabIndex={-1} aria-live="polite" className="text-section">
        <Status status={run.status} />
      </div>
      {failure && (
        <p className="mt-1 text-ink-2">
          {failureText(failure) ?? (
            <>
              The run failed with <code>{failure}</code>.
            </>
          )}
        </p>
      )}
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-3 xl:grid-cols-4">
        <Fact label="Agent">
          <Link to={`/agents/${run.agent.id}`} className={textLink}>
            {run.agent.name}
          </Link>
        </Fact>
        {/* The page's title is the task's: the fact links to it instead of repeating it. */}
        {run.task && (
          <Fact label="Task">
            <Link to={`/tasks/${run.task.id}`} className={textLink}>
              Open the task
            </Link>
          </Fact>
        )}
        <Fact label="Ran by">
          {run.seat ? run.seat.owner.name : <Faint>Not picked up yet</Faint>}
        </Fact>
        <Fact label="Started by">{run.startedBy.user?.name ?? starters[run.startedBy.kind]}</Fact>
        {run.startedAt ? (
          <Fact label="Started">{formatWhen(run.startedAt)}</Fact>
        ) : (
          <Fact label="Queued">{formatWhen(run.createdAt)}</Fact>
        )}
        {run.endedAt && <Fact label="Ended">{formatWhen(run.endedAt)}</Fact>}
        {duration && <Fact label="Duration">{duration}</Fact>}
        {work && work.lanes.length > 1 && (
          <Fact label="Team">
            <TeamTiles work={work} />
          </Fact>
        )}
        {/* The budget is the agent's business until the run runs into it. */}
        {limits && failure && failure in limitHit && (
          <Fact label="Limits">
            {limits.maxMinutes} min, {limits.maxTurns} turns, {formatTokensShort(limits.maxTokens)}
          </Fact>
        )}
      </dl>
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-small text-ink-3">{label}</dt>
      <dd className="break-words">{children}</dd>
    </div>
  );
}

const Faint = ({ children }: { children: ReactNode }) => (
  <span className="text-ink-3">{children}</span>
);

/** The time, refreshed every `intervalMs` while there is something that ticks. */
function useNow(intervalMs: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!intervalMs) return;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function Section(props: { id: string; title: string; children: ReactNode }) {
  return (
    <section
      aria-labelledby={props.id}
      className="mt-7 border-t border-line pt-4 first:mt-0 first:border-t-0 first:pt-0"
    >
      <h2 id={props.id} className="mb-2 text-section">
        {props.title}
      </h2>
      {props.children}
    </section>
  );
}

// The report first: it is what a person opens the run for.
const kindOrder: Artifact['kind'][] = ['report', 'change_request', 'branch', 'file'];
const kindLabel = {
  report: 'Report',
  change_request: 'Merge or pull request',
  branch: 'Branch',
  file: 'File',
};

type Answer = ReturnType<typeof useFinalAnswer>;

const isCard = ({ kind }: Artifact) => kind === 'branch' || kind === 'change_request';

function Artifacts(props: { artifacts: Artifact[]; live: boolean; answer: Answer }) {
  const sorted = [...props.artifacts].sort(
    (left, right) => kindOrder.indexOf(left.kind) - kindOrder.indexOf(right.kind),
  );
  const texts = sorted.filter((artifact) => !isCard(artifact));
  const cards = sorted.filter(isCard);
  return (
    <Section id="artifacts" title="Artifacts">
      {sorted.length === 0 && (
        <p className="text-ink-3">
          {props.live
            ? 'Branches and reports show up here when the run finishes.'
            : 'This run left no branch or report.'}
        </p>
      )}
      {texts.length > 0 && (
        <ul className="grid grid-cols-[minmax(0,1fr)] gap-4">
          {texts.map((artifact) => (
            <li key={artifact.id}>
              <p className="mb-0.5 text-small font-medium text-ink-2">{kindLabel[artifact.kind]}</p>
              <ArtifactBody artifact={artifact} answer={props.answer} />
            </li>
          ))}
        </ul>
      )}
      {/* The change request and the branch as the task page shows them. */}
      {cards.length > 0 && (
        <ul className={cn('grid grid-cols-[minmax(0,1fr)] gap-2', texts.length > 0 && 'mt-4')}>
          {cards.map((artifact) =>
            artifact.kind === 'change_request' ? (
              <RequestCard key={artifact.id} request={requestOf(artifact)} stacked />
            ) : (
              <BranchCard
                key={artifact.id}
                branch={branchOf(artifact)}
                pushed={typeof artifact.meta.pushedTo === 'string'}
              />
            ),
          )}
        </ul>
      )}
    </Section>
  );
}

const oneOf = <T extends string>(values: readonly T[], value: unknown): T | null =>
  values.find((one) => one === value) ?? null;

/** A change request as its host's webhooks last told of it. */
function requestOf({ ref, meta }: Artifact): Request {
  return {
    url: ref,
    number: typeof meta.number === 'number' ? meta.number : null,
    title: typeof meta.title === 'string' ? meta.title : null,
    state: oneOf(['open', 'draft', 'merged', 'closed'] as const, meta.state),
    pipeline: oneOf(['none', 'running', 'success', 'failed'] as const, meta.pipeline),
    review: oneOf(['approved', 'changes_requested', 'commented'] as const, meta.review),
  };
}

// Commits that no repository kept (`pushedTo`) say so on the card. Why shows
// elsewhere: the run's status, or a push_failed note in the transcript.
function branchOf({ ref, meta }: Artifact) {
  const commits = Array.isArray(meta.commits) ? meta.commits.filter(isCommit) : [];
  // "web-elm" out of https://…/vibe-code-projects/web-elm/web-elm.git or a local path.
  const where =
    typeof meta.pushedTo === 'string'
      ? meta.pushedTo
          .replace(/\/+$/, '')
          .replace(/\.git$/, '')
          .split('/')
          .at(-1)
      : undefined;
  return { name: ref, commits, additions: null, deletions: null, files: null, url: null, where };
}

type Commit = { sha: string; subject: string };
const isCommit = (value: unknown): value is Commit =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Commit).sha === 'string' &&
  typeof (value as Commit).subject === 'string';

function ArtifactBody(props: { artifact: Artifact; answer: Answer }) {
  const { artifact, answer } = props;
  const { kind, ref, meta } = artifact;
  if (kind === 'report') {
    if (answer === 'pending') return null;
    // The report repeats the final answer, which the transcript ends with: shown there once.
    if (answer && repeatsAnswer(artifact, answer)) return <AnswerLink />;
    // The aside scrolls on its own, so a long report pushes Cost down rather than off the page.
    return (
      <Markdown className="text-ui">{typeof meta.text === 'string' ? meta.text : ref}</Markdown>
    );
  }
  return <Address value={ref} />;
}

/** To the answer under Result, scrolled to and focused in place (`jumpTo`). */
function AnswerLink() {
  return (
    <a href="#final-answer" className={textLink} onClick={(event) => jumpTo(event, 'final-answer')}>
      The final answer, shown under Result
    </a>
  );
}

/** A link when the value is an http(s) address, its literal text otherwise. */
function Address({ value }: { value: string }) {
  const href = httpUrl(value);
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className={cn('break-all', textLink)}>
      {value}
    </a>
  ) : (
    <code className="break-all">{value}</code>
  );
}

function Cost({ run, live }: { run: RunDetail; live: boolean }) {
  const { rows, totalUsd, unpriced } = run.cost;
  return (
    <Section id="cost" title="Cost">
      {rows.length === 0 ? (
        <p className="text-ink-3">
          {live ? 'Counted when the run finishes.' : 'The computer reported no usage.'}
        </p>
      ) : (
        <>
          <p className="font-medium">
            {totalUsd ? formatUsd(totalUsd) : <Faint>Not priced yet</Faint>}{' '}
            <span className="text-small font-normal text-ink-3">at API prices</span>
          </p>
          <div className="mt-2">
            <Disclosure quiet flush summary={<span className="text-ink-2">By model</span>}>
              <table className="w-full">
                <thead className="sr-only">
                  <tr>
                    <th>Model</th>
                    <th>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.model} className="border-b border-line align-top">
                      <td className="py-1.5 pr-3">
                        <code className="break-all">{row.model}</code>
                        <p className="text-small text-ink-3" title={tokenParts(row)}>
                          {tokenPartsShort(row)}
                        </p>
                      </td>
                      <td className="py-1.5 text-right">
                        {row.usd ? formatUsd(row.usd) : totalUsd && <Faint>No price</Faint>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {unpriced && totalUsd && (
                <p className="mt-1 text-small text-ink-3">
                  The total leaves out tokens without a price.
                </p>
              )}
              <p className="mt-3 text-small text-ink-3">
                Estimate at API list prices; on a subscription this is what the run would have cost
                with an API key.
              </p>
            </Disclosure>
          </div>
        </>
      )}
    </Section>
  );
}

/** Cancel while the run can stop; the computer hears it at its next heartbeat. */
function CancelRun({ run, onCancelled }: { run: RunDetail; onCancelled: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [asked, setAsked] = useState(false);
  // Read when the dialog has gone, by a handler of its last render: a ref, not state.
  const leftQueue = useRef(false);
  const cancellable: RunStatus[] = ['queued', 'running'];
  if (!cancellable.includes(run.status)) return null;
  // Disabled by aria-disabled, so that it keeps the focus the dialog hands back to it.
  const requested = asked || run.cancelRequestedAt !== null;
  const queued = run.status === 'queued';

  async function cancel() {
    setPending(true);
    setError(undefined);
    try {
      await api(`/api/runs/${run.id}/cancel`, { method: 'POST' });
      leftQueue.current = queued;
      setAsked(true);
      setOpen(false);
      await onCancelled();
    } catch (caught) {
      setError(asApiError(caught).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <D.Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next && !requested);
        setError(undefined);
      }}
    >
      <D.DialogTrigger asChild>
        <Button
          variant="danger"
          aria-disabled={requested || undefined}
          className="aria-disabled:cursor-not-allowed aria-disabled:opacity-45"
        >
          {requested ? 'Cancel requested' : 'Cancel run'}
        </Button>
      </D.DialogTrigger>
      <D.DialogContent
        onCloseAutoFocus={(event) => {
          // A cancelled queued run loses its Cancel button: the focus goes to its new status.
          if (!leftQueue.current) return;
          event.preventDefault();
          document.getElementById('run-status')?.focus();
        }}
      >
        <D.DialogTitle>Cancel this run of {run.agent.name}?</D.DialogTitle>
        <D.DialogDescription>
          {queued
            ? 'It leaves the queue and never starts.'
            : `Claude Code stops on ${run.seat ? `${run.seat.owner.name}'s computer` : 'the computer'} within about 30 seconds. What the run did so far stays in the transcript.`}
        </D.DialogDescription>
        {error && <FormError>{error}</FormError>}
        <D.DialogFooter>
          <D.DialogClose asChild>
            <Button variant="quiet">{queued ? 'Keep it queued' : 'Keep running'}</Button>
          </D.DialogClose>
          <Button variant="danger" disabled={pending} onClick={() => void cancel()}>
            Cancel run
          </Button>
        </D.DialogFooter>
      </D.DialogContent>
    </D.Dialog>
  );
}
