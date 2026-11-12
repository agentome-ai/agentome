import { readFileSync } from 'node:fs';
import { type DrizzleSnapshotJSON, generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { describe, expect, it } from 'vitest';
import * as schema from './schema.js';

const meta = new URL('../migrations/meta/', import.meta.url);
const readJson = (name: string): unknown => JSON.parse(readFileSync(new URL(name, meta), 'utf8'));

describe('the committed migrations', () => {
  // Without this, a schema or enum edit made without `pnpm generate` passes every other
  // check and fails only when a query touches the missing column or value.
  it('describe the current schema', async () => {
    const journal = readJson('_journal.json') as { entries: { idx: number }[] };
    const last = journal.entries.at(-1)?.idx ?? 0;
    const snapshot = readJson(
      `${String(last).padStart(4, '0')}_snapshot.json`,
    ) as DrizzleSnapshotJSON;
    const current = generateDrizzleJson(schema, snapshot.id);
    expect(await generateMigration(snapshot, current)).toEqual([]);
  });
});
