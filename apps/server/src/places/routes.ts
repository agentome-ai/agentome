import { clearShape } from './shape.js';
import type { Duplex } from 'node:stream';
import { agents, and, type Db, eq, pairingCodes, runs, seats } from '@agentome/db';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { browserOnly, signedInWithToken } from '../auth.js';
import { AppError } from '../errors.js';
import { isLive, requestStop } from '../runs/service.js';
import { hashSecret, newPairingCode } from '../tokens.js';
import type { Launcher } from './client.js';
import type { PlaceState } from './protocol.js';

// A person's own place on the server, from Computers: they make it, wake it, put it to sleep
// and delete it; the place launcher does it to the container. One place a person, named by
// their id; its seat is the one of kind subscription-server they own.

const Place = z.object({
  /** Whether this installation has a place launcher at all. */
  available: z.boolean(),
  place: z
    .object({
      seatId: z.uuid().nullable(),
      state: z.enum(['none', 'asleep', 'awake', 'unknown']),
      /** The CLIs the place's worker says are not signed in yet. */
      signedOut: z.array(z.string()),
      lastSeenAt: z.iso.datetime().nullable(),
      /** The person's agents that work in the place, each with its own folders there. */
      agents: z.array(z.object({ id: z.uuid(), name: z.string() })),
    })
    .nullable(),
});

/** The person's place's seat, if they have one. */
async function seatOf(db: Db, userId: string) {
  const [seat] = await db
    .select({ id: seats.id, capabilities: seats.capabilities, lastSeenAt: seats.lastSeenAt })
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

/** What the terminal uses of a WebSocket (ws's, which has no types here). */
interface Socket {
  readonly OPEN: number;
  readonly readyState: number;
  send(data: Buffer, options: { binary: boolean }): void;
  on(
    event: 'message',
    listener: (data: Buffer | ArrayBuffer | Buffer[], binary: boolean) => void,
  ): void;
  once(event: 'close', listener: () => void): void;
  close(code?: number, reason?: string): void;
}

export const placeRoutes: FastifyPluginAsyncZod<{
  db: Db;
  launcher?: Launcher;
  publicUrl: string;
}> = async (app, { db, launcher, publicUrl }) => {
  const ownOrigin = new URL(publicUrl).origin;
  const need = (): Launcher => {
    if (!launcher) throw new AppError('not_found', 'This installation has no places on the server');
    return launcher;
  };

  async function view(userId: string): Promise<z.infer<typeof Place>> {
    if (!launcher) return { available: false, place: null };
    const seat = await seatOf(db, userId);
    const state: PlaceState | 'unknown' = await launcher.state(userId).catch(() => 'unknown');
    if (state === 'none' && !seat) return { available: true, place: null };
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
      place: {
        seatId: seat?.id ?? null,
        state,
        signedOut: seat?.capabilities.signedOut ?? [],
        lastSeenAt: seat?.lastSeenAt?.toISOString() ?? null,
        agents: own,
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
      // The launcher pairs the place with this code, at once; it is spent like any other.
      const code = newPairingCode();
      await db.insert(pairingCodes).values({
        codeHash: hashSecret(code),
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
      const me = request.user.id;
      const seatId = (await seatOf(db, me))?.id;
      await need().remove(me);
      request.log.info({ userId: me, seatId }, 'deleted a place on the server, with its volumes');
      await db.transaction(async (tx) => {
        const gone = await tx
          .update(seats)
          .set({ status: 'revoked' })
          .where(
            and(
              eq(seats.ownerUserId, me),
              eq(seats.kind, 'subscription-server'),
              eq(seats.status, 'active'),
            ),
          )
          .returning({ id: seats.id });
        for (const seat of gone) await requestStop(tx, eq(runs.seatId, seat.id));
      });
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
        need();
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
      socket.once('close', () => (gone = true));
      const resize = (cols: number, rows: number) =>
        void places.resize(me, cols, rows).catch(() => undefined);
      socket.on('message', (data, binary) => {
        const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
        if (binary) {
          if (shell) shell.write(bytes);
          else typed.push(bytes);
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
          opened.on('data', (chunk: Buffer) => socket.send(chunk, { binary: true }));
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
