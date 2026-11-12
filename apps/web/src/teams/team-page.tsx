import { Copy, Ellipsis, UsersRound } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { type ApiError, api, asApiError } from '../api';
import { type Agent, useAgents } from '../agents/agents-data';
import { ApiErrorState } from '../session';
import { frame, PageHeader } from '../shell/page-header';
import { LoadingState } from '../shell/states';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { Combobox } from '../ui/combobox';
import * as D from '../ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { FormError } from '../ui/field';
import { InPlace } from '../ui/in-place';
import { AgentTile, tintOf } from '../ui/tint';
import { TeamEditor } from './team-editor';
import { agentLabel, type TeamChanges, type TeamSummary } from './teams-data';

/**
 * /teams/:id: a team's name, lead and members, copied or removed whole, read as
 * Linear's page: the name in place, its fields as chips, its members and steps as
 * lists.
 */
export function TeamPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { agents } = useAgents();
  const [team, setTeam] = useState<TeamSummary>();
  // The lead as its editor has it: whose agents may join, and its team_step policy.
  const [lead, setLead] = useState<Agent>();
  const [error, setError] = useState<ApiError>();
  const [failed, setFailed] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(undefined);
    try {
      const next = await api<TeamSummary>(`/api/teams/${id}`);
      setTeam(next);
      setLead(await api<Agent>(`/api/agents/${next.lead.id}`));
    } catch (caught) {
      setError(asApiError(caught));
    }
  }, [id]);
  useEffect(() => void load(), [load]);

  /** Changes the name or the lead; answers why it could not. */
  async function change(changes: TeamChanges) {
    setFailed(undefined);
    try {
      const next = await api<TeamSummary>(`/api/teams/${id}`, { method: 'PATCH', body: changes });
      setTeam(next);
      if (changes.leadId) setLead(await api<Agent>(`/api/agents/${next.lead.id}`));
      return undefined;
    } catch (caught) {
      const message = asApiError(caught).message;
      if (!changes.name) setFailed(message);
      return message;
    }
  }

  async function duplicate() {
    setBusy(true);
    setFailed(undefined);
    try {
      const copy = await api<TeamSummary>(`/api/teams/${id}/duplicate`, { method: 'POST' });
      await navigate(`/teams/${copy.id}`);
    } catch (caught) {
      setFailed(asApiError(caught).message);
    } finally {
      setBusy(false);
    }
  }

  const header = (title: string, actions?: React.ReactNode, heading?: React.ReactNode) => (
    <PageHeader
      title={title}
      width="read"
      crumbs={[{ label: 'Teams', to: '/teams' }]}
      actions={actions}
      ownHeading={heading}
    />
  );
  if (error) {
    return (
      <>
        {header('Team')}
        <div className={cn(frame.read, 'pt-8')}>
          <ApiErrorState title="Couldn't load the team" error={error} onRetry={load} />
        </div>
      </>
    );
  }
  if (!team || !lead) {
    return (
      <>
        {header('Team')}
        <LoadingState label="Loading the team" />
      </>
    );
  }

  // Another lead: one of the same owner's active agents, so the members can stay.
  const leads = agents
    .filter(
      (agent) =>
        agent.status === 'active' &&
        agent.owner.id === lead.owner.id &&
        !team.members.some((member) => member.id === agent.id),
    )
    .map((agent) => ({
      value: agent.id,
      label: agentLabel(agent),
    }));
  const policy = lead.tools.find((tool) => tool.name === 'team_step')?.policy;

  const heading = (
    <div className="grid justify-items-start gap-3.5">
      <span
        aria-hidden="true"
        className={cn(
          'grid size-9 place-items-center rounded-lg border border-current/25 bg-current/10',
          tintOf(team.id),
        )}
      >
        <UsersRound className="size-4.5" />
      </span>
      <InPlace
        label="Name"
        text={team.name}
        oneLine
        fieldClassName="text-name"
        heading
        onSave={(next) => (next ? change({ name: next }) : Promise.resolve('A team needs a name.'))}
      >
        <h1 className="text-name">{team.name}</h1>
      </InPlace>
    </div>
  );
  const leadChip = (
    <Combobox
      value={team.lead.id}
      options={leads}
      trigger="chip"
      face={
        <>
          <AgentTile id={team.lead.id} name={team.lead.name} className="size-4.5" />
          <span className="truncate">
            <span className="text-ink-3">Lead</span> {team.lead.name}
          </span>
        </>
      }
      placeholder={`Lead: ${team.lead.name}`}
      searchPlaceholder="Search agents"
      emptyText="No other agent of this owner"
      onValueChange={(leadId) => leadId !== team.lead.id && void change({ leadId })}
    />
  );

  return (
    <>
      {header(
        team.name,
        <>
          <Button disabled={busy} onClick={() => void duplicate()}>
            <Copy aria-hidden="true" className="size-3.5" />
            {busy ? 'Copying…' : 'Duplicate'}
          </Button>
          <TeamMenu team={team} />
        </>,
        heading,
      )}
      <div className={cn(frame.read, 'grid grid-cols-[minmax(0,1fr)] gap-4.5 pt-1.5 pb-24')}>
        <p className="max-w-170 text-read text-ink-2">
          A task given to{' '}
          <Link to={`/agents/${team.lead.id}`} className="text-ink">
            {team.lead.name}
          </Link>{' '}
          is split between the members, who work at the same time. Duplicate copies the team with
          copies of its agents, without their memory.
        </p>
        <TeamEditor
          team={team}
          ownerId={lead.owner.id}
          policy={policy}
          leadChip={leadChip}
          onSaved={setTeam}
        />
        {failed && <FormError>{failed}</FormError>}
      </div>
    </>
  );
}

/** The team's other actions: Delete, asked first; the agents stay, the team and its order go. */
function TeamMenu({ team }: { team: TeamSummary }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  async function remove() {
    setPending(true);
    setError(undefined);
    try {
      await api(`/api/teams/${team.id}`, { method: 'DELETE' });
      setOpen(false);
      await navigate('/teams');
    } catch (caught) {
      setError(asApiError(caught).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <D.Dialog open={open} onOpenChange={setOpen}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="quiet" size="icon" aria-label="More actions">
            <Ellipsis aria-hidden="true" className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem variant="danger" onSelect={() => setOpen(true)}>
            Delete team…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <D.DialogContent>
        <D.DialogTitle>Delete {team.name}?</D.DialogTitle>
        <D.DialogDescription>
          {team.lead.name} works alone again. The agents stay, with their memory, tasks and runs.
        </D.DialogDescription>
        {error && <FormError>{error}</FormError>}
        <D.DialogFooter>
          <D.DialogClose asChild>
            <Button variant="secondary">Cancel</Button>
          </D.DialogClose>
          <Button variant="danger" disabled={pending} onClick={() => void remove()}>
            Delete team
          </Button>
        </D.DialogFooter>
      </D.DialogContent>
    </D.Dialog>
  );
}
