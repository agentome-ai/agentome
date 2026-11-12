import { readFileSync } from 'node:fs';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from './index.js';
import { migrate } from './migrate.js';

const journal: { entries: { when: number }[] } = JSON.parse(
  readFileSync(new URL('../migrations/meta/_journal.json', import.meta.url), 'utf8'),
);

let container: StartedPostgreSqlContainer;
let db: Db;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  db = createDb(container.getConnectionUri(), () => {});
}, 120_000);

afterAll(async () => {
  await db?.$client.end();
  await container?.stop();
});

async function appliedMigrations() {
  const rows = await db.execute<{ count: number }>(
    sql`select count(*)::int as count from drizzle.__drizzle_migrations`,
  );
  return rows[0]?.count;
}

describe('migrate', () => {
  it('applies every migration once when several instances start at the same time', async () => {
    const url = container.getConnectionUri();
    await Promise.all([migrate(url), migrate(url), migrate(url)]);

    expect(await appliedMigrations()).toBe(journal.entries.length);
    const tables = await db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`,
    );
    expect(tables.map((row) => row.table_name)).toEqual([
      'accounts',
      'agent_grants',
      'agent_memory_docs',
      'agents',
      'api_tokens',
      'catalog_items',
      'cost_events',
      'installation',
      'invitations',
      'knowledge_documents',
      'knowledge_sources',
      'log_entries',
      'mcp_authorizations',
      'model_connections',
      'notifications',
      'pairing_codes',
      'project_agents',
      'project_connections',
      'projects',
      'push_subscriptions',
      'run_artifacts',
      'run_events',
      'runs',
      'schedules',
      'seats',
      'sessions',
      'task_comments',
      'tasks',
      'team_members',
      'teams',
      'tool_calls',
      'users',
      'verifications',
      'webhook_deliveries',
    ]);
  });

  it('does nothing when the database is up to date', async () => {
    await migrate(container.getConnectionUri());
    expect(await appliedMigrations()).toBe(journal.entries.length);
  });

  it('leaves alone a database built by the migrations the baseline replaced', async () => {
    // The baseline carries the time of the last of them, and a migration is applied only when
    // it is later than the last one the database has. That time must never be raised: a
    // database from before the baseline would then be given every table a second time.
    const LAST_BEFORE_THE_BASELINE = 1794172992637;
    expect(journal.entries[0]?.when).toBe(LAST_BEFORE_THE_BASELINE);

    await db.execute(sql`create database before_baseline`);
    const url = new URL(container.getConnectionUri());
    url.pathname = '/before_baseline';
    const old = createDb(url.href, () => {});
    try {
      await old.execute(sql`create schema drizzle`);
      await old.execute(
        sql`create table drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)`,
      );
      await old.execute(
        sql`insert into drizzle.__drizzle_migrations (hash, created_at) values ('the last of the old ones', ${LAST_BEFORE_THE_BASELINE})`,
      );
      // What the migrations after the baseline change, as the old ones left it.
      await old.execute(sql`create table public.seats (id uuid primary key)`);
      await migrate(url.href);
      // The baseline is skipped; only the migrations after it are applied.
      const applied = await old.execute<{ count: number }>(
        sql`select count(*)::int as count from drizzle.__drizzle_migrations`,
      );
      expect(applied[0]?.count).toBe(journal.entries.length);
      const tables = await old.execute(
        sql`select 1 from information_schema.tables where table_schema = 'public'`,
      );
      expect(tables).toHaveLength(1);
    } finally {
      await old.$client.end();
    }
  });
});
