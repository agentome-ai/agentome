import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate as applyMigrations } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

// "agentome" typed on a phone keypad. Any constant works, but it must never change:
// instances of different versions that start at the same time have to wait for each other.
const MIGRATION_LOCK_ID = 24_368_663;

/** Applies pending migrations. Safe to call from several instances at once. */
export async function migrate(databaseUrl: string): Promise<void> {
  // A single connection that is never recycled: the advisory lock belongs to the session
  // that took it, so the migrations have to run in that session too, even after a long wait
  // for the lock. Closing the session releases the lock.
  const client = postgres(databaseUrl, { max: 1, max_lifetime: null, onnotice: () => {} });
  try {
    await client`select pg_advisory_lock(${MIGRATION_LOCK_ID})`;
    await applyMigrations(drizzle(client), { migrationsFolder });
  } finally {
    await client.end();
  }
}
