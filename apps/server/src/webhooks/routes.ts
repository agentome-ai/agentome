import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { and, type Db, eq, projectConnections, webhookDeliveries } from '@agentome/db';
import { CodeHostKind } from '@agentome/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { codeHostFor } from '../code-host/index.js';
import type { Config } from '../config.js';
import { connectionsKey, decryptSecret } from '../connections/crypto.js';
import { AppError } from '../errors.js';
import type { Jobs } from '../jobs.js';

// Webhooks of GitHub and GitLab: one endpoint per connection, checked against the
// connection's secret, recorded once per delivery, answered at once; a job applies them.

// GitHub caps a body at 25 MB; the events we read are a few dozen KB.
const BODY_LIMIT = 256 * 1024;

const HEADERS = {
  github: { delivery: 'x-github-delivery', event: 'x-github-event' },
  gitlab: { delivery: 'x-gitlab-event-uuid', event: 'x-gitlab-event' },
} as const;

const Answer = z.object({ status: z.enum(['received', 'ignored', 'duplicate']) });

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest();
/** Equal or not, in a time that tells neither where they differ nor how long either is. */
const same = (given: string, expected: string) => timingSafeEqual(digest(given), digest(expected));

/** One value of a header: a repeated one is as good as none. */
function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** GitHub signs the body's bytes with the secret; GitLab sends the secret itself. */
function authentic(kind: CodeHostKind, secret: string, request: FastifyRequest, raw: Buffer) {
  if (kind === 'github') {
    const signature = header(request, 'x-hub-signature-256');
    const expected = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
    return signature !== undefined && same(signature, expected);
  }
  const token = header(request, 'x-gitlab-token');
  return token !== undefined && same(token, secret);
}

export const webhookRoutes: FastifyPluginAsyncZod<{ db: Db; config: Config; jobs: Jobs }> = async (
  app,
  { db, config, jobs },
) => {
  const key = connectionsKey(config.secretKey);
  // The signature is over the bytes as sent, so the body stays bytes until it is verified.
  // Scoped to this plugin: every other route keeps Fastify's own JSON parser.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: BODY_LIMIT },
    (_request, body, done) => done(null, body),
  );

  app.post(
    '/webhooks/:kind/:connectionId',
    {
      bodyLimit: BODY_LIMIT,
      schema: {
        summary: 'A webhook delivery of GitHub or GitLab, signed with the connection’s secret',
        params: z.object({ kind: CodeHostKind, connectionId: z.uuid() }),
        response: { 200: Answer, 202: Answer },
      },
    },
    async (request, reply) => {
      const { kind, connectionId } = request.params;
      const [connection] = await db
        .select()
        .from(projectConnections)
        .where(and(eq(projectConnections.id, connectionId), eq(projectConnections.kind, kind)));
      const raw = request.body;
      // One answer for a connection that does not exist and a signature that does not match,
      // so the endpoint tells nobody which connections there are.
      if (
        !connection ||
        !Buffer.isBuffer(raw) ||
        !authentic(kind, decryptSecret(key, connection.webhookSecretCiphertext), request, raw)
      ) {
        request.log.warn({ connectionId, kind }, 'a webhook delivery failed its signature check');
        throw new AppError('unauthorized', 'The signature does not match this connection');
      }

      const names = HEADERS[kind];
      const delivery = header(request, names.delivery);
      if (!delivery || delivery.length > 200) {
        throw new AppError('bad_request', `Send the delivery's id in ${names.delivery}`);
      }
      const event = (header(request, names.event) ?? '').slice(0, 100);
      let body: unknown;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch (error) {
        throw new AppError('bad_request', 'The body is not JSON', undefined, { cause: error });
      }

      const baseUrl =
        typeof connection.config.baseUrl === 'string' ? connection.config.baseUrl : undefined;
      const host = codeHostFor({ kind, baseUrl }, decryptSecret(key, connection.tokenCiphertext));
      const parsed = host.parseWebhook(event, body);
      const [row] = await db
        .insert(webhookDeliveries)
        .values({
          connectionId,
          kind,
          externalEventId: delivery,
          event,
          status: parsed ? 'received' : 'ignored',
          processedAt: parsed ? null : new Date(),
        })
        .onConflictDoNothing()
        .returning({ id: webhookDeliveries.id });
      // A host sends a delivery again when it missed our answer: it was taken the first time.
      if (!row) return { status: 'duplicate' as const };
      if (!parsed) return reply.code(202).send({ status: 'ignored' });
      try {
        await jobs.fileWebhook({ deliveryId: row.id, connectionId, event: parsed });
      } catch (error) {
        // Without its job the row would turn the host's retry away as a repeat.
        await db.delete(webhookDeliveries).where(eq(webhookDeliveries.id, row.id));
        throw error;
      }
      return { status: 'received' as const };
    },
  );
};
