import { timingSafeEqual } from 'node:crypto';
import { and, type Db, eq, projects, runs, seats, tasks } from '@agentome/db';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  cliEgressToken,
  dockerEgressToken,
  egressProxyKey,
  placeEgressToken,
  placesKey,
} from './keys.js';
import { isWorking } from '../runs/service.js';
import { hashSecret } from '../tokens.js';

// What a person's place may reach. Its network is internal: the only way out is the egress proxy
// (`agentome place-egress`), which asks here, with the token its connection came with, which
// hosts are allowed. A run's token, which its sandbox's commands use, opens Agentome and what its
// task's project lists; its CLI container's token, the CLI's alone, Agentome and the model vendors
//; the place's own token, for its worker and the person's sign-in in its terminal,
// Agentome, the vendors and npm.

/**
 * Where Claude Code and Codex talk to their models and keep their sign-in fresh, under a
 * subscription: the exact hosts, not the vendors' domains, whose other names (a CDN's, a
 * user-content one) would be ways out. The sign-in page itself opens in the person's browser.
 * When a CLI's release moves to another host, the proxy's log shows it refused.
 */
export const VENDOR_HOSTS = [
  'api.anthropic.com',
  'platform.claude.com',
  'claude.ai',
  'api.openai.com',
  'auth.openai.com',
  'chatgpt.com',
];

const NPM_REGISTRY = 'registry.npmjs.org';
/** The place installs its CLI from npm at its first start. */
const SIGN_IN_HOSTS = [...VENDOR_HOSTS, NPM_REGISTRY];

/**
 * A host the proxy lets out, and on which port: `host[:port]`, `public:host[:port]` or
 * `*.domain[:port]`, 443 by default. Only an exact `host` reaches the company's own addresses.
 */
export type HostMatch = { pattern: string; exact: boolean };

/** What an allowed host's entry says, without its marks: whether it reaches public addresses only. */
export const PUBLIC_ONLY = 'public:';

/**
 * The pattern of `patterns` that lets `host:port` out, if one does: the host exactly, or under a
 * `*.` one, on the pattern's port, 443 when it names none.
 */
export function hostAllowed(
  host: string,
  port: number,
  patterns: readonly string[],
): HostMatch | undefined {
  const name = host.toLowerCase().replace(/\.$/, '');
  for (const pattern of patterns) {
    const publicOnly = pattern.startsWith(PUBLIC_ONLY);
    const entry = publicOnly ? pattern.slice(PUBLIC_ONLY.length) : pattern;
    const colon = entry.lastIndexOf(':');
    const [domain, allowedPort] =
      colon > 0 ? [entry.slice(0, colon), Number(entry.slice(colon + 1))] : [entry, 443];
    if (port !== allowedPort) continue;
    const wild = domain.startsWith('*.');
    if (wild ? name.endsWith(domain.slice(1)) : name === domain) {
      return { pattern, exact: !wild && !publicOnly };
    }
  }
  return undefined;
}

/** Agentome's own host, on the port of its public address: what its links and git use. */
export function ownHost(publicUrl: string): string {
  const url = new URL(publicUrl);
  return `${url.hostname}:${url.port || (url.protocol === 'https:' ? 443 : 80)}`;
}

const Ask = z.object({
  /**
   * `run`: a run's token; `cli`: the run's id and its CLI container's token; `docker`: the run's id and
   * its own Docker's token; `place`: the person's id
   * and their place's token; `seat`: a server seat's.
   */
  kind: z.enum(['run', 'cli', 'docker', 'place', 'seat']),
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
    const expected = id ? Buffer.from(placeEgressToken(placesKey(secretKey), id)) : Buffer.alloc(0);
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
    // A place that is gone, or a person whose place was removed, opens nothing: the token is
    // derived, so it cannot be revoked any other way.
    if (!seat) return undefined;
    // Agentome too: the place's worker clones and pushes through its git proxy.
    return { who: `place ${id}`, hosts: [own, ...SIGN_IN_HOSTS], seatId: seat.id };
  }
  // The server seat installs Claude Code from npm at its start, before it has a run.
  if (kind === 'seat') {
    const [seat] = await db
      .select({ id: seats.id })
      .from(seats)
      .where(
        and(
          eq(seats.tokenHash, hashSecret(token)),
          eq(seats.kind, 'api-server'),
          eq(seats.status, 'active'),
        ),
      );
    if (!seat) return undefined;
    return { who: `seat ${seat.id}`, hosts: [NPM_REGISTRY], seatId: seat.id };
  }
  // A run's CLI container: the CLI, for its model. Derived from the run, so good while the run works.
  if (kind === 'cli') {
    const expected = id ? Buffer.from(cliEgressToken(placesKey(secretKey), id)) : Buffer.alloc(0);
    const given = Buffer.from(token);
    if (!id || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return undefined;
    }
    const [run] = await db
      .select({ id: runs.id, seatId: runs.seatId })
      .from(runs)
      .where(and(eq(runs.id, id), isWorking()));
    if (!run) return undefined;
    return {
      who: `run ${run.id}`,
      hosts: [own, ...VENDOR_HOSTS],
      runId: run.id,
      seatId: run.seatId ?? undefined,
    };
  }
  // A run's own Docker, for its pulls: the hosts its project allows, its registries among them.
  if (kind === 'docker') {
    const expected = id
      ? Buffer.from(dockerEgressToken(placesKey(secretKey), id))
      : Buffer.alloc(0);
    const given = Buffer.from(token);
    if (!id || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return undefined;
    }
    const [run] = await db
      .select({ id: runs.id, seatId: runs.seatId, hosts: projects.allowedHosts })
      .from(runs)
      .leftJoin(tasks, eq(tasks.id, runs.taskId))
      .leftJoin(projects, eq(projects.id, tasks.projectId))
      .where(and(eq(runs.id, id), isWorking()));
    if (!run) return undefined;
    return {
      who: `run ${run.id}`,
      hosts: run.hosts ?? [],
      runId: run.id,
      seatId: run.seatId ?? undefined,
    };
  }
  // A working run's, for its sandbox: its task's project's hosts and the server. Not the vendors:
  // with a key of its own a command would upload there what it read (review N3).
  const [run] = await db
    .select({ id: runs.id, seatId: runs.seatId, hosts: projects.allowedHosts })
    .from(runs)
    .leftJoin(tasks, eq(tasks.id, runs.taskId))
    .leftJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(eq(runs.tokenHash, hashSecret(token)), isWorking()));
  if (!run) return undefined;
  return {
    who: `run ${run.id}`,
    hosts: [own, ...(run.hosts ?? [])],
    runId: run.id,
    seatId: run.seatId ?? undefined,
  };
}

/**
 * What the proxy did with the calls of one token: each connection it let out, with the entry of
 * the list that let it, and the hosts it refused, how often and why.
 */
const Event = Ask.extend({
  // A host name or an IPv4 address, as the proxy saw it in a CONNECT: nothing to read as
  // more than that in the log.
  host: z
    .string()
    .max(253)
    .regex(/^[a-z0-9.-]+$/i),
  port: z.int().min(1).max(65_535),
  allowed: z.boolean(),
  // As often as a token can try in the proxy's few seconds between accounts, not more: a
  // huge one would break the sums of the week's list.
  count: z.int().min(1).max(100_000),
  // An entry of the list, as the app gave it: a host, `public:host` or `*.domain`, and a port.
  rule: z
    .string()
    .max(270)
    .regex(/^[a-z0-9.*:-]+$/i)
    .optional(),
  reason: z.enum(['not-listed', 'address', 'hello']).optional(),
  method: z
    .string()
    .max(16)
    .regex(/^[A-Z]+$/)
    .optional(),
  // A path of plain HTTP, its query cut off by the proxy: what a command asked for, read as
  // text in the log and nothing more.
  path: z.string().max(512).optional(),
  status: z.int().min(100).max(599).optional(),
  sent: z.int().min(0).optional(),
  received: z.int().min(0).optional(),
  ms: z.int().min(0).optional(),
});

/**
 * A batch the proxy sends: each event is checked on its own, so one the app cannot read (a host
 * name no CONNECT could carry, say) is left out alone, not with every other run's lines.
 */
const Events = z.object({ events: z.array(z.unknown()).max(500) });

/** How the log says why the proxy refused a host. */
const WHY = {
  'not-listed': 'not an allowed host',
  address: 'its address is not one a place may reach',
  hello: 'not TLS to the name it asked for',
} as const;

/** Lines of the egress log a run or a place may have in a minute. */
const LINES_A_MINUTE = 600;
const budgets = new Map<string, { minute: number; lines: number }>();

/**
 * Whether one more line of this run's or place's fits in its minute: 'yes', 'no', or 'first-no'
 * for the first line that does not, which the log tells of once.
 */
export function withinBudget(who: string, now = Date.now()): 'yes' | 'no' | 'first-no' {
  const minute = Math.floor(now / 60_000);
  const kept = budgets.get(who);
  if (!kept || kept.minute !== minute) {
    if (budgets.size > 10_000) budgets.clear();
    budgets.set(who, { minute, lines: 1 });
    return 'yes';
  }
  kept.lines += 1;
  if (kept.lines <= LINES_A_MINUTE) return 'yes';
  return kept.lines === LINES_A_MINUTE + 1 ? 'first-no' : 'no';
}

/** The header the egress proxy shows its key in. */
export const PROXY_KEY_HEADER = 'x-agentome-egress';

/** Whether a request is the egress proxy's: its key, in constant time. */
export function fromEgressProxy(given: unknown, secretKey: string): boolean {
  if (typeof given !== 'string') return false;
  const want = Buffer.from(egressProxyKey(placesKey(secretKey)));
  const got = Buffer.from(given);
  return got.length === want.length && timingSafeEqual(got, want);
}

export const egressRoutes: FastifyPluginAsyncZod<{
  db: Db;
  secretKey: string;
  publicUrl: string;
}> = async (app, { db, secretKey, publicUrl }) => {
  const own = ownHost(publicUrl);
  // The proxy's routes, the proxy's alone: a run's token could otherwise ask what any token opens,
  // or write the lines of refused hosts an admin may open with one click (review P9).
  app.addHook('onRequest', async (request, reply) => {
    if (!fromEgressProxy(request.headers[PROXY_KEY_HEADER], secretKey)) {
      return reply.code(401).send({ who: '', hosts: [] });
    }
  });
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
      let unread = 0;
      for (const raw of request.body.events) {
        const parsed = Event.safeParse(raw);
        if (!parsed.success) {
          unread += 1;
          continue;
        }
        const event = parsed.data;
        const key = `${event.kind}\n${event.id ?? ''}\n${event.token}`;
        if (!known.has(key)) known.set(key, await whoIs(db, secretKey, own, event));
        const found = known.get(key);
        // A token that opens nothing now: a run that ended, say. Its lines go unsaid.
        if (!found) continue;
        // The proxy tells of each connection it let out and of what it refused as it goes: a run
        // that makes more than this a minute is filling the log. What it reached and what it was
        // refused count apart, so a flood of refused names cannot hide where it got through.
        const fits = withinBudget(`${found.who}\n${event.allowed ? 'reached' : 'refused'}`);
        const by = {
          ...(found.runId && { runId: found.runId }),
          ...(found.seatId && { seatId: found.seatId }),
        };
        if (fits === 'first-no') {
          request.log.warn(
            by,
            `a place's ${event.allowed ? 'reached' : 'refused'} hosts went past ${LINES_A_MINUTE} lines this minute; the rest of the minute's are not logged`,
          );
        }
        if (fits !== 'yes') continue;
        // Named one by one, so that the token never reaches the log.
        const { host, port, count, rule, reason, method, path, status, sent, received, ms } = event;
        const said = { host, port, count, rule, reason, method, path, status, sent, received, ms };
        const where = {
          ...by,
          ...Object.fromEntries(Object.entries(said).filter(([, value]) => value !== undefined)),
        };
        if (event.allowed) request.log.info(where, `a place reached ${event.host}`);
        else
          request.log.warn(
            where,
            `a place was refused ${event.host}: ${WHY[event.reason ?? 'not-listed']}`,
          );
      }
      if (unread > 0)
        request.log.warn({ unread }, 'the egress proxy sent events the app cannot read');
      return reply.code(204).send(null);
    },
  );
};
