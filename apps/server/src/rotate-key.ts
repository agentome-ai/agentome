import {
  accounts,
  catalogItems,
  type Db,
  eq,
  installation,
  isNotNull,
  mcpAuthorizations,
  modelConnections,
  or,
  projectConnections,
  pushSubscriptions,
  sessions,
  sql,
  twoFactors,
  verifications,
} from '@agentome/db';
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import { deriveKey } from './auth.js';
import { connectionsKey, decryptSecret, encryptSecret } from './connections/crypto.js';
import { installationIdOf } from './license/service.js';
import { keyFingerprint } from './setup.js';

// `agentome rotate-key`: a new secret key, for one that may have leaked. Everything the
// database keeps under the old key is sealed again under the new one in one transaction; what is
// only signed with it ends. Sessions (their cookies are signed), password-reset links, and
// notifications (the server's VAPID key is drawn from the key, and a browser subscribed to the
// old one gets nothing from the new): people sign in and turn notifications on again. Keycloak's
// tokens, which nothing reads, are dropped and come back at the next sign-in through it.

export type Rotated = {
  connections: number;
  modelKeys: number;
  libraryServers: number;
  mcpSignIns: number;
  secondSteps: number;
  sessionsEnded: number;
};

/** A library server's settings: the token and the OAuth client it keeps, sealed. */
type Spec = {
  authorization?: string | null;
  oauth?: { client?: string } & Record<string, unknown>;
};

/**
 * `alone`: refuse when anything else is connected to the database once the installation is
 * locked, as the command does; a server that read the old fingerprint just before would go on
 * sealing under the old key.
 */
export async function rotateKey(
  db: Db,
  oldKey: string,
  newKey: string,
  { alone = false }: { alone?: boolean } = {},
): Promise<Rotated> {
  const before = connectionsKey(oldKey);
  const after = connectionsKey(newKey);
  const reseal = (record: string) => encryptSecret(after, decryptSecret(before, record));
  const authBefore = deriveKey(oldKey, 'better-auth');
  const authAfter = deriveKey(newKey, 'better-auth');
  const resealAuth = async (data: string) =>
    symmetricEncrypt({ key: authAfter, data: await symmetricDecrypt({ key: authBefore, data }) });

  return db.transaction(async (tx) => {
    // Locked whole first: a server that starts meanwhile waits at its own read of the
    // fingerprint, then finds the new one and refuses to start under the old key.
    await tx.execute(sql`lock table ${installation} in access exclusive mode`);
    if (alone) {
      const [others] = await tx.execute<{ count: number }>(sql`
        select count(*)::int as count from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid()
          and backend_type = 'client backend'`);
      if ((others?.count ?? 0) > 0) {
        throw new Error(
          'Something connected to the database meanwhile: stop it and run this again',
        );
      }
    }
    const [row] = await tx
      .select({ id: installation.installationId, fingerprint: installation.secretKeyFingerprint })
      .from(installation);
    if (!row) throw new Error('This installation is not set up yet: there is nothing to rotate');
    if (row.fingerprint !== keyFingerprint(oldKey)) {
      throw new Error('The secret key given is not the one this installation runs under');
    }

    const connections = await tx
      .select({
        id: projectConnections.id,
        token: projectConnections.tokenCiphertext,
        webhook: projectConnections.webhookSecretCiphertext,
      })
      .from(projectConnections);
    for (const c of connections) {
      await tx
        .update(projectConnections)
        .set({ tokenCiphertext: reseal(c.token), webhookSecretCiphertext: reseal(c.webhook) })
        .where(eq(projectConnections.id, c.id));
    }

    const models = await tx
      .select({ id: modelConnections.id, key: modelConnections.keyCiphertext })
      .from(modelConnections);
    for (const m of models) {
      await tx
        .update(modelConnections)
        .set({ keyCiphertext: reseal(m.key) })
        .where(eq(modelConnections.id, m.id));
    }

    // Only the library's MCP servers keep secrets in their settings.
    const servers = await tx
      .select({ id: catalogItems.id, spec: catalogItems.spec })
      .from(catalogItems)
      .where(
        or(
          sql`${catalogItems.spec}->>'authorization' is not null`,
          sql`${catalogItems.spec}->'oauth'->>'client' is not null`,
        ),
      );
    for (const server of servers) {
      const spec = server.spec as Spec;
      const next: Spec = { ...spec };
      if (spec.authorization) next.authorization = reseal(spec.authorization);
      if (spec.oauth?.client) next.oauth = { ...spec.oauth, client: reseal(spec.oauth.client) };
      await tx.update(catalogItems).set({ spec: next }).where(eq(catalogItems.id, server.id));
    }

    const signIns = await tx
      .select({
        id: mcpAuthorizations.id,
        tokens: mcpAuthorizations.tokens,
        verifier: mcpAuthorizations.pendingVerifier,
      })
      .from(mcpAuthorizations)
      .where(or(isNotNull(mcpAuthorizations.tokens), isNotNull(mcpAuthorizations.pendingVerifier)));
    for (const s of signIns) {
      await tx
        .update(mcpAuthorizations)
        .set({
          tokens: s.tokens && reseal(s.tokens),
          pendingVerifier: s.verifier && reseal(s.verifier),
        })
        .where(eq(mcpAuthorizations.id, s.id));
    }

    // better-auth seals the authenticator app's secret and the backup codes with its own key.
    const steps = await tx
      .select({ id: twoFactors.id, secret: twoFactors.secret, codes: twoFactors.backupCodes })
      .from(twoFactors);
    for (const step of steps) {
      await tx
        .update(twoFactors)
        .set({ secret: await resealAuth(step.secret), backupCodes: await resealAuth(step.codes) })
        .where(eq(twoFactors.id, step.id));
    }

    await tx
      .update(accounts)
      .set({ accessToken: null, refreshToken: null, idToken: null })
      .where(
        or(
          isNotNull(accounts.accessToken),
          isNotNull(accounts.refreshToken),
          isNotNull(accounts.idToken),
        ),
      );
    const ended = await tx.delete(sessions).returning({ id: sessions.id });
    await tx.delete(verifications);
    await tx.delete(pushSubscriptions);

    await tx.update(installation).set({
      secretKeyFingerprint: keyFingerprint(newKey),
      // Licenses are made out to the id of the key the installation was set up with.
      installationId: row.id ?? installationIdOf(oldKey),
    });

    return {
      connections: connections.length,
      modelKeys: models.length,
      libraryServers: servers.length,
      mcpSignIns: signIns.length,
      secondSteps: steps.length,
      sessionsEnded: ended.length,
    };
  });
}
