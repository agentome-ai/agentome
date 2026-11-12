import { sep } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyError, FastifyPluginAsync } from 'fastify';
import { errorHandler } from './errors.js';

// Vite names the files in assets/ after a hash of their contents: a changed file gets a new
// URL, so the old one can be cached for good. index.html names the current files, so it is
// revalidated on every load, which its ETag turns into a 304 while nothing has changed.
const FOREVER = 'public, max-age=31536000, immutable';
const REVALIDATE = 'no-cache';

// First segments that belong to the server, now or in later slices (webhooks, the git proxy,
// the MCP gateway, the connect script): below them a miss is a JSON 404, never the web app.
const SERVER_PATHS = new Set([
  'api',
  'health',
  'ready',
  'openapi.json',
  'webhooks',
  'git',
  'mcp',
  'connect',
]);

/**
 * The built web app: its files as they are, and index.html for a browser asking for a page
 * whose last segment has no extension, so that the app's own routes (/setup, /agents/…) load.
 * Anything else, a probe of /healthz or an API client off by a slash, gets the JSON 404.
 */
export const webApp: FastifyPluginAsync<{ root: string }> = async (app, { root }) => {
  const assets = `${root}${sep}assets${sep}`;
  // The route below decides what is a file and what is a page of the app.
  await app.register(fastifyStatic, { root, serve: false, index: false, dotfiles: 'ignore' });

  // Only on a file actually sent (@fastify/static puts its path on the stream): an error
  // answer must not be cached for a year.
  app.addHook('onSend', async (_request, reply, payload) => {
    const path: unknown =
      payload !== null && typeof payload === 'object' && Reflect.get(payload, 'path');
    if (reply.statusCode < 400 && typeof path === 'string') {
      reply.header('cache-control', path.startsWith(assets) ? FOREVER : REVALIDATE);
    }
    return payload;
  });

  // @fastify/static and @fastify/send turn down a path that is not canonical or that leaves
  // the directory (`..`, `//`, a backslash, NUL) with a 400 or a 403. No file of the app has
  // such a name, so the answer is the app's own 404. Other refusals keep their headers: a 416
  // names the length of the file in Content-Range.
  app.setErrorHandler(
    (error: FastifyError & { headers?: Record<string, string> }, request, reply) => {
      if (error.statusCode === 400 || error.statusCode === 403) return reply.callNotFound();
      if (error.headers) reply.headers(error.headers);
      return errorHandler(error, request, reply);
    },
  );

  app.get<{ Params: { '*': string } }>('/*', { schema: { hide: true } }, (request, reply) => {
    const path = request.params['*'];
    if (SERVER_PATHS.has(path.split('/', 1)[0] ?? '')) return reply.callNotFound();
    if (path.slice(path.lastIndexOf('/') + 1).includes('.')) return reply.sendFile(`/${path}`);
    if (request.headers.accept?.includes('text/html')) return reply.sendFile('index.html');
    return reply.callNotFound();
  });
};
