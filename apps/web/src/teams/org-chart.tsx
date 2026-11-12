import { ChevronRight, Ellipsis } from 'lucide-react';
import { type DragEvent, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { asApiError } from '../api';
import { type AgentSummary, useAgents } from '../agents/agents-data';
import { useMe } from '../session';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { Combobox } from '../ui/combobox';
import * as D from '../ui/dialog';
import * as M from '../ui/dropdown-menu';
import { AgentTile, Tint, tintOf } from '../ui/tint';
import { type ChartNode, chartOf, moveUnder, onChart, removeFrom } from './chart-data';
import { agentLabel, type TeamSummary } from './teams-data';

// Teams as a chart: a lead over its members, a member that leads a team over that team,
// each team's branch ruled in its own colour. Your own agents move by dragging one onto another,
// by + under an agent, or by its menu; others' agents are shown, not changed.

type Dragged = { agentId: string; from: TeamSummary | null };

export function OrgChart(props: { teams: TeamSummary[]; onChanged: () => Promise<void> }) {
  const me = useMe();
  const { agents } = useAgents();
  const [dragged, setDragged] = useState<Dragged>();
  const [over, setOver] = useState<string>();
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [moving, setMoving] = useState<ChartNode>();

  const roots = chartOf(props.teams);
  const shown = onChart(roots);
  const mine = new Set(
    agents
      .filter((agent) => agent.owner.id === me.id && agent.status === 'active')
      .map((agent) => agent.id),
  );
  const free = agents.filter((agent) => mine.has(agent.id) && !shown.has(agent.id));
  const options = (except: string) =>
    agents
      .filter((agent) => mine.has(agent.id) && agent.id !== except)
      .map((agent) => ({ value: agent.id, label: agentLabel(agent) }));
  const nameOf = (id: string) => agents.find((agent) => agent.id === id)?.name ?? 'the agent';

  async function act(what: string, change: () => Promise<unknown>) {
    try {
      await change();
    } catch (caught) {
      toast.error(`Couldn't ${what}`, { description: asApiError(caught).message });
    }
    await props.onChanged();
  }

  const put = (agentId: string, lead: { id: string; name: string }, from: TeamSummary | null) =>
    act(`put ${nameOf(agentId)} under ${lead.name}`, () =>
      moveUnder(agentId, lead, props.teams, from),
    );
  const remove = (node: ChartNode) =>
    node.within &&
    act(`remove ${node.agent.name}`, () => removeFrom(node.agent.id, node.within as TeamSummary));

  /** A drop on an agent of yours puts the dragged one under it. */
  function target(lead: { id: string; name: string }, key: string) {
    const fits = dragged && mine.has(lead.id) && dragged.agentId !== lead.id;
    return {
      onDragOver: (event: DragEvent) => {
        if (!fits) return;
        event.preventDefault();
        setOver(key);
      },
      onDragLeave: () => setOver((was) => (was === key ? undefined : was)),
      onDrop: (event: DragEvent) => {
        event.preventDefault();
        setOver(undefined);
        if (fits) void put(dragged.agentId, lead, dragged.from);
      },
    };
  }

  function source(agentId: string, from: TeamSummary | null) {
    if (!mine.has(agentId)) return {};
    return {
      draggable: true,
      onDragStart: (event: DragEvent) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', agentId);
        setDragged({ agentId, from });
      },
      onDragEnd: () => {
        setDragged(undefined);
        setOver(undefined);
      },
    };
  }

  function row(node: ChartNode) {
    const editable = mine.has(node.agent.id);
    const isFolded = folded.has(node.key);
    const toggle = () =>
      setFolded((was) => {
        const next = new Set(was);
        if (isFolded) next.delete(node.key);
        else next.add(node.key);
        return next;
      });
    return (
      <li key={node.key} className="relative">
        {node.within && (
          <span
            aria-hidden="true"
            className={cn('absolute top-5 -left-4 h-px w-3 bg-current', tintOf(node.within.id))}
          />
        )}
        <div
          {...source(node.agent.id, node.within)}
          {...target(node.agent, node.key)}
          className={cn(
            'group flex h-10 items-center gap-2 rounded-md px-2 hover:bg-hover',
            over === node.key && 'bg-accent-subtle ring-1 ring-accent',
            dragged?.agentId === node.agent.id && 'opacity-50',
            editable && 'cursor-grab active:cursor-grabbing',
          )}
        >
          {node.children.length > 0 ? (
            <button
              type="button"
              aria-label={`${node.agent.name}'s team`}
              aria-expanded={!isFolded}
              onClick={toggle}
              className="-ml-1 grid size-5 place-items-center rounded-sm text-ink-3 hover:text-ink"
            >
              <ChevronRight
                aria-hidden="true"
                className={cn('size-3.5 transition-transform', !isFolded && 'rotate-90')}
              />
            </button>
          ) : (
            <span aria-hidden="true" className="-ml-1 size-5" />
          )}
          <AgentTile id={node.agent.id} name={node.agent.name} className="size-6 text-[10px]" />
          <Link to={`/agents/${node.agent.id}`} className="truncate font-medium hover:underline">
            {node.agent.name}
          </Link>
          {node.agent.roleTitle && (
            <span className="min-w-0 truncate text-ink-3 max-md:hidden">
              {node.agent.roleTitle}
            </span>
          )}
          {node.team && (
            <Link
              to={`/teams/${node.team.id}`}
              className="ml-1 inline-flex shrink-0 items-center gap-1.5 text-small text-ink-2 hover:text-ink"
            >
              <Tint id={node.team.id} kind="team" />
              {node.team.name}
              {isFolded && `, ${node.children.length}`}
            </Link>
          )}
          {editable && (
            <span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 max-lg:opacity-100">
              <Combobox
                trigger="icon"
                options={options(node.agent.id)}
                value={null}
                onValueChange={(id) => {
                  const from = props.teams.find((team) =>
                    team.members.some((member) => member.id === id),
                  );
                  void put(id, node.agent, from ?? null);
                }}
                placeholder={`Put an agent under ${node.agent.name}`}
                searchPlaceholder="Search your agents"
                emptyText="No other agent of yours"
              />
              <M.DropdownMenu>
                <M.DropdownMenuTrigger asChild>
                  <Button
                    variant="quiet"
                    size="icon-sm"
                    aria-label={`Actions for ${node.agent.name}`}
                  >
                    <Ellipsis />
                  </Button>
                </M.DropdownMenuTrigger>
                <M.DropdownMenuContent align="end">
                  <M.DropdownMenuItem onSelect={() => setMoving(node)}>
                    Move under…
                  </M.DropdownMenuItem>
                  {node.team && (
                    <M.DropdownMenuItem asChild>
                      <Link to={`/teams/${node.team.id}`}>Open {node.team.name}</Link>
                    </M.DropdownMenuItem>
                  )}
                  {node.within && (
                    <>
                      <M.DropdownMenuSeparator />
                      <M.DropdownMenuItem variant="danger" onSelect={() => void remove(node)}>
                        Remove from {node.within.name}
                      </M.DropdownMenuItem>
                    </>
                  )}
                </M.DropdownMenuContent>
              </M.DropdownMenu>
            </span>
          )}
        </div>
        {node.team && node.children.length > 0 && !isFolded && (
          <ul className="relative ml-[17px] pl-4">
            {/* The team's branch, in its colour, down to its last member. */}
            <span
              aria-hidden="true"
              className={cn('absolute top-0 bottom-5 left-0 w-px bg-current', tintOf(node.team.id))}
            />
            {node.children.map((child) => row(child))}
          </ul>
        )}
      </li>
    );
  }

  return (
    <div className="grid gap-8">
      {roots.length === 0 ? (
        <p className="text-ink-2">
          No agent leads a team with members yet. Drag one of your agents onto another below, and
          the first leads a team with the second in it.
        </p>
      ) : (
        <ul aria-label="Chart of the teams" className="grid gap-1">
          {roots.map((root) => row(root))}
        </ul>
      )}
      <FreeAgents
        agents={free}
        source={source}
        target={target}
        over={over}
        dragging={dragged}
        onDropHere={() => {
          const from = dragged?.from;
          if (dragged && from) {
            void act(`remove ${nameOf(dragged.agentId)}`, () => removeFrom(dragged.agentId, from));
          }
          setDragged(undefined);
          setOver(undefined);
        }}
      />
      <D.Dialog open={moving !== undefined} onOpenChange={(open) => !open && setMoving(undefined)}>
        <D.DialogContent>
          {moving && (
            <MoveUnder
              node={moving}
              options={options(moving.agent.id)}
              onMove={async (leadId) => {
                setMoving(undefined);
                await put(moving.agent.id, { id: leadId, name: nameOf(leadId) }, moving.within);
              }}
            />
          )}
        </D.DialogContent>
      </D.Dialog>
    </div>
  );
}

/** Your agents in no team: dragged onto the chart, or the place to drop one out of its team. */
function FreeAgents(props: {
  agents: AgentSummary[];
  source: (agentId: string, from: TeamSummary | null) => object;
  target: (lead: { id: string; name: string }, key: string) => object;
  over: string | undefined;
  dragging: Dragged | undefined;
  onDropHere: () => void;
}) {
  const leaving = props.dragging?.from != null;
  return (
    <section
      aria-labelledby="free-agents"
      onDragOver={(event) => leaving && event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        props.onDropHere();
      }}
      className={cn(
        'rounded-lg border border-dashed border-line-strong px-4 py-3',
        leaving && 'border-accent bg-accent-subtle',
      )}
    >
      <h2 id="free-agents" className="mb-2 text-small font-medium text-ink-2">
        Your agents in no team
      </h2>
      {props.agents.length === 0 ? (
        <p className="text-small text-ink-3">
          {leaving
            ? 'Drop here to take it out of its team.'
            : 'Every agent of yours is on the chart.'}
        </p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {props.agents.map((agent) => (
            <li
              key={agent.id}
              {...props.source(agent.id, null)}
              {...props.target(agent, `free/${agent.id}`)}
              className={cn(
                'flex h-8 cursor-grab items-center gap-2 rounded-md border border-line bg-paper px-2 active:cursor-grabbing',
                props.over === `free/${agent.id}` && 'bg-accent-subtle ring-1 ring-accent',
              )}
            >
              <AgentTile id={agent.id} name={agent.name} />
              <span className="font-medium">{agent.name}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function MoveUnder(props: {
  node: ChartNode;
  options: { value: string; label: string }[];
  onMove: (leadId: string) => Promise<void>;
}) {
  const [leadId, setLeadId] = useState<string | null>(null);
  return (
    <form
      noValidate
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (leadId) void props.onMove(leadId);
      }}
    >
      <D.DialogTitle>Move {props.node.agent.name}</D.DialogTitle>
      <D.DialogDescription>
        It joins the team of the agent you pick
        {props.node.within ? ` and leaves ${props.node.within.name}` : ''}. Its own team comes with
        it.
      </D.DialogDescription>
      <Combobox
        options={props.options}
        value={leadId}
        onValueChange={setLeadId}
        placeholder="Pick its new lead"
        searchPlaceholder="Search your agents"
        emptyText="No other agent of yours"
      />
      <D.DialogFooter>
        <D.DialogClose asChild>
          <Button type="button" variant="quiet">
            Cancel
          </Button>
        </D.DialogClose>
        <Button type="submit" variant="primary" disabled={!leadId}>
          Move
        </Button>
      </D.DialogFooter>
    </form>
  );
}
