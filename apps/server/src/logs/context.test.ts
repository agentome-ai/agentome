import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { loggerOptions } from '../app.js';
import { runWithLog, tagLog } from './context.js';

describe('the log context', () => {
  it('gives each line of a request its trace and none of an earlier line’s fields', async () => {
    const lines: Record<string, unknown>[] = [];
    const app = Fastify({
      logger: {
        ...loggerOptions('info'),
        stream: {
          write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>),
        },
      },
    });
    app.addHook('onRequest', (request, _reply, done) =>
      runWithLog({ traceId: request.id, route: 'POST /events' }, done),
    );
    app.post('/events', (request) => {
      tagLog({ runId: 'r1' });
      request.log.info({ host: 'a.example', rule: 'a.example', sent: 10 }, 'reached');
      request.log.warn({ host: 'b.example', reason: 'not-listed' }, 'refused');
      return null;
    });
    await app.inject({ method: 'POST', url: '/events' });
    await app.close();

    const refused = lines.find((line) => line.msg === 'refused');
    expect(refused).toMatchObject({ route: 'POST /events', runId: 'r1', host: 'b.example' });
    expect(refused).not.toHaveProperty('rule');
    expect(refused).not.toHaveProperty('sent');
  });
});
