import { Ellipsis, Hand, ListOrdered, Plus, Sparkles } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import { api, asApiError } from '../api';
import { Button } from '../ui/button';
import { fieldChip } from '../ui/chip';
import { cn } from '../ui/cn';
import { Combobox } from '../ui/combobox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { FormError } from '../ui/field';
import { InPlace } from '../ui/in-place';
import { Row } from '../ui/list-row';
import { Section } from '../ui/section';
import { AgentTile } from '../ui/tint';
import { useAgents } from '../agents/agents-data';
import { agentLabel, type TeamMode, type TeamStep, type TeamSummary } from './teams-data';

type Body = { mode: TeamMode; members: string[]; steps: TeamStep[] };

/**
 * A team's fields, members and steps as Linear's: the lead and
 * who sets the order as chips, the members and the steps as lists. A change saves at once, as a
 * skill does; a step's "done when" saves when it loses focus. Members are the lead owner's
 * active agents: they run on that owner's computer.
 */
export function TeamEditor(props: {
  team: TeamSummary;
  /** The lead's owner, whose agents may join. */
  ownerId: string;
  /** The lead's `team_step` policy, which says whether assignments wait for approval. */
  policy?: 'allow' | 'ask' | 'deny';
  /** The lead's chip, which the page owns: changing the lead reloads the lead's agent. */
  leadChip: ReactNode;
  onSaved: (team: TeamSummary) => void;
}) {
  const { team, policy } = props;
  const lead = team.lead;
  const { agents } = useAgents();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const members = team.members.map((member) => member.id);
  const nameOf = (id: string) => team.members.find((member) => member.id === id)?.name ?? '';

  async function save(body: Body) {
    if (pending) return;
    setPending(true);
    setError(undefined);
    try {
      props.onSaved(await api<TeamSummary>(`/api/teams/${team.id}`, { method: 'PATCH', body }));
    } catch (caught) {
      setError(asApiError(caught).message);
    } finally {
      setPending(false);
    }
  }

  // A manual team keeps at least one step, and every step at least one agent.
  const withSteps = (body: Body): Body => {
    if (body.mode === 'auto') return { ...body, steps: [] };
    const steps = body.steps
      .map((step) => ({ ...step, agents: step.agents.filter((id) => body.members.includes(id)) }))
      .filter((step) => step.agents.length > 0);
    return {
      ...body,
      steps: steps.length || !body.members.length ? steps : [{ agents: body.members, note: '' }],
    };
  };
  const change = (next: Partial<Body>) =>
    void save(withSteps({ mode: team.mode, members, steps: team.steps, ...next }));

  const options = agents
    .filter(
      (other) =>
        other.status === 'active' &&
        other.id !== lead.id &&
        other.owner.id === props.ownerId &&
        !members.includes(other.id),
    )
    .map((other) => ({
      value: other.id,
      label: agentLabel(other),
    }));
  // Whether the owner approves the work: the current mode as the lead's team_step policy says
  // (Tools & policies), the other one as it starts, asking: auto once per task, manual per step.
  const asks = (mode: Body['mode']) => (team.mode === mode ? policy === 'ask' : true);
  const idle = members.filter((id) => !team.steps.some((step) => step.agents.includes(id)));
  const modes = {
    auto: {
      icon: Sparkles,
      title: 'The lead decides',
      text: `${lead.name} decides who works on what, and when.${asks('auto') ? ' After its first assignment it waits for your approval, once per task.' : ''}`,
    },
    manual: {
      icon: ListOrdered,
      title: 'Steps you set',
      text: `You set the steps. ${asks('manual') ? 'Each one waits for your approval.' : 'They start without your approval.'}`,
    },
  };
  const mode = modes[team.mode];

  return (
    // One column that may shrink: an `auto` one grows with a long role and runs off a phone.
    <div className="grid grid-cols-[minmax(0,1fr)] gap-9">
      <div className="flex flex-wrap gap-1.5">
        {props.leadChip}
        {members.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger
              className={fieldChip}
              disabled={pending}
              aria-label={`Who sets the order: ${mode.title}`}
            >
              <mode.icon aria-hidden="true" className="text-ink-2" />
              <span>{mode.title}</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-80 max-w-[calc(100vw-32px)]">
              <DropdownMenuLabel>Who sets the order</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={team.mode}
                onValueChange={(next) =>
                  next !== team.mode &&
                  change({
                    mode: next as Body['mode'],
                    // From auto, one step for each agent, in the team's order.
                    steps: members.map((id) => ({ agents: [id], note: '' })),
                  })
                }
              >
                {(['auto', 'manual'] as const).map((value) => (
                  <DropdownMenuRadioItem key={value} value={value} className="items-start">
                    <span className="grid gap-0.5 py-0.5">
                      <span>{modes[value].title}</span>
                      <span className="text-small text-ink-3">{modes[value].text}</span>
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <Section
        title="Members"
        count={members.length}
        action={
          <Combobox
            value={null}
            options={options}
            trigger="icon"
            placeholder="Add an agent"
            searchPlaceholder="Search agents"
            emptyText="No other agent of its owner to add"
            onValueChange={(id) =>
              change({
                members: [...members, id],
                // In a manual team the new agent works in a step of its own, after the others.
                steps: [...team.steps, { agents: [id], note: '' }],
              })
            }
          />
        }
        empty={`No members yet. Add agents for ${lead.name} to lead: in its runs it splits the task between them, and they work at the same time, each with its own tools and memory.`}
        isEmpty={members.length === 0}
      >
        <ul aria-label="Members" className="-mt-2 grid grid-cols-[minmax(0,1fr)]">
          {team.members.map((member) => (
            <Row
              key={member.id}
              lead={<AgentTile id={member.id} name={member.name} />}
              name={
                <Link to={`/agents/${member.id}`} className="truncate font-medium">
                  {member.name}
                </Link>
              }
              detail={member.roleTitle}
              what={member.name}
              menu={
                <DropdownMenuItem
                  disabled={pending}
                  onSelect={() => change({ members: members.filter((id) => id !== member.id) })}
                >
                  Remove from team
                </DropdownMenuItem>
              }
            />
          ))}
        </ul>
      </Section>

      {team.mode === 'manual' && members.length > 0 && (
        <Section
          title="Steps"
          count={team.steps.length}
          action={
            <Button
              size="icon-sm"
              variant="quiet"
              aria-label="Add a step"
              disabled={pending}
              onClick={() =>
                change({
                  steps: [...team.steps, { agents: [idle[0] ?? members.at(-1) ?? ''], note: '' }],
                })
              }
            >
              <Plus aria-hidden="true" className="size-4" />
            </Button>
          }
          empty=""
          isEmpty={false}
        >
          <ol aria-label="Steps" className="grid grid-cols-[minmax(0,1fr)]">
            {team.steps.map((step, index) => (
              <Step
                key={`${index}-${step.agents.join()}`}
                index={index}
                last={index === team.steps.length - 1}
                step={step}
                team={team}
                pending={pending}
                onlyStep={team.steps.length === 1}
                onChange={(next) =>
                  change({
                    steps: next
                      ? team.steps.map((was, at) => (at === index ? next : was))
                      : team.steps.filter((_, at) => at !== index),
                  })
                }
              />
            ))}
          </ol>
          {idle.length > 0 && (
            <p className="flex items-center gap-2 text-small text-ink-2">
              <Hand aria-hidden="true" className="size-3.5 text-waiting" />
              {idle.map(nameOf).join(', ')} {idle.length === 1 ? 'is' : 'are'} in no step, so{' '}
              {lead.name} can't give {idle.length === 1 ? 'it' : 'them'} work.
            </p>
          )}
        </Section>
      )}
      {error && <FormError>{error}</FormError>}
    </div>
  );
}

/**
 * One manual step, as a point on a thread: its number, who works in it (pressed or not), and
 * when it is done, changed in place.
 */
function Step(props: {
  index: number;
  last: boolean;
  step: TeamStep;
  team: TeamSummary;
  pending: boolean;
  onlyStep: boolean;
  /** The step as it is now; nothing removes it. */
  onChange: (step?: TeamStep) => void;
}) {
  const { index, step } = props;
  const number = index + 1;
  return (
    <li className="relative grid grid-cols-[26px_minmax(0,1fr)_28px] gap-3 py-3">
      {/* The thread to the next step. */}
      {!props.last && (
        <span
          aria-hidden="true"
          className="absolute top-10.5 -bottom-2.5 left-[12.5px] w-px bg-line"
        />
      )}
      <span className="grid size-6.5 place-items-center rounded-full border border-line-strong bg-raised text-small font-semibold text-ink-2 tabular-nums">
        {number}
      </span>
      <div className="grid min-w-0 gap-1.5">
        <div
          role="group"
          aria-label={`Agents of step ${number}`}
          className="flex min-w-0 flex-wrap gap-1.5"
        >
          {props.team.members.map((member) => {
            const pressed = step.agents.includes(member.id);
            const lone = pressed && step.agents.length === 1;
            return (
              <button
                key={member.id}
                type="button"
                aria-pressed={pressed}
                disabled={props.pending || lone}
                title={lone ? 'A step needs an agent' : undefined}
                onClick={() =>
                  props.onChange({
                    ...step,
                    agents: pressed
                      ? step.agents.filter((id) => id !== member.id)
                      : props.team.members
                          .map((m) => m.id)
                          .filter((id) => id === member.id || step.agents.includes(id)),
                  })
                }
                className={cn(
                  'inline-flex h-6.5 items-center gap-1.5 rounded-md border pr-2 pl-1 text-small whitespace-nowrap transition-colors duration-120',
                  pressed
                    ? 'border-line-strong bg-raised text-ink'
                    : 'border-dashed border-line-strong text-ink-3 hover:text-ink [&>span]:opacity-45',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-default',
                )}
              >
                <AgentTile id={member.id} name={member.name} className="size-4.5" />
                {member.name}
              </button>
            );
          })}
        </div>
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 text-ink-3">Done when</span>
          <div className="min-w-0 flex-1">
            <InPlace
              label={`Done when, step ${number}`}
              text={step.note}
              oneLine
              onSave={async (note) => {
                props.onChange({ ...step, note });
                return undefined;
              }}
            >
              <p className={cn('truncate', !step.note && 'text-ink-3')}>
                {step.note || 'Say what done looks like'}
              </p>
            </InPlace>
          </div>
        </div>
      </div>
      <span>
        {!props.onlyStep && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="quiet" size="icon-sm" aria-label={`Actions for step ${number}`}>
                <Ellipsis aria-hidden="true" className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={props.pending} onSelect={() => props.onChange()}>
                Remove step
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </span>
    </li>
  );
}
