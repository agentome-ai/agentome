import {
  accounts,
  and,
  type Db,
  eq,
  inArray,
  invitations,
  isNull,
  runs,
  seats,
  sessions,
  users,
} from '@agentome/db';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { verifyPassword } from 'better-auth/crypto';
import { z } from 'zod';
import { transferAgentsOf } from '../agents/ownership.js';
import { AppError, postgresCode } from '../errors.js';
import { requestStop } from '../runs/service.js';
import { Name } from './validators.js';

export const Role = z.enum(['admin', 'member']);
// Lower-cased on the way in: users.email must be lower case.
export const Email = z.email().max(254).toLowerCase();
export { Name } from './validators.js';
const Handed = z.object({ id: z.uuid(), name: z.string() });
export const User = z.object({ id: z.uuid(), name: z.string(), email: z.string(), role: Role });
const Person = User.extend({ disabledAt: z.string().nullable(), createdAt: z.string() });

type UserRow = typeof users.$inferSelect;
export const toUser = ({ id, name, email, role }: UserRow) => ({ id, name, email, role });
const toPerson = (row: UserRow) => ({
  ...toUser(row),
  disabledAt: row.disabledAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

/**
 * Creates a person who signs in with email and password, the rows better-auth's sign-up
 * writes, in the caller's transaction. Hash the password before the transaction starts.
 */
export async function insertUser(
  tx: Pick<Db, 'insert'>,
  user: {
    name: string;
    email: string;
    role: z.infer<typeof Role>;
    passwordHash: string;
    /** Somebody vouched for the address: the setup, or an invitation made out to it. */
    emailVerified: boolean;
  },
): Promise<UserRow> {
  let created: UserRow | undefined;
  try {
    [created] = await tx
      .insert(users)
      .values({
        name: user.name,
        email: user.email,
        role: user.role,
        emailVerified: user.emailVerified,
      })
      .returning();
  } catch (error) {
    if (postgresCode(error) !== '23505') throw error;
    throw new AppError(
      'email_taken',
      'Someone already has an account with this email. Sign in instead, or use another email.',
    );
  }
  if (!created) throw new Error('The insert returned no user');
  await tx.insert(accounts).values({
    userId: created.id,
    accountId: created.id,
    providerId: 'credential',
    password: user.passwordHash,
  });
  return created;
}

export const userRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.get(
    '/api/me',
    {
      onRequest: app.requireSession,
      schema: { summary: 'The signed-in person', response: { 200: User } },
    },
    async (request) => request.user,
  );

  // The name and the email a person signs in with. A new email asks for the password too: an
  // open session alone must not be enough to take the account's sign-in. The password itself
  // changes through better-auth (POST /api/auth/change-password).
  app.patch(
    '/api/me',
    {
      onRequest: app.requireSession,
      schema: {
        summary: 'Renames the signed-in person or changes their email',
        body: z.object({
          name: Name.optional(),
          email: Email.optional(),
          currentPassword: z.string().max(128).optional(),
        }),
        response: { 200: User },
      },
    },
    async (request) => {
      const { name, email, currentPassword } = request.body;
      const me = request.user;
      const newEmail = email !== undefined && email !== me.email ? email : undefined;
      if (newEmail !== undefined) {
        const [account] = await db
          .select({ hash: accounts.password })
          .from(accounts)
          .where(and(eq(accounts.userId, me.id), eq(accounts.providerId, 'credential')));
        const right =
          account?.hash != null &&
          currentPassword !== undefined &&
          (await verifyPassword({ hash: account.hash, password: currentPassword }));
        if (!right) {
          throw new AppError(
            'invalid_password',
            'The current password is wrong. Check it, then try again.',
          );
        }
      }
      let row: UserRow | undefined;
      try {
        [row] = await db
          .update(users)
          // A new address is the person's word only: it no longer joins a Keycloak sign-in,
          // or anyone could take another person's address and catch their sign-in.
          .set({ name, email: newEmail, ...(newEmail !== undefined && { emailVerified: false }) })
          .where(eq(users.id, me.id))
          .returning();
      } catch (error) {
        if (postgresCode(error) !== '23505') throw error;
        throw new AppError('email_taken', 'Someone already has an account with this email.');
      }
      if (!row) throw new AppError('not_found', 'There is no such person');
      return toUser(row);
    },
  );

  app.get(
    '/api/users',
    {
      onRequest: app.requireAdmin,
      schema: {
        summary: 'Everyone with an account',
        response: { 200: z.object({ users: z.array(Person) }) },
      },
    },
    async () => {
      const rows = await db.select().from(users).orderBy(users.createdAt);
      return { users: rows.map(toPerson) };
    },
  );

  app.get(
    '/api/people',
    {
      onRequest: app.requireSession,
      schema: {
        summary: 'The names of the people who can be given an agent: everyone not disabled',
        response: {
          200: z.object({ people: z.array(z.object({ id: z.uuid(), name: z.string() })) }),
        },
      },
    },
    async () => ({
      people: await db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(isNull(users.disabledAt))
        .orderBy(users.name),
    }),
  );

  app.post(
    '/api/users/:id/transfer-agents',
    {
      onRequest: app.requireAdmin,
      schema: {
        summary:
          'Transfers everything a person owns to a successor, for good; what they had for a time goes back to its owner',
        params: z.object({ id: z.uuid() }),
        body: z.object({ to: z.uuid() }),
        response: {
          200: z.object({
            transferred: z.array(Handed),
            returned: z.array(Handed),
            to: Handed,
          }),
        },
      },
    },
    async (request) => transferAgentsOf(db, request.params.id.toLowerCase(), request.body.to),
  );

  app.patch(
    '/api/users/:id',
    {
      onRequest: app.requireAdmin,
      schema: {
        summary: 'Disables or enables a person; disabling signs them out everywhere',
        params: z.object({ id: z.uuid() }),
        body: z.object({ disabled: z.boolean() }),
        response: { 200: Person },
      },
    },
    async (request) => {
      // PostgreSQL reads a uuid in either case; the comparison below must too.
      const id = request.params.id.toLowerCase();
      // So that an installation always keeps an admin who can sign in.
      if (id === request.user.id) {
        throw new AppError('forbidden', "You can't disable your own account");
      }
      const disabled = request.body.disabled;
      const person = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(users)
          .set({ disabledAt: disabled ? new Date() : null })
          .where(eq(users.id, id))
          .returning();
        if (row && disabled) {
          await tx.delete(sessions).where(eq(sessions.userId, id));
          // Their invitations stop working too: a departing admin keeps no way back in.
          const pending = and(isNull(invitations.acceptedAt), isNull(invitations.revokedAt));
          await tx
            .update(invitations)
            .set({ revokedAt: new Date() })
            .where(and(eq(invitations.createdBy, id), pending));
          // A run on their computer stops, and its tokens with it: the computer of someone
          // who left must not go on calling tools or pushing.
          const theirs = tx.select({ id: seats.id }).from(seats).where(eq(seats.ownerUserId, id));
          await requestStop(tx, inArray(runs.seatId, theirs));
        }
        return row;
      });
      if (!person) throw new AppError('not_found', 'There is no such person');
      return toPerson(person);
    },
  );
};
