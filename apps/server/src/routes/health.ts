import { type Db, sql } from '@agentome/db';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../errors.js';

// A probe that hangs tells nothing: a database that stalls or drops packets must turn into
// a 503 quickly, not after the driver's 30-second connect timeout or never.
const READY_TIMEOUT_MS = 2000;

const Ok = z.object({ status: z.literal('ok') });

export const healthRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.get(
    '/health',
    { schema: { summary: 'Answers while the process is alive', response: { 200: Ok } } },
    async () => ({ status: 'ok' as const }),
  );

  app.get(
    '/ready',
    { schema: { summary: 'Answers when the database does', response: { 200: Ok } } },
    async () => {
      try {
        await withTimeout(db.execute(sql`select 1`), READY_TIMEOUT_MS);
      } catch (error) {
        throw new AppError('not_ready', 'The database is not reachable', undefined, {
          cause: error,
        });
      }
      return { status: 'ok' as const };
    },
  );
};

async function withTimeout<T>(work: PromiseLike<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`No answer within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
