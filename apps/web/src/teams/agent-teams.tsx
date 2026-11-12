import { Fragment, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api, asApiError } from '../api';
import { Button } from '../ui/button';
import { FormError } from '../ui/field';
import type { TeamSummary } from './teams-data';
import { NewTeamDialog } from './teams-page';
import { Tint } from '../ui/tint';

/**
 * The agent editor's Team section: the team the agent leads and the ones it is in, each
 * a link to the team's page, where members are added. One that leads none can start one.
 */
export function AgentTeams(props: { agentId: string; agentName: string; owned: boolean }) {
  const [teams, setTeams] = useState<TeamSummary[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    api<{ teams: TeamSummary[] }>('/api/teams').then(
      (data) => setTeams(data.teams),
      (caught: unknown) => setError(asApiError(caught).message),
    );
  }, []);
  if (error) return <FormError>{error}</FormError>;
  if (!teams) return <p className="text-ink-2">Loading teams…</p>;

  const leads = teams.find((team) => team.lead.id === props.agentId);
  const member = teams.filter((team) => team.members.some((m) => m.id === props.agentId));
  const link = (team: TeamSummary) => (
    <Link to={`/teams/${team.id}`} className="font-medium underline underline-offset-2">
      <Tint id={team.id} kind="team" className="mr-1.5" />
      {team.name}
    </Link>
  );
  return (
    <div className="grid max-w-150 gap-3 text-read">
      {leads ? (
        <p>
          Leads {link(leads)}
          {leads.members.length
            ? `, with ${leads.members.map((m) => m.name).join(', ')}.`
            : ', which has no members yet.'}
        </p>
      ) : (
        <p className="text-ink-2">
          {props.agentName} leads no team. A team splits {props.agentName}'s tasks between its
          members, who work at the same time.
        </p>
      )}
      {member.length > 0 && (
        <p>
          In{' '}
          {member.map((team, index) => (
            <Fragment key={team.id}>
              {index > 0 && ', '}
              {link(team)}
            </Fragment>
          ))}
          .
        </p>
      )}
      {!leads && props.owned && (
        <div>
          <NewTeamDialog
            leadId={props.agentId}
            trigger={<Button size="sm">Create a team it leads</Button>}
          />
        </div>
      )}
    </div>
  );
}
