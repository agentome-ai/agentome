import {
  agents,
  and,
  type Db,
  eq,
  inArray,
  isNotNull,
  max,
  runs,
  seats,
  users,
} from '@agentome/db';
import type { FastifyBaseLogger } from 'fastify';
import { isLive, placeMayRun } from '../runs/service.js';
import type { Launcher } from './client.js';
import { clearShape } from './shape.js';

// Once a minute: a place that sleeps wakes when one of its person's agents has a run queued and
// the place may run it (its person is at work, or let it work while they are away); a place that is awake goes to sleep when nothing has run in it, and nothing
// has started it, for its person's idle time. Asleep, a place costs its volumes only.

/** What a place may hold on Docker, whose volumes have no size: past it, it sleeps. */
export const overDisk = (diskBytes: number | undefined, limitBytes: number) =>
  diskBytes !== undefined && diskBytes > limitBytes;

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

/** Why a place sleeps for its disk, in words its person can act on. */
export const diskFull = (diskBytes: number, limitBytes: number) =>
  `Your place holds ${gb(diskBytes)} of its ${gb(limitBytes)}. Empty an agent's folders, then wake it.`;

export async function tendPlaces(
  db: Db,
  launcher: Launcher,
  log: FastifyBaseLogger,
  diskLimitBytes = Number.POSITIVE_INFINITY,
) {
  const places = await db
    .select({
      id: seats.id,
      ownerUserId: seats.ownerUserId,
      idleMinutes: seats.idleMinutes,
      createdAt: seats.createdAt,
      disabledAt: users.disabledAt,
    })
    .from(seats)
    .innerJoin(users, eq(users.id, seats.ownerUserId))
    .where(and(eq(seats.kind, 'subscription-server'), eq(seats.status, 'active')));
  for (const place of places) {
    try {
      const { state, startedAt, terminals, diskBytes } = await launcher.status(place.ownerUserId);
      if (state === 'none') continue;
      // A place that holds more than it may sleeps, its run with it, and is not woken until its
      // person empties an agent's folders: a run must not fill the disk the database is on.
      if (overDisk(diskBytes, diskLimitBytes)) {
        if (state !== 'asleep') {
          await launcher.sleep(place.ownerUserId);
          await clearShape(db, place.ownerUserId);
          log.warn(
            { seatId: place.id, diskBytes },
            'put a place on the server to sleep: it holds more than it may',
          );
        }
        continue;
      }
      // A disabled person's place sleeps and is not woken: their run, if one went, was stopped
      // with their sessions. The volumes stay until an admin deletes the place or enables them.
      if (place.disabledAt) {
        if (state !== 'asleep') {
          await launcher.sleep(place.ownerUserId);
          await clearShape(db, place.ownerUserId);
          log.info(
            { seatId: place.id },
            'put a place on the server to sleep: its person is disabled',
          );
        }
        continue;
      }
      const [queued] = await db
        .select({ id: runs.id })
        .from(runs)
        .innerJoin(agents, eq(agents.id, runs.agentId))
        .where(
          and(
            eq(runs.status, 'queued'),
            eq(agents.ownerUserId, place.ownerUserId),
            eq(agents.runsOn, 'laptop'),
            eq(agents.status, 'active'),
          ),
        )
        .limit(1);
      // A place found asleep has nothing running beside its agent.
      if (state === 'asleep') await clearShape(db, place.ownerUserId);
      if (state === 'asleep') {
        if (queued && (await placeMayRun(db, place))) {
          await launcher.wake(place.ownerUserId);
          log.info({ seatId: place.id }, 'woke a place on the server: its person has a run queued');
        }
        continue;
      }
      const [live] = await db
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.seatId, place.id), isLive()))
        .limit(1);
      // Its person has a terminal open in it, or it has work: it stays awake.
      if (terminals > 0 || live || (queued && (await placeMayRun(db, place)))) continue;
      const [last] = await db
        .select({ endedAt: max(runs.endedAt) })
        .from(runs)
        .where(and(eq(runs.seatId, place.id), isNotNull(runs.endedAt)));
      const busyAt = Math.max(
        place.createdAt.getTime(),
        last?.endedAt?.getTime() ?? 0,
        startedAt ? Date.parse(startedAt) : 0,
      );
      if (Date.now() - busyAt > place.idleMinutes * 60_000) {
        await launcher.sleep(place.ownerUserId);
        await clearShape(db, place.ownerUserId);
        log.info({ seatId: place.id }, 'put a place on the server to sleep: nothing ran in it');
      }
    } catch (error) {
      log.warn({ err: error, seatId: place.id }, 'could not tend a place on the server');
    }
  }
}

/**
 * Deletes the containers of runs in places that the server closed itself: a seat that fell
 * silent, a stop or a time limit it did not keep. Their worker asks for this at a run's end;
 * one that died never will, and its CLI container, with the person's sign-in, and its sandbox,
 * with the agent's processes, would live until the place slept, beside the next run's folder.
 */
export async function endClosedRuns(
  db: Db,
  launcher: Launcher,
  runIds: string[],
  log: FastifyBaseLogger,
): Promise<void> {
  if (runIds.length === 0) return;
  const inPlaces = await db
    .select({ id: runs.id, owner: seats.ownerUserId })
    .from(runs)
    .innerJoin(seats, eq(seats.id, runs.seatId))
    .where(and(inArray(runs.id, runIds), eq(seats.kind, 'subscription-server')));
  for (const run of inPlaces) {
    if (!run.owner) continue;
    try {
      await launcher.endRun(run.owner, run.id);
      log.info({ runId: run.id }, "deleted the containers of a place's run the server closed");
    } catch (error) {
      log.warn({ err: error, runId: run.id }, "could not delete a closed run's containers");
    }
  }
}
