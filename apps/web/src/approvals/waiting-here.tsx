import { useState } from 'react';
import { Link } from 'react-router';
import { api, asApiError } from '../api';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { FormError } from '../ui/field';
import { AnswerForm } from './answer-form';
import { type Approval, describe, useApprovals } from './approvals-data';
import { DenyDialog, WithRefs } from './approvals-page';
import { CallArguments } from './call-arguments';

/**
 * The calls of one task or run that wait for the person, with Approve and Deny where the work
 * is read, so a run's steps need no trip to Approvals. Nothing when none wait.
 */
export function WaitingHere(props: {
  which: (call: Approval) => boolean;
  /** On a page of many tasks (the dashboard): each call names the task it is for. */
  withTask?: boolean;
  className?: string;
}) {
  const { approvals, reload } = useApprovals();
  const [denying, setDenying] = useState<Approval>();
  const waiting = approvals?.filter(props.which) ?? [];
  if (waiting.length === 0 && !denying) return null;
  return (
    <section
      aria-labelledby="waiting-here"
      className={cn('rounded-xl border border-line bg-raised', props.className ?? 'mb-8')}
    >
      {/* A panel like the dashboard's: the heading over a rule, the calls as rows. */}
      <h2 id="waiting-here" className="border-b border-line px-4 py-3 font-semibold">
        {waiting.length === 1 ? 'Waiting for you' : `${waiting.length} steps wait for you`}
      </h2>
      <ul className="grid divide-y divide-line px-4">
        {waiting.map((call) =>
          call.tool === 'ask_owner' ? (
            <li key={call.id} className="py-3">
              <p className="mb-2 text-small text-ink-3">
                {call.agent.name} asks you
                {props.withTask && <OnTask call={call} />}
              </p>
              <AnswerForm call={call} onDone={reload} />
            </li>
          ) : (
            <Waiting
              key={call.id}
              call={call}
              withTask={props.withTask}
              onDecided={reload}
              onDeny={() => setDenying(call)}
            />
          ),
        )}
      </ul>
      <DenyDialog
        call={denying}
        onClose={() => setDenying(undefined)}
        onDenied={() => {
          setDenying(undefined);
          void reload();
        }}
      />
    </section>
  );
}

/** " on <task>", linked, for a call shown away from its task. */
function OnTask({ call }: { call: Approval }) {
  if (!call.task) return null;
  return (
    <>
      {' on '}
      <Link to={`/tasks/${call.task.id}`} className="text-ink-2 underline underline-offset-2">
        {call.task.title}
      </Link>
    </>
  );
}

function Waiting(props: {
  call: Approval;
  withTask?: boolean;
  onDecided: () => Promise<void>;
  onDeny: () => void;
}) {
  const { call } = props;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const words = describe(call);

  async function approve() {
    if (pending) return;
    setPending(true);
    setError(undefined);
    try {
      await api(`/api/tool-calls/${call.id}/approve`, { method: 'POST' });
      await props.onDecided();
    } catch (caught) {
      setError(asApiError(caught).message);
      setPending(false);
    }
  }

  return (
    <li className="grid gap-2 py-3">
      <span className="min-w-0">
        <WithRefs text={words.action} refs={words.refs} />
        <span className="block text-small text-ink-3">
          Asked by {call.agent.name}
          {props.withTask && <OnTask call={call} />}
        </span>
      </span>
      {/* What Approve lets through, whole, and the answer under it, as on the Approvals page. */}
      <CallArguments tool={call.tool} input={call.input} compact />
      <span className="flex justify-end gap-2">
        <Button size="sm" onClick={props.onDeny}>
          Deny
        </Button>
        <Button size="sm" variant="decision" disabled={pending} onClick={() => void approve()}>
          {pending ? 'Approving…' : 'Approve'}
        </Button>
      </span>
      {error && <FormError>{error}</FormError>}
    </li>
  );
}
