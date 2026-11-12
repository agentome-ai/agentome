import { createDb, type Db, installation } from '@agentome/db';
import { hashPassword } from 'better-auth/crypto';
import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { seedTemplates } from './agents/templates.js';
import { seedSkills } from './library/skills.js';
import { type Auth, deriveKey, signIn } from './auth.js';
import { type Config, ConfigError, Password } from './config.js';
import { AppError } from './errors.js';
import { isSetupCode, setupCode } from './setup-code.js';
import { Email, insertUser, Name, toUser, User } from './routes/users.js';
import { keycloakAllowed } from './license/service.js';

const SetupBody = z.object({
  code: z.string().max(64),
  orgName: Name,
  baseUrl: z.url({ protocol: /^https?$/ }).optional(),
  admin: z.object({ name: Name, email: Email, password: Password }),
});
type SetupInput = Omit<z.infer<typeof SetupBody>, 'code'>;

/** Stored at setup; a different value at start means the secret key was replaced. */
export const keyFingerprint = (secretKey: string) => deriveKey(secretKey, 'key-fingerprint');

async function isSetupComplete(db: Db): Promise<boolean> {
  const rows = await db.select({ id: installation.id }).from(installation);
  return rows.length > 0;
}

const alreadyComplete = () =>
  new AppError('setup_completed', 'The setup is already complete. Sign in instead.');

/** Creates the installation and its first admin in one transaction. */
async function completeSetup(db: Db, config: Config, input: SetupInput) {
  // Before the hash, so that a request after the setup costs no scrypt work.
  if (await isSetupComplete(db)) throw alreadyComplete();
  const passwordHash = await hashPassword(input.admin.password);
  return db.transaction(async (tx) => {
    // The single-row key settles a race: of two setups at once, the second inserts nothing.
    const created = await tx
      .insert(installation)
      .values({
        orgName: input.orgName,
        baseUrl: input.baseUrl ?? config.publicUrl,
        secretKeyFingerprint: keyFingerprint(config.secretKey),
      })
      .onConflictDoNothing()
      .returning({ id: installation.id });
    if (created.length === 0) throw alreadyComplete();
    return insertUser(tx, { ...input.admin, role: 'admin', passwordHash, emailVerified: true });
  });
}

/**
 * Runs at start, after the migrations: refuses a secret key other than the one the
 * installation was set up with, brings the platform's role templates up to date, and
 * completes the setup from AGENTOME_SETUP_ADMIN_* if asked.
 */
export async function prepareInstallation(config: Config, log: FastifyBaseLogger) {
  const db = createDb(config.databaseUrl, (notice) => log.warn({ notice }, 'database notice'));
  try {
    const [row] = await db
      .select({ fingerprint: installation.secretKeyFingerprint })
      .from(installation);
    if (row && row.fingerprint !== keyFingerprint(config.secretKey)) {
      throw new ConfigError(
        'The secret key changed; restore AGENTOME_SECRET_KEY or the secrets volume',
      );
    }
    await seedTemplates(db);
    await seedSkills(db);
    if (!row && !config.setupAdmin) {
      log.info(
        `Complete the setup at ${config.publicUrl.replace(/\/$/, '')}/setup with the setup code ${setupCode(config.secretKey)}`,
      );
    }
    if (!row && config.setupAdmin) {
      const { orgName, email, password } = config.setupAdmin;
      const admin = { name: 'Administrator', email, password };
      await completeSetup(db, config, { orgName, admin }).then(
        () => log.info('completed the setup with the administrator from AGENTOME_SETUP_ADMIN_*'),
        (error: unknown) => {
          // Another instance, starting at the same moment, completed it first.
          if (!(error instanceof AppError && error.code === 'setup_completed')) throw error;
        },
      );
    }
  } finally {
    await db.$client.end({ timeout: 5 });
  }
}

/** Until the setup completes, every API route but the setup's answers 409 setup_required. */
export function setupGate(db: Db) {
  let complete = false;
  return async (request: FastifyRequest) => {
    if (complete) return;
    // The route the router matched, not the raw URL, which may be percent-encoded.
    const path = request.routeOptions.url ?? request.url.split('?', 1)[0] ?? '';
    if (!path.startsWith('/api/') || path === '/api/setup') return;
    // Once complete, always complete: the installation row is never deleted.
    complete = await isSetupComplete(db);
    if (!complete) throw new AppError('setup_required', 'Complete the setup at /setup first');
  };
}

export const setupRoutes: FastifyPluginAsyncZod<{ db: Db; auth: Auth; config: Config }> = async (
  app,
  { db, auth, config },
) => {
  app.get(
    '/api/setup',
    {
      schema: {
        summary: 'Whether the setup is complete, and whether people can sign in with Keycloak',
        response: { 200: z.object({ completed: z.boolean(), keycloak: z.boolean() }) },
      },
    },
    async () => ({
      completed: await isSetupComplete(db),
      // Keycloak is Enterprise: the sign-in page offers it once a key has been in.
      keycloak: config.keycloak !== undefined && (await keycloakAllowed(db)),
    }),
  );

  app.post(
    '/api/setup',
    {
      schema: {
        summary:
          "Completes the setup with the setup code from the server's log: the company and its first admin, who is signed in",
        body: SetupBody,
        response: { 201: User },
      },
    },
    async (request, reply) => {
      const { code, ...input } = request.body;
      if (await isSetupComplete(db)) throw alreadyComplete();
      if (!isSetupCode(config.secretKey, code)) {
        const message = "This is not the setup code. Find it in the server's log.";
        throw new AppError('validation_failed', message, [{ path: 'body/code', message }]);
      }
      const user = await completeSetup(db, config, input);
      await signIn(auth, request, reply, request.body.admin);
      return reply.status(201).send(toUser(user));
    },
  );
};
