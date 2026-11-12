import {
  agents,
  and,
  asc,
  type Db,
  eq,
  inArray,
  projectAgents,
  teamMembers,
  teams,
} from '@agentome/db';
import { z } from 'zod';
import { agentFor, duplicateAgent, grantedTo } from '../agents/service.js';
import { checkTeam, TeamBody, writeMembers } from '../agents/team.js';
import { AppError } from '../errors.js';
import { joinTeamProjects } from '../projects/service.js';

// Teams as their own thing: a lead, its members in order, the mode and the steps. Who
// may see a team is who may see its lead; changing it takes what changing the lead's team took.

const AgentRef = z.object({
  id: z.uuid(),
  name: z.string(),
  roleTitle: z.string(),
  status: z.enum(['active', 'archived']),
});

export const TeamSummary = z.object({
  id: z.uuid(),
  name: z.string(),
  mode: z.enum(['auto', 'manual']),
  lead: AgentRef,
  members: z.array(AgentRef),
  steps: TeamBody.shape.steps,
});
export type TeamSummary = z.infer<typeof TeamSummary>;

const Steps = TeamBody.shape.steps;
const ref = ({ id, name, roleTitle, status }: typeof agents.$inferSelect) => ({
  id,
  name,
  roleTitle,
  status,
});

/** The teams whose leads the person may see, by name; with `id`, that one. */
export async function listTeams(db: Db, userId: string, id?: string): Promise<TeamSummary[]> {
  const rows = await db
    .select({ team: teams, lead: agents })
    .from(teams)
    .innerJoin(agents, eq(agents.id, teams.leadAgentId))
    .where(and(grantedTo(userId, teams.leadAgentId), id ? eq(teams.id, id) : undefined))
    .orderBy(asc(teams.name));
  if (rows.length === 0) return [];
  const members = await db
    .select({ teamId: teamMembers.teamId, agent: agents })
    .from(teamMembers)
    .innerJoin(agents, eq(agents.id, teamMembers.agentId))
    .where(
      inArray(
        teamMembers.teamId,
        rows.map(({ team }) => team.id),
      ),
    )
    .orderBy(asc(teamMembers.position));
  return rows.map(({ team, lead }) => ({
    id: team.id,
    name: team.name,
    mode: team.mode,
    lead: ref(lead),
    members: members.filter((row) => row.teamId === team.id).map((row) => ref(row.agent)),
    steps: Steps.catch([]).parse(team.steps),
  }));
}

export async function teamFor(db: Db, id: string, userId: string): Promise<TeamSummary> {
  const [team] = await listTeams(db, userId, id);
  if (!team) throw new AppError('not_found', 'Team not found');
  return team;
}

export const NewTeam = z.object({
  name: z.string().trim().min(1).max(100),
  leadId: z.uuid(),
  mode: z.enum(['auto', 'manual']).default('auto'),
  members: TeamBody.shape.members.default([]),
  steps: TeamBody.shape.steps.default([]),
});

/** One team per lead: a run of the lead must know which team works in it. */
async function assertFreeLead(db: Db, leadId: string, except?: string) {
  const [taken] = await db
    .select({ id: teams.id, name: teams.name, lead: agents.name })
    .from(teams)
    .innerJoin(agents, eq(agents.id, teams.leadAgentId))
    .where(eq(teams.leadAgentId, leadId));
  if (taken && taken.id !== except) {
    throw new AppError('team_lead_taken', `${taken.lead} already leads ${taken.name}`);
  }
}

export async function createTeam(db: Db, userId: string, input: z.infer<typeof NewTeam>) {
  const { lead, members, steps } = await checkTeam(db, input.leadId, userId, input);
  await assertFreeLead(db, lead.id);
  const id = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(teams)
      .values({
        name: input.name,
        leadAgentId: lead.id,
        mode: input.mode,
        steps,
        createdBy: userId,
      })
      .returning({ id: teams.id });
    if (!row) throw new Error('The team was not inserted');
    await writeMembers(tx, row.id, members);
    return row.id;
  });
  // A team made under a lead already working on projects joins them.
  await joinTeamProjects(db, id);
  return teamFor(db, id, userId);
}

// Without NewTeam's defaults: a field left out is a field left as it is.
export const TeamChanges = z.object({
  name: NewTeam.shape.name.optional(),
  leadId: z.uuid().optional(),
  mode: z.enum(['auto', 'manual']).optional(),
  members: TeamBody.shape.members.optional(),
  steps: TeamBody.shape.steps.optional(),
});

/** Renames, gives another lead, mode or steps, or sets the members in their order. */
export async function updateTeam(
  db: Db,
  id: string,
  userId: string,
  changes: z.infer<typeof TeamChanges>,
) {
  const team = await teamFor(db, id, userId);
  const next = {
    leadId: changes.leadId ?? team.lead.id,
    mode: changes.mode ?? team.mode,
    members: changes.members ?? team.members.map((member) => member.id),
    // A member who leaves takes their place in the steps along.
    steps: changes.steps ?? team.steps,
  };
  if (!changes.steps && changes.members) {
    next.steps = next.steps
      .map((step) => ({ ...step, agents: step.agents.filter((a) => next.members.includes(a)) }))
      .filter((step) => step.agents.length > 0);
  }
  const { lead, members, steps } = await checkTeam(db, next.leadId, userId, next);
  await assertFreeLead(db, lead.id, id);
  await db.transaction(async (tx) => {
    await tx
      .update(teams)
      .set({ name: changes.name ?? team.name, leadAgentId: lead.id, mode: next.mode, steps })
      .where(eq(teams.id, id));
    await writeMembers(tx, id, members);
  });
  await joinTeamProjects(db, id);
  return teamFor(db, id, userId);
}

export async function deleteTeam(db: Db, id: string, userId: string) {
  const team = await teamFor(db, id, userId);
  // Changing the team takes access to its lead, as setting it in the lead's editor did.
  await agentFor(db, team.lead.id, userId);
  await db.delete(teams).where(eq(teams.id, id));
}

/**
 * A copy of the team with copies of its agents, owned by the person copying: their
 * configuration, not their memory, tasks or runs. An admin's copies join the projects
 * the originals are in; a member's join none, as only an admin assigns projects.
 */
export async function duplicateTeam(
  db: Db,
  id: string,
  user: { id: string; role: 'admin' | 'member' },
) {
  const team = await teamFor(db, id, user.id);
  // An archived member is not copied: a team is of active agents.
  const members = team.members.filter((member) => member.status === 'active');
  const originals = [team.lead, ...members];
  const copies = new Map<string, string>();
  for (const original of originals) {
    const source = await agentFor(db, original.id, user.id);
    const copy = await duplicateAgent(db, source, user.id);
    copies.set(original.id, copy.id);
    if (user.role === 'admin') {
      const projects = await db
        .select({ projectId: projectAgents.projectId })
        .from(projectAgents)
        .where(eq(projectAgents.agentId, original.id));
      if (projects.length > 0) {
        await db
          .insert(projectAgents)
          .values(projects.map(({ projectId }) => ({ projectId, agentId: copy.id })));
      }
    }
  }
  const copyOf = (agentId: string) => copies.get(agentId) ?? '';
  return createTeam(db, user.id, {
    name: `${team.name.slice(0, 93)} (copy)`,
    leadId: copyOf(team.lead.id),
    mode: team.mode,
    members: members.map((member) => copyOf(member.id)),
    steps: team.steps
      .map((step) => ({ ...step, agents: step.agents.map(copyOf).filter(Boolean) }))
      .filter((step) => step.agents.length > 0),
  });
}
