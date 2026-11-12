import { createHash } from 'node:crypto';
import { type Db, eq, projects } from '@agentome/db';
import { codeHostOf, projectConnectionFor } from '../connections/service.js';
import { AppError } from '../errors.js';
import type { Tx } from '../runs/service.js';
import { ProjectEnvironment, readEnvironmentFrom, type ServiceSpec } from './devcontainer.js';

// A project's environment: the services its main repository's devcontainer asks for, read from
// the code host when a person asks, and approved by an admin before any place runs them, since
// they are images of whoever can push to the repository, run on the company's server.

/** The fingerprint of a list of services: the same list, the same hash. */
export const servicesHash = (services: ServiceSpec[]) =>
  createHash('sha256').update(JSON.stringify(services)).digest('hex');

/** The environment as a project's page shows it: what was read, and whether it may run. */
export function environmentView(row: { environment: unknown; environmentApproved: string | null }) {
  const parsed = ProjectEnvironment.safeParse(row.environment);
  if (!parsed.success) return null;
  const environment = parsed.data;
  return {
    ...environment,
    approved: environment.services.length > 0 && environment.hash === row.environmentApproved,
  };
}

/**
 * Reads the project's environment from its main repository, the first of its list, and keeps
 * it. What the host refuses is kept as a problem for a person to read. A changed list of
 * services needs an admin's approval again; the same list keeps it.
 */
export async function readProjectEnvironment(db: Db, key: Buffer, projectId: string) {
  const [project] = await db
    .select({ repositories: projects.repositories })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!project) throw new AppError('not_found', 'Project not found');
  const repository = project.repositories[0];
  if (!repository) {
    await db.update(projects).set({ environment: null }).where(eq(projects.id, projectId));
    return;
  }
  let read: Omit<ProjectEnvironment, 'readAt' | 'hash'>;
  try {
    const connection = await projectConnectionFor(db, projectId, repository);
    if (!connection) throw new Error(`No connection of the project reaches ${repository}`);
    read = await readEnvironmentFrom(await codeHostOf(db, key, connection.id), repository);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    read = { repository, devcontainer: null, services: [], problems: [message] };
  }
  const environment: ProjectEnvironment = {
    ...read,
    readAt: new Date().toISOString(),
    hash: servicesHash(read.services),
  };
  await db.update(projects).set({ environment }).where(eq(projects.id, projectId));
}

/** An admin lets the services they saw run: refused when the list has changed since. */
export async function approveEnvironment(db: Db, projectId: string, hash: string) {
  const [project] = await db
    .select({ environment: projects.environment })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!project) throw new AppError('not_found', 'Project not found');
  const current = ProjectEnvironment.safeParse(project.environment);
  if (!current.success || current.data.services.length === 0) {
    throw new AppError('validation_failed', 'This project has no services to approve');
  }
  if (current.data.hash !== hash) {
    throw new AppError(
      'environment_changed',
      'The services changed since you saw them: read them again before you approve',
    );
  }
  await db.update(projects).set({ environmentApproved: hash }).where(eq(projects.id, projectId));
}

/** The services a place runs for a project: only an approved list, and none without one. */
export async function approvedServices(
  db: Db | Tx,
  projectId: string,
): Promise<{ hash: string; services: ServiceSpec[] } | null> {
  const [project] = await db
    .select({ environment: projects.environment, approved: projects.environmentApproved })
    .from(projects)
    .where(eq(projects.id, projectId));
  const parsed = ProjectEnvironment.safeParse(project?.environment);
  if (!parsed.success || parsed.data.services.length === 0) return null;
  if (parsed.data.hash !== project?.approved) return null;
  return { hash: parsed.data.hash, services: parsed.data.services };
}
