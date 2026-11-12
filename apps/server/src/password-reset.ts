import {
  accounts,
  and,
  apiTokens,
  type Db,
  eq,
  isNull,
  like,
  users,
  verifications,
} from '@agentome/db';
import { createAuth } from './auth.js';
import type { Config } from './config.js';
import { AppError } from './errors.js';

// A way back in for someone who forgot their password. The server sends no mail, so there is
// nothing to click on the sign-in page: whoever runs the server asks for a link with
// `agentome reset-password <email>` and hands it over. The link is the sign-in library's own
// one-time token: it works once, for an hour, and a new password ends what the old one opened.

/** How long a link works, in minutes: the sign-in library's own hour. */
export const RESET_LINK_MINUTES = 60;

/**
 * The page that takes the new password. The token is after the `#`, which a browser keeps to
 * itself: in the path it would be written to the server's log, kept for a month where every
 * admin reads it, and seen by any proxy on the way.
 */
export const resetLink = (publicUrl: string, token: string) =>
  `${publicUrl.replace(/\/+$/, '')}/reset-password#${token}`;

/** The links issued for a person and not used yet: one issued earlier must not outlive a newer. */
const linksOf = (userId: string) =>
  and(eq(verifications.value, userId), like(verifications.identifier, 'reset-password:%'));

/**
 * What a new password takes away besides the sessions, which the sign-in library ends: the
 * person's personal API tokens, which are their password in another form, and any other link
 * for a new password. Their computers stay connected: a computer is revoked in Admin, Computers.
 */
export async function afterPasswordReset(db: Db, userId: string): Promise<void> {
  await db
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)));
  await db.delete(verifications).where(linksOf(userId));
}

/**
 * A one-time link that sets a new password for the account with this email. `disabled` says
 * that the account is: the link works, and the person still cannot sign in until an admin
 * enables them.
 */
export async function passwordResetLink(db: Db, config: Config, email: string) {
  const address = email.trim().toLowerCase();
  const [user] = await db
    .select({ id: users.id, email: users.email, disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.email, address));
  if (!user) throw new AppError('not_found', `No account with the email ${address}`);
  // A person who signs in through Keycloak has no password here, and a link would give them
  // one: a way in that the realm no longer decides.
  const [password] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.userId, user.id), eq(accounts.providerId, 'credential')));
  if (!password) {
    throw new AppError(
      'bad_request',
      `${address} signs in through Keycloak and has no password here to reset`,
    );
  }
  await db.delete(verifications).where(linksOf(user.id));
  let token: string | undefined;
  // Quiet: the library's own words about a reset are for a server's log, not for a terminal.
  const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  const auth = createAuth(db, config, quiet, (issued) => {
    token = issued;
  });
  await auth.api.requestPasswordReset({ body: { email: user.email } });
  if (!token) throw new Error('The sign-in library issued no token');
  return { url: resetLink(config.publicUrl, token), disabled: user.disabledAt !== null };
}
