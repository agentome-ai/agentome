import { createHash, randomBytes } from 'node:crypto';
import { and, type Db, desc, eq, gt, installation, invitations, isNull, users } from '@agentome/db';
import { hashPassword } from 'better-auth/crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { type Auth, signIn, browserOnly } from '../auth.js';
import { Password } from '../config.js';
import { AppError } from '../errors.js';
import { Email, insertUser, Name, Role, toUser, User } from './users.js';

const lifetimeMs = 7 * 24 * 60 * 60 * 1000;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

const Unavailable = z.enum(['unknown', 'expired', 'revoked', 'accepted']);
type InvitationRow = typeof invitations.$inferSelect;

function unavailable(row: InvitationRow | undefined): z.infer<typeof Unavailable> | undefined {
  if (!row) return 'unknown';
  if (row.acceptedAt) return 'accepted';
  if (row.revokedAt) return 'revoked';
  if (row.expiresAt <= new Date()) return 'expired';
  return undefined;
}

const unavailableMessage = {
  unknown: "This invitation link doesn't work. Ask an admin for a new one.",
  expired: 'This invitation has expired. Ask an admin for a new one.',
  revoked: 'This invitation was revoked. Ask an admin for a new one.',
  accepted: 'This invitation was already used. Sign in instead.',
};

/** The invitation, if it can still create an account with this email; otherwise throws. */
function usableFor(email: string, row: InvitationRow | undefined): InvitationRow {
  const reason = unavailable(row);
  if (reason || !row) {
    throw new AppError('invitation_invalid', unavailableMessage[reason ?? 'unknown'], { reason });
  }
  if (row.email && row.email !== email) {
    throw new AppError('validation_failed', 'The request is not valid', [
      { path: 'body/email', message: `This invitation is for ${row.email}` },
    ]);
  }
  return row;
}

const Token = z.object({ token: z.string().max(100) });

export const invitationRoutes: FastifyPluginAsyncZod<{
  db: Db;
  auth: Auth;
  publicUrl: string;
}> = async (app, { db, auth, publicUrl }) => {
  app.post(
    '/api/invitations',
    {
      onRequest: app.requireAdmin,
      schema: {
        summary: 'Creates an invitation link; the link is in this answer only',
        body: z.object({ role: Role.default('member'), email: Email.optional() }),
        response: { 201: z.object({ id: z.uuid(), url: z.string(), expiresAt: z.string() }) },
      },
    },
    async (request, reply) => {
      // An invitation makes an account, which would outlive the personal token that made it.
      browserOnly(request);
      const token = randomBytes(32).toString('base64url');
      const [row] = await db
        .insert(invitations)
        .values({
          tokenHash: hash(token),
          role: request.body.role,
          email: request.body.email,
          createdBy: request.user.id,
          expiresAt: new Date(Date.now() + lifetimeMs),
        })
        .returning();
      if (!row) throw new Error('The insert returned no invitation');
      return reply.status(201).send({
        id: row.id,
        url: `${publicUrl.replace(/\/+$/, '')}/invite/${token}`,
        expiresAt: row.expiresAt.toISOString(),
      });
    },
  );

  app.get(
    '/api/invitations',
    {
      onRequest: app.requireAdmin,
      schema: {
        summary: 'Invitations that can still be accepted',
        response: {
          200: z.object({
            invitations: z.array(
              z.object({
                id: z.uuid(),
                role: Role,
                email: z.string().nullable(),
                invitedBy: z.string(),
                createdAt: z.string(),
                expiresAt: z.string(),
              }),
            ),
          }),
        },
      },
    },
    async () => {
      const rows = await db
        .select({ invitation: invitations, invitedBy: users.name })
        .from(invitations)
        .innerJoin(users, eq(users.id, invitations.createdBy))
        .where(
          and(
            isNull(invitations.acceptedAt),
            isNull(invitations.revokedAt),
            gt(invitations.expiresAt, new Date()),
          ),
        )
        .orderBy(desc(invitations.createdAt));
      return {
        invitations: rows.map(({ invitation, invitedBy }) => ({
          id: invitation.id,
          role: invitation.role,
          email: invitation.email,
          invitedBy,
          createdAt: invitation.createdAt.toISOString(),
          expiresAt: invitation.expiresAt.toISOString(),
        })),
      };
    },
  );

  app.delete(
    '/api/invitations/:id',
    {
      onRequest: app.requireAdmin,
      schema: { summary: 'Revokes an invitation', params: z.object({ id: z.uuid() }) },
    },
    async (request, reply) => {
      await db
        .update(invitations)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(invitations.id, request.params.id),
            isNull(invitations.acceptedAt),
            isNull(invitations.revokedAt),
          ),
        );
      return reply.status(204).send();
    },
  );

  app.get(
    '/api/invitations/:token',
    {
      schema: {
        summary: 'Whether an invitation link can still be used, and for which role',
        params: Token,
        response: {
          200: z.object({
            valid: z.boolean(),
            reason: Unavailable.optional(),
            role: Role.optional(),
            email: z.string().nullable().optional(),
            // Who sent it and to which company: the holder of a valid link may know both.
            invitedBy: z.string().optional(),
            orgName: z.string().optional(),
          }),
        },
      },
    },
    async (request) => {
      const [row] = await db
        .select()
        .from(invitations)
        .where(eq(invitations.tokenHash, hash(request.params.token)));
      const reason = unavailable(row);
      if (reason || !row) return { valid: false, reason };
      const [[inviter], [org]] = await Promise.all([
        db.select({ name: users.name }).from(users).where(eq(users.id, row.createdBy)),
        db.select({ name: installation.orgName }).from(installation),
      ]);
      return {
        valid: true,
        role: row.role,
        email: row.email,
        invitedBy: inviter?.name,
        orgName: org?.name,
      };
    },
  );

  app.post(
    '/api/invitations/:token/accept',
    {
      schema: {
        summary: 'Creates the account an invitation is for, and signs the person in',
        params: Token,
        body: z.object({ name: Name, email: Email, password: Password }),
        response: { 201: User },
      },
    },
    async (request, reply) => {
      const { name, email, password } = request.body;
      const find = (executor: Pick<Db, 'select'>) =>
        executor
          .select()
          .from(invitations)
          .where(eq(invitations.tokenHash, hash(request.params.token)));
      // Checked before the hash as well, so that a wrong link costs no scrypt work.
      usableFor(email, (await find(db))[0]);
      const passwordHash = await hashPassword(password);
      const user = await db.transaction(async (tx) => {
        // Locked, so that the same link cannot create two accounts at once.
        const row = usableFor(email, (await find(tx).for('update'))[0]);
        const created = await insertUser(tx, {
          name,
          email,
          role: row.role,
          passwordHash,
          // An invitation made out to one address vouches for it; an open one does not.
          emailVerified: row.email !== null,
        });
        await tx
          .update(invitations)
          .set({ acceptedAt: new Date() })
          .where(eq(invitations.id, row.id));
        return created;
      });
      await signIn(auth, request, reply, { email, password });
      return reply.status(201).send(toUser(user));
    },
  );
};
