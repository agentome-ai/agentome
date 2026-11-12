import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agents, createDb, type Db, eq, installation, projectAgents, projects } from '@agentome/db';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { forgetLicense, signLicense, useLicenseKey } from '../src/license/service.js';
import { setupCode } from '../src/setup-code.js';

/** Refuses connections at once: nothing listens on port 1 of localhost. */
export const REFUSING_DATABASE = 'postgres://agentome:agentome@127.0.0.1:1/agentome';

/**
 * The whole app with quiet logs, keeping its files in `dataDir`. postgres.js connects on the
 * first query only, so routes that never touch the database work with any URL.
 */
export function appFor(
  databaseUrl: string,
  dataDir: string,
  env: Record<string, string> = {},
  options: Parameters<typeof buildApp>[1] = {},
) {
  return buildApp(
    loadConfig({
      AGENTOME_DATABASE_URL: databaseUrl,
      AGENTOME_DATA_DIR: dataDir,
      AGENTOME_LOG_LEVEL: 'silent',
      ...env,
    }),
    options,
  );
}

/** The setup code of an app that keeps its secret key in `dataDir`, for POST /api/setup. */
export const setupCodeIn = (dataDir: string) =>
  setupCode(readFileSync(join(dataDir, 'secrets', 'secret.key'), 'utf8').trim());

/** The tests' own license pair: no test signs with the owner's key, which only the owner has. */
const licensePair = generateKeyPairSync('ed25519');

/**
 * Makes an installation that has been set up Enterprise, for a suite that goes past
 * Free: more than five agents or one team, agents on the server, monthly budgets. A key that
 * ended `-days` ago, with a negative `days`.
 */
export async function licenseEnterprise(db: Pick<Db, 'update'>, days = 3650): Promise<void> {
  useLicenseKey(licensePair.publicKey);
  const key = signLicense(licensePair.privateKey, {
    id: 'tests',
    company: 'Tests',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + days * 86_400_000).toISOString(),
    agents: null,
  });
  await db.update(installation).set({ license: key });
  forgetLicense();
}

/** licenseEnterprise for a suite that keeps no connection of its own to the database. */
export async function licenseEnterpriseAt(databaseUrl: string): Promise<void> {
  const db = createDb(databaseUrl, () => {});
  try {
    await licenseEnterprise(db);
  } finally {
    await db.$client.end();
  }
}

/**
 * A project the agent is on, made straight in the database when it is on none: every new task is
 * filed in a project, and a suite about something else needs only that there is one.
 */
export async function projectOfAgent(db: Db, agentId: string): Promise<string> {
  const [on] = await db
    .select({ id: projectAgents.projectId })
    .from(projectAgents)
    .where(eq(projectAgents.agentId, agentId))
    .limit(1);
  if (on) return on.id;
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent) throw new Error(`No agent ${agentId}`);
  const [project] = await db
    .insert(projects)
    .values({ name: `Work of ${agent.name}`, createdBy: agent.ownerUserId })
    .returning({ id: projects.id });
  if (!project) throw new Error('The project was not inserted');
  await db.insert(projectAgents).values({ projectId: project.id, agentId });
  return project.id;
}
