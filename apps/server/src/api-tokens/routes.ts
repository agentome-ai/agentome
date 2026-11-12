import { and, apiTokens, type Db, desc, eq, isNull } from '@agentome/db';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { browserOnly } from '../auth.js';
import { AppError } from '../errors.js';
import { newToken } from '../tokens.js';
import { IdParams } from '../protocol.js';

// A person's own tokens: made and revoked from the browser only, so a token that
// leaked cannot mint more of itself. The token is in the answer that creates it and nowhere
// after: the database keeps its hash.

const Name = z.string().trim().min(1).max(80);
const Scope = z.enum(['read', 'write']);
const Iso = z.iso.datetime();
const TokenView = z.object({
  id: z.uuid(),
  name: Name,
  scope: Scope,
  createdAt: Iso,
  expiresAt: Iso.nullable(),
  lastUsedAt: Iso.nullable(),
});
const DAY = 24 * 60 * 60 * 1000;

const iso = (date: Date | null) => date?.toISOString() ?? null;
const view = (row: typeof apiTokens.$inferSelect) => ({
  id: row.id,
  name: row.name,
  scope: row.scope,
  createdAt: row.createdAt.toISOString(),
  expiresAt: iso(row.expiresAt),
  lastUsedAt: iso(row.lastUsedAt),
});

export const apiTokenRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  const own = (userId: string) => and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt));
  // Signed in with a token: it may act as the person everywhere but here.
  app.addHook('onRequest', app.requireSession);
  app.addHook('onRequest', async (request) => browserOnly(request));

  app.get(
    '/api/me/tokens',
    {
      schema: {
        summary: "The person's own tokens that are not revoked, expired ones too, newest first",
        response: { 200: z.object({ tokens: z.array(TokenView) }) },
      },
    },
    async (request) => {
      const rows = await db
        .select()
        .from(apiTokens)
        .where(own(request.user.id))
        .orderBy(desc(apiTokens.createdAt));
      return { tokens: rows.map(view) };
    },
  );

  app.post(
    '/api/me/tokens',
    {
      schema: {
        summary: 'Creates a token that acts as the person; the token is in this answer only',
        body: z.object({
          name: Name,
          scope: Scope.default('write').describe('read: the token passes only requests that read'),
          expiresInDays: z
            .int()
            .min(1)
            .max(365)
            .nullable()
            .default(30)
            .describe('Days until the token stops working, up to a year; null never expires'),
        }),
        response: { 201: TokenView.extend({ token: z.string() }) },
      },
    },
    async (request, reply) => {
      const { token, hash } = newToken();
      const { name, scope, expiresInDays } = request.body;
      const expiresAt = expiresInDays === null ? null : new Date(Date.now() + expiresInDays * DAY);
      const [row] = await db
        .insert(apiTokens)
        .values({ userId: request.user.id, name, scope, expiresAt, tokenHash: hash })
        .returning();
      if (!row) throw new Error('The token was not inserted');
      return reply.code(201).send({ ...view(row), token });
    },
  );

  app.delete(
    '/api/me/tokens/:id',
    {
      schema: {
        summary: 'Revokes a token; whatever holds it is signed out at once',
        params: IdParams,
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const [gone] = await db
        .update(apiTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(apiTokens.id, request.params.id), own(request.user.id)))
        .returning({ id: apiTokens.id });
      if (!gone) throw new AppError('not_found', 'Token not found');
      return reply.code(204).send(null);
    },
  );
};
