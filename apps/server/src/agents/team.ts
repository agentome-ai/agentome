import { agents, asc, type Db, eq, inArray, teamMembers, teams } from '@agentome/db';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { skillsOf } from '../library/skills.js';
import { currentMemory } from '../memory/service.js';
import type { LaunchPackage } from '../protocol.js';
import type { Tx } from '../runs/service.js';
import { hashSecret, newToken } from '../tokens.js';
import { agentFor } from './service.js';

// A lead agent's team: agents its owner put beside it, which its runs call as
// subagents of the one `claude` process on the owner's computer. Auto lets the lead decide who
// works when; manual holds it to the owner's steps, and each step waits for the owner unless the
// lead's `team_step` policy says otherwise. The team is a row of `teams`, its members rows of
// `team_members`; this module reads and checks it, teams/ serves it.

const Note = z.string().trim().max(1000);

export const TeamBody = z
  .object({
    mode: z.enum(['auto', 'manual']),
    members: z.array(z.uuid()).max(10),
    steps: z.array(z.object({ agents: z.array(z.uuid()).min(1).max(10), note: Note })).max(10),
  })
  .describe('An empty member list removes the team');
export type Team = z.infer<typeof TeamBody>;

const Steps = TeamBody.shape.steps;

/** The team the agent leads, with its row's id and name; null for none or one without members. */
export async function teamOfLead(db: Db, leadId: string) {
  const [team] = await db.select().from(teams).where(eq(teams.leadAgentId, leadId));
  if (!team) return null;
  const members = await db
    .select({ agentId: teamMembers.agentId })
    .from(teamMembers)
    .where(eq(teamMembers.teamId, team.id))
    .orderBy(asc(teamMembers.position));
  if (members.length === 0) return null;
  return {
    id: team.id,
    name: team.name,
    mode: team.mode,
    members: members.map((member) => member.agentId),
    steps: Steps.catch([]).parse(team.steps),
  };
}

async function membersOf(db: Db, team: Team) {
  const rows = await db.select().from(agents).where(inArray(agents.id, team.members));
  // In the team's order, which is the order the lead reads them in.
  return team.members.flatMap((id) => rows.filter((row) => row.id === id));
}

/**
 * Checks a team. Members are the lead owner's own active agents, which run on that owner's
 * computer, and ones the person setting the team may edit; manual needs steps, each of members
 * only. Gives the members once each and the steps the mode keeps.
 */
export async function checkTeam(db: Db, leadId: string, userId: string, body: Team) {
  const lead = await agentFor(db, leadId, userId);
  const members = [...new Set(body.members)];
  if (members.includes(lead.id)) {
    throw new AppError('validation_failed', 'An agent cannot be in its own team');
  }
  for (const id of members) {
    const member = await agentFor(db, id, userId);
    if (member.ownerUserId !== lead.ownerUserId || member.status !== 'active') {
      throw new AppError(
        'validation_failed',
        `${member.name} cannot join: a team is made of its lead's owner's active agents, which run on that owner's computer`,
      );
    }
  }
  // A team under one of the members that the lead leads in turn would make a circle.
  if ((await agentsUnder(db, members)).has(lead.id)) {
    throw new AppError(
      'validation_failed',
      `This would put ${lead.name} under itself: one of these agents leads a team ${lead.name} is already under`,
    );
  }
  const steps = body.mode === 'manual' ? body.steps : [];
  if (body.mode === 'manual' && members.length > 0 && steps.length === 0) {
    throw new AppError('validation_failed', 'Manual mode needs at least one step');
  }
  if (steps.some((step) => step.agents.some((id) => !members.includes(id)))) {
    throw new AppError('validation_failed', 'Every agent of a step must be in the team');
  }
  return { lead, members, steps };
}

/** The agents under these, through the teams each leads and the teams under those. */
export async function agentsUnder(db: Db, agentIds: string[]) {
  const seen = new Set<string>();
  let leads = agentIds;
  while (leads.length > 0) {
    const rows = await db
      .select({ agentId: teamMembers.agentId })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .where(inArray(teams.leadAgentId, leads));
    leads = [...new Set(rows.map((row) => row.agentId))].filter((id) => !seen.has(id));
    for (const id of leads) seen.add(id);
  }
  return seen;
}

/** Those of these agents that lead a team with members: they take work by `assign_task`. */
export async function leadsAmong(db: Db, agentIds: string[]) {
  if (agentIds.length === 0) return new Set<string>();
  const rows = await db
    .selectDistinct({ leadId: teams.leadAgentId })
    .from(teams)
    .innerJoin(teamMembers, eq(teamMembers.teamId, teams.id))
    .where(inArray(teams.leadAgentId, agentIds));
  return new Set(rows.map((row) => row.leadId));
}

/** The leads under a lead: its team's active members that lead teams of their own. */
export async function reportsOf(db: Db, leadId: string) {
  const team = await teamOfLead(db, leadId);
  if (!team) return [];
  const leads = await leadsAmong(db, team.members);
  const members = await db.select().from(agents).where(inArray(agents.id, team.members));
  return team.members.flatMap(
    (id) => members.find((row) => row.id === id && row.status === 'active' && leads.has(id)) ?? [],
  );
}

/** Writes a team's members in order, replacing the ones it had. */
export async function writeMembers(db: Db | Tx, teamId: string, members: string[]) {
  await db.delete(teamMembers).where(eq(teamMembers.teamId, teamId));
  if (members.length > 0) {
    await db
      .insert(teamMembers)
      .values(members.map((agentId, position) => ({ teamId, agentId, position })));
  }
}

/** A team member's subagent name: ASCII, unique in the team, and part of its gateway server's. */
export function keysOf(names: string[]): string[] {
  const taken = new Set<string>();
  return names.map((name) => {
    const base =
      name
        .normalize('NFKD')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 30) || 'agent';
    let key = base;
    for (let n = 2; taken.has(key); n++) key = `${base}-${n}`;
    taken.add(key);
    return key;
  });
}

/** The gateway server a member's tools come from, so the gateway knows which agent calls. */
export const memberServer = (key: string) => `agentome-${key}`;

/** The run's record of its team: who each member token belongs to, and the steps. */
export const RunTeam = z.object({
  mode: z.enum(['auto', 'manual']),
  members: z.array(z.object({ agentId: z.uuid(), key: z.string(), tokenHash: z.string() })),
});
export type RunTeam = z.infer<typeof RunTeam>;

/**
 * What a team run adds to its launch package: each member with its own gateway token, prompt,
 * skills and memory, and the steps by member key; plus the run's record and the lead's section.
 */
export async function teamForRun(db: Db, leadId: string) {
  const team = await teamOfLead(db, leadId);
  if (!team) return null;
  // An archived member stays out of the run; its steps go on without it. A member that leads a
  // team of its own is no subagent: its team would not come along, so it takes work down.
  const active = (await membersOf(db, team)).filter((member) => member.status === 'active');
  const leads = await leadsAmong(
    db,
    active.map((member) => member.id),
  );
  const reports = active.filter((member) => leads.has(member.id));
  const members = active.filter((member) => !leads.has(member.id));
  if (members.length === 0) {
    return reports.length > 0
      ? { launch: null, record: null, section: reportsSection(reports) }
      : null;
  }
  const keys = keysOf(members.map((member) => member.name));
  const built = await Promise.all(
    members.map(async (member, index) => {
      const key = keys[index] ?? 'agent';
      const { token, hash } = newToken();
      const skills = (await skillsOf(db, member.skills)).map(({ name, version, content }) => ({
        name,
        version,
        content,
      }));
      const memoryDocuments = (await currentMemory(db, member.id)).map(
        ({ path, version, content }) => ({ path, version, content }),
      );
      return {
        hash,
        member: {
          key,
          agentId: member.id,
          name: member.name,
          description: member.roleTitle.trim() || member.name,
          prompt: memberPrompt(member, key, skills),
          modelPref: member.modelPref,
          token,
          skills,
          memoryDocuments,
        },
      };
    }),
  );
  const keyOf = new Map(built.map(({ member }) => [member.agentId, member.key]));
  const steps = team.steps
    .map((step) => ({
      members: step.agents.flatMap((id) => keyOf.get(id) ?? []),
      note: step.note,
    }))
    .filter((step) => step.members.length > 0);
  const launch: NonNullable<LaunchPackage['team']> = {
    mode: team.mode,
    members: built.map(({ member }) => member),
    steps,
  };
  const record: RunTeam = {
    mode: team.mode,
    members: built.map(({ member, hash }) => ({
      agentId: member.agentId,
      key: member.key,
      tokenHash: hash,
    })),
  };
  return { launch, record, section: teamSection(launch) + reportsSection(reports) };
}

/** The member a token belongs to in a run's team record, if any. */
export function memberOf(record: unknown, token: string) {
  const team = RunTeam.safeParse(record);
  if (!team.success) return undefined;
  const hash = hashSecret(token);
  return team.data.members.find((member) => member.tokenHash === hash);
}

type MemberSource = { name: string; roleTitle: string; instructions: string };

function memberPrompt(
  member: MemberSource,
  key: string,
  skills: { name: string; content: string }[],
): string {
  const role = member.roleTitle.trim() ? `, ${member.roleTitle.trim()}` : '';
  const tools = `mcp__${memberServer(key)}__`;
  const skillLines = skills.map(({ name, content }) => {
    const description = /^description:\s*(.+)$/m.exec(content)?.[1]?.trim() ?? '';
    return `- **${name}** (team/${key}/skills/${name}/SKILL.md): ${description}`;
  });
  return `You are ${member.name}${role}, an agent of this company on Agentome, working in a team on one task. The team's lead gives you your assignment; you do not see the lead's conversation.

## Instructions

${member.instructions.trim() || 'Your owner has not written instructions yet. Follow the assignment.'}

## Working in the team

- The team shares this workspace and its branch. Commit your work there; the lead pushes and opens the change request unless your assignment says otherwise.
- Your Agentome tools are the ones named ${tools}*. Use only those: they act as you.
- Your memory is in team/${key}/ of the profile folder: MEMORY.md and memory/*.md, as it was when the run started. Read it first; write a whole document with ${tools}memory_write, giving the version you read.
- Finish with a short report: what you did, where the result is (files, commits), and what is left.
${skillLines.length > 0 ? `\n## Skills\n\nWhen the assignment calls for one, read its SKILL.md in the profile folder first and follow it.\n\n${skillLines.join('\n')}\n` : ''}`;
}

function reportsSection(reports: { name: string; roleTitle: string }[]): string {
  if (reports.length === 0) return '';
  const lines = reports.map(
    (report) =>
      `- **${report.name}**${report.roleTitle.trim() ? `: ${report.roleTitle.trim()}` : ''}`,
  );
  return `\n## Teams under you\n\nThese agents lead teams of their own. Hand them work with Agentome's assign_task tool, naming the agent, never with the Agent tool: each gets its own task and run with its team, and you do not wait for it. Write each assignment so it stands alone: the goal, what to hand back and the limits. Once you have assigned, say in your reply what went to whom and end your turn. When every task you assigned has ended, Agentome runs you again on this task with their reports.\n\n${lines.join('\n')}\n`;
}

function teamSection(team: NonNullable<LaunchPackage['team']>): string {
  const members = team.members.map(
    (member) => `- **${member.key}**: ${member.name}, ${member.description}`,
  );
  const order =
    team.mode === 'auto'
      ? 'You decide who works on what, and when. Once your first assignments have reported, the work after them may wait for your owner to approve it, once per task: before you give it, write in your reply what they found and what comes next, since your owner reads that to decide.'
      : `Your owner set the order. Follow these steps; a step opens once every agent of the step before has reported. You may send work back to an agent of an earlier step.\n\n${team.steps
          .map(
            (step, index) =>
              `${index + 1}. ${step.members.join(', ')}${step.note ? `. Done when: ${step.note}` : ''}`,
          )
          .join('\n')}`;
  return `\n## Your team\n\nYou lead these agents on this task. Give one work with the Agent tool, \`subagent_type\` set to its key. They do not see this conversation: each assignment names the goal, what to hand back (files, commits on this branch) and the limits. An assignment returns the agent's report; give several in one message and they work at the same time, so split the work by files when they share the branch. When Agentome refuses an assignment, do not retry it: read why and do what it says.\n\n${members.join('\n')}\n\n${order}\n`;
}
