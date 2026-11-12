import { afterEach, describe, expect, it, vi } from 'vitest';
import { pgEnvironment } from './cli.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('pgEnvironment', () => {
  it('hands the tools the database of the URL, the password included', async () => {
    const env = await pgEnvironment('postgres://agentome:s3cret@postgres:5432/agentome');
    expect(env).toMatchObject({
      PGHOST: 'postgres',
      PGPORT: '5432',
      PGUSER: 'agentome',
      PGDATABASE: 'agentome',
      PGPASSWORD: 's3cret',
    });
  });

  it('reads the URL as postgres.js does: several hosts, encoded and raw @ in the password', async () => {
    const env = await pgEnvironment(
      'postgresql://app:50%25off@db1:5432,db2:5433/app?sslmode=require',
    );
    expect(env).toMatchObject({
      PGHOST: 'db1,db2',
      PGPORT: '5432,5433',
      PGPASSWORD: '50%off',
      PGSSLMODE: 'require',
    });
    const raw = await pgEnvironment('postgres://agentome:Secr@t42@postgres:5432/agentome');
    expect(raw).toMatchObject({ PGHOST: 'postgres', PGPASSWORD: 'Secr@t42' });
  });

  // compose.yaml passes the password this way, out of the URL.
  it('keeps the PGPASSWORD of the environment for a URL without one', async () => {
    vi.stubEnv('PGPASSWORD', 'from-compose');
    const env = await pgEnvironment('postgres://agentome@postgres:5432/agentome');
    expect(env.PGPASSWORD).toBe('from-compose');
  });
});
