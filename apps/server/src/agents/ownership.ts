import {
  agentGrants,
  agents,
  and,
  type Db,
  eq,
  inArray,
  isNotNull,
  isNull,
  runs,
  sql,
  teamMembers,
  teams,
  users,
} from '@agentome/db';
import { AppError } from '../errors.js';
import { LIVE_RUN_STATUSES, type Tx } from '../runs/service.js';

// Who an agent belongs to, and how that changes: for good, when a person leaves, or until
// a date, for a vacation. The term lives in the grants: the person who has the agent
// for a time holds a grant that ends on the date, and the one it goes back to keeps a grant that
// starts then, so `grantedTo` hands it over by the clock. `agents.owner_user_id`, by which runs
// find a computer and approvals their person, follows within a minute (returnDueAgents).

type AgentRow = typeof agents.$inferSelect;
type Handed = { id: string; name: string };

/** The grant an agent goes back by, if it is with someone for a time: whose, and when. */
async function goingBack(tx: Tx, agentId: string) {
  const [grant] = await tx
    .select({ userId: agentGrants.userId, at: agentGrants.validFrom })
    .from(agentGrants)
    .where(and(eq(agentGrants.agentId, agentId), isNotNull(agentGrants.validFrom)));
  return grant?.at ? { userId: grant.userId, at: grant.at } : undefined;
}

/** A person who can be given agents: one with an account that is not disabled. */
async function recipient(tx: Tx, userId: string) {
  const [person] = await tx
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.disabledAt)));
  if (!person) throw new AppError('validation_failed', 'There is no such person to transfer to');
  return person;
}

/** The agent's for good: the one grant on it is this person's, with no term. */
async function give(tx: Tx, agentId: string, userId: string) {
  await tx.delete(agentGrants).where(eq(agentGrants.agentId, agentId));
  await tx.insert(agentGrants).values({ agentId, userId, level: 'owner' });
  await tx.update(agents).set({ ownerUserId: userId }).where(eq(agents.id, agentId));
}

/** A run that is going keeps its computer and its approvals: nothing changes hands under it. */
async function refuseWhileRunning(tx: Tx, agentIds: string[]) {
  const [live] = await tx
    .select({ name: agents.name })
    .from(runs)
    .innerJoin(agents, eq(agents.id, runs.agentId))
    .where(and(inArray(runs.agentId, agentIds), inArray(runs.status, [...LIVE_RUN_STATUSES])))
    .limit(1);
  if (live) {
    throw new AppError(
      'run_in_progress',
      `${live.name} is running: wait for the run to end, or cancel it, and transfer then`,
    );
  }
}

/**
 * Transfers an agent, and with a lead its whole team: a team is one person's agents, which run on
 * that person's computer, so a member does not go alone. With `until`, the agent comes back to
 * its owner then. An agent that is with someone for a time can only go back early.
 */
export async function transferAgent(
  db: Db,
  agent: AgentRow,
  input: { to: string; until?: Date },
): Promise<{ transferred: Handed[]; to: Handed; until: Date | null }> {
  return db.transaction(async (tx) => {
    const to = await recipient(tx, input.to);
    if (to.id === agent.ownerUserId) {
      throw new AppError('validation_failed', `${agent.name} is ${to.name}'s already`);
    }
    if (input.until && input.until.getTime() <= Date.now()) {
      throw new AppError('validation_failed', 'The day it comes back must be ahead');
    }
    const [inTeam] = await tx
      .select({ lead: agents.name })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .innerJoin(agents, eq(agents.id, teams.leadAgentId))
      .where(eq(teamMembers.agentId, agent.id));
    if (inTeam) {
      throw new AppError(
        'validation_failed',
        `${agent.name} is in ${inTeam.lead}'s team: transfer ${inTeam.lead}, and its team goes with it`,
      );
    }
    const members = await tx
      .select({ id: agents.id, name: agents.name })
      .from(teams)
      .innerJoin(teamMembers, eq(teamMembers.teamId, teams.id))
      .innerJoin(agents, eq(agents.id, teamMembers.agentId))
      .where(eq(teams.leadAgentId, agent.id))
      .orderBy(teamMembers.position);
    const handed = [{ id: agent.id, name: agent.name }, ...members];
    await refuseWhileRunning(
      tx,
      handed.map((one) => one.id),
    );

    const back = await goingBack(tx, agent.id);
    if (back && (back.userId !== to.id || input.until)) {
      const [owner] = await tx
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, back.userId));
      throw new AppError(
        'validation_failed',
        `${agent.name} goes back to ${owner?.name ?? 'its owner'} on ${back.at.toISOString().slice(0, 10)}: until then it can only be returned early`,
      );
    }
    for (const one of handed) {
      if (!input.until) {
        await give(tx, one.id, to.id);
        continue;
      }
      // The owner's grant sleeps until the day; the other person's ends on it.
      await tx
        .update(agentGrants)
        .set({ validFrom: input.until })
        .where(and(eq(agentGrants.agentId, one.id), eq(agentGrants.userId, agent.ownerUserId)));
      await tx
        .insert(agentGrants)
        .values({ agentId: one.id, userId: to.id, level: 'owner', validUntil: input.until });
      await tx.update(agents).set({ ownerUserId: to.id }).where(eq(agents.id, one.id));
    }
    return { transferred: handed, to, until: input.until ?? null };
  });
}

/**
 * Everything a person owns goes to a successor, for when the person leaves. An agent they have
 * for a time goes back to its owner now; one of theirs that is with someone else for a time comes
 * back to the successor instead.
 */
export async function transferAgentsOf(
  db: Db,
  fromUserId: string,
  toUserId: string,
): Promise<{ transferred: Handed[]; returned: Handed[]; to: Handed }> {
  return db.transaction(async (tx) => {
    const to = await recipient(tx, toUserId);
    if (to.id === fromUserId) {
      throw new AppError('validation_failed', 'Choose another person to transfer to');
    }
    const owned = await tx
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(eq(agents.ownerUserId, fromUserId))
      .orderBy(agents.createdAt);
    await refuseWhileRunning(
      tx,
      owned.map((one) => one.id),
    );
    const transferred: Handed[] = [];
    const returned: Handed[] = [];
    for (const one of owned) {
      const back = await goingBack(tx, one.id);
      await give(tx, one.id, back?.userId ?? to.id);
      (back ? returned : transferred).push(one);
    }
    // Theirs, but with someone else until a day: on that day they are the successor's.
    const away = await tx
      .select({ agentId: agentGrants.agentId, holder: agents.ownerUserId })
      .from(agentGrants)
      .innerJoin(agents, eq(agents.id, agentGrants.agentId))
      .where(and(eq(agentGrants.userId, fromUserId), isNotNull(agentGrants.validFrom)));
    for (const { agentId, holder } of away) {
      if (holder === to.id) await give(tx, agentId, to.id);
      else {
        await tx
          .update(agentGrants)
          .set({ userId: to.id })
          .where(and(eq(agentGrants.agentId, agentId), eq(agentGrants.userId, fromUserId)));
      }
    }
    return { transferred, returned, to };
  });
}

/**
 * The agents whose time with someone is up go back to their owners. Run each minute; a run that
 * is going ends where it started.
 */
export async function returnDueAgents(db: Db): Promise<string[]> {
  return db.transaction(async (tx) => {
    const due = await tx
      .select({ agentId: agentGrants.agentId, userId: agentGrants.userId })
      .from(agentGrants)
      .where(and(isNotNull(agentGrants.validFrom), sql`${agentGrants.validFrom} <= now()`));
    for (const { agentId, userId } of due) await give(tx, agentId, userId);
    return due.map((one) => one.agentId);
  });
}
