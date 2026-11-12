import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appFor, REFUSING_DATABASE } from './app.js';

const page = '<!doctype html><div id="root"></div>';
const browser = { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' };
let dir: string;
let app: Awaited<ReturnType<typeof appFor>>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentome-web-'));
  const web = join(dir, 'web');
  mkdirSync(join(web, 'assets'), { recursive: true });
  writeFileSync(join(web, 'index.html'), page);
  writeFileSync(join(web, 'assets', 'index-4f2a9c.js'), 'export {};\n');
  writeFileSync(join(web, 'robots.txt'), 'User-agent: *\n');
  writeFileSync(join(web, '.env'), 'TOKEN=hunter2\n');
  writeFileSync(join(dir, 'outside.txt'), 'not part of the app\n');
  // These routes never query the database.
  app = await appFor(REFUSING_DATABASE, join(dir, 'data'), { AGENTOME_WEB_DIR: web });
  await app.listen({ host: '127.0.0.1', port: 0 });
});

afterAll(async () => {
  await app?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** GET with the path sent exactly as written: inject() resolves dot segments first. */
function rawGet(path: string): Promise<{ status: number; body: string }> {
  const { port } = app.server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => (body += chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    })
      .on('error', reject)
      .end();
  });
}

describe('the web app', () => {
  it.each(['/', '/setup', '/agents/123', '/agents/123/'])(
    'answers a browser asking for %s with index.html, revalidated on every load',
    async (url) => {
      const response = await app.inject({ method: 'GET', url, headers: browser });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/^text\/html/);
      expect(response.headers['cache-control']).toBe('no-cache');
      expect(response.headers.etag).toBeDefined();
      expect(response.body).toBe(page);
    },
  );

  it('answers HEAD like GET, without a body', async () => {
    const response = await app.inject({ method: 'HEAD', url: '/setup', headers: browser });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^text\/html/);
    expect(response.body).toBe('');
  });

  it('serves the hashed assets with a cache that never expires', async () => {
    const response = await app.inject({ method: 'GET', url: '/assets/index-4f2a9c.js' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/javascript/);
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('revalidates the files outside assets/', async () => {
    const response = await app.inject({ method: 'GET', url: '/robots.txt' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-cache');
  });

  // A health probe or an API client that got the path wrong must see a miss, not a page.
  it.each(['/setup', '/healthz', '/agents/123'])(
    'answers %s without Accept: text/html with a JSON 404',
    async (url) => {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'not_found' } });
    },
  );

  it.each(['/api', '/api/nope', '/ready/', '/health/live', '/openapi.json/', '/webhooks/gitlab'])(
    'keeps %s to the server: a JSON 404 even for a browser',
    async (url) => {
      const response = await app.inject({ method: 'GET', url, headers: browser });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        error: { code: 'not_found', message: `Route GET ${url} not found` },
      });
    },
  );

  it.each([
    '/assets/missing.js',
    '/.env',
    '/assets/../.env',
    '/%2e%2e/outside.txt',
    '/assets/%2e%2e/%2e%2e/outside.txt',
    '//outside.txt',
    '/foo%5Cbar.js',
    '/assets%5Cindex-4f2a9c.js',
    '/robots.txt%00.js',
  ])('answers %s with a JSON 404, not with a file', async (path) => {
    const response = await rawGet(path);
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: 'not_found' } });
  });

  it('loads the app for GET only', async () => {
    const response = await app.inject({ method: 'POST', url: '/setup', headers: browser });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('leaves the routes of the server to themselves and out of the OpenAPI document', async () => {
    expect((await app.inject({ method: 'GET', url: '/health' })).json()).toEqual({
      status: 'ok',
    });
    const document: { paths: Record<string, unknown> } = (
      await app.inject({ method: 'GET', url: '/openapi.json' })
    ).json();
    expect(Object.keys(document.paths)).toContain('/health');
    expect(Object.keys(document.paths)).not.toContain('/*');
  });

  it('answers a Range past the end of a file as the client error it is', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/robots.txt',
      headers: { range: 'bytes=1000-2000' },
    });
    expect(response.statusCode).toBe(416);
    expect(response.headers['content-range']).toBe('bytes */14');
    expect(response.headers['cache-control']).toBeUndefined();
    expect(response.json()).toEqual({
      error: { code: 'bad_request', message: 'Range Not Satisfiable' },
    });
  });
});
