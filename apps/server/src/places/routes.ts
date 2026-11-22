import type { Duplex } from 'node:stream';
import {
  agents,
  and,
  count,
  type Db,
  eq,
  installation,
  pairingCodes,
  runs,
  seats,
  tasks,
} from '@agentome/db';
import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { browserOnly, signedInWithToken } from '../auth.js';
import { AppError } from '../errors.js';
import { isLive, requestStop } from '../runs/service.js';
import { bearerToken, hashSecret, newPairingCode } from '../tokens.js';
import { approvedServices } from '../projects/environment.js';
import { clearShape, PlaceShape } from './shape.js';
import { diskFull, overDisk } from './tend.js';
import type { Launcher } from './client.js';
import { cliEgressToken, placesKey } from './keys.js';
import { RunAddresses } from './launcher.js';
import type { PlaceState } from './protocol.js';

// A person's own place on the server, from Computers: they make it, wake it, put it to sleep
// and delete it; the place launcher does it to the container. One place a person, named by
// their id; its seat is the one of kind subscription-server they own.

const Place = z.object({
  /** Whether this installation has a place launcher at all. */
  available: z.boolean(),
  /** Whether people's own computers may run agents here (AGENTOME_COMPUTERS). */
  computers: z.boolean(),
  /** Whether an admin lets people's places here work while their people are away. */
  awayAllowed: z.boolean(),
  place: z
    .object({
      seatId: z.uuid().nullable(),
      state: z.enum(['none', 'asleep', 'awake', 'unknown']),
      /** The CLIs the place's worker says are not signed in yet. */
      signedOut: z.array(z.string()),
      lastSeenAt: z.iso.datetime().nullable(),
      /** Whether its person lets it take runs while they are away. */
      worksWhileAway: z.boolean(),
      /** The person's agents that work in the place, each with its own folders there. */
      agents: z.array(z.object({ id: z.uuid(), name: z.string() })),
      /** What the place holds on Docker and may hold; null where the launcher does not count. */
      disk: z.object({ usedBytes: z.number(), limitBytes: z.number() }).nullable(),
    })
    .nullable(),
});

/** The person's place's seat, if they have one. */
async function seatOf(db: Db, userId: string) {
  const [seat] = await db
    .select({
      id: seats.id,
      capabilities: seats.capabilities,
      lastSeenAt: seats.lastSeenAt,
      worksWhileAway: seats.worksWhileAway,
    })
    .from(seats)
    .where(
      and(
        eq(seats.ownerUserId, userId),
        eq(seats.kind, 'subscription-server'),
        eq(seats.status, 'active'),
      ),
    );
  return seat;
}

/** Whether an admin lets places here work while their people are away; allowed until one says no. */
async function awayAllowed(db: Db) {
  const [row] = await db
    .select({ allowed: installation.placesAwayAllowed })
    .from(installation)
    .limit(1);
  return row?.allowed ?? true;
}

/** What the terminal uses of a WebSocket (ws's, which has no types here). */
interface Socket {
  readonly OPEN: number;
  readonly readyState: number;
  /** Bytes queued to the browser and not yet sent. */
  readonly bufferedAmount: number;
  send(data: Buffer, options: { binary: boolean }, done?: () => void): void;
  on(
    event: 'message',
    listener: (data: Buffer | ArrayBuffer | Buffer[], binary: boolean) => void,
  ): void;
  once(event: 'close', listener: () => void): void;
  close(code?: number, reason?: string): void;
}

/** A browser that reads slower than the shell writes holds the shell, not the server's memory. */
const PAUSE_AT = 1024 * 1024;
const RESUME_AT = 256 * 1024;
/** What a browser may send before the shell is open. */
const MAX_TYPED = 64 * 1024;
/** Terminals a person may have open at once, across their tabs. */
const MAX_TERMINALS = 3;
/** A terminal nobody typed in for this long closes, and lets the place sleep. */
const IDLE_MS = 30 * 60_000;
/** How often an open terminal checks that its person is still signed in. */
const RECHECK_MS = 60_000;

export const placeRoutes: FastifyPluginAsyncZod<{
  db: Db;
  launcher?: Launcher;
  publicUrl: string;
  limits: { diskBytes: number; places: number };
  computers: boolean;
  /** The installation's secret, from which a run's CLI container's egress token is derived. */
  secretKey: string;
}> = async (app, { db, launcher, publicUrl, limits, computers, secretKey }) => {
  const ownOrigin = new URL(publicUrl).origin;
  const need = (): Launcher => {
    if (!launcher) throw new AppError('not_found', 'This installation has no places on the server');
    return launcher;
  };

  async function view(userId: string): Promise<z.infer<typeof Place>> {
    const allowed = await awayAllowed(db);
    if (!launcher) return { available: false, computers, awayAllowed: allowed, place: null };
    const seat = await seatOf(db, userId);
    const status = await launcher.status(userId).catch(() => undefined);
    const state: PlaceState | 'unknown' = status?.state ?? 'unknown';
    if (state === 'none' && !seat)
      return { available: true, computers, awayAllowed: allowed, place: null };
    const own = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(
        and(
          eq(agents.ownerUserId, userId),
          eq(agents.runsOn, 'laptop'),
          eq(agents.status, 'active'),
        ),
      )
      .orderBy(agents.name);
    return {
      available: true,
      computers,
      awayAllowed: allowed,
      place: {
        seatId: seat?.id ?? null,
        state,
        signedOut: seat?.capabilities.signedOut ?? [],
        lastSeenAt: seat?.lastSeenAt?.toISOString() ?? null,
        worksWhileAway: seat?.worksWhileAway ?? false,
        agents: own,
        disk:
          status?.diskBytes === undefined
            ? null
            : { usedBytes: status.diskBytes, limitBytes: limits.diskBytes },
      },
    };
  }

  app.get(
    '/api/me/place',
    {
      onRequest: app.requireSession,
      schema: { summary: "The signed-in person's place on the server", response: { 200: Place } },
    },
    async (request) => view(request.user.id),
  );

  app.post(
    '/api/me/place',
    {
      onRequest: app.requireSession,
      schema: {
        summary: 'Makes a place on the server for the signed-in person, and connects it',
        response: { 201: Place },
      },
    },
    async (request, reply) => {
      // A place runs its person's subscription: only the person, in the browser, makes it.
      browserOnly(request);
      const places = need();
      const me = request.user.id;
      if (await seatOf(db, me))
        throw new AppError('place_exists', 'You have a place on the server');
      // Anyone who can sign in may make one, Keycloak's newcomers too: the server's room is not.
      const [made] = await db
        .select({ count: count() })
        .from(seats)
        .where(and(eq(seats.kind, 'subscription-server'), eq(seats.status, 'active')));
      if ((made?.count ?? 0) >= limits.places) {
        throw new AppError(
          'places_full',
          `This server has ${limits.places} places, all it may have. Ask an admin to delete one that is not used, or to raise AGENTOME_PLACES_MAX.`,
        );
      }
      // The launcher pairs the place with this code, at once; it is spent like any other.
      const code = newPairingCode();
      await db.insert(pairingCodes).values({
        codeHash: hashSecret(code),
        forPlace: true,
        createdBy: me,
        expiresAt: new Date(Date.now() + 10 * 60_000),
      });
      await places.create(me, code);
      request.log.info(
        { userId: me, seatId: (await seatOf(db, me))?.id },
        'made a place on the server',
      );
      return reply.code(201).send(await view(me));
    },
  );

  for (const action of ['wake', 'sleep'] as const) {
    app.post(
      `/api/me/place/${action}`,
      {
        onRequest: app.requireSession,
        schema: {
          summary:
            action === 'wake'
              ? "Wakes the signed-in person's place"
              : "Puts the signed-in person's place to sleep",
          response: { 200: Place },
        },
      },
      async (request) => {
        browserOnly(request);
        if (action === 'wake') {
          const { diskBytes } = await need().status(request.user.id);
          if (diskBytes !== undefined && overDisk(diskBytes, limits.diskBytes)) {
            throw new AppError('place_disk_full', diskFull(diskBytes, limits.diskBytes));
          }
        }
        await need()[action](request.user.id);
        // Asleep, its services are stopped too: the next run gets them ready again.
        if (action === 'sleep') await clearShape(db, request.user.id);
        const seatId = (await seatOf(db, request.user.id))?.id;
        request.log.info(
          { userId: request.user.id, seatId },
          action === 'wake'
            ? 'woke a place on the server: its person asked'
            : 'put a place on the server to sleep: its person asked',
        );
        return view(request.user.id);
      },
    );
  }

  // The person's own choice for their own subscription: only they, in the browser, make it, as
  // they made the place and signed in there. Text an assistant reads cannot turn it on.
  app.put(
    '/api/me/place/away',
    {
      onRequest: app.requireSession,
      schema: {
        summary: "Lets the signed-in person's place take runs while they are away, or stops that",
        body: z.object({ on: z.boolean() }),
        response: { 200: Place },
      },
    },
    async (request) => {
      browserOnly(request);
      const me = request.user.id;
      const seat = await seatOf(db, me);
      if (!seat) throw new AppError('not_found', 'You have no place on the server');
      const on = request.body.on;
      if (on && !(await awayAllowed(db))) {
        throw new AppError(
          'forbidden',
          'An admin has turned this off: places here take runs only while their people are here.',
        );
      }
      await db.update(seats).set({ worksWhileAway: on }).where(eq(seats.id, seat.id));
      request.log.info(
        { userId: me, seatId: seat.id, on },
        on
          ? 'a place on the server works while its person is away: its person asked'
          : 'a place on the server waits for its person again: its person asked',
      );
      return view(me);
    },
  );

  // An admin's word for everyone here. Off, every place waits for its person again, whatever
  // they chose; their choice is kept for when it is allowed again.
  app.put(
    '/api/admin/places/away',
    {
      onRequest: app.requireAdmin,
      schema: {
        summary:
          "Lets people's places take runs while their people are away, or stops that for all",
        body: z.object({ allowed: z.boolean() }),
        response: { 200: Place },
      },
    },
    async (request) => {
      browserOnly(request);
      const allowed = request.body.allowed;
      await db.update(installation).set({ placesAwayAllowed: allowed });
      request.log.info(
        { userId: request.user.id, allowed },
        allowed
          ? 'places on the server may work while their people are away: an admin allowed it'
          : 'places on the server wait for their people: an admin turned working away off',
      );
      return view(request.user.id);
    },
  );

  // The agent's folders in the person's place start fresh at its next run: its clone, its
  // dependencies, whatever it left. Its own agents only, and not while one of its runs goes.
  app.delete(
    '/api/me/place/folders/:agentId',
    {
      onRequest: app.requireSession,
      schema: {
        summary: "Empties an agent's working folders in the signed-in person's place",
        params: z.object({ agentId: z.uuid() }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      browserOnly(request);
      const me = request.user.id;
      const { agentId } = request.params;
      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.ownerUserId, me)));
      if (!agent) throw new AppError('not_found', 'Agent not found');
      const [busy] = await db
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.agentId, agentId), isLive()))
        .limit(1);
      if (busy)
        throw new AppError('run_in_progress', 'This agent is running: try again when its run ends');
      await need().freshFolders(me, agentId);
      request.log.info(
        { userId: me, seatId: (await seatOf(db, me))?.id, agentId },
        "emptied an agent's working folders in a place on the server",
      );
      return reply.code(204).send(null);
    },
  );

  /** Deletes a person's place with its volumes, revokes its seat and stops its run. */
  async function removePlace(userId: string, log: FastifyBaseLogger, why: string) {
    const seatId = (await seatOf(db, userId))?.id;
    await need().remove(userId);
    log.info({ userId, seatId }, `deleted a place on the server, with its volumes: ${why}`);
    await db.transaction(async (tx) => {
      const gone = await tx
        .update(seats)
        .set({ status: 'revoked' })
        .where(
          and(
            eq(seats.ownerUserId, userId),
            eq(seats.kind, 'subscription-server'),
            eq(seats.status, 'active'),
          ),
        )
        .returning({ id: seats.id });
      for (const seat of gone) await requestStop(tx, eq(runs.seatId, seat.id));
    });
  }

  app.delete(
    '/api/me/place',
    {
      onRequest: app.requireSession,
      schema: {
        summary: "Deletes the signed-in person's place, its sign-in and working folders with it",
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      browserOnly(request);
      await removePlace(request.user.id, request.log, 'its person asked');
      return reply.code(204).send(null);
    },
  );

  // An admin deletes someone's place: they left, or their sign-in in it must go. The sign-in to
  // the CLIs lives on its volume, which goes with it.
  app.delete(
    '/api/users/:id/place',
    {
      onRequest: app.requireAdmin,
      schema: {
        summary:
          "Deletes a person's place on the server, its sign-in and working folders with it; an admin's",
        params: z.object({ id: z.uuid() }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      browserOnly(request);
      const id = request.params.id.toLowerCase();
      const state = await need()
        .state(id)
        .catch(() => 'unknown' as const);
      if (state === 'none' && !(await seatOf(db, id))) {
        throw new AppError('not_found', 'This person has no place on the server');
      }
      await removePlace(id, request.log, `an admin, ${request.user.id}, asked`);
      return reply.code(204).send(null);
    },
  );

  /**
   * The place's worker asks for its run's own container, by the place's seat token:
   * the launcher makes it with the run's folder, the agent's folder and the services its project
   * runs with; deleting it ends whatever the run left running.
   */
  async function placeRun(request: FastifyRequest, runId: string) {
    const token = bearerToken(request);
    const [seat] = token
      ? await db
          .select({ id: seats.id, ownerUserId: seats.ownerUserId, shape: seats.placeShape })
          .from(seats)
          .where(
            and(
              eq(seats.tokenHash, hashSecret(token)),
              eq(seats.kind, 'subscription-server'),
              eq(seats.status, 'active'),
            ),
          )
      : [];
    if (!seat) throw new AppError('unauthorized', 'Only a place asks for its runs');
    const [run] = await db
      .select({
        id: runs.id,
        agentId: runs.agentId,
        projectId: tasks.projectId,
        engine: agents.engine,
      })
      .from(runs)
      .leftJoin(tasks, eq(tasks.id, runs.taskId))
      .innerJoin(agents, eq(agents.id, runs.agentId))
      .where(and(eq(runs.id, runId), eq(runs.seatId, seat.id)));
    if (!run) throw new AppError('not_found', 'Run not found');
    return { seat, run };
  }

  const RunFolder = z.object({ folder: z.string().max(200).optional() });

  app.put(
    '/api/runs/:id/container',
    {
      schema: {
        summary: "Makes a place's run its own container: the place's worker asks, by its seat",
        params: z.object({ id: z.uuid() }),
        body: RunFolder,
        response: { 200: RunAddresses.extend({ cliToken: z.string() }) },
      },
    },
    async (request) => {
      const { seat, run } = await placeRun(request, request.params.id);
      const [live] = await db
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.id, run.id), isLive()));
      if (!live) throw new AppError('run_in_progress', 'This run is not going any more');
      // Only the agent's own folders: the worker names one, the server checks whose it is.
      const { folder } = request.body;
      if (folder !== undefined && !folder.startsWith(`folders/${run.agentId}/`)) {
        throw new AppError('forbidden', "Not this run's agent's folder");
      }
      // The project's approved services, when the place has them running for it.
      const wanted = run.projectId ? await approvedServices(db, run.projectId) : null;
      const shape = PlaceShape.safeParse(seat.shape);
      const ready =
        wanted &&
        shape.success &&
        shape.data.state === 'ready' &&
        shape.data.projectId === run.projectId &&
        shape.data.hash === wanted.hash;
      const addresses = await need().startRun(seat.ownerUserId, run.id, {
        ...(folder !== undefined && { folder }),
        engine: run.engine,
        ...(ready &&
          run.projectId && {
            shape: { project: run.projectId, hash: wanted.hash, services: wanted.services },
          }),
      });
      request.log.info({ seatId: seat.id, runId: run.id }, "made a place's run its containers");
      // The CLI container's own way to its model: the run's token no longer opens the vendors.
      return { ...addresses, cliToken: cliEgressToken(placesKey(secretKey), run.id) };
    },
  );

  app.delete(
    '/api/runs/:id/container',
    {
      schema: {
        summary: "Deletes a place's run's container and what runs in it: the place's worker asks",
        params: z.object({ id: z.uuid() }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const { seat, run } = await placeRun(request, request.params.id);
      await need().endRun(seat.ownerUserId, run.id);
      request.log.info({ seatId: seat.id, runId: run.id }, "deleted a place's run's container");
      return reply.code(204).send(null);
    },
  );

  // A terminal in the person's own place, in the browser: to sign in to Claude Code and Codex,
  // or to look around. Only a session in a page of this server: another site's page would bring
  // the person's cookie too, so its origin is checked. Keystrokes go to the shell as binary
  // frames; a text frame is a resize. What goes through is never logged.
  app.get(
    '/api/me/place/terminal',
    {
      websocket: true,
      onRequest: app.requireSession,
      preHandler: async (request) => {
        if (signedInWithToken(request) || request.headers.origin !== ownOrigin) {
          throw new AppError('forbidden', 'Open the terminal from Agentome in the browser');
        }
        // The launcher counts the terminals open in the place, whichever app opened them.
        const { terminals } = await need()
          .status(request.user.id)
          .catch(() => ({ terminals: 0 }));
        if (terminals >= MAX_TERMINALS) {
          throw new AppError(
            'too_many_terminals',
            `You have ${MAX_TERMINALS} terminals open in your place: close one first`,
          );
        }
      },
      schema: { hide: true },
    },
    (raw, request) => {
      const socket = raw as unknown as Socket;
      const me = request.user.id;
      const places = need();
      // For the log: the lines of this terminal go under the place's seat.
      let placeSeat: string | undefined;
      void seatOf(db, me).then((seat) => (placeSeat = seat?.id));
      // What the browser sends while the shell is opening is kept: the first size comes at once.
      let shell: Duplex | undefined;
      const typed: Buffer[] = [];
      let size: { cols: number; rows: number } | undefined;
      let gone = false;
      let lastTyped = Date.now();
      // Signed out, disabled or idle, the terminal closes: the session is checked again while it
      // is open, not only when it opened.
      const watch = setInterval(() => {
        if (Date.now() - lastTyped > IDLE_MS) {
          socket.close(1000, 'Closed after 30 minutes without typing');
          return;
        }
        app.requireSession(request).catch(() => socket.close(1008, 'Signed out'));
      }, RECHECK_MS);
      watch.unref();
      socket.once('close', () => {
        gone = true;
        clearInterval(watch);
      });
      let typedBytes = 0;
      const resize = (cols: number, rows: number) =>
        void places.resize(me, cols, rows).catch(() => undefined);
      socket.on('message', (data, binary) => {
        const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
        if (binary) {
          lastTyped = Date.now();
          if (shell) shell.write(bytes);
          else if ((typedBytes += bytes.length) <= MAX_TYPED) typed.push(bytes);
          else socket.close(1009, 'Too much typed before the terminal opened');
          return;
        }
        try {
          const { cols, rows } = JSON.parse(bytes.toString('utf8')) as {
            cols?: number;
            rows?: number;
          };
          if (Number.isInteger(cols) && Number.isInteger(rows)) {
            size = { cols: Number(cols), rows: Number(rows) };
            if (shell) resize(size.cols, size.rows);
          }
        } catch {
          // Not a size: nothing else comes as text.
        }
      });
      places
        .terminal(me)
        .then((opened) => {
          // The browser left while the shell was opening.
          if (gone) {
            opened.destroy();
            return;
          }
          shell = opened;
          request.log.info(
            { userId: me, seatId: placeSeat },
            'a terminal opened in a place on the server',
          );
          opened.on('data', (chunk: Buffer) => {
            if (socket.readyState !== socket.OPEN) return;
            socket.send(chunk, { binary: true }, () => {
              if (opened.isPaused() && socket.bufferedAmount < RESUME_AT) opened.resume();
            });
            if (socket.bufferedAmount > PAUSE_AT) opened.pause();
          });
          for (const bytes of typed.splice(0)) opened.write(bytes);
          if (size) resize(size.cols, size.rows);
          const close = () => {
            opened.destroy();
            if (socket.readyState === socket.OPEN) socket.close();
          };
          opened.once('close', () => {
            request.log.info(
              { userId: me, seatId: placeSeat },
              'a terminal closed in a place on the server',
            );
            close();
          });
          opened.once('error', close);
          socket.once('close', close);
        })
        .catch((error: unknown) => {
          request.log.warn({ err: error, userId: me }, 'could not open a terminal in a place');
          socket.close(1011, 'The place could not open a terminal');
        });
    },
  );
};
