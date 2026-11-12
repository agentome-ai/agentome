import { and, type Db, eq, pushSubscriptions } from '@agentome/db';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { browserOnly } from '../auth.js';
import { isPushEndpoint, sendTo, type Vapid } from './service.js';

// A person's devices for web push: a browser subscribes with the server's public key
// and hands over its endpoint, here, from the browser only.

/** base64url of the given number of bytes, as the Push API hands the keys over. */
const bytes = (length: number) =>
  z
    .string()
    .regex(/^[A-Za-z0-9_-]+={0,2}$/)
    .refine((text) => Buffer.from(text, 'base64url').length === length, {
      message: `Expected ${length} bytes in base64url`,
    });
const Endpoint = z
  .string()
  .max(2048)
  .refine(isPushEndpoint, { message: "Expected the https: endpoint of a browser's push service" });

export const pushRoutes: FastifyPluginAsyncZod<{ db: Db; vapid: Vapid }> = async (
  app,
  { db, vapid },
) => {
  app.addHook('onRequest', app.requireSession);
  app.addHook('onRequest', async (request) => browserOnly(request));

  app.get(
    '/api/me/push',
    {
      schema: {
        summary: "The server's public VAPID key, for a browser to subscribe with",
        response: { 200: z.object({ publicKey: z.string() }) },
      },
    },
    async () => ({ publicKey: vapid.publicKey }),
  );

  app.put(
    '/api/me/push/subscriptions',
    {
      schema: {
        summary: 'Turns notifications on for this browser: its push subscription, as it is',
        body: z.object({
          endpoint: Endpoint,
          keys: z.object({ p256dh: bytes(65), auth: bytes(16) }),
        }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const { endpoint, keys } = request.body;
      const row = { userId: request.user.id, endpoint, ...keys };
      await db
        .insert(pushSubscriptions)
        .values(row)
        .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: row });
      return reply.status(204).send(null);
    },
  );

  app.delete(
    '/api/me/push/subscriptions',
    {
      schema: {
        summary: 'Turns notifications off for this browser',
        body: z.object({ endpoint: z.string().max(2048) }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      await db
        .delete(pushSubscriptions)
        .where(
          and(
            eq(pushSubscriptions.userId, request.user.id),
            eq(pushSubscriptions.endpoint, request.body.endpoint),
          ),
        );
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/api/me/push/test',
    {
      schema: {
        summary: "Sends a test notification to the person's devices; answers how many took it",
        response: { 200: z.object({ sent: z.int() }) },
      },
    },
    async (request) => {
      const message = {
        title: 'Notifications are on',
        body: 'This device will hear when an agent needs you or finishes a run.',
        url: '/approvals',
      };
      return { sent: await sendTo(db, vapid, request.user.id, message, request.log) };
    },
  );
};
