import { timingSafeEqual } from 'node:crypto';
import { and, type Db, eq, projects, runs, seats, tasks } from '@agentome/db';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { deriveKey } from '../auth.js';
import { isWorking } from '../runs/service.js';
import { hashSecret } from '../tokens.js';

// What a person's place may reach. Its network is internal: the only way out is the egress proxy
// (`agentome place-egress`), which asks here, with the token its connection came with, which
// hosts are allowed. A run's token opens Agentome, the model vendors and what its task's project
// lists; the place's own token, for its worker and the person's sign-in in its terminal,
// Agentome, the vendors and npm.

/** Where Claude Code and Codex sign in and talk to their models, under a subscription. */
export const VENDOR_HOSTS = [
  'anthropic.com',
  '*.anthropic.com',
  'claude.ai',
  '*.claude.ai',
  'claude.com',
  '*.claude.com',
  'openai.com',
  '*.openai.com',
  'chatgpt.com',
  '*.chatgpt.com',
];

/** The place installs its CLI from npm at its first start. */
const SIGN_IN_HOSTS = [...VENDOR_HOSTS, 'registry.npmjs.org'];

/** Whether `host` is one of `patterns`: exactly, or under a `*.` one. */
export function hostAllowed(host: string, patterns: readonly string[]): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  return patterns.some((pattern) =>
    pattern.startsWith('*.') ? name.endsWith(pattern.slice(1)) : name === pattern,
  );
}

/** The token a person's place gives the egress proxy for its sign-in: the person's, derived. */
export const placeEgressToken = (secretKey: string, personId: string) =>
  deriveKey(secretKey, `place-egress:${personId}`);

const Ask = z.object({
  /** `run`: a run's token; `place`: the person's id and their place's token. */
  kind: z.enum(['run', 'place']),
  id: z.string().max(100).optional(),
  token: z.string().min(1).max(200),
});

/** Whom the hosts are for, for the proxy's log, and the hosts; none when the token opens nothing. */
const Hosts = z.object({ who: z.string(), hosts: z.array(z.string()) });

/** Whom a token is: a working run, or a person's place, with what it opens; or nobody. */
async function whoIs(
  db: Db,
  secretKey: string,
  own: string,
  ask: z.infer<typeof Ask>,
): Promise<{ who: string; hosts: string[]; runId?: string; seatId?: string } | undefined> {
  const { kind, id, token } = ask;
  if (kind === 'place') {
    const expected = id ? Buffer.from(placeEgressToken(secretKey, id)) : Buffer.alloc(0);
    const given = Buffer.from(token);
    if (!id || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return undefined;
    }
    const [seat] = await db
      .select({ id: seats.id })
      .from(seats)
      .where(
        and(
          eq(seats.ownerUserId, id),
          eq(seats.kind, 'subscription-server'),
          eq(seats.status, 'active'),
        ),
      );
    // Agentome too: the place's worker clones and pushes through its git proxy.
    return { who: `place ${id}`, hosts: [own, ...SIGN_IN_HOSTS], seatId: seat?.id };
  }
  // A working run's: its task's project's hosts, the server, the vendors.
  const [run] = await db
    .select({ id: runs.id, seatId: runs.seatId, hosts: projects.allowedHosts })
    .from(runs)
    .leftJoin(tasks, eq(tasks.id, runs.taskId))
    .leftJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(eq(runs.tokenHash, hashSecret(token)), isWorking()));
  if (!run) return undefined;
  return {
    who: `run ${run.id}`,
    hosts: [own, ...VENDOR_HOSTS, ...(run.hosts ?? [])],
    runId: run.id,
    seatId: run.seatId ?? undefined,
  };
}

/** What the proxy did with the calls of one token: hosts it let out or refused, and how often. */
const Events = z.object({
  events: z
    .array(
      Ask.extend({
        host: z.string().max(253),
        port: z.int().min(1).max(65_535),
        allowed: z.boolean(),
        count: z.int().min(1),
      }),
    )
    .max(500),
});

export const egressRoutes: FastifyPluginAsyncZod<{
  db: Db;
  secretKey: string;
  publicUrl: string;
}> = async (app, { db, secretKey, publicUrl }) => {
  const own = new URL(publicUrl).hostname;
  app.post(
    '/api/egress/hosts',
    {
      schema: {
        hide: true,
        body: Ask,
        response: { 200: Hosts, 401: Hosts },
      },
    },
    async (request, reply) => {
      const found = await whoIs(db, secretKey, own, request.body);
      if (!found) return reply.code(401).send({ who: '', hosts: [] });
      return { who: found.who, hosts: found.hosts };
    },
  );

  // The proxy's account of what it let out and refused, into the platform's log under the run
  // or the place: each line by the token it came with, so nobody writes under another's name.
  app.post(
    '/api/egress/events',
    { schema: { hide: true, body: Events, response: { 204: z.null() } } },
    async (request, reply) => {
      const known = new Map<string, Awaited<ReturnType<typeof whoIs>>>();
      for (const event of request.body.events) {
        const key = `${event.kind}\n${event.id ?? ''}\n${event.token}`;
        if (!known.has(key)) known.set(key, await whoIs(db, secretKey, own, event));
        const found = known.get(key);
        // A token that opens nothing now: a run that ended, say. Its lines go unsaid.
        if (!found) continue;
        const where = {
          ...(found.runId && { runId: found.runId }),
          ...(found.seatId && { seatId: found.seatId }),
          host: event.host,
          port: event.port,
          count: event.count,
        };
        if (event.allowed) request.log.info(where, `a place reached ${event.host}`);
        else request.log.warn(where, `a place was refused ${event.host}: not an allowed host`);
      }
      return reply.code(204).send(null);
    },
  );
};
