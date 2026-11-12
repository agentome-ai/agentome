import { type Db, eq, seats, sql, tasks } from '@agentome/db';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import { ServiceSpec } from '../projects/devcontainer.js';
import { approvedServices } from '../projects/environment.js';
import type { Tx } from '../runs/service.js';
import type { Launcher } from './client.js';

// A person's place is made ready for the project of its next run: the services that project's
// devcontainer asks for, as an admin approved them, run beside the agent before the run is
// handed over. Between runs only, so nothing a run uses changes under it. Sleep clears it.

export const PlaceShape = z.object({
  projectId: z.uuid(),
  hash: z.string(),
  state: z.enum(['preparing', 'ready', 'failed']),
  at: z.iso.datetime(),
  error: z.string().optional(),
});
export type PlaceShape = z.infer<typeof PlaceShape>;

/** A preparation that has not answered in this long is tried again: its process may be gone. */
const PREPARING_MS = 15 * 60_000;
/** A failed one: the runs in between go without the services, and say so in the place's log. */
const FAILED_MS = 15 * 60_000;

/** What a place gets ready for: the project, and its approved services. */
export interface ShapeTarget {
  personId: string;
  seatId: string;
  projectId: string;
  hash: string;
  services: ServiceSpec[];
}

/**
 * Whether a place may take a run of this task now: yes when its project has no approved
 * services, or the place is ready for them (or failed at it lately). Otherwise the place is marked
 * as getting ready, under the seat's lock the caller holds, and the target is returned for the
 * caller to start once its transaction is over.
 */
export async function placeReadyFor(
  tx: Db | Tx,
  seat: { id: string; ownerUserId: string },
  taskId: string | null,
): Promise<{ ready: true; services?: ServiceSpec[] } | { ready: false; start?: ShapeTarget }> {
  if (!taskId) return { ready: true };
  const [task] = await tx
    .select({ projectId: tasks.projectId })
    .from(tasks)
    .where(eq(tasks.id, taskId));
  if (!task?.projectId) return { ready: true };
  const wanted = await approvedServices(tx, task.projectId);
  if (!wanted) return { ready: true };
  const [row] = await tx
    .select({ shape: seats.placeShape })
    .from(seats)
    .where(eq(seats.id, seat.id));
  const parsed = PlaceShape.safeParse(row?.shape);
  const shape = parsed.success ? parsed.data : undefined;
  const same = shape?.projectId === task.projectId && shape.hash === wanted.hash;
  const age = shape ? Date.now() - Date.parse(shape.at) : Infinity;
  if (same && shape.state === 'ready') return { ready: true, services: wanted.services };
  if (same && shape.state === 'failed' && age < FAILED_MS) return { ready: true };
  if (same && shape.state === 'preparing' && age < PREPARING_MS) return { ready: false };
  const next: PlaceShape = {
    projectId: task.projectId,
    hash: wanted.hash,
    state: 'preparing',
    at: new Date().toISOString(),
  };
  await tx.update(seats).set({ placeShape: next }).where(eq(seats.id, seat.id));
  return {
    ready: false,
    start: {
      personId: seat.ownerUserId,
      seatId: seat.id,
      projectId: task.projectId,
      hash: wanted.hash,
      services: wanted.services,
    },
  };
}

/** The place's state, if it still waits for this very target: a later one is not overwritten. */
async function settle(db: Db, target: ShapeTarget, state: 'ready' | 'failed', error?: string) {
  const shape: PlaceShape = {
    projectId: target.projectId,
    hash: target.hash,
    state,
    at: new Date().toISOString(),
    ...(error && { error: error.slice(0, 500) }),
  };
  await db
    .update(seats)
    .set({ placeShape: shape })
    .where(
      sql`${seats.id} = ${target.seatId}
        and ${seats.placeShape}->>'projectId' = ${target.projectId}
        and ${seats.placeShape}->>'hash' = ${target.hash}
        and ${seats.placeShape}->>'state' = 'preparing'`,
    );
}

/** Gets one place at a time ready, in the background: a claim that waits asks again. */
export function placeShaper(db: Db, launcher: Launcher | undefined, log: FastifyBaseLogger) {
  const busy = new Set<string>();
  return (target: ShapeTarget) => {
    if (busy.has(target.seatId)) return;
    busy.add(target.seatId);
    const where = { seatId: target.seatId, projectId: target.projectId };
    const started = Date.now();
    const work = launcher
      ? launcher.services(target.personId, {
          project: target.projectId,
          hash: target.hash,
          services: target.services,
        })
      : Promise.reject(new Error('This installation has no place launcher'));
    void work
      .then(async () => {
        await settle(db, target, 'ready');
        log.info({ ...where, ms: Date.now() - started }, "a place's services are running");
      })
      .catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        log.warn({ ...where, err: error }, "a place's services did not start");
        await settle(db, target, 'failed', message).catch(() => undefined);
      })
      .finally(() => busy.delete(target.seatId));
  };
}

/** Sleep, waking and deleting leave a place with nothing beside the agent. */
export async function clearShape(db: Db, personId: string) {
  await db
    .update(seats)
    .set({ placeShape: null })
    .where(sql`${seats.ownerUserId} = ${personId} and ${seats.kind} = 'subscription-server'`);
}
