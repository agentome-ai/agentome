import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appFor, REFUSING_DATABASE } from './app.js';

type Operation = { tags?: string[]; security?: Record<string, string[]>[] };
type Spec = {
  info: { version: string };
  tags: { name: string }[];
  paths: Record<string, Record<string, Operation>>;
  components: { securitySchemes: Record<string, unknown> };
};

describe('GET /openapi.json', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agentome-openapi-'));
  let spec: Spec;

  beforeAll(async () => {
    const app = await appFor(REFUSING_DATABASE, dataDir, { AGENTOME_BUILD_VERSION: '9.8.7' });
    spec = (await app.inject('/openapi.json')).json<Spec>();
    await app.close();
  });
  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

  const operation = (method: string, path: string) => spec.paths[path]?.[method];

  it('describes the release the server was built from', () => {
    expect(spec.info.version).toBe('9.8.7');
  });

  it('puts every call in one of its sections', () => {
    const sections = new Set(spec.tags.map((tag) => tag.name));
    for (const operations of Object.values(spec.paths)) {
      for (const op of Object.values(operations)) {
        expect(op.tags).toHaveLength(1);
        expect(sections).toContain(op.tags?.[0]);
      }
    }
    expect(operation('post', '/api/tasks')?.tags).toEqual(['Tasks']);
    expect(operation('get', '/api/me/place')?.tags).toEqual(['Places']);
    expect(operation('get', '/api/me/tokens')?.tags).toEqual(['You']);
    expect(operation('post', '/api/users/{id}/transfer-agents')?.tags).toEqual(['People']);
  });

  it('says who may call: a person by default, nobody signed in, or a worker', () => {
    expect(Object.keys(spec.components.securitySchemes)).toEqual(['token', 'session', 'seat']);
    expect(operation('get', '/api/agents')?.security).toBeUndefined();
    expect(operation('get', '/health')?.security).toEqual([]);
    expect(operation('post', '/api/invitations/{token}/accept')?.security).toEqual([]);
    expect(operation('post', '/api/runs/{id}/heartbeat')).toMatchObject({
      tags: ['Worker'],
      security: [{ seat: [] }],
    });
    // Reading a run's events is a person's; appending them is the worker's.
    expect(operation('get', '/api/runs/{id}/events')?.tags).toEqual(['Runs']);
  });
});
