import { createPublicKey, type KeyObject, verify } from 'node:crypto';
import {
  agents,
  and,
  type Db,
  eq,
  installation,
  isNotNull,
  projects,
  sql,
  teams,
} from '@agentome/db';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { deriveKey } from '../auth.js';
import { AppError } from '../errors.js';
import { type LicensePayload, PREFIX } from './sign.js';

export { signLicense } from './sign.js';

// The license. Without a key Agentome is Free, with no end: up to five
// active agents and one team, on computers, without monthly budgets. A key the owner signs makes
// it Enterprise until the key's end and 14 days of grace after. An installation over Free
// without a key that holds is read-only: viewing and history work, nothing new runs and nothing
// changes, until a new key or until it is cut back to Free. The key's agent limit is soft: the
// peak is kept and shown, never enforced.

/** The owner's public key; the private half never leaves the owner's machine. */
const OWNER_KEY = 'MCowBQYDK2VwAyEAO77iJmyvCRlUWW7VjFDt+LAQeNEdUvScVt5k0YUh6rs=';

const DAY_MS = 86_400_000;
const GRACE_DAYS = 14;
/** How long the state is read from memory: the guard runs on every write. */
const CACHE_MS = 60_000;
/** How far the clock may go before the latest time seen is written down again. */
const SEEN_STEP_MS = 3_600_000;

/** What Free allows. */
export const FREE = { agents: 5, teams: 1 } as const;

const Payload = z.object({
  id: z.string().min(1),
  company: z.string().min(1),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  agents: z.number().int().positive().nullable(),
  // The installation the key is for; a key without one works anywhere.
  installation: z.string().min(1).optional(),
});

export const publicKeyOf = (base64Der: string) =>
  createPublicKey({ key: Buffer.from(base64Der, 'base64'), format: 'der', type: 'spki' });

let ownerKey = publicKeyOf(OWNER_KEY);
let installationId = '';

/**
 * The key licenses are checked against. Tests sign with a pair of their own and pass it to
 * buildApp; never the environment, which would be a way around the license for anyone.
 */
export function useLicenseKey(key: KeyObject): void {
  ownerKey = key;
  forgetLicense();
}

/**
 * This installation's id, which a key may be bound to: drawn from the secret key, so it stays
 * the same across restarts and updates and differs between installations.
 */
export const installationIdOf = (secretKey: string) =>
  (deriveKey(secretKey, 'installation-id').slice(0, 16).match(/.{4}/g) ?? []).join('-');

export function useInstallation(secretKey: string): void {
  installationId = installationIdOf(secretKey);
  forgetLicense();
}

const invalid = (message: string) => new AppError('invalid_license', message);

/** What a key licenses, or invalid_license saying what is wrong with it. */
export function readLicense(key: string): LicensePayload {
  const [prefix, body = '', signature = '', ...rest] = key.trim().split('.');
  if (prefix !== PREFIX || rest.length > 0) {
    throw invalid('This is not an Agentome license key. Paste the whole key you were given.');
  }
  // A signature of the wrong length throws rather than failing: both are a key that is not ours.
  const signed = (() => {
    try {
      return verify(
        null,
        Buffer.from(`${PREFIX}.${body}`),
        ownerKey,
        Buffer.from(signature, 'base64url'),
      );
    } catch {
      return false;
    }
  })();
  if (!signed) throw invalid('This license key was not issued for Agentome, or it was changed.');
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw invalid('This license key is damaged. Paste the whole key you were given.');
  }
  const parsed = Payload.safeParse(json);
  if (!parsed.success)
    throw invalid('This license key is damaged. Paste the whole key you were given.');
  return parsed.data;
}

export type LicenseStatus = 'free' | 'valid' | 'grace' | 'read_only';

/** What takes an installation over Free. */
export type OverFree = 'agents' | 'teams' | 'server_agents' | 'budgets';

export type LicenseState = {
  /** free: no key and within Free; valid, grace: a key; read_only: over Free without one. */
  status: LicenseStatus;
  /** Enterprise works: a key in its term or its grace. */
  enterprise: boolean;
  installationId: string;
  id: string | null;
  company: string | null;
  /** The key's end, and the end of its grace; null without a key. */
  expiresAt: string | null;
  graceEndsAt: string | null;
  agents: { limit: number | null; active: number; peak: number };
  /** Where the installation is over Free, whatever the key. */
  over: OverFree[];
};

let cache: { at: number; state: LicenseState } | undefined;

/** Read again on the next call: after a new key, or in a test that moved the clock. */
export function forgetLicense(): void {
  cache = undefined;
}

/** What the license reads and writes: the installation row and the agents, in or out of a transaction. */
type Store = Pick<Db, 'select' | 'update'>;

export async function licenseState(db: Store, now = Date.now()): Promise<LicenseState> {
  if (cache && now - cache.at < CACHE_MS) return cache.state;
  const state = await readState(db, now);
  cache = { at: now, state };
  return state;
}

/** The key's terms, or null when there is none or it is not good for this installation. */
function keyOf(stored: string | null): LicensePayload | null {
  if (!stored) return null;
  try {
    const license = readLicense(stored);
    return license.installation && license.installation !== installationId ? null : license;
  } catch {
    return null;
  }
}

async function overFree(db: Store, active: number): Promise<OverFree[]> {
  const count = async (query: Promise<{ n: number }[]>) => (await query)[0]?.n ?? 0;
  const n = sql<number>`count(*)::int`;
  const live = eq(agents.status, 'active');
  const [teamCount, serverAgents, agentBudgets, projectBudgets] = await Promise.all([
    count(db.select({ n }).from(teams)),
    count(
      db
        .select({ n })
        .from(agents)
        .where(and(live, eq(agents.runsOn, 'server'))),
    ),
    count(
      db
        .select({ n })
        .from(agents)
        .where(and(live, sql`${agents.budget}->>'usdPerMonth' is not null`)),
    ),
    count(db.select({ n }).from(projects).where(isNotNull(projects.usdPerMonth))),
  ]);
  const over: OverFree[] = [];
  if (active > FREE.agents) over.push('agents');
  if (teamCount > FREE.teams) over.push('teams');
  if (serverAgents > 0) over.push('server_agents');
  if (agentBudgets + projectBudgets > 0) over.push('budgets');
  return over;
}

async function readState(db: Store, clock: number): Promise<LicenseState> {
  const [row] = await db
    .select({
      license: installation.license,
      peak: installation.licensePeakAgents,
      seenAt: installation.licenseSeenAt,
    })
    .from(installation);
  // A clock put back does not bring a key back: the term runs from the latest time seen.
  const seen = row?.seenAt?.getTime() ?? 0;
  const now = Math.max(clock, seen);
  if (row && clock - seen > SEEN_STEP_MS) {
    await db.update(installation).set({ licenseSeenAt: new Date(clock) });
  }
  const [counted] = await db
    .select({ active: sql<number>`count(*)::int` })
    .from(agents)
    .where(eq(agents.status, 'active'));
  const active = counted?.active ?? 0;
  // A stored key that does not check out, edited in the database or made for another
  // installation, licenses nothing: the installation is Free.
  const license = keyOf(row?.license ?? null);
  const ends = license ? Date.parse(license.expiresAt) : null;
  const graceEnds = ends === null ? null : ends + GRACE_DAYS * DAY_MS;
  let peak = row?.peak ?? 0;
  if (row && active > peak) {
    peak = active;
    await db.update(installation).set({ licensePeakAgents: active });
  }
  const over = await overFree(db, active);
  const status: LicenseStatus =
    ends !== null && graceEnds !== null && now < graceEnds
      ? now < ends
        ? 'valid'
        : 'grace'
      : over.length > 0
        ? 'read_only'
        : 'free';
  return {
    status,
    enterprise: status === 'valid' || status === 'grace',
    installationId,
    id: license?.id ?? null,
    company: license?.company ?? null,
    expiresAt: ends === null ? null : new Date(ends).toISOString(),
    graceEndsAt: graceEnds === null ? null : new Date(graceEnds).toISOString(),
    agents: { limit: license?.agents ?? null, active, peak },
    over,
  };
}

/** Puts a new key in place of the old one; the peak of agents starts again under it. */
export async function applyLicense(db: Db, key: string): Promise<LicenseState> {
  const license = readLicense(key);
  if (license.installation && license.installation !== installationId) {
    throw invalid(
      `This license key is for another installation. This one is ${installationId}: ask for a key made out to it.`,
    );
  }
  await db.update(installation).set({ license: key.trim(), licensePeakAgents: 0 });
  forgetLicense();
  return licenseState(db);
}

/** What Enterprise adds, as a refusal names it. */
export type EnterpriseFeature =
  'agents' | 'teams' | 'server_agents' | 'budgets' | 'analytics' | 'keycloak';

const featureWords: Record<EnterpriseFeature, string> = {
  agents: `More than ${FREE.agents} active agents need a license key.`,
  teams: 'More than one team needs a license key.',
  server_agents: 'Agents on the server need a license key.',
  budgets: 'Monthly budgets need a license key.',
  analytics: "An agent's quality needs a license key.",
  keycloak: 'Sign-in with Keycloak needs a license key.',
};

export const licenseRequired = (feature: EnterpriseFeature) =>
  new AppError(
    'license_required',
    `${featureWords[feature]} Without one Agentome is Free; an admin adds a key in Admin → License.`,
  );

/**
 * Whether people may sign in with Keycloak: while a key holds and in its grace. After
 * that only passwords sign in, the first admin's among them, so an admin can always put a key in.
 */
export async function keycloakAllowed(db: Store): Promise<boolean> {
  return (await licenseState(db)).enterprise;
}

/** Throws license_required unless a key holds: before an Enterprise feature is used. */
export async function requireEnterprise(db: Store, feature: EnterpriseFeature): Promise<void> {
  if (!(await licenseState(db)).enterprise) throw licenseRequired(feature);
}

/**
 * Throws license_required when `more` active agents, or teams, would take a Free installation
 * past Free. The count is read now, not from the cached state, so quick creations add up.
 */
export async function requireRoomFor(db: Store, what: 'agents' | 'teams', more = 1): Promise<void> {
  if ((await licenseState(db)).enterprise) return;
  const [row] =
    what === 'agents'
      ? await db
          .select({ n: sql<number>`count(*)::int` })
          .from(agents)
          .where(eq(agents.status, 'active'))
      : await db.select({ n: sql<number>`count(*)::int` }).from(teams);
  if ((row?.n ?? 0) + more > FREE[what]) throw licenseRequired(what);
}

export const readOnlyError = () =>
  new AppError(
    'read_only',
    'Agentome is read-only: it is over Free without a license key that holds. You can look at everything, but nothing runs or changes until an admin adds a license key in Admin → License or cuts it back to Free.',
  );

/** Throws read_only while the installation is over Free without a key: before anything runs. */
export async function requireWritable(db: Store): Promise<void> {
  if ((await licenseState(db)).status === 'read_only') throw readOnlyError();
}

/** Whether a refusal to queue a run is one a job should pass over rather than fail on. */
export const refusesRun = (error: unknown) =>
  error instanceof AppError && (error.code === 'budget_reached' || error.code === 'read_only');

// Writes that go on in read-only: signing in and out, a license key, a seat's work on runs
// already going and its log lines, and a person's own push subscriptions. A code host's news of
// change requests comes to /webhooks, outside the API.
const WRITABLE = [
  /^\/api\/auth\//,
  /^\/api\/setup$/,
  /^\/api\/admin\/license$/,
  /^\/api\/runs\/:id\/(events|finish|heartbeat)$/,
  /^\/api\/seats\/logs$/,
  /^\/api\/me\/push\//,
];

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * Whether a write only takes the installation back towards Free: archiving an agent,
 * removing a team, moving an agent back to computers, taking a monthly budget off. Read-only lets
 * these through, so a company can cut back instead of waiting for a key.
 */
function cutsBack(method: string, path: string, body: unknown): boolean {
  if (method === 'POST' && path === '/api/agents/:id/archive') return true;
  if (method === 'DELETE' && path === '/api/teams/:id') return true;
  const changes = record(body);
  const keys = Object.keys(changes);
  if (keys.length === 0) return false;
  if (method === 'PATCH' && path === '/api/agents/:id') {
    return keys.every(
      (key) =>
        (key === 'runsOn' && changes.runsOn === 'laptop') ||
        (key === 'budget' &&
          (changes.budget === null || record(changes.budget).usdPerMonth == null)),
    );
  }
  if (method === 'PATCH' && path === '/api/projects/:id') {
    return keys.every((key) => key === 'usdPerMonth' && changes.usdPerMonth === null);
  }
  return false;
}

/** A preHandler: read_only for every other write to the API while the installation is over Free without a key. */
export function readOnlyGate(db: Db) {
  return async (request: FastifyRequest) => {
    if (READS.has(request.method)) return;
    // The route the router matched, as the setup gate goes by.
    const path = request.routeOptions.url ?? request.url.split('?', 1)[0] ?? '';
    if (!path.startsWith('/api/') || WRITABLE.some((pattern) => pattern.test(path))) return;
    if (cutsBack(request.method, path, request.body)) {
      // The state is read again after it: cut back to Free, the installation works at once.
      forgetLicense();
      return;
    }
    await requireWritable(db);
  };
}
