import { useEffect, useState } from 'react';
import { api, asApiError, formatDate } from '../api';
import { Button } from '../ui/button';
import { DateField } from '../ui/calendar';
import * as D from '../ui/dialog';
import { Field, FormError } from '../ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import type { Agent } from './agents-data';

type Person = { id: string; name: string };
type Transferred = { transferred: Person[]; to: Person; until: string | null };

/** The first day an agent can come back on: tomorrow. */
function tomorrow() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
}
const FOR_GOOD = 'Never: it is theirs for good';

/**
 * Transfer ownership: to whom, and for good or until a day, picked in the calendar,
 * on which the agent comes back by itself.
 * An agent that is with the person for a time can only go back to its owner early.
 */
export function TransferDialog(props: {
  agent: Agent;
  open: boolean;
  onClose: () => void;
  onCloseAutoFocus: (event: Event) => void;
  onTransferred: (done: Transferred) => void;
}) {
  const { agent } = props;
  const [people, setPeople] = useState<Person[]>();
  const [to, setTo] = useState('');
  // The day it comes back, at its start; none is for good.
  const [back, setBack] = useState<Date>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  // The owner it goes back to, when it is here only until a day.
  const lender = agent.people.find((person) => person.validFrom !== null);

  useEffect(() => {
    if (!props.open) return;
    setTo('');
    setBack(undefined);
    setError(undefined);
    if (lender) return;
    let live = true;
    api<{ people: Person[] }>('/api/people').then(
      (answer) => live && setPeople(answer.people.filter((one) => one.id !== agent.owner.id)),
      (caught: unknown) => live && setError(asApiError(caught).message),
    );
    return () => {
      live = false;
    };
  }, [props.open, lender, agent.owner.id]);

  const until = back?.toISOString();
  const chosen = lender ?? people?.find((one) => one.id === to);
  async function transfer() {
    if (!chosen) return;
    setPending(true);
    setError(undefined);
    try {
      const body = { to: chosen.id, ...(until && !lender && { until }) };
      props.onTransferred(
        await api<Transferred>(`/api/agents/${agent.id}/transfer`, { method: 'POST', body }),
      );
      props.onClose();
    } catch (caught) {
      setError(asApiError(caught).message);
    } finally {
      setPending(false);
    }
  }

  const footer = (label: string, danger: boolean) => (
    <D.DialogFooter>
      <D.DialogClose asChild>
        <Button variant="quiet">Cancel</Button>
      </D.DialogClose>
      <Button
        variant={danger ? 'danger' : 'primary'}
        disabled={pending || !chosen}
        onClick={() => void transfer()}
      >
        {label}
      </Button>
    </D.DialogFooter>
  );

  if (lender?.validFrom) {
    return (
      <D.Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
        <D.DialogContent onCloseAutoFocus={props.onCloseAutoFocus}>
          <D.DialogTitle>
            Return {agent.name} to {lender.name}?
          </D.DialogTitle>
          <D.DialogDescription>
            It is with you until {formatDate(lender.validFrom)} and goes back then by itself.
            Returned now, it is {lender.name}’s again today, and you no longer see it.
          </D.DialogDescription>
          {error && <FormError>{error}</FormError>}
          {footer('Return now', false)}
        </D.DialogContent>
      </D.Dialog>
    );
  }
  return (
    <D.Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <D.DialogContent onCloseAutoFocus={props.onCloseAutoFocus}>
        <D.DialogTitle>Transfer {agent.name}</D.DialogTitle>
        <D.DialogDescription>
          Its memory, history and settings go with it. If it leads a team, the whole team goes too.
        </D.DialogDescription>
        <div className="mt-4 grid gap-4">
          <Field label="New owner">
            {(control) => (
              <Select value={to} onValueChange={setTo} disabled={!people?.length}>
                <SelectTrigger {...control}>
                  <SelectValue
                    placeholder={
                      people === undefined
                        ? 'Loading people'
                        : people.length
                          ? 'Choose a person'
                          : 'Nobody else has an account'
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {people?.map((person) => (
                    <SelectItem key={person.id} value={person.id}>
                      {person.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
          <Field label="Comes back">
            {(control) => (
              <DateField
                {...control}
                value={back}
                onChange={setBack}
                min={tomorrow()}
                placeholder={FOR_GOOD}
                clearLabel={FOR_GOOD}
              />
            )}
          </Field>
          <p className="text-small text-ink-2">
            {until
              ? `Until ${formatDate(until)} you don't see it: its runs go to ${chosen?.name ?? 'the new owner'}'s computer and its approvals to them. Then it comes back to you by itself.`
              : `You lose access to it. Its runs go to ${chosen?.name ?? 'the new owner'}'s computer and its approvals to them.`}{' '}
            Sign-ins to MCP servers are personal: they sign in again to the ones it uses.
          </p>
        </div>
        {error && <FormError>{error}</FormError>}
        {footer('Transfer', !until)}
      </D.DialogContent>
    </D.Dialog>
  );
}

/**
 * Admin, People: everything a person owns goes to a successor, for when the person leaves. What
 * they had for a time goes back to its owner; the server says which was which.
 */
export function TransferAgentsDialog(props: {
  from: Person | undefined;
  people: Person[];
  onClose: () => void;
}) {
  const { from } = props;
  const [to, setTo] = useState('');
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  // What the server did, said in the dialog itself: nothing on the page behind it changes.
  const [done, setDone] = useState<{ transferred: Person[]; returned: Person[]; to: Person }>();
  useEffect(() => {
    setTo('');
    setError(undefined);
    setDone(undefined);
  }, [from?.id]);
  const others = props.people.filter((one) => one.id !== from?.id);
  async function transfer() {
    if (!from || !to) return;
    setPending(true);
    setError(undefined);
    try {
      setDone(await api(`/api/users/${from.id}/transfer-agents`, { method: 'POST', body: { to } }));
    } catch (caught) {
      setError(asApiError(caught).message);
    } finally {
      setPending(false);
    }
  }
  const names = (agents: Person[]) => agents.map((agent) => agent.name).join(', ');
  const count = (agents: Person[]) =>
    `${agents.length} ${agents.length === 1 ? 'agent' : 'agents'}`;
  if (done) {
    const { transferred, returned } = done;
    return (
      <D.Dialog open={from !== undefined} onOpenChange={(open) => !open && props.onClose()}>
        <D.DialogContent>
          <D.DialogTitle>
            {transferred.length
              ? `${count(transferred)} ${transferred.length === 1 ? 'is' : 'are'} ${done.to.name}’s now`
              : returned.length
                ? `${count(returned)} went back`
                : `${from?.name} owns no agents`}
          </D.DialogTitle>
          <D.DialogDescription>
            {transferred.length > 0 && `${names(transferred)}. `}
            {returned.length > 0 &&
              `${transferred.length ? 'Back with ' : 'With '}${returned.length === 1 ? 'its owner' : 'their owners'} again: ${names(returned)}.`}
            {transferred.length + returned.length === 0 && 'There was nothing to transfer.'}
          </D.DialogDescription>
          <D.DialogFooter>
            <D.DialogClose asChild>
              <Button variant="primary">Done</Button>
            </D.DialogClose>
          </D.DialogFooter>
        </D.DialogContent>
      </D.Dialog>
    );
  }
  return (
    <D.Dialog open={from !== undefined} onOpenChange={(open) => !open && props.onClose()}>
      <D.DialogContent>
        <D.DialogTitle>Transfer {from?.name}’s agents</D.DialogTitle>
        <D.DialogDescription>
          Every agent {from?.name} owns goes to the person you choose, for good, with its memory,
          history and teams. An agent {from?.name} has only for a time goes back to its owner.
        </D.DialogDescription>
        <div className="mt-4 grid gap-4">
          <Field label="New owner">
            {(control) => (
              <Select value={to} onValueChange={setTo} disabled={!others.length}>
                <SelectTrigger {...control}>
                  <SelectValue
                    placeholder={others.length ? 'Choose a person' : 'Nobody else has an account'}
                  />
                </SelectTrigger>
                <SelectContent>
                  {others.map((person) => (
                    <SelectItem key={person.id} value={person.id}>
                      {person.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
          <p className="text-small text-ink-2">
            Their runs go to the new owner’s computer and their approvals to them. Sign-ins to MCP
            servers are personal: the new owner signs in again to the ones the agents use.
          </p>
        </div>
        {error && <FormError>{error}</FormError>}
        <D.DialogFooter>
          <D.DialogClose asChild>
            <Button variant="quiet">Cancel</Button>
          </D.DialogClose>
          <Button variant="danger" disabled={pending || !to} onClick={() => void transfer()}>
            Transfer
          </Button>
        </D.DialogFooter>
      </D.DialogContent>
    </D.Dialog>
  );
}
