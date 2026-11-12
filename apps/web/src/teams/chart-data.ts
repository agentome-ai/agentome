import { api } from '../api';
import type { AgentRef, TeamSummary } from './teams-data';

// The teams as one chart: a lead over its members, and a member that leads a team of
// its own over that team in turn. Nothing of its own is stored: it is read from the teams, and
// a change on it is a change of a team's members.

export type ChartNode = {
  agent: AgentRef;
  /** The team this agent leads, if it has members. */
  team: TeamSummary | null;
  /** The team it shows in, under that team's lead; none at the top. */
  within: TeamSummary | null;
  children: ChartNode[];
  /** Unique on the chart: an agent may sit in two teams. */
  key: string;
};

export function chartOf(teams: TeamSummary[]): ChartNode[] {
  const led = new Map(
    teams.filter((team) => team.members.length > 0).map((team) => [team.lead.id, team]),
  );
  const inATeam = new Set(teams.flatMap((team) => team.members.map((member) => member.id)));
  const node = (agent: AgentRef, within: TeamSummary | null, path: string[]): ChartNode => {
    // A circle, which the server refuses, would never end here.
    const team = path.includes(agent.id) ? null : (led.get(agent.id) ?? null);
    const next = [...path, agent.id];
    return {
      agent,
      team,
      within,
      children: team ? team.members.map((member) => node(member, team, next)) : [],
      key: next.join('/'),
    };
  };
  const tops = [...led.values()].filter((team) => !inATeam.has(team.lead.id));
  // A circle has no top: show its teams anyway, each from its own lead.
  const reached = new Set<string>();
  const walk = (one: ChartNode) => {
    if (one.team) reached.add(one.team.id);
    one.children.forEach(walk);
  };
  const roots = tops.map((team) => node(team.lead, null, []));
  roots.forEach(walk);
  for (const team of led.values()) {
    if (!reached.has(team.id)) {
      const root = node(team.lead, null, []);
      walk(root);
      roots.push(root);
    }
  }
  return roots;
}

/** Every agent on the chart, once each. */
export function onChart(roots: ChartNode[]): Set<string> {
  const ids = new Set<string>();
  const walk = (one: ChartNode) => {
    ids.add(one.agent.id);
    one.children.forEach(walk);
  };
  roots.forEach(walk);
  return ids;
}

/** A team's members set, with its manual steps kept to the members it still has. */
function setMembers(team: TeamSummary, members: string[]) {
  const steps = team.steps
    .map((step) => ({ ...step, agents: step.agents.filter((id) => members.includes(id)) }))
    .filter((step) => step.agents.length > 0);
  return api<TeamSummary>(`/api/teams/${team.id}`, {
    method: 'PATCH',
    body: { members, steps },
  });
}

/**
 * Puts an agent under a lead: in the lead's team, which is made ("<lead> team", auto) for its
 * first member, then out of the team it was in. Added first, so a refused move leaves it where
 * it was.
 */
export async function moveUnder(
  agentId: string,
  lead: { id: string; name: string },
  teams: TeamSummary[],
  from: TeamSummary | null,
) {
  const own = teams.find((team) => team.lead.id === lead.id);
  if (own) {
    const members = own.members.map((member) => member.id);
    if (!members.includes(agentId)) await setMembers(own, [...members, agentId]);
  } else {
    await api<TeamSummary>('/api/teams', {
      method: 'POST',
      body: { name: `${lead.name} team`, leadId: lead.id, members: [agentId] },
    });
  }
  if (from && from.id !== own?.id) await removeFrom(agentId, from);
}

export function removeFrom(agentId: string, team: TeamSummary) {
  return setMembers(
    team,
    team.members.map((member) => member.id).filter((id) => id !== agentId),
  );
}
