import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  accounts,
  catalogItems,
  createDb,
  type Db,
  eq,
  installation,
  mcpAuthorizations,
  migrate,
  modelConnections,
  projectConnections,
  projects,
  sql,
  pushSubscriptions,
  sessions,
  twoFactors,
  users,
} from '@agentome/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { symmetricDecrypt } from 'better-auth/crypto';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveKey } from '../src/auth.js';
import { connectionsKey, decryptSecret, encryptSecret } from '../src/connections/crypto.js';
import { installationIdOf } from '../src/license/service.js';
import { rotateKey } from '../src/rotate-key.js';
import { keyFingerprint, prepareInstallation } from '../src/setup.js';
import { loadConfig } from '../src/config.js';
import { setupCode } from '../src/setup-code.js';
import { appFor } from './app.js';

// `agentome rotate-key` on a real database: everything sealed under the old key opens under the
// new one, what was signed with it ends, and the licenses keep their installation.

const OLD = 'a'.repeat(64);
const NEW = 'b'.repeat(64);

let container: StartedPostgreSqlContainer;
let db: Db;
let dir: string;
let cookie = '';
/** The admin's authenticator secret, from turning the second step on under the old key. */
let totpSecret = '';
const ORIGIN = 'http://localhost:3000';

/** The six digits an authenticator app shows now for this base32 secret (RFC 6238). */
function totp(secret: string, at = Date.now()) {
  let bits = '';
  for (const char of secret.replace(/=+$/, '').toUpperCase()) {
    bits += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char).toString(2).padStart(5, '0');
  }
  const key = Buffer.from(bits.match(/.{8}/g)?.map((byte) => parseInt(byte, 2)) ?? []);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac('sha1', key).update(counter).digest();
  const offset = (mac.at(-1) ?? 0) & 0xf;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  await migrate(container.getConnectionUri());
  db = createDb(container.getConnectionUri(), () => {});
  dir = mkdtempSync(join(tmpdir(), 'agentome-rotate-'));
  const app = await appFor(container.getConnectionUri(), dir, { AGENTOME_SECRET_KEY: OLD });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: {
      code: setupCode(OLD),
      orgName: 'Acme',
      admin: { name: 'Ann Admin', email: 'admin@example.com', password: 'the admin password' },
    },
  });
  // The second step turned on as the Account page does: its secret is sealed under the old key.
  const enable = await app.inject({
    method: 'POST',
    url: '/api/auth/two-factor/enable',
    headers: { origin: ORIGIN, cookie: cookieOf(setup) },
    payload: { password: 'the admin password' },
  });
  totpSecret = new URL(enable.json<{ totpURI: string }>().totpURI).searchParams.get('secret') ?? '';
  const verify = await app.inject({
    method: 'POST',
    url: '/api/auth/two-factor/verify-totp',
    headers: { origin: ORIGIN, cookie: cookieOf(setup) },
    payload: { code: totp(totpSecret) },
  });
  cookie = cookieOf(verify);
  expect((await app.inject({ url: '/api/me', headers: { cookie } })).statusCode).toBe(200);
  await app.close();
}, 120_000);

afterAll(async () => {
  await db?.$client.end();
  await container?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function cookieOf(response: LightMyRequestResponse): string {
  const setCookie = response.headers['set-cookie'] ?? [];
  return (Array.isArray(setCookie) ? setCookie : [setCookie])
    .map((line) => line.split(';', 1)[0])
    .join('; ');
}

/** `agentome rotate-key` as an admin runs it, from the source. */
const rotate = (env: Record<string, string> = {}, stdin = '') =>
  new Promise<{ code: number | null; err: string; out: string }>((resolve) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', join(import.meta.dirname, '..', 'src', 'cli.ts'), 'rotate-key'],
      {
        env: {
          PATH: process.env.PATH,
          AGENTOME_DATABASE_URL: container.getConnectionUri(),
          AGENTOME_DATA_DIR: dir,
          ...env,
        },
      },
    );
    let err = '';
    let out = '';
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.on('close', (code) => resolve({ code, err, out }));
    child.stdin.end(stdin);
  });

describe('rotating the secret key', () => {
  it('seals every secret again under the new key and ends what was signed with the old', async () => {
    const [admin] = await db.select({ id: users.id }).from(users);
    const userId = admin?.id ?? '';
    const seal = (text: string) => encryptSecret(connectionsKey(OLD), text);
    const authKey = (key: string) => deriveKey(key, 'better-auth');
    const [project] = await db
      .insert(projects)
      .values({ name: 'Shop', createdBy: userId })
      .returning({ id: projects.id });
    await db.insert(projectConnections).values({
      projectId: project?.id ?? '',
      kind: 'gitlab',
      config: { baseUrl: 'https://gitlab.acme.com', group: 'acme' },
      host: 'gitlab.acme.com',
      namespace: 'acme',
      tokenCiphertext: seal('glpat-token'),
      webhookSecretCiphertext: seal('webhook-secret'),
      createdBy: userId,
    });
    await db.insert(modelConnections).values({
      name: 'Gateway',
      kind: 'openai',
      baseUrl: 'https://llm.acme.com',
      keyCiphertext: seal('sk-model-key'),
      createdBy: userId,
    });
    const [server] = await db
      .insert(catalogItems)
      .values({
        kind: 'mcp',
        name: 'Wiki',
        version: '1',
        ownerUserId: userId,
        spec: {
          url: 'https://wiki.acme.com/mcp',
          authorization: seal('Bearer wiki-token'),
          oauth: { client: seal('{"client_id":"agentome"}'), issuer: 'https://id.acme.com' },
        },
      })
      .returning({ id: catalogItems.id });
    await db.insert(mcpAuthorizations).values({
      serverId: server?.id ?? '',
      userId,
      tokens: seal('{"access_token":"wiki-access"}'),
    });
    await db.update(accounts).set({ accessToken: 'sealed-by-better-auth' });
    await db.insert(pushSubscriptions).values({
      userId,
      endpoint: 'https://push.example.com/device',
      p256dh: 'key',
      auth: 'auth',
    });

    await expect(rotateKey(db, 'c'.repeat(64), NEW)).rejects.toThrow('not the one');
    const done = await rotateKey(db, OLD, NEW);
    expect(done).toMatchObject({
      connections: 1,
      modelKeys: 1,
      libraryServers: 1,
      mcpSignIns: 1,
      secondSteps: 1,
      sessionsEnded: 1,
    });

    const open = (record: string) => decryptSecret(connectionsKey(NEW), record);
    const [connection] = await db.select().from(projectConnections);
    expect(open(connection?.tokenCiphertext ?? '')).toBe('glpat-token');
    expect(open(connection?.webhookSecretCiphertext ?? '')).toBe('webhook-secret');
    expect(() => decryptSecret(connectionsKey(OLD), connection?.tokenCiphertext ?? '')).toThrow();
    const [model] = await db.select().from(modelConnections);
    expect(open(model?.keyCiphertext ?? '')).toBe('sk-model-key');
    const [item] = await db
      .select({ spec: catalogItems.spec })
      .from(catalogItems)
      .where(eq(catalogItems.id, server?.id ?? ''));
    const spec = item?.spec as { authorization: string; oauth: { client: string; issuer: string } };
    expect(open(spec.authorization)).toBe('Bearer wiki-token');
    expect(open(spec.oauth.client)).toBe('{"client_id":"agentome"}');
    expect(spec.oauth.issuer).toBe('https://id.acme.com');
    const [signIn] = await db.select().from(mcpAuthorizations);
    expect(open(signIn?.tokens ?? '')).toBe('{"access_token":"wiki-access"}');
    // Unreadable under the old key now; the sign-in of the next test reads it under the new.
    const [step] = await db.select().from(twoFactors);
    await expect(
      symmetricDecrypt({ key: authKey(OLD), data: step?.secret ?? '' }),
    ).rejects.toThrow();

    expect(await db.select().from(sessions)).toEqual([]);
    expect(await db.select().from(pushSubscriptions)).toEqual([]);
    const [account] = await db.select({ token: accounts.accessToken }).from(accounts);
    expect(account?.token).toBeNull();
    const [row] = await db.select().from(installation);
    expect(row?.secretKeyFingerprint).toBe(keyFingerprint(NEW));
    expect(row?.installationId).toBe(installationIdOf(OLD));
  });

  it('starts under the new key only, with the installation the licenses were made out to', async () => {
    const url = container.getConnectionUri();
    const log = { info: () => {}, warn: () => {} } as never;
    const under = (key: string) =>
      loadConfig({
        AGENTOME_DATABASE_URL: url,
        AGENTOME_DATA_DIR: dir,
        AGENTOME_SECRET_KEY: key,
        AGENTOME_LOG_LEVEL: 'silent',
      });
    await expect(prepareInstallation(under(OLD), log)).rejects.toThrow('The secret key changed');
    const app = await appFor(url, dir, { AGENTOME_SECRET_KEY: NEW });
    await prepareInstallation(under(NEW), log);
    // The old session's cookie opens nothing.
    expect((await app.inject({ url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
    // The password and the authenticator app still sign the admin in.
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { origin: ORIGIN },
      payload: { email: 'admin@example.com', password: 'the admin password' },
    });
    expect(signIn.json<{ twoFactorRedirect?: boolean }>().twoFactorRedirect).toBe(true);
    const verify = await app.inject({
      method: 'POST',
      url: '/api/auth/two-factor/verify-totp',
      headers: { origin: ORIGIN, cookie: cookieOf(signIn) },
      payload: { code: totp(totpSecret) },
    });
    expect(verify.statusCode).toBe(200);
    const license = await app.inject({
      url: '/api/license',
      headers: { cookie: cookieOf(verify) },
    });
    expect(license.json<{ installationId: string }>().installationId).toBe(installationIdOf(OLD));
    await app.close();
  });

  it('runs as `agentome rotate-key` with the server stopped, and replaces the key file', async () => {
    const url = container.getConnectionUri();
    const keyFile = join(dir, 'secrets', 'secret.key');
    mkdirSync(join(dir, 'secrets'), { recursive: true });
    writeFileSync(keyFile, NEW, { mode: 0o600 });
    // This suite's own connection stands for a server that still runs.
    await db.execute(sql`select 1`);
    const refused = await rotate();
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('Stop the server and the place launcher first');
    expect(readFileSync(keyFile, 'utf8')).toBe(NEW);

    await db.$client.end();
    const done = await rotate();
    expect(done.err).toContain('Sealed again under the new key');
    expect(done.code).toBe(0);
    const third = readFileSync(keyFile, 'utf8');
    expect(third).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(`${keyFile}.next`)).toBe(false);
    db = createDb(url, () => {});
    const [row] = await db.select().from(installation);
    expect(row?.secretKeyFingerprint).toBe(keyFingerprint(third));
    expect(row?.installationId).toBe(installationIdOf(OLD));
  });

  it('takes a new key on stdin when the key comes from the environment, and prints none', async () => {
    const url = container.getConnectionUri();
    await db.$client.end();
    const current = readFileSync(join(dir, 'secrets', 'secret.key'), 'utf8');
    const fourth = 'd'.repeat(64);
    const done = await rotate({ AGENTOME_SECRET_KEY: current }, `${fourth}\n`);
    expect(done.code).toBe(0);
    expect(done.out).toBe('');
    expect(done.out + done.err).not.toContain(fourth);
    db = createDb(url, () => {});
    const [row] = await db.select().from(installation);
    expect(row?.secretKeyFingerprint).toBe(keyFingerprint(fourth));
    // The data folder's file is not the key in use here, and stays as it was.
    expect(readFileSync(join(dir, 'secrets', 'secret.key'), 'utf8')).toBe(current);
  });
});
