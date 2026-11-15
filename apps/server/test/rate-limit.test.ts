import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { appFor, REFUSING_DATABASE } from './app.js';

describe('the API, called too often', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agentome-rate-'));
  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

  it('counts each address on its own, 1200 calls a minute, and not health', async () => {
    const app = await appFor(REFUSING_DATABASE, dataDir);
    try {
      const call = (address: string) =>
        app.inject({ url: '/api/seats/claim', remoteAddress: address });
      const first = await call('192.0.2.10');
      expect(first.headers['x-ratelimit-limit']).toBe('1200');
      expect(first.headers['x-ratelimit-remaining']).toBe('1199');
      expect((await call('192.0.2.10')).headers['x-ratelimit-remaining']).toBe('1198');
      expect((await call('192.0.2.11')).headers['x-ratelimit-remaining']).toBe('1199');
      const health = await app.inject({ url: '/health', remoteAddress: '192.0.2.10' });
      expect(health.headers['x-ratelimit-limit']).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
