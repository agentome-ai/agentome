import { ChevronRight, CircleDot, GitPullRequest, MessageCircleQuestion } from 'lucide-react';
import {
  type ChangeEvent,
  type FormEvent,
  forwardRef,
  type KeyboardEvent,
  type ReactNode,
  useRef,
  useState,
} from 'react';
import { Link } from 'react-router';
import { type ApiError, api, asApiError, timeAgo } from '../api';
import { formatUsd, formatWhen, runDuration, stoppedBy } from '../runs/run-data';
import { cn } from '../ui/cn';
import { Button } from '../ui/button';
import * as D from '../ui/dialog';
import { FormError } from '../ui/field';
import { Textarea } from '../ui/input';
import { StatusMarker } from '../ui/status';
import { AgentTile, PersonAvatar } from '../ui/tint';
import { Prose } from './prose';
import { Pill } from './task-changes';
import type { Task, TaskComment, TaskQuestion, TaskRun } from './tasks-data';

// The task's life by stages, oldest first, the way Linear tells an issue's: who made it,
// then each run as a step with how it ended. What a run asked the person and the change requests
// it opened are folded under it, as a run's transcript is under its plan: a question
// still waiting for an answer is the one thing shown open.

type ChangeRequest = Task['changeRequests'][number];

const tile = 'grid size-6 place-items-center rounded-full border border-line-strong bg-paper';

/** "ran it · stopped by time limit after 2 h 00 min", in words for each way a run goes. */
function runWords(run: TaskRun, agent: string) {
  const duration = runDuration(run);
  const took = duration ? ` after ${duration}` : '';
  const who = <b className="font-medium text-ink">{agent}</b>;
  if (run.status === 'queued') return <>{who} will run it once a computer takes it</>;
  if (run.status === 'running') return <>{who} is running it</>;
  if (run.status === 'waiting_approval') {
    return (
      <>
        {who} is running it <span className="text-waiting">and waits for you</span>
      </>
    );
  }
  if (run.status === 'done')
    return (
      <>
        {who} ran it · finished{took}
      </>
    );
  if (run.status === 'cancelled') {
    if (!run.startedAt) return <>{who} was to run it · cancelled while queued</>;
    return (
      <>
        {who} ran it · cancelled{took}
      </>
    );
  }
  const why = run.errorCode ? stoppedBy(run.errorCode).toLowerCase() : 'failed';
  return (
    <>
      {who} ran it · stopped by {why}
      {took}
    </>
  );
}

function changeName(url: string) {
  const gitlab = /\/-\/merge_requests\/(\d+)/.exec(url);
  if (gitlab) return `MR !${gitlab[1]}`;
  const github = /\/pull\/(\d+)/.exec(url);
  return github ? `PR #${github[1]}` : 'a change request';
}

function answerOf(asked: TaskQuestion) {
  if (asked.state === 'answered')
    return `${asked.answeredBy ?? 'Answered'}: «${asked.answer ?? ''}»`;
  if (asked.state === 'skipped') return 'Skipped: the agent went on with its best judgement';
  if (asked.state === 'waiting') return 'Waits for your answer above';
  return 'Not answered before the run ended';
}

/** What is folded under a run, in a few words: "2 questions · MR !306". */
function foldedWords(questions: TaskQuestion[], requests: ChangeRequest[]) {
  const words: string[] = [];
  if (questions.length) {
    words.push(`${questions.length} ${questions.length === 1 ? 'question' : 'questions'}`);
  }
  words.push(...requests.map((request) => changeName(request.url)));
  return words.join(' · ');
}

/** Under a run's line: its page, its cost, and what it asked and opened, folded. */
function RunStage(props: {
  run: TaskRun;
  agent: string;
  questions: TaskQuestion[];
  requests: ChangeRequest[];
}) {
  const { run, agent, questions, requests } = props;
  const waiting = questions.some((asked) => asked.state === 'waiting');
  const [unfolded, setUnfolded] = useState<boolean | null>(null);
  const open = unfolded ?? waiting;
  const folded = questions.length + requests.length > 0;
  return (
    <>
      {run.summary?.trim() && <Report text={run.summary} />}
      <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-small">
        {run.status === 'failed' && (
          <Pill className="text-failed">{run.errorCode ? stoppedBy(run.errorCode) : 'Failed'}</Pill>
        )}
        <Link to={`/runs/${run.id}`} className="text-ink-2 underline underline-offset-2">
          {run.status === 'running' || run.status === 'waiting_approval'
            ? 'Follow the run'
            : 'Open the run'}
        </Link>
        {run.usd !== null && <span className="text-ink-3">{formatUsd(run.usd)} at API prices</span>}
      </span>
      {folded && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setUnfolded(!open)}
          className="-ml-1.5 mt-1.5 flex min-h-8 items-center gap-1.5 rounded-md px-1.5 text-small text-ink-2 hover:bg-hover max-md:min-h-10"
        >
          <ChevronRight
            aria-hidden="true"
            className={cn(
              'size-3.5 shrink-0 text-ink-3 transition-transform duration-120',
              open && 'rotate-90',
            )}
          />
          <span className={cn(waiting && 'text-waiting')}>{foldedWords(questions, requests)}</span>
        </button>
      )}
      {open && (
        <div className="mt-1 grid gap-2">
          {questions.map((asked) => (
            <div key={asked.id} className="rounded-xl border border-line bg-raised px-3 py-2.5">
              <span className="flex items-center gap-1.5 text-small text-ink-3">
                <MessageCircleQuestion aria-hidden="true" className="size-3.5 text-waiting" />
                {agent} asked you
                <span title={formatWhen(asked.askedAt)}> · {timeAgo(asked.askedAt)}</span>
              </span>
              <span className="mt-1 block font-medium text-ink wrap-anywhere whitespace-pre-line">
                {asked.question}
              </span>
              <span className="mt-1 block text-small text-ink-2 wrap-anywhere">
                {answerOf(asked)}
              </span>
            </div>
          ))}
          {requests.map((request) => (
            <span key={request.url} className="flex items-center gap-1.5 text-small">
              <GitPullRequest aria-hidden="true" className="size-3.5 shrink-0 text-review" />
              <span>
                Opened{' '}
                <a
                  href={request.url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-ink underline underline-offset-2"
                >
                  {changeName(request.url)}
                </a>
              </span>
              <span className="text-ink-3" title={formatWhen(request.createdAt)}>
                · {timeAgo(request.createdAt)}
              </span>
            </span>
          ))}
        </div>
      )}
    </>
  );
}

/** A run's report, or a comment: what was written, as a message in the thread. */
function Report({ text }: { text: string }) {
  // A long report is shown in part until it is asked for whole.
  const long = text.length > 1200;
  const [whole, setWhole] = useState(false);
  return (
    <div className="mt-1.5 rounded-xl border border-line bg-raised px-3 py-2.5 text-ink">
      <div className={cn(long && !whole && 'max-h-48 overflow-hidden')}>
        <Prose>{text}</Prose>
      </div>
      {long && (
        <button
          type="button"
          onClick={() => setWhole(!whole)}
          className="mt-1.5 text-small text-ink-2 underline underline-offset-2"
        >
          {whole ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  );
}

type Entry =
  { kind: 'run'; at: string; run: TaskRun } | { kind: 'comment'; at: string; comment: TaskComment };

export const TaskActivity = forwardRef<
  HTMLElement,
  {
    task: Task;
    aside?: ReactNode;
    /** Why a run cannot start now, if it cannot: Comment and run waits for it. */
    cannotRun?: string;
    onCommented: () => Promise<void>;
  }
>(function TaskActivity({ task, aside, cannotRun, onCommented }, ref) {
  const agent = task.agent.name;
  const feed = useRef<HTMLOListElement>(null);
  const entries: Entry[] = [
    ...task.runs.map((run) => ({
      kind: 'run' as const,
      at: run.startedAt ?? run.createdAt,
      run,
    })),
    ...task.comments.map((comment) => ({
      kind: 'comment' as const,
      at: comment.createdAt,
      comment,
    })),
  ].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  const spent = task.runs.reduce((sum, run) => sum + Number(run.usd ?? 0), 0);
  return (
    <section ref={ref} aria-labelledby="activity" className="mt-10">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line pb-2.5">
        <h2 id="activity" className="text-section">
          Activity
        </h2>
        <span className="text-small text-ink-3">
          {task.runs.length} {task.runs.length === 1 ? 'run' : 'runs'}
          {spent > 0 && ` · ${formatUsd(String(spent))} at API prices`}
        </span>
        {aside && <span className="ml-auto">{aside}</span>}
      </div>
      <ol ref={feed} className="grid">
        <Stage
          icon={<CircleDot aria-hidden="true" className="size-3.5 text-ink-2" />}
          at={task.createdAt}
          last={entries.length === 0}
          line={
            <>
              <b className="font-medium text-ink">{task.createdBy.name}</b> created the task
              {task.source === 'jira' && ' from Jira'}
            </>
          }
        />
        {entries.map((entry, index) =>
          entry.kind === 'run' ? (
            <Stage
              key={entry.run.id}
              icon={<StatusMarker status={entry.run.status} className="size-3.5" />}
              at={entry.at}
              last={index === entries.length - 1}
              line={runWords(entry.run, agent)}
            >
              <RunStage
                run={entry.run}
                agent={agent}
                questions={task.questions.filter((asked) => asked.runId === entry.run.id)}
                requests={task.changeRequests.filter((request) => request.runId === entry.run.id)}
              />
            </Stage>
          ) : (
            <Stage
              key={entry.comment.id}
              icon={
                entry.comment.author.kind === 'agent' ? (
                  <AgentTile id={entry.comment.author.id} name={entry.comment.author.name} />
                ) : (
                  <PersonAvatar id={entry.comment.author.id} name={entry.comment.author.name} />
                )
              }
              plain
              at={entry.at}
              last={index === entries.length - 1}
              line={
                <>
                  <b className="font-medium text-ink">{entry.comment.author.name}</b> commented
                </>
              }
            >
              <Report text={entry.comment.body} />
            </Stage>
          ),
        )}
      </ol>
      <Composer
        task={task}
        cannotRun={cannotRun}
        onCommented={onCommented}
        onSentFromSheet={() =>
          // After the reloaded feed is drawn: the new comment is its last entry.
          requestAnimationFrame(() =>
            feed.current?.lastElementChild?.scrollIntoView({ block: 'center' }),
          )
        }
      />
    </section>
  );
});

/**
 * A comment for the task's agent: kept for its next run, or with a run of its own. On a phone the
 * field at the feed's end is out of reach, so it is a bar above the tab bar wherever the page is
 * scrolled, opening as a composer sheet; one draft serves both.
 */
function Composer(props: {
  task: Task;
  cannotRun?: string;
  onCommented: () => Promise<void>;
  /** After a comment sent from the sheet: the feed's end is out of sight on a phone. */
  onSentFromSheet: () => void;
}) {
  const [body, setBody] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError>();
  const [sheet, setSheet] = useState(false);
  const empty = !body.trim();
  const placeholder = `Write to ${props.task.agent.name}`;

  async function send(run: boolean) {
    if (empty || pending) return;
    setPending(true);
    setError(undefined);
    try {
      await api(`/api/tasks/${props.task.id}/comments`, { body: { body, run } });
      setBody('');
      await props.onCommented();
      if (sheet) {
        setSheet(false);
        props.onSentFromSheet();
      }
    } catch (caught) {
      setError(asApiError(caught));
    } finally {
      setPending(false);
    }
  }

  const field = {
    'aria-label': 'Comment',
    value: body,
    onChange: (event: ChangeEvent<HTMLTextAreaElement>) => setBody(event.target.value),
    onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void send(false);
      }
    },
  };
  const actions = (
    <>
      {error && <FormError>{error.message}</FormError>}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {props.cannotRun && !empty && (
          <span className="mr-auto text-small text-ink-3">
            {props.cannotRun} The next run reads your comment.
          </span>
        )}
        <Button type="submit" disabled={pending || empty}>
          Comment
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={pending || empty || props.cannotRun !== undefined}
          onClick={() => void send(true)}
        >
          Comment and run
        </Button>
      </div>
    </>
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void send(false);
  };

  return (
    <>
      <form
        noValidate
        aria-label="Comment"
        className="mt-4 grid gap-2 max-md:hidden"
        onSubmit={submit}
      >
        <Textarea
          {...field}
          placeholder={`${placeholder}: what to change, what you found`}
          className="min-h-20"
        />
        {actions}
      </form>
      {/* Room at the page's end for the bar, so the feed's last entry is not under it. */}
      <div aria-hidden="true" className="h-14 md:hidden" />
      <div className="fixed inset-x-0 bottom-[calc(56px+env(safe-area-inset-bottom))] z-30 border-t border-line bg-paper/85 px-4 py-2 backdrop-blur-md md:hidden">
        <D.Dialog open={sheet} onOpenChange={(open) => pending || setSheet(open)}>
          <D.DialogTrigger asChild>
            <button
              type="button"
              className={cn(
                'flex h-10 w-full items-center rounded-md border border-line-control bg-raised px-3 text-left',
                empty ? 'text-ink-3' : 'text-ink',
              )}
            >
              <span className="truncate">{empty ? placeholder : body}</span>
            </button>
          </D.DialogTrigger>
          <D.DialogContent
            size="wide"
            className={D.composer}
            onOpenAutoFocus={(event) => {
              const text = (event.currentTarget as HTMLElement).querySelector('textarea');
              if (!text) return;
              event.preventDefault();
              text.focus();
            }}
          >
            <form noValidate aria-label="Comment" className="flex flex-col" onSubmit={submit}>
              <div className="grid grid-cols-[1fr_auto_1fr] items-center border-b border-line p-2">
                <D.DialogClose asChild>
                  <Button variant="quiet" type="button" className="justify-self-start">
                    Cancel
                  </Button>
                </D.DialogClose>
                <D.DialogTitle className="text-section">Comment</D.DialogTitle>
                <D.DialogDescription className="sr-only">
                  {placeholder}: kept for its next run, or with a run of its own.
                </D.DialogDescription>
              </div>
              <textarea
                {...field}
                placeholder={`${placeholder}: what to change, what you found`}
                className="field-sizing-content max-h-[40dvh] min-h-24 resize-none bg-transparent px-4 pt-4 text-read text-ink outline-none placeholder:text-ink-3"
              />
              <div className="grid gap-2 px-4 pt-3 pb-4">{actions}</div>
            </form>
          </D.DialogContent>
        </D.Dialog>
      </div>
    </>
  );
}

/** One step of the feed: its marker on the thread, and the time after its first line. */
function Stage(props: {
  icon: ReactNode;
  /** An avatar stands on the thread as it is, without the ring of a step. */
  plain?: boolean;
  line: ReactNode;
  at: string;
  last: boolean;
  children?: ReactNode;
}) {
  return (
    <li
      className={cn(
        'relative grid grid-cols-[24px_minmax(0,1fr)] gap-3 py-2.5',
        // The thread between the markers, down to the next one.
        !props.last &&
          'before:absolute before:top-9 before:-bottom-2.5 before:left-[11.5px] before:w-px before:bg-line',
      )}
    >
      <span className={props.plain ? 'grid size-6 place-items-center' : tile}>{props.icon}</span>
      <div className="min-w-0 pt-0.5 text-ink-2">
        <p>
          {props.line}
          <span className="text-ink-3" title={formatWhen(props.at)}>
            {' · '}
            {timeAgo(props.at)}
          </span>
        </p>
        {props.children}
      </div>
    </li>
  );
}
