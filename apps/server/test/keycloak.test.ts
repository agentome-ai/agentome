import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accounts, createDb, type Db, eq, migrate, users } from '@agentome/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { licenseEnterprise, setupCodeIn } from './app.js';

// Sign-in with Keycloak against a stand-in realm: its discovery, its keys and a token
// endpoint whose id_token, signed as Keycloak signs it, names whoever `person` is at the time.

const publicUrl = 'http://agentome.test';
let container: StartedPostgreSqlContainer;
let realm: Server;
let app: Awaited<ReturnType<typeof buildApp>>;
let db: Db;
let dataDir: string;
let person: { sub: string; email: string; name: string; email_verified?: boolean } = {
  sub: 'k-1',
  email: 'kim@acme.com',
  name: 'Kim Keycloak',
};
/** The nonce of the sign-in under way, which the id_token has to carry back. */
let nonce: string | null = null;
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };

function idToken(issuer: string) {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${part({ alg: 'RS256', typ: 'JWT', kid: 'k1' })}.${part({
    iss: issuer,
    aud: 'agentome',
    iat: now,
    exp: now + 300,
    ...(nonce && { nonce }),
    email_verified: true,
    ...person,
  })}`;
  return `${body}.${sign('sha256', Buffer.from(body), keys.privateKey).toString('base64url')}`;
}

beforeAll(async () => {
  realm = createServer((request, response) => {
    const base = `http://127.0.0.1:${(realm.address() as AddressInfo).port}/realms/acme`;
    const answer = (body: object) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(body));
    };
    if (request.url === '/realms/acme/.well-known/openid-configuration') {
      return answer({
        issuer: base,
        authorization_endpoint: `${base}/protocol/openid-connect/auth`,
        token_endpoint: `${base}/protocol/openid-connect/token`,
        userinfo_endpoint: `${base}/protocol/openid-connect/userinfo`,
        jwks_uri: `${base}/protocol/openid-connect/certs`,
        id_token_signing_alg_values_supported: ['RS256'],
      });
    }
    if (request.url === '/realms/acme/protocol/openid-connect/certs')
      return answer({ keys: [jwk] });
    if (request.url === '/realms/acme/protocol/openid-connect/token') {
      return answer({
        access_token: 'access',
        token_type: 'Bearer',
        expires_in: 300,
        id_token: idToken(base),
      });
    }
    if (request.url === '/realms/acme/protocol/openid-connect/userinfo') {
      return answer({ ...person, email_verified: true });
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((done) => realm.listen(0, '127.0.0.1', done));
  const port = (realm.address() as AddressInfo).port;

  container = await new PostgreSqlContainer('postgres:16').start();
  dataDir = mkdtempSync(join(tmpdir(), 'agentome-keycloak-'));
  await migrate(container.getConnectionUri());
  const config = loadConfig({
    AGENTOME_DATABASE_URL: container.getConnectionUri(),
    AGENTOME_DATA_DIR: dataDir,
    AGENTOME_LOG_LEVEL: 'silent',
    AGENTOME_PUBLIC_URL: publicUrl,
    AGENTOME_KEYCLOAK_ISSUER: `http://127.0.0.1:${port}/realms/acme/`,
    AGENTOME_KEYCLOAK_CLIENT_ID: 'agentome',
    AGENTOME_KEYCLOAK_CLIENT_SECRET: 'the client secret',
  });
  app = await buildApp(config, { workerBundle: join(dataDir, 'no-bundle.mjs') });
  db = createDb(container.getConnectionUri(), () => {});
  const setup = await app.inject({
    method: 'POST',
    url: '/api/setup',
    headers: { origin: publicUrl },
    payload: {
      code: setupCodeIn(dataDir),
      orgName: 'Acme',
      admin: { name: 'Ann Admin', email: 'ann@acme.com', password: 'the admin password' },
    },
  });
  await licenseEnterprise(db);
  expect(setup.statusCode).toBe(201);
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.$client.end();
  await container?.stop();
  realm?.close();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

// Sign-in allows 3 attempts in 10 s per address: each sign-in here comes from its own.
let lastAddress = 0;
const nextAddress = () => `10.0.0.${++lastAddress}`;

function cookieOf(response: LightMyRequestResponse): string {
  const setCookie = response.headers['set-cookie'] ?? [];
  return (Array.isArray(setCookie) ? setCookie : [setCookie])
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');
}

/** The whole round: Agentome to Keycloak and back; answers the redirect and the cookie. */
async function signInWithKeycloak() {
  const start = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/social',
    remoteAddress: nextAddress(),
    headers: { origin: publicUrl },
    payload: { provider: 'keycloak', callbackURL: '/tasks', errorCallbackURL: '/login' },
  });
  expect(start.statusCode).toBe(200);
  const to = new URL(start.json<{ url: string }>().url);
  expect(to.pathname).toBe('/realms/acme/protocol/openid-connect/auth');
  expect(to.searchParams.get('redirect_uri')).toBe(`${publicUrl}/api/auth/callback/keycloak`);
  expect(to.searchParams.get('code_challenge_method')).toBe('S256');
  nonce = to.searchParams.get('nonce');
  const back = await app.inject({
    method: 'GET',
    url: `/api/auth/callback/keycloak?code=the-code&state=${to.searchParams.get('state')}`,
    headers: { cookie: cookieOf(start) },
  });
  return { location: back.headers.location, cookie: cookieOf(back) };
}

describe('sign-in with Keycloak', () => {
  it('says the server has Keycloak', async () => {
    const setup = await app.inject({ method: 'GET', url: '/api/setup' });
    expect(setup.json()).toEqual({ completed: true, keycloak: true });
  });

  it('makes a member of a new person and signs them in', async () => {
    const { location, cookie } = await signInWithKeycloak();
    expect(location).toBe('/tasks');
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(me.json()).toMatchObject({
      email: 'kim@acme.com',
      name: 'Kim Keycloak',
      role: 'member',
    });
    // The tokens Keycloak gave are kept only encrypted.
    const [account] = await db.select().from(accounts).where(eq(accounts.providerId, 'keycloak'));
    expect(account?.accessToken).not.toBe('access');
  });

  it('signs a person who has a password in to the same account', async () => {
    person = { sub: 'k-2', email: 'ann@acme.com', name: 'Ann from Keycloak' };
    const { location, cookie } = await signInWithKeycloak();
    expect(location).toBe('/tasks');
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(me.json()).toMatchObject({ email: 'ann@acme.com', role: 'admin' });
    expect(await db.select().from(users).where(eq(users.email, 'ann@acme.com'))).toHaveLength(1);
  });

  it('never joins an account to a sign-in whose address Keycloak has not verified', async () => {
    person = { sub: 'k-9', email: 'ann@acme.com', name: 'Not Ann', email_verified: false };
    const { location } = await signInWithKeycloak();
    expect(location).toBe('/login?error=account_not_linked');
  });

  it('takes no id_token posted to the sign-in, only the code flow', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/social',
      remoteAddress: nextAddress(),
      headers: { origin: publicUrl },
      payload: { provider: 'keycloak', idToken: { token: 'a.b.c' } },
    });
    expect(response.statusCode).toBe(400);
  });

  it('never joins an account whose address came from an open invitation', async () => {
    const admin = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      remoteAddress: nextAddress(),
      headers: { origin: publicUrl },
      payload: { email: 'ann@acme.com', password: 'the admin password' },
    });
    const invited = await app.inject({
      method: 'POST',
      url: '/api/invitations',
      headers: { origin: publicUrl, cookie: cookieOf(admin) },
      payload: {},
    });
    const token = invited.json<{ url: string }>().url.split('/invite/')[1];
    const accepted = await app.inject({
      method: 'POST',
      url: `/api/invitations/${token}/accept`,
      headers: { origin: publicUrl },
      payload: { name: 'Lee', email: 'lee@acme.com', password: 'whoever had the link' },
    });
    expect(accepted.statusCode).toBe(201);
    person = { sub: 'k-3', email: 'lee@acme.com', name: 'Lee Keycloak' };
    const { location } = await signInWithKeycloak();
    expect(location).toBe('/login?error=account_not_linked');
  });

  it('keeps a disabled person out', async () => {
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.email, 'kim@acme.com'));
    person = { sub: 'k-1', email: 'kim@acme.com', name: 'Kim Keycloak' };
    const { location, cookie } = await signInWithKeycloak();
    expect(location).toMatch(/^\/login\?error=/);
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(me.statusCode).toBe(401);
  });

  it('stops joining a sign-in to an account whose address its owner changed', async () => {
    const admin = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      remoteAddress: nextAddress(),
      headers: { origin: publicUrl },
      payload: { email: 'ann@acme.com', password: 'the admin password' },
    });
    const changed = await app.inject({
      method: 'PATCH',
      url: '/api/me',
      headers: { origin: publicUrl, cookie: cookieOf(admin) },
      payload: { email: 'boss@acme.com', currentPassword: 'the admin password' },
    });
    expect(changed.statusCode).toBe(200);
    const [row] = await db.select().from(users).where(eq(users.email, 'boss@acme.com'));
    expect(row?.emailVerified).toBe(false);
  });
});
