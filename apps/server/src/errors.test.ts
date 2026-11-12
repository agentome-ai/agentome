import { DrizzleQueryError } from '@agentome/db';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loggerOptions } from './app.js';
import { AppError, errorHandler, notFoundHandler } from './errors.js';

const app = Fastify().withTypeProvider<ZodTypeProvider>();
app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);
app.setErrorHandler(errorHandler);
app.setNotFoundHandler(notFoundHandler);
app.post('/agents', { schema: { body: z.object({ name: z.string() }) } }, () => ({ ok: true }));
app.get('/agents/42', () => {
  throw new AppError('not_found', 'Agent 42 not found', { agentId: '42' });
});
app.get('/crash', () => {
  throw new Error('connect ECONNREFUSED postgres://agentome:hunter2@db:5432');
});
app.get('/upstream', () => {
  throw Object.assign(new Error('GitLab answered 401 for token glpat-hunter2'), {
    statusCode: 401,
  });
});
// What http-errors makes of a 4xx, as @fastify/send throws for a Range past the end of a file.
app.get('/range', () => {
  throw Object.assign(new Error('Range Not Satisfiable'), { statusCode: 416, expose: true });
});

afterAll(() => app.close());

describe('errorHandler', () => {
  it('answers an AppError with its status, code, message and details', async () => {
    const response = await app.inject({ method: 'GET', url: '/agents/42' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: 'not_found', message: 'Agent 42 not found', details: { agentId: '42' } },
    });
  });

  it('answers a request that fails its zod schema with 400 validation_failed', async () => {
    const response = await app.inject({ method: 'POST', url: '/agents', payload: { name: 7 } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: 'validation_failed',
        message: 'The request is not valid',
        details: [{ path: 'body/name', message: expect.stringContaining('expected string') }],
      },
    });
  });

  it('answers malformed JSON with 400 bad_request rather than a server error', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/agents',
      headers: { 'content-type': 'application/json' },
      payload: '{"name":',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'bad_request' } });
  });

  it('hides the message and stack of an unexpected error', async () => {
    const response = await app.inject({ method: 'GET', url: '/crash' });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: 'internal', message: 'Internal server error' },
    });
    expect(response.body).not.toContain('hunter2');
  });

  it('does not pass on the status and message of a library error', async () => {
    const response = await app.inject({ method: 'GET', url: '/upstream' });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: 'internal', message: 'Internal server error' },
    });
  });

  it('answers a 4xx that a library exposes as bad_request with its status', async () => {
    const response = await app.inject({ method: 'GET', url: '/range' });
    expect(response.statusCode).toBe(416);
    expect(response.json()).toEqual({
      error: { code: 'bad_request', message: 'Range Not Satisfiable' },
    });
  });
});

describe('the log', () => {
  it('carries neither the parameters of a failed query nor a token in the path', async () => {
    const lines: string[] = [];
    const logged = Fastify({
      logger: { ...loggerOptions('info'), stream: { write: (line: string) => lines.push(line) } },
    });
    logged.setErrorHandler(errorHandler);
    logged.get('/api/invitations/:token', () => {
      const cause = Object.assign(new Error('canceling statement due to statement timeout'), {
        code: '57014',
      });
      throw new DrizzleQueryError('select * from users where email = $1', ['ann@x.com'], cause);
    });
    const token = 'k'.repeat(43);
    const response = await logged.inject({ method: 'GET', url: `/api/invitations/${token}` });
    await logged.close();

    expect(response.statusCode).toBe(500);
    const log = lines.join('');
    expect(log).toContain('Failed query: select * from users where email = $1');
    expect(log).toContain('57014');
    expect(log).toContain('/api/invitations/[redacted]');
    expect(log).not.toContain('ann@x.com');
    expect(log).not.toContain(token);
  });
});

describe('notFoundHandler', () => {
  it('answers an unknown route with 404 not_found in the same format', async () => {
    const response = await app.inject({ method: 'GET', url: '/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: 'not_found', message: 'Route GET /nope not found' },
    });
  });
});
