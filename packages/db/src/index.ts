import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

export * from './schema.js';
export { migrate } from './migrate.js';
// Drizzle from here is the copy the schema was built with. pnpm installs drizzle-orm once per
// set of optional peers it finds (kysely through better-auth, pg through pg-boss), and the
// types of two copies do not mix; at run time they do, by global symbols.
export * from 'drizzle-orm';

/**
 * A connection pool with Drizzle on top; close it with `db.$client.end()`. Server notices
 * (a collation warning after an upgrade, say) go to `onNotice`: by default postgres.js
 * prints them with console.log, in the middle of the JSON log.
 */
export function createDb(databaseUrl: string, onNotice: (notice: postgres.Notice) => void) {
  return drizzle(postgres(databaseUrl, { onnotice: onNotice }));
}

export type Db = ReturnType<typeof createDb>;
