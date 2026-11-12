// The teams API as the pages read it.

export type AgentRef = {
  id: string;
  name: string;
  roleTitle: string;
  status: 'active' | 'archived';
};

export type TeamMode = 'auto' | 'manual';
export type TeamStep = { agents: string[]; note: string };

export type TeamSummary = {
  id: string;
  name: string;
  mode: TeamMode;
  lead: AgentRef;
  members: AgentRef[];
  steps: TeamStep[];
};

export type TeamChanges = Partial<{
  name: string;
  leadId: string;
  mode: TeamMode;
  members: string[];
  steps: TeamStep[];
}>;

export const modeLabel: Record<TeamMode, string> = {
  auto: 'The lead decides',
  manual: 'Steps',
};

/** An agent in a picker: its name, and its role when that says something more. */
export function agentLabel(agent: { name: string; roleTitle: string }): string {
  const role = agent.roleTitle.trim();
  return role && role.toLowerCase() !== agent.name.trim().toLowerCase()
    ? `${agent.name}, ${role}`
    : agent.name;
}
