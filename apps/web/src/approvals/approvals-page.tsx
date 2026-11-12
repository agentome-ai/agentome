import {
  ArrowLeft,
  ChevronDown,
  CircleDot,
  GitBranch,
  MessageCircleQuestion,
  ScrollText,
  ShieldCheck,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api, asApiError, timeAgo } from '../api';
import { useRunEvents } from '../dashboard/plans';
import { planOf } from '../runs/run-plan';
import { ApiErrorState } from '../session';
import { ContextFacts, frame, PageHeader, split } from '../shell/page-header';
import { EmptyState, LoadingState } from '../shell/states';
import { Button } from '../ui/button';
import { fieldChip } from '../ui/chip';
import { cn } from '../ui/cn';
import * as D from '../ui/dialog';
import * as M from '../ui/dropdown-menu';
import { Field, FormError } from '../ui/field';
import { Textarea } from '../ui/input';
import { Markdown } from '../ui/markdown';
import { StatusMarker } from '../ui/status';
import { AgentTile } from '../ui/tint';
import { AnswerForm, questionOf } from './answer-form';
import { type Approval, describe, repositoryName, useApprovals } from './approvals-data';

// A waiting agent holds its run, so the queue asks as often as the task page does.
const REFRESH_MS = 5_000;

// A key is the person's only while nothing that types or picks has focus.
const keyIsTaken = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
    target.closest('[role=menu], [role=listbox], [role=dialog]') !== null);

/**
 * /approvals: what waits for the person, as Linear's inbox. The requests on the
 * left, oldest first; the one picked on the right with what the agent wrote and Approve, Deny or
 * its answer. J and K move, A approves, D denies. On a phone the list decides in place, and a
 * request opens over it.
 */
export function ApprovalsPage() {
  const { approvals, error, reload } = useApprovals();
  const [picked, setPicked] = useState<string>();
  // On a phone the detail covers the list once a request is opened.
  const [opened, setOpened] = useState(false);
  const [denying, setDenying] = useState<Approval>();
  const [failed, setFailed] = useState<{ id: string; message: string }>();
  const [pending, setPending] = useState<string>();
  // Where the request just decided stood: the one after it is picked next.
  const decidedAt = useRef<number | undefined>(undefined);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [reload]);

  // The picked request, or the one that took the decided one's place, or the first.
  const list = approvals ?? [];
  const index = Math.max(
    0,
    list.findIndex((call) => call.id === picked),
  );
  const current =
    list.find((call) => call.id === picked) ?? list[decidedAt.current ?? 0] ?? list[0];
  useEffect(() => {
    if (!approvals) return;
    const next = approvals.find((call) => call.id === picked)
      ? picked
      : approvals[Math.min(decidedAt.current ?? 0, approvals.length - 1)]?.id;
    decidedAt.current = undefined;
    if (next !== picked) setPicked(next);
    if (!next) setOpened(false);
  }, [approvals, picked]);

  const gone = useCallback(
    async (call: Approval) => {
      // Picked stays on the decided one: once the list comes back without it, the one in its
      // place is picked.
      decidedAt.current = list.findIndex((each) => each.id === call.id);
      await reload();
    },
    [list, reload],
  );

  // `always`: and the agent is not asked about this tool again.
  const approve = useCallback(
    async (call: Approval, always = false) => {
      if (pending) return;
      setPending(call.id);
      setFailed(undefined);
      try {
        await api(`/api/tool-calls/${call.id}/approve`, {
          method: 'POST',
          ...(always && { body: { always: true } }),
        });
        await gone(call);
      } catch (caught) {
        setFailed({ id: call.id, message: asApiError(caught).message });
      } finally {
        setPending(undefined);
      }
    },
    [gone, pending],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || keyIsTaken(event.target)) return;
      if (!current || denying) return;
      const key = event.key.toLowerCase();
      if (key === 'j' || key === 'k') {
        const next = list[Math.min(list.length - 1, Math.max(0, index + (key === 'j' ? 1 : -1)))];
        if (next) setPicked(next.id);
      } else if (current.tool !== 'ask_owner' && key === 'a') void approve(current);
      else if (current.tool !== 'ask_owner' && key === 'd') setDenying(current);
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [approve, current, denying, index, list]);

  let body;
  if (!approvals) {
    body = (
      <div className={cn(frame.wide, 'pt-6')}>
        {error ? (
          <ApiErrorState title="Couldn't load approvals" error={error} onRetry={reload} />
        ) : (
          <LoadingState label="Loading approvals" />
        )}
      </div>
    );
  } else if (approvals.length === 0 || !current) {
    body = (
      <div className={cn(frame.wide, 'pt-6')}>
        <EmptyState title="Nothing is waiting for you" preview="approval">
          When an agent needs your approval for a step, or asks you something, it waits here until
          you decide.
        </EmptyState>
      </div>
    );
  } else {
    body = (
      <div className={split.page}>
        <div className={cn(split.list, opened && 'max-md:hidden')}>
          <p className="px-4 pt-3.5 pb-2.5 text-small text-ink-3">
            {approvals.length === 1
              ? 'One waiting for you'
              : `${approvals.length} waiting for you, oldest first`}
          </p>
          <ul aria-label="Waiting for you" className="grid grid-cols-[minmax(0,1fr)]">
            {approvals.map((call) => (
              <Item
                key={call.id}
                call={call}
                current={call.id === current.id}
                pending={pending === call.id}
                onPick={() => {
                  setPicked(call.id);
                  setOpened(true);
                }}
                onApprove={() => void approve(call)}
                onDeny={() => setDenying(call)}
              />
            ))}
          </ul>
        </div>
        <div className={cn(split.item, !opened && 'max-md:hidden')}>
          <Detail
            key={current.id}
            call={current}
            pending={pending === current.id}
            error={failed?.id === current.id ? failed.message : undefined}
            onBack={() => setOpened(false)}
            onApprove={() => void approve(current)}
            onApproveAlways={() => void approve(current, true)}
            onDeny={() => setDenying(current)}
            onAnswered={() => gone(current)}
          />
        </div>
      </div>
    );
  }

  return (
    <>
      <PageHeader title="Approvals" />
      {body}
      <DenyDialog
        call={denying}
        onClose={() => setDenying(undefined)}
        onDenied={() => {
          const call = denying;
          setDenying(undefined);
          if (call) void gone(call);
        }}
      />
    </>
  );
}

/** What a request is, in two words and an icon: a step to approve, or a question to answer. */
function kindOf(call: Approval) {
  if (call.tool === 'ask_owner') return { icon: MessageCircleQuestion, word: 'Answer' };
  if (call.tool.startsWith('code_host')) return { icon: GitBranch, word: 'Approve' };
  return { icon: ShieldCheck, word: 'Approve' };
}

/** The line a request reads as: an agent's question, or the step in people's words. */
function headlineOf(call: Approval) {
  const words = describe(call);
  return call.tool === 'ask_owner'
    ? { text: questionOf(call).question || 'A question', refs: [] }
    : { text: words.action, refs: words.refs };
}

function Item(props: {
  call: Approval;
  current: boolean;
  pending: boolean;
  onPick: () => void;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const { call } = props;
  const kind = kindOf(call);
  const line = headlineOf(call);
  const question = call.tool === 'ask_owner';
  return (
    <li
      className={cn(
        'relative grid grid-cols-[24px_minmax(0,1fr)] gap-x-2.5 border-b border-line px-4 py-2.5 hover:bg-hover',
        props.current &&
          'md:bg-raised md:before:absolute md:before:inset-y-2 md:before:left-0 md:before:w-0.5 md:before:rounded-full md:before:bg-waiting',
      )}
    >
      <AgentTile id={call.agent.id} name={call.agent.name} className="mt-0.5 size-6" />
      {/* The whole item picks the request; its buttons sit above that cover. */}
      <button
        type="button"
        aria-current={props.current ? 'true' : undefined}
        onClick={props.onPick}
        className="grid min-w-0 gap-0.5 text-left after:absolute after:inset-0"
      >
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate font-medium">
            <WithRefs text={line.text} refs={line.refs} />
          </span>
          <span className="shrink-0 text-small text-ink-3">{timeAgo(call.createdAt)}</span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-small text-ink-3">
          <kind.icon aria-hidden="true" className="size-3 shrink-0 text-waiting" />
          <span className="shrink-0 text-waiting">{kind.word}</span>
          <span className="truncate">
            · {call.agent.name}
            {call.task && ` · ${call.task.title}`}
          </span>
        </span>
      </button>
      {/* On a phone a step is decided in the list; a question needs the room of its own page. */}
      <span className="relative col-start-2 mt-2 flex gap-2 md:hidden">
        {question ? (
          <Button className="flex-1" onClick={props.onPick}>
            Answer
          </Button>
        ) : (
          <>
            <Button className="flex-1" onClick={props.onDeny}>
              Deny
            </Button>
            <Button className="flex-1" variant="decision" onClick={props.onApprove}>
              {props.pending ? 'Approving…' : 'Approve'}
            </Button>
          </>
        )}
      </span>
    </li>
  );
}

function Detail(props: {
  call: Approval;
  pending: boolean;
  error?: string;
  onBack: () => void;
  onApprove: () => void;
  onApproveAlways: () => void;
  onDeny: () => void;
  onAnswered: () => Promise<void>;
}) {
  const { call } = props;
  const words = describe(call);
  const question = call.tool === 'ask_owner';
  const kind = kindOf(call);
  const input =
    call.input && typeof call.input === 'object' ? (call.input as Record<string, unknown>) : {};
  // The call's own arguments, those a person can read at a glance.
  const args = Object.entries(input).filter(
    ([key, value]) =>
      ['string', 'number', 'boolean'].includes(typeof value) &&
      !['title', 'description', 'body', 'question'].includes(key) &&
      String(value).length < 120,
  );
  return (
    <article aria-label="Request" className={split.body}>
      <div className={split.column}>
        <button
          type="button"
          onClick={props.onBack}
          className="-ml-1 inline-flex items-center gap-1 justify-self-start text-read text-ink-2 md:hidden"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          All requests
        </button>
        <div className="grid gap-2.5">
          <p className="flex items-center gap-1.5 text-small text-ink-3">
            <kind.icon aria-hidden="true" className="size-3.5 text-waiting" />
            <span className="font-medium text-waiting">
              {question ? 'Asks you' : 'Waiting for approval'}
            </span>
            · asked {timeAgo(call.createdAt)}
          </p>
          <h2 className="text-title text-balance break-words">
            {question ? (
              `${call.agent.name} asks you`
            ) : (
              <WithRefs text={words.action} refs={words.refs} />
            )}
          </h2>
          {/* The same facts as the context column's, while there is no room for that column. */}
          <div className={cn('flex flex-wrap gap-1.5', split.narrow)}>
            <Link to={`/agents/${call.agent.id}`} className={fieldChip}>
              <AgentTile id={call.agent.id} name={call.agent.name} className="size-4.5" />
              <span className="truncate">{call.agent.name}</span>
            </Link>
            {call.task && (
              <Link to={`/tasks/${call.task.id}`} className={fieldChip}>
                <CircleDot aria-hidden="true" className="text-ink-2" />
                <span className="truncate">{call.task.title}</span>
              </Link>
            )}
            {call.task?.repository && (
              <span className={fieldChip}>
                <GitBranch aria-hidden="true" className="text-ink-2" />
                <span className="truncate">{repositoryName(call.task.repository)}</span>
              </span>
            )}
            <Link to={`/runs/${call.runId}`} className={fieldChip}>
              <ScrollText aria-hidden="true" className="text-ink-2" />
              <span>Open the run</span>
            </Link>
          </div>
        </div>
      </div>
      <Context call={call} />
      <div className={split.column}>
        {question ? (
          <AnswerForm call={call} onDone={props.onAnswered} />
        ) : (
          <>
            {(words.title || words.body) && (
              // What the agent wrote, set apart from our description of the step.
              <div className="rounded-xl border border-line bg-raised px-4 py-3.5">
                <p className="mb-2 flex items-center gap-2 text-small text-ink-2">
                  <AgentTile id={call.agent.id} name={call.agent.name} />
                  <span>
                    <span className="font-medium text-ink">{call.agent.name}</span> wrote
                  </span>
                </p>
                {words.title && <p className="font-medium break-words">{words.title}</p>}
                {words.body && (
                  <Markdown className="mt-1 text-ui text-ink-2">{words.body}</Markdown>
                )}
              </div>
            )}
            <dl className="overflow-hidden rounded-lg border border-line">
              {[['Tool', call.tool] as const, ...args].map(([key, value]) => (
                <div
                  key={key}
                  className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-3 border-line px-3 py-2 not-first:border-t"
                >
                  <dt className="truncate text-ink-3">{key === 'Tool' ? 'Tool' : key}</dt>
                  <dd className="font-mono text-[12.5px] break-all">{String(value)}</dd>
                </div>
              ))}
            </dl>
            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4.5">
              {/* One answer and its rarer form, as one button: Approve, and under its arrow the
                  approval that also stops the agent asking. Three buttons of three colours in a
                  row read as three equal choices. */}
              <div className="flex">
                <Button
                  variant="decision"
                  className="rounded-r-none"
                  disabled={props.pending}
                  onClick={props.onApprove}
                >
                  {props.pending ? 'Approving…' : 'Approve'}
                </Button>
                <M.DropdownMenu>
                  <M.DropdownMenuTrigger asChild>
                    <Button
                      variant="decision"
                      aria-label="More ways to approve"
                      className="rounded-l-none border-l-accent-text/20 px-1.5"
                      disabled={props.pending}
                    >
                      <ChevronDown aria-hidden="true" className="size-4" />
                    </Button>
                  </M.DropdownMenuTrigger>
                  <M.DropdownMenuContent align="start" className="w-80">
                    <M.DropdownMenuItem
                      className="grid h-auto gap-0.5 py-2"
                      onSelect={props.onApproveAlways}
                    >
                      <span>Approve and stop asking</span>
                      <span className="text-small whitespace-normal text-ink-3">
                        {call.agent.name} uses <span className="font-mono">{call.tool}</span>{' '}
                        without your approval from now on. Change it back in the agent’s Tools &amp;
                        policies.
                      </span>
                    </M.DropdownMenuItem>
                  </M.DropdownMenuContent>
                </M.DropdownMenu>
              </div>
              <Button onClick={props.onDeny}>Deny</Button>
              <p className="ml-auto flex items-center gap-1 text-small text-ink-3 max-md:hidden">
                <Key>A</Key> approve · <Key>D</Key> deny · <Key>J</Key>
                <Key>K</Key> next
              </p>
            </div>
          </>
        )}
        {props.error && <FormError>{props.error}</FormError>}
      </div>
    </article>
  );
}

/**
 * What stands beside a request: its facts, as a tracker sets an issue's properties beside
 * the issue, and how far its run has come, which a person used to open the run to see. From
 * 1800 px it is a column of its own; narrower, the facts are the chips under the heading and the
 * run's plan stands between the heading and the decision.
 */
function Context({ call }: { call: Approval }) {
  const events = useRunEvents([call.runId], call.id).get(call.runId);
  const steps = events ? planOf(events) : [];
  const done = steps.filter((step) => step.status === 'completed').length;
  const facts: [string, ReactNode][] = [
    [
      'Agent',
      <Link to={`/agents/${call.agent.id}`} className="inline-flex min-w-0 items-center gap-1.5">
        <AgentTile id={call.agent.id} name={call.agent.name} className="size-4.5" />
        <span className="truncate underline-offset-2 hover:underline">{call.agent.name}</span>
      </Link>,
    ],
  ];
  if (call.task) {
    facts.push([
      'Task',
      <Link to={`/tasks/${call.task.id}`} className="underline-offset-2 hover:underline">
        {call.task.title}
      </Link>,
    ]);
    if (call.task.repository) {
      facts.push([
        'Repository',
        <span className="font-mono text-[12.5px] break-all">
          {repositoryName(call.task.repository)}
        </span>,
      ]);
    }
  }
  facts.push(['Asked', timeAgo(call.createdAt)]);
  return (
    // Without a plan there is nothing to show while the facts are the chips above.
    <aside
      aria-label="About this request"
      className={cn(split.context, steps.length === 0 && split.wide)}
    >
      <ContextFacts facts={facts} />
      {steps.length > 0 && (
        <section aria-labelledby="request-run" className="grid gap-2">
          <div className="flex items-baseline gap-3">
            <h3 id="request-run" className="text-section">
              The run so far
            </h3>
            <span className="text-small text-ink-3">
              {done} of {steps.length} done
            </span>
          </div>
          <ol className="grid grid-cols-[minmax(0,1fr)]">
            {steps.map((step, index) => (
              <li
                key={`${index}-${step.content}`}
                className="flex min-w-0 items-start gap-2.5 border-line py-1.5 not-first:border-t"
              >
                <StatusMarker
                  className="mt-1"
                  status={
                    step.status === 'completed'
                      ? 'done'
                      : step.status === 'in_progress'
                        ? 'waiting_approval'
                        : 'queued'
                  }
                />
                <span className={cn('min-w-0', step.status === 'pending' && 'text-ink-2')}>
                  {step.status === 'in_progress' ? step.active : step.content}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}
      <Link
        to={`/runs/${call.runId}`}
        className={cn('justify-self-start text-ink-2 underline underline-offset-2', split.wide)}
      >
        Open the run
      </Link>
    </aside>
  );
}

const Key = ({ children }: { children: string }) => (
  <kbd className="rounded-sm border border-line-strong px-1 text-[11px] leading-4 font-medium text-ink-2">
    {children}
  </kbd>
);

/** A sentence with its repositories and branches set as code, never broken across lines. */
export function WithRefs({ text, refs }: { text: string; refs: string[] }) {
  const sorted = [...new Set(refs)].sort((a, b) => b.length - a.length);
  if (sorted.length === 0) return <>{text}</>;
  const escape = (ref: string) => ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${sorted.map(escape).join('|')})`));
  return (
    <>
      {parts.map((part, i) =>
        sorted.includes(part) ? (
          <code key={i} className="whitespace-nowrap">
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}

export function DenyDialog(props: { call?: Approval; onClose: () => void; onDenied: () => void }) {
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const call = props.call;
  // Each request starts with an empty reason.
  useEffect(() => {
    setReason('');
    setError(undefined);
  }, [call?.id]);

  async function deny() {
    if (!call || pending) return;
    setPending(true);
    setError(undefined);
    try {
      const sent = reason.trim();
      await api(`/api/tool-calls/${call.id}/deny`, { body: sent ? { reason: sent } : {} });
      props.onDenied();
    } catch (caught) {
      setError(asApiError(caught).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <D.Dialog open={call !== undefined} onOpenChange={(open) => !open && props.onClose()}>
      <D.DialogContent>
        <D.DialogTitle>Deny this request?</D.DialogTitle>
        <D.DialogDescription>
          {call && (
            <>
              {call.agent.name} won't{' '}
              <WithRefs text={lower(describe(call).action)} refs={describe(call).refs} />.{' '}
            </>
          )}
          It reads your reason and carries on with the task without this step.
        </D.DialogDescription>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void deny();
          }}
        >
          <Field label="Reason (optional)" hint="For example: open it as a draft first.">
            {(control) => (
              <Textarea
                {...control}
                rows={3}
                maxLength={1000}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            )}
          </Field>
          {error && <FormError>{error}</FormError>}
          <D.DialogFooter>
            <D.DialogClose asChild>
              <Button variant="quiet">Cancel</Button>
            </D.DialogClose>
            <Button type="submit" variant="danger" disabled={pending}>
              Deny
            </Button>
          </D.DialogFooter>
        </form>
      </D.DialogContent>
    </D.Dialog>
  );
}

const lower = (sentence: string) => sentence.charAt(0).toLowerCase() + sentence.slice(1);
