import { setTimeout as sleep } from 'node:timers/promises';
import {
  agents,
  type Db,
  engineEnum,
  pairingCodes,
  runs,
  seats,
  seatStatusEnum,
  users,
} from '@agentome/db';
import { SeatKind } from '@agentome/shared';
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireUser, browserOnly } from '../auth.js';
import type { Config } from '../config.js';
import { connectCommand, updateCommand } from '../connect.js';
import { windowsConnectCommand, windowsUpdateCommand } from '../connect.js';
import { AppError } from '../errors.js';
import {
  ClaimQuery,
  IdParams,
  LaunchPackage,
  Name,
  noStore,
  PairBody,
  PairResponse,
} from '../protocol.js';
import {
  claimRun,
  LIVE_RUN_STATUSES,
  ownerPresent,
  requestStop,
  type Tx,
} from '../runs/service.js';
import {
  bearerToken,
  hashSecret,
  newPairingCode,
  newToken,
  normalizePairingCode,
} from '../tokens.js';
import type { Jobs } from '../jobs.js';
import { tellJira } from '../jira/push.js';
import type { Launcher } from '../places/client.js';
import { PlaceShape, placeShaper } from '../places/shape.js';
import { tagLog } from '../logs/context.js';
import { storeWorkerLines } from '../logs/service.js';

const PAIRING_CODE_MINUTES = 10;
// A waiting claim reads the queue this often: a second of latency, one indexed query.
const CLAIM_POLL_MS = 1000;
// last_seen_at is for people, so it is written at most this often per seat.
const SEEN_EVERY_MS = 30_000;

const iso = (date: Date | null) => date?.toISOString() ?? null;

/** Minutes without a person at the computer after which it takes no runs: 5 to 120. */
const IdleMinutes = z.int().min(5).max(120);
/** How the worker learns the seat's idle time: on every claim answer, 200 and 204 alike. */
export const IDLE_MINUTES_HEADER = 'x-agentome-idle-minutes';
/**
 * On a claim answer with no run: `sandbox`, a Windows computer no admin has allowed yet;
 * `presence`, a place whose person is away; `services`, a place getting its run's services ready.
 */
export const WAITING_HEADER = 'x-agentome-waiting';

/** Whether a seat runs the agent's commands without a sandbox: a computer on Windows. */
const unsandboxed = (seat: { kind: string; capabilities: { platform?: string } }) =>
  seat.kind === 'subscription-laptop' && seat.capabilities.platform === 'win32';

const SeatView = z.object({
  id: z.uuid(),
  name: z.string(),
  /** Whose computer it is: the person who connected it. */
  owner: z.object({ id: z.uuid(), name: z.string() }),
  kind: SeatKind,
  status: z.enum(seatStatusEnum.enumValues),
  lastSeenAt: z.iso.datetime().nullable(),
  idleMinutes: IdleMinutes,
  activeRun: z
    .object({ id: z.uuid(), agentName: z.string(), startedAt: z.iso.datetime().nullable() })
    .nullable(),
  /**
   * What to run on the computer when its worker is not the build this server hands out; null
   * when it is, or when there is nothing to compare. The server never sends a worker itself.
   */
  updateCommand: z.string().nullable(),
  /** The engines that said at the seat's last claim that they are not signed in on it. */
  signedOut: z.array(z.enum(engineEnum.enumValues)),
  /** The system its worker named at its last claim, as Node names it; null before one. */
  platform: z.string().nullable(),
  /**
   * Whether it runs the agent's commands without a sandbox (Windows), and since when an admin
   * has allowed that: until then it takes no runs.
   */
  sandbox: z.object({ none: z.boolean(), allowedAt: z.iso.datetime().nullable() }),
});

const PairingCode = z.object({
  code: z.string(),
  expiresAt: z.iso.datetime(),
  // What the person pastes into a terminal on the computer: the one-line installer of
  // connect.ts, or the worker's own command for a server without the bundle (one run from a
  // checkout), which runs in a checkout of the repository. The server cannot know where that
  // is, so there is no `cd`; `checkout` tells which of the two it is.
  command: z.string(),
  /** The same in PowerShell, for a Windows computer; null where `command` is a checkout's. */
  windowsCommand: z.string().nullable(),
  checkout: z.boolean(),
});

export const seatRoutes: FastifyPluginAsyncZod<{
  db: Db;
  config: Config;
  jobs: Pick<Jobs, 'fileJira'>;
  /** The SHA-256 of the worker this server hands out at /connect; nothing when it has none. */
  bundle: string | undefined;
  /** People's places on the server, made ready for their next run's services. */
  placeLauncher: Launcher | undefined;
}> = async (app, { db, config, jobs, bundle, placeLauncher }) => {
  const shape = placeShaper(db, placeLauncher, app.log);
  const bundled = bundle !== undefined;
  const server = config.publicUrl.replace(/\/+$/, '');
  /** The seats as people see them, each with the command that updates an older worker. */
  const list = async (userId: string | null, seatId?: string) =>
    (await listSeats(db, userId, seatId)).map(({ worker, ...seat }) => ({
      ...seat,
      updateCommand: outdated(seat, worker, bundle)
        ? seat.kind !== 'subscription-laptop'
          ? SEAT_IMAGE_COMMAND
          : seat.platform === 'win32'
            ? windowsUpdateCommand(server)
            : updateCommand(server)
        : null,
    }));
  app.addHook('onSend', noStore);
  // preClose runs before Fastify waits for requests in flight: without it, shutdown would
  // wait out every long poll.
  const closing = new AbortController();
  app.addHook('preClose', async () => closing.abort());

  app.post(
    '/api/seats/pairing-codes',
    {
      schema: {
        summary: 'Creates a code that connects a computer',
        response: { 201: PairingCode },
      },
    },
    async (request, reply) => {
      const user = await requireUser(db, request);
      // A code becomes a seat token, which would outlive the personal token that made it.
      browserOnly(request);
      const code = newPairingCode();
      const expiresAt = new Date(Date.now() + PAIRING_CODE_MINUTES * 60_000);
      await db
        .insert(pairingCodes)
        .values({ codeHash: hashSecret(code), createdBy: user.id, expiresAt });
      return reply.code(201).send({
        code,
        expiresAt: expiresAt.toISOString(),
        command: connectCommand(server, code, bundled),
        windowsCommand: bundled ? windowsConnectCommand(server, code) : null,
        checkout: !bundled,
      });
    },
  );

  app.post(
    '/api/seats/pair',
    {
      schema: {
        summary: 'Turns a pairing code into a seat and its token',
        body: PairBody,
        response: { 201: PairResponse },
      },
    },
    async (request, reply) => {
      const { code, ...seat } = request.body;
      const codeHash = hashSecret(normalizePairingCode(code));
      const { token, hash } = newToken();
      const seatId = await db.transaction(async (tx) => {
        // Spent in the same statement that checks it, so a code can never make two seats.
        const [spent] = await tx
          .update(pairingCodes)
          .set({ usedAt: sql`now()` })
          .where(
            and(
              eq(pairingCodes.codeHash, codeHash),
              isNull(pairingCodes.usedAt),
              gt(pairingCodes.expiresAt, sql`now()`),
              sql`exists (select 1 from ${users} where ${users.id} = ${pairingCodes.createdBy} and ${users.disabledAt} is null)`,
            ),
          )
          .returning({ ownerUserId: pairingCodes.createdBy });
        if (!spent) throw await pairingRefusal(tx, codeHash);
        // A server seat runs anyone's server agents with the company's model keys: only
        // an admin's code makes one. A local-model seat is not used: its model is a connection's.
        // A computer and a person's own place on the server run only that person's agents.
        if (seat.kind !== 'subscription-laptop' && seat.kind !== 'subscription-server') {
          const [owner] = await tx
            .select({ role: users.role })
            .from(users)
            .where(eq(users.id, spent.ownerUserId));
          if (seat.kind === 'local-model' || owner?.role !== 'admin') {
            throw new AppError('forbidden', 'Only an admin’s code connects a server seat');
          }
        }
        const [created] = await tx
          .insert(seats)
          .values({ ...seat, ownerUserId: spent.ownerUserId, tokenHash: hash })
          .returning({ id: seats.id });
        if (!created) throw new Error('The seat was not inserted');
        return created.id;
      });
      return reply.code(201).send({ seatId, token });
    },
  );

  app.get(
    '/api/seats/claim',
    {
      schema: {
        summary: 'Waits up to `wait` seconds for a run this seat may take',
        querystring: ClaimQuery,
        response: { 200: LaunchPackage, 204: z.null().describe('No run for this seat yet') },
      },
    },
    async (request, reply) => {
      const found = await requireSeat(db, request);
      const { engines, worker, signedOut = [], platform } = request.query;
      const changed = engines !== undefined && !sameSet(engines, found.engines);
      // A worker that names no build is one from before it did: what an earlier one said goes,
      // and so does a sign-in it no longer reports as missing.
      const said = {
        worker,
        signedOut: signedOut.length ? signedOut : undefined,
        ...(platform !== undefined && { platform }),
      };
      const capabilities =
        worker === found.capabilities.worker &&
        sameSet(signedOut, found.capabilities.signedOut ?? []) &&
        (platform === undefined || platform === found.capabilities.platform)
          ? undefined
          : { ...found.capabilities, ...said };
      if (changed || capabilities) {
        await db
          .update(seats)
          .set({ ...(changed && { engines }), ...(capabilities && { capabilities }) })
          .where(eq(seats.id, found.id));
      }
      // A run of an engine that is not signed in would fail at its first request. A Windows
      // computer runs the agent's commands without a sandbox: nothing until an admin allows it.
      const waits = unsandboxed({ ...found, capabilities: capabilities ?? found.capabilities })
        ? found.sandboxWaivedAt === null
        : false;
      const usable = waits
        ? []
        : (engines ?? found.engines).filter((engine) => !signedOut.includes(engine));
      const seat = { ...found, engines: usable };
      reply.header(IDLE_MINUTES_HEADER, String(seat.idleMinutes));
      if (waits) reply.header(WAITING_HEADER, 'sandbox');
      // A person's place on the server says why it waits; claimRun itself refuses it a run.
      else if (seat.kind === 'subscription-server' && !(await ownerPresent(db, seat))) {
        reply.header(WAITING_HEADER, 'presence');
      }
      // Once the seat hangs up, nothing more is claimed for it.
      const hungUp = new AbortController();
      reply.raw.once('close', () => hungUp.abort());
      if (reply.raw.destroyed) hungUp.abort();
      const stop = AbortSignal.any([hungUp.signal, closing.signal]);
      const deadline = Date.now() + request.query.wait * 1000;
      const { runLimits: limits, publicUrl, secretKey } = config;
      const options = { limits, publicUrl, secretKey, shape };
      while (!stop.aborted) {
        const launch = usable.length ? await claimRun(db, seat, options) : undefined;
        if (launch) {
          if (launch.task) {
            const job = { step: 'start', taskId: launch.task.id } as const;
            void tellJira(db, jobs.fileJira, job, request.log);
          }
          return launch;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const pause = Math.min(CLAIM_POLL_MS, remaining);
        if (!(await sleep(pause, true, { signal: stop }).catch(() => false))) break;
      }
      // A place whose services are being started says so: its run is on the way.
      if (seat.kind === 'subscription-server') {
        const [row] = await db
          .select({ shape: seats.placeShape })
          .from(seats)
          .where(eq(seats.id, seat.id));
        if (PlaceShape.safeParse(row?.shape).data?.state === 'preparing') {
          reply.header(WAITING_HEADER, 'services');
        }
      }
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/api/seats/logs',
    {
      schema: {
        summary: "Stores a batch of the worker's own log lines under its seat",
        body: z.object({
          lines: z
            .array(
              z.object({
                at: z.iso.datetime(),
                level: z.enum(['info', 'warn', 'error']),
                message: z.string().max(4000),
                runId: z.uuid().optional(),
              }),
            )
            .max(500),
        }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const seat = await requireSeat(db, request);
      await storeWorkerLines(db, seat.id, request.body.lines);
      return reply.code(204).send(null);
    },
  );

  app.get(
    '/api/seats',
    {
      schema: {
        summary: "The signed-in user's seats; every seat for an admin",
        response: { 200: z.array(SeatView) },
      },
    },
    async (request) => {
      const user = await requireUser(db, request);
      // The role is on the session: an admin sees everyone's computers, a member their own.
      return list(request.user.role === 'admin' ? null : user.id);
    },
  );

  app.patch(
    '/api/seats/:id',
    {
      schema: {
        summary: "Changes a seat's name or its idle time",
        params: IdParams,
        body: z
          .object({ name: Name.optional(), idleMinutes: IdleMinutes.optional() })
          .refine((body) => body.name !== undefined || body.idleMinutes !== undefined, {
            message: 'Give a name or an idle time',
          }),
        response: { 200: SeatView },
      },
    },
    async (request) => {
      const user = await requireUser(db, request);
      await db
        .update(seats)
        .set(request.body)
        .where(and(eq(seats.id, request.params.id), eq(seats.ownerUserId, user.id)));
      const [seat] = await list(user.id, request.params.id);
      if (!seat) throw new AppError('not_found', 'Seat not found');
      return seat;
    },
  );

  app.put(
    '/api/seats/:id/sandbox',
    {
      onRequest: app.requireAdmin,
      schema: {
        summary:
          "Allows a Windows computer to run the agent's commands without a sandbox, or takes that back",
        params: IdParams,
        body: z.object({ allowed: z.boolean() }),
        response: { 200: SeatView },
      },
    },
    async (request) => {
      // An admin decides for any computer: the person at it has no sandbox to give up.
      const allowed = request.body.allowed;
      const [changed] = await db
        .update(seats)
        .set({ sandboxWaivedAt: allowed ? sql`coalesce(${seats.sandboxWaivedAt}, now())` : null })
        .where(and(eq(seats.id, request.params.id), isNull(seats.removedAt)))
        .returning({ id: seats.id });
      if (!changed) throw new AppError('not_found', 'Seat not found');
      // Taken back: a run in progress stops, as it would on a revoked computer.
      if (!allowed) await requestStop(db, eq(runs.seatId, changed.id));
      const [seat] = await list(null, changed.id);
      if (!seat) throw new AppError('not_found', 'Seat not found');
      return seat;
    },
  );

  app.delete(
    '/api/seats/:id',
    { schema: { summary: 'Revokes a seat and stops its run', params: IdParams } },
    async (request, reply) => {
      const user = await requireUser(db, request);
      await db.transaction(async (tx) => {
        const [seat] = await tx
          .update(seats)
          .set({ status: 'revoked' })
          .where(and(eq(seats.id, request.params.id), eq(seats.ownerUserId, user.id)))
          .returning({ id: seats.id });
        if (!seat) throw new AppError('not_found', 'Seat not found');
        // A cancel rather than a cut: the run token still reaches finish, so the seat can
        // report what the run used before it stops.
        await requestStop(tx, eq(runs.seatId, seat.id));
      });
      return reply.code(204).send();
    },
  );

  app.post(
    '/api/seats/:id/remove',
    {
      schema: {
        summary: 'Takes a revoked seat off the list; its runs still name it',
        params: IdParams,
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const user = await requireUser(db, request);
      const [seat] = await db
        .select({ id: seats.id, status: seats.status })
        .from(seats)
        .where(
          and(
            eq(seats.id, request.params.id),
            eq(seats.ownerUserId, user.id),
            isNull(seats.removedAt),
          ),
        );
      if (!seat) throw new AppError('not_found', 'Seat not found');
      if (seat.status !== 'revoked') {
        throw new AppError(
          'bad_request',
          'Revoke the seat first; a connected computer stays listed',
        );
      }
      await db.update(seats).set({ removedAt: new Date() }).where(eq(seats.id, seat.id));
      return reply.code(204).send(null);
    },
  );
};

/** The seat behind a seat token; refreshes last_seen_at. */
async function requireSeat(db: Db, request: FastifyRequest) {
  const token = bearerToken(request);
  // A disabled person's computers stop with them, like their sessions.
  const [seat] = token
    ? await db
        .select({
          id: seats.id,
          ownerUserId: seats.ownerUserId,
          engines: seats.engines,
          kind: seats.kind,
          capabilities: seats.capabilities,
          lastSeenAt: seats.lastSeenAt,
          idleMinutes: seats.idleMinutes,
          sandboxWaivedAt: seats.sandboxWaivedAt,
        })
        .from(seats)
        .innerJoin(users, eq(users.id, seats.ownerUserId))
        .where(
          and(
            eq(seats.tokenHash, hashSecret(token)),
            eq(seats.status, 'active'),
            isNull(users.disabledAt),
          ),
        )
    : [];
  if (!seat) {
    throw new AppError(
      'unauthorized',
      'This computer is not connected. Connect it again with a new code.',
    );
  }
  tagLog({ seatId: seat.id });
  if (!seat.lastSeenAt || Date.now() - seat.lastSeenAt.getTime() > SEEN_EVERY_MS) {
    await db
      .update(seats)
      .set({ lastSeenAt: sql`now()` })
      .where(eq(seats.id, seat.id));
  }
  return seat;
}

/** Why a code was refused: an expired one is told apart, so the person makes a new one. */
async function pairingRefusal(tx: Tx, codeHash: string) {
  const [code] = await tx
    .select({ usedAt: pairingCodes.usedAt, expiresAt: pairingCodes.expiresAt })
    .from(pairingCodes)
    .where(eq(pairingCodes.codeHash, codeHash));
  return code && !code.usedAt && code.expiresAt <= new Date()
    ? new AppError(
        'pairing_code_expired',
        'This code has expired. Create a new one in Admin, Computers.',
      )
    : new AppError(
        'pairing_code_invalid',
        'This code is not valid. Check it, or create a new one in Admin, Computers.',
      );
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((item) => b.includes(item));

/** The server seat's worker comes in its image, which starts again from the server's version. */
const SEAT_IMAGE_COMMAND = 'docker compose --profile server-seat up -d';

/**
 * Whether a seat's worker is another build than the one this server hands out. A seat that has
 * claimed since #548 names its build; one that names none is a worker from before, and one run
 * from a checkout is another build as well. Nothing is
 * said of a revoked seat, of one that never claimed, or by a server without the bundle.
 */
function outdated(
  seat: { status: 'active' | 'revoked'; lastSeenAt: string | null },
  worker: string | undefined,
  bundle: string | undefined,
): boolean {
  return (
    bundle !== undefined &&
    seat.status === 'active' &&
    seat.lastSeenAt !== null &&
    worker !== bundle
  );
}

/**
 * Active seats first, the most recently seen on top; each with its owner and the run it is busy
 * with. `userId` null lists everyone's seats: an admin sees who is online.
 */
async function listSeats(db: Db, userId: string | null, seatId?: string) {
  const rows = await db
    .select({
      id: seats.id,
      name: seats.name,
      ownerId: seats.ownerUserId,
      ownerName: users.name,
      kind: seats.kind,
      status: seats.status,
      capabilities: seats.capabilities,
      lastSeenAt: seats.lastSeenAt,
      idleMinutes: seats.idleMinutes,
      sandboxWaivedAt: seats.sandboxWaivedAt,
      runId: runs.id,
      agentName: agents.name,
      startedAt: runs.startedAt,
    })
    .from(seats)
    .innerJoin(users, eq(users.id, seats.ownerUserId))
    .leftJoin(runs, and(eq(runs.seatId, seats.id), inArray(runs.status, [...LIVE_RUN_STATUSES])))
    .leftJoin(agents, eq(agents.id, runs.agentId))
    .where(
      and(
        userId ? eq(seats.ownerUserId, userId) : undefined,
        isNull(seats.removedAt),
        seatId ? eq(seats.id, seatId) : undefined,
      ),
    )
    .orderBy(
      sql`${seats.status} = 'active' desc`,
      sql`${seats.lastSeenAt} desc nulls last`,
      desc(seats.createdAt),
    );
  return rows.map(
    ({
      runId,
      agentName,
      startedAt,
      lastSeenAt,
      ownerId,
      ownerName,
      capabilities,
      sandboxWaivedAt,
      ...seat
    }) => ({
      ...seat,
      owner: { id: ownerId, name: ownerName },
      lastSeenAt: iso(lastSeenAt),
      activeRun: runId
        ? { id: runId, agentName: agentName ?? '', startedAt: iso(startedAt) }
        : null,
      worker: capabilities.worker,
      signedOut: capabilities.signedOut ?? [],
      platform: capabilities.platform ?? null,
      sandbox: { none: unsandboxed({ ...seat, capabilities }), allowedAt: iso(sandboxWaivedAt) },
    }),
  );
}
