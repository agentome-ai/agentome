import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  accounts,
  createDb,
  type Db,
  eq,
  installation,
  invitations,
  migrate,
  sessions,
  users,
} from '@agentome/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { setupCode } from '../src/setup-code.js';
import { passwordResetLink } from '../src/password-reset.js';
import { prepareInstallation } from '../src/setup.js';

const publicUrl = 'http://agentome.test';
const key = 'a-test-secret-key-that-is-long-enough';
const code = setupCode(key);
const admin = { name: 'Ann Admin', email: 'Ann@Example.com', password: 'correct horse battery' };
const member = { name: 'Bob Member', email: 'bob@example.com', password: 'another long password' };

let container: StartedPostgreSqlContainer;
let db: Db;
let app: Awaited<ReturnType<typeof buildApp>>;
let dataDir: string;

const env = (databaseUrl: string, extra: Record<string, string> = {}) => ({
  AGENTOME_DATABASE_URL: databaseUrl,
  AGENTOME_DATA_DIR: dataDir,
  AGENTOME_PUBLIC_URL: publicUrl,
  AGENTOME_SECRET_KEY: key,
  AGENTOME_LOG_LEVEL: 'silent',
  ...extra,
});

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  dataDir = mkdtempSync(join(tmpdir(), 'agentome-auth-'));
  await migrate(container.getConnectionUri());
  db = createDb(container.getConnectionUri(), () => {});
  app = await buildApp(loadConfig(env(container.getConnectionUri())));
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.$client.end();
  await container?.stop();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

// Each sign-in comes from its own address: better-auth allows 3 in 10 s per address.
let lastAddress = 0;
const nextAddress = () => `10.0.0.${++lastAddress}`;

/** The Cookie header a browser would send back after this response. */
function cookieOf(response: LightMyRequestResponse): string {
  const setCookie = response.headers['set-cookie'] ?? [];
  return (Array.isArray(setCookie) ? setCookie : [setCookie])
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');
}

function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  options: { cookie?: string; body?: object; address?: string } = {},
) {
  return app.inject({
    method,
    url,
    payload: options.body,
    remoteAddress: options.address ?? nextAddress(),
    // The browser sends the page's origin with every POST; better-auth checks it.
    headers: { origin: publicUrl, ...(options.cookie ? { cookie: options.cookie } : {}) },
  });
}

async function signIn(email: string, password: string) {
  const response = await call('POST', '/api/auth/sign-in/email', { body: { email, password } });
  expect(response.statusCode).toBe(200);
  return cookieOf(response);
}

async function invite(cookie: string, body: object = {}) {
  const response = await call('POST', '/api/invitations', { cookie, body });
  expect(response.statusCode).toBe(201);
  const { id, url } = response.json<{ id: string; url: string }>();
  return { id, token: url.split('/invite/')[1] ?? '' };
}

describe('before the setup', () => {
  it('answers setup_required on the API, but not on the setup, health or OpenAPI', async () => {
    // %61 is "a": the gate goes by the route the router matched, not by the raw URL.
    for (const url of ['/api/me', '/api/users', '/api/invitations', '/%61pi/me']) {
      const response = await call('GET', url);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'setup_required' } });
    }
    expect((await call('POST', '/api/auth/sign-in/email', { body: admin })).statusCode).toBe(409);
    expect((await call('GET', '/api/setup')).json()).toEqual({ completed: false, keycloak: false });
    for (const url of ['/health', '/ready', '/openapi.json']) {
      expect((await call('GET', url)).statusCode).toBe(200);
    }
  });

  it('refuses a password shorter than 12 characters', async () => {
    const response = await call('POST', '/api/setup', {
      body: { code, orgName: 'Acme', admin: { ...admin, password: 'short' } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'validation_failed', details: [{ path: 'body/admin/password' }] },
    });
  });

  it('refuses a setup without the setup code, or with another', async () => {
    expect(code).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
    const missing = await call('POST', '/api/setup', { body: { orgName: 'Evil', admin: member } });
    expect(missing.statusCode).toBe(400);
    const other = setupCode('someone-elses-key-that-is-long-enough');
    const wrong = await call('POST', '/api/setup', {
      body: { code: other, orgName: 'Evil', admin: member },
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toMatchObject({
      error: { code: 'validation_failed', details: [{ path: 'body/code' }] },
    });
    expect(await db.select().from(installation)).toEqual([]);
  });
});

describe('the setup', () => {
  let cookie: string;

  it('creates the company and the first admin, with a lower-case email, and signs them in', async () => {
    // As typed by hand: in capitals and without the dashes.
    const typed = code.replaceAll('-', '').toUpperCase();
    const response = await call('POST', '/api/setup', {
      body: { code: typed, orgName: 'Acme', admin },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ email: 'ann@example.com', role: 'admin' });
    const setCookie = String(response.headers['set-cookie']);
    expect(setCookie).toMatch(/^agentome\.session_token=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    // The public URL is http, so the cookie must not require https.
    expect(setCookie).not.toMatch(/Secure/i);
    cookie = cookieOf(response);

    const me = await call('GET', '/api/me', { cookie });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({
      id: expect.any(String),
      name: 'Ann Admin',
      email: 'ann@example.com',
      role: 'admin',
    });
    const [row] = await db.select().from(installation);
    expect(row).toMatchObject({ orgName: 'Acme', baseUrl: publicUrl });
    expect(row?.secretKeyFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('answers 403 setup_completed once it is done', async () => {
    expect((await call('GET', '/api/setup')).json()).toEqual({ completed: true, keycloak: false });
    const again = await call('POST', '/api/setup', {
      body: { code, orgName: 'Evil', admin: member },
    });
    expect(again.statusCode).toBe(403);
    expect(again.json()).toMatchObject({ error: { code: 'setup_completed' } });
  });
});

describe('signing in', () => {
  it('accepts the email in any case and returns the person at /api/me', async () => {
    const cookie = await signIn('ANN@example.COM', admin.password);
    const me = await call('GET', '/api/me', { cookie });
    expect(me.json()).toMatchObject({ email: 'ann@example.com', role: 'admin' });
  });

  it('refuses a wrong password and an unknown email alike', async () => {
    for (const email of ['ann@example.com', 'nobody@example.com']) {
      const response = await call('POST', '/api/auth/sign-in/email', {
        body: { email, password: 'wrong password!!' },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: { code: 'invalid_email_or_password', message: expect.any(String) },
      });
    }
  });

  it('answers 401 without a session, and after sign-out', async () => {
    const anonymous = await call('GET', '/api/me');
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ error: { code: 'unauthorized' } });

    const cookie = await signIn(admin.email, admin.password);
    const signOut = await call('POST', '/api/auth/sign-out', { cookie, body: {} });
    expect(signOut.statusCode).toBe(200);
    expect((await call('GET', '/api/me', { cookie })).statusCode).toBe(401);
  });

  it('exposes only sign-in, sign-out and change-password of better-auth; no sign-up', async () => {
    const cookie = await signIn(admin.email, admin.password);
    for (const path of ['sign-up/email', 'update-user', 'change-email', 'list-sessions']) {
      const response = await call('POST', `/api/auth/${path}`, { cookie, body: member });
      expect(response.statusCode).toBe(404);
    }
    expect((await call('GET', '/api/auth/get-session', { cookie })).statusCode).toBe(404);
  });

  it('refuses a request with the session cookie from another origin', async () => {
    const cookie = await signIn(admin.email, admin.password);
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      payload: {},
      headers: { origin: 'https://evil.example', cookie },
    });
    expect(response.statusCode).toBe(403);
    expect((await call('GET', '/api/me', { cookie })).statusCode).toBe(200);
  });

  it('records the client behind a proxy only with AGENTOME_TRUST_PROXY', async () => {
    const proxied = await buildApp(
      loadConfig(env(container.getConnectionUri(), { AGENTOME_TRUST_PROXY: 'true' })),
    );
    try {
      for (const [server, address] of [
        [proxied, '203.0.113.7'],
        [app, '10.9.9.9'],
      ] as const) {
        const response = await server.inject({
          method: 'POST',
          url: '/api/auth/sign-in/email',
          payload: { email: admin.email, password: admin.password },
          remoteAddress: '10.9.9.9',
          headers: { origin: publicUrl, 'x-forwarded-for': '203.0.113.7' },
        });
        expect(response.statusCode).toBe(200);
        const [session] = await db
          .select({ ipAddress: sessions.ipAddress })
          .from(sessions)
          .where(eq(sessions.token, response.json<{ token: string }>().token));
        expect(session?.ipAddress).toBe(address);
      }
    } finally {
      await proxied.close();
    }
  });

  it('limits sign-in attempts from one address, whatever it claims to be', async () => {
    const address = nextAddress();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        payload: { email: 'ann@example.com', password: 'wrong password!!' },
        remoteAddress: address,
        headers: { origin: publicUrl, 'x-agentome-client-ip': `192.0.2.${attempt}` },
      });
      statuses.push(response.statusCode);
    }
    expect(statuses).toEqual([401, 401, 401, 429]);
  });
});

describe('invitations', () => {
  let adminCookie: string;

  beforeAll(async () => {
    adminCookie = await signIn(admin.email, admin.password);
  });

  it('let a second person join with the role of the link, once', async () => {
    const { token } = await invite(adminCookie);
    expect(token).toMatch(/^[\w-]{43}$/);
    expect((await call('GET', `/api/invitations/${token}`)).json()).toEqual({
      valid: true,
      role: 'member',
      email: null,
      invitedBy: admin.name,
      orgName: 'Acme',
    });

    const accepted = await call('POST', `/api/invitations/${token}/accept`, { body: member });
    expect(accepted.statusCode).toBe(201);
    const me = await call('GET', '/api/me', { cookie: cookieOf(accepted) });
    expect(me.json()).toMatchObject({ name: 'Bob Member', email: member.email, role: 'member' });

    const again = await call('POST', `/api/invitations/${token}/accept`, {
      body: { ...member, email: 'carol@example.com' },
    });
    expect(again.statusCode).toBe(410);
    expect(again.json()).toMatchObject({
      error: { code: 'invitation_invalid', details: { reason: 'accepted' } },
    });
    expect((await call('GET', `/api/invitations/${token}`)).json()).toEqual({
      valid: false,
      reason: 'accepted',
    });
  });

  it('stop working when expired or revoked, and the list shows neither', async () => {
    const expired = await invite(adminCookie);
    await db
      .update(invitations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invitations.id, expired.id));
    const revoked = await invite(adminCookie);
    const pending = await invite(adminCookie, { role: 'admin' });
    expect(
      (await call('DELETE', `/api/invitations/${revoked.id}`, { cookie: adminCookie })).statusCode,
    ).toBe(204);

    for (const [token, reason] of [
      [expired.token, 'expired'],
      [revoked.token, 'revoked'],
      ['no-such-token', 'unknown'],
    ] as const) {
      expect((await call('GET', `/api/invitations/${token}`)).json()).toEqual({
        valid: false,
        reason,
      });
      const accept = await call('POST', `/api/invitations/${token}/accept`, {
        body: { name: 'Carol', email: 'carol@example.com', password: 'a third long password' },
      });
      expect(accept.statusCode).toBe(410);
    }

    const list = await call('GET', '/api/invitations', { cookie: adminCookie });
    expect(list.json<{ invitations: { id: string }[] }>().invitations).toEqual([
      expect.objectContaining({ id: pending.id, role: 'admin', invitedBy: 'Ann Admin' }),
    ]);
  });

  it('keep to the address they were made for, and to free addresses', async () => {
    const bound = await invite(adminCookie, { email: 'Dave@Example.com' });
    const wrong = await call('POST', `/api/invitations/${bound.token}/accept`, {
      body: { name: 'Eve', email: 'eve@example.com', password: 'a third long password' },
    });
    expect(wrong.statusCode).toBe(400);

    const taken = await invite(adminCookie);
    const duplicate = await call('POST', `/api/invitations/${taken.token}/accept`, {
      body: { ...member, email: 'BOB@example.com' },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ error: { code: 'email_taken' } });
    expect((await call('GET', `/api/invitations/${taken.token}`)).json()).toMatchObject({
      valid: true,
    });
  });
});

describe('admin routes', () => {
  it('answer 401 without a session and 403 to a member', async () => {
    const memberCookie = await signIn(member.email, member.password);
    const routes = [
      ['GET', '/api/users'],
      ['GET', '/api/invitations'],
      ['POST', '/api/invitations'],
      ['DELETE', '/api/invitations/00000000-0000-4000-8000-000000000000'],
      ['PATCH', '/api/users/00000000-0000-4000-8000-000000000000'],
    ] as const;
    for (const [method, url] of routes) {
      expect((await call(method, url)).statusCode).toBe(401);
      const forbidden = await call(method, url, { cookie: memberCookie, body: { disabled: true } });
      expect(forbidden.statusCode).toBe(403);
      expect(forbidden.json()).toMatchObject({ error: { code: 'forbidden' } });
    }
  });
});

describe('a disabled person', () => {
  it('is signed out, cannot sign in, and can be enabled again', async () => {
    const adminCookie = await signIn(admin.email, admin.password);
    const memberCookie = await signIn(member.email, member.password);
    const [bob] = await db.select().from(users).where(eq(users.email, member.email));
    // A link Bob handed out while he could (members cannot today; admins can).
    await db.insert(invitations).values({
      tokenHash: createHash('sha256').update('bobs-link').digest('hex'),
      role: 'admin',
      createdBy: bob?.id ?? '',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const disabled = await call('PATCH', `/api/users/${bob?.id}`, {
      cookie: adminCookie,
      body: { disabled: true },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({ disabledAt: expect.any(String) });
    expect((await call('GET', '/api/me', { cookie: memberCookie })).statusCode).toBe(401);
    expect((await call('GET', '/api/invitations/bobs-link')).json()).toEqual({
      valid: false,
      reason: 'revoked',
    });

    const signIn403 = await call('POST', '/api/auth/sign-in/email', { body: member });
    expect(signIn403.statusCode).toBe(403);
    expect(signIn403.json()).toMatchObject({ error: { code: 'account_disabled' } });
    // A wrong password learns nothing about the account.
    const wrong = await call('POST', '/api/auth/sign-in/email', {
      body: { ...member, password: 'wrong password!!' },
    });
    expect(wrong.statusCode).toBe(401);

    const list = await call('GET', '/api/users', { cookie: adminCookie });
    expect(list.json()).toMatchObject({
      users: [
        { email: 'ann@example.com', disabledAt: null },
        { email: member.email, disabledAt: expect.any(String) },
      ],
    });

    await call('PATCH', `/api/users/${bob?.id}`, {
      cookie: adminCookie,
      body: { disabled: false },
    });
    await signIn(member.email, member.password);
  });

  it('cannot be the admin themselves, whatever the case of the id', async () => {
    const cookie = await signIn(admin.email, admin.password);
    const me = (await call('GET', '/api/me', { cookie })).json<{ id: string }>();
    for (const id of [me.id, me.id.toUpperCase()]) {
      const response = await call('PATCH', `/api/users/${id}`, {
        cookie,
        body: { disabled: true },
      });
      expect(response.statusCode).toBe(403);
    }
  });
});

describe('the account', () => {
  const carol = { name: 'Carol', email: 'carol@example.com', password: 'carol long password' };
  let cookie: string;

  beforeAll(async () => {
    const { token } = await invite(await signIn(admin.email, admin.password));
    const accepted = await call('POST', `/api/invitations/${token}/accept`, { body: carol });
    expect(accepted.statusCode).toBe(201);
    cookie = cookieOf(accepted);
  });

  it('renames the person without a password', async () => {
    const renamed = await call('PATCH', '/api/me', { cookie, body: { name: 'Carol Diaz' } });
    expect(renamed.json()).toMatchObject({ name: 'Carol Diaz', email: carol.email });
  });

  it('changes the email only with the current password, and not to a taken one', async () => {
    const asked = { email: 'Carol.Diaz@Example.com' };
    for (const currentPassword of [undefined, 'not her password']) {
      const refused = await call('PATCH', '/api/me', {
        cookie,
        body: { ...asked, currentPassword },
      });
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({ error: { code: 'invalid_password' } });
    }
    const taken = await call('PATCH', '/api/me', {
      cookie,
      body: { email: admin.email, currentPassword: carol.password },
    });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ error: { code: 'email_taken' } });

    const changed = await call('PATCH', '/api/me', {
      cookie,
      body: { ...asked, currentPassword: carol.password },
    });
    expect(changed.json()).toMatchObject({ email: 'carol.diaz@example.com' });
    await signIn('carol.diaz@example.com', carol.password);
  });

  it('changes the password with the current one and signs the other devices out', async () => {
    const other = await signIn('carol.diaz@example.com', carol.password);
    const wrong = await call('POST', '/api/auth/change-password', {
      cookie,
      body: { currentPassword: 'not her password', newPassword: 'a new long password' },
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toMatchObject({ error: { code: 'invalid_password' } });

    const changed = await call('POST', '/api/auth/change-password', {
      cookie,
      body: {
        currentPassword: carol.password,
        newPassword: 'a new long password',
        revokeOtherSessions: true,
      },
    });
    expect(changed.statusCode).toBe(200);
    // This device keeps its session, under the cookie the answer set; the other is out.
    const here = cookieOf(changed);
    expect((await call('GET', '/api/me', { cookie: here })).statusCode).toBe(200);
    expect((await call('GET', '/api/me', { cookie: other })).statusCode).toBe(401);
    const old = await call('POST', '/api/auth/sign-in/email', {
      body: { email: 'carol.diaz@example.com', password: carol.password },
    });
    expect(old.statusCode).toBe(401);
    await signIn('carol.diaz@example.com', 'a new long password');
  });
});

describe('a forgotten password', () => {
  const dana = { name: 'Dana', email: 'dana@example.com', password: 'dana long password' };
  const config = () => loadConfig(env(container.getConnectionUri()));
  const tokenOf = (url: string) => url.split('/reset-password#')[1] ?? '';

  beforeAll(async () => {
    const { token } = await invite(await signIn(admin.email, admin.password));
    const accepted = await call('POST', `/api/invitations/${token}/accept`, { body: dana });
    expect(accepted.statusCode).toBe(201);
  });

  it('is set anew through a link that works once and ends every session', async () => {
    const before = await signIn(dana.email, dana.password);
    // The address in any case, as the person who runs the server types it.
    const { url, disabled } = await passwordResetLink(db, config(), ' Dana@Example.com ');
    expect(disabled).toBe(false);
    // The secret is after the #: a browser does not send it, so no log or proxy sees it.
    expect(url).toMatch(/^http:\/\/agentome\.test\/reset-password#[A-Za-z0-9]{24}$/);

    const short = await call('POST', '/api/auth/reset-password', {
      body: { token: tokenOf(url), newPassword: 'too short' },
    });
    expect(short.statusCode).toBe(400);
    expect(short.json()).toMatchObject({ error: { code: 'password_too_short' } });

    const set = await call('POST', '/api/auth/reset-password', {
      body: { token: tokenOf(url), newPassword: 'a password from the link' },
    });
    expect(set.statusCode).toBe(200);
    // Whoever had the old password is out, and it opens nothing any more.
    expect((await call('GET', '/api/me', { cookie: before })).statusCode).toBe(401);
    const old = await call('POST', '/api/auth/sign-in/email', {
      body: { email: dana.email, password: dana.password },
    });
    expect(old.statusCode).toBe(401);
    await signIn(dana.email, 'a password from the link');

    const again = await call('POST', '/api/auth/reset-password', {
      body: { token: tokenOf(url), newPassword: 'a second password from it' },
    });
    expect(again.statusCode).toBe(400);
    expect(again.json()).toMatchObject({ error: { code: 'invalid_token' } });
    await signIn(dana.email, 'a password from the link');
  });

  it('takes the personal API tokens with it, and an earlier link', async () => {
    const cookie = await signIn(dana.email, 'a password from the link');
    const made = await call('POST', '/api/me/tokens', { cookie, body: { name: 'laptop' } });
    expect(made.statusCode).toBe(201);
    const { token: apiToken } = made.json<{ token: string }>();
    const withToken = () =>
      app.inject({
        method: 'GET',
        url: '/api/me',
        headers: { authorization: `Bearer ${apiToken}` },
      });
    expect((await withToken()).statusCode).toBe(200);

    const first = await passwordResetLink(db, config(), dana.email);
    // A link sent to the wrong place is useless once another is asked for.
    const second = await passwordResetLink(db, config(), dana.email);
    const stale = await call('POST', '/api/auth/reset-password', {
      body: { token: tokenOf(first.url), newPassword: 'the first link will not do' },
    });
    expect(stale.statusCode).toBe(400);
    expect(stale.json()).toMatchObject({ error: { code: 'invalid_token' } });

    const set = await call('POST', '/api/auth/reset-password', {
      body: { token: tokenOf(second.url), newPassword: 'a password from the link' },
    });
    expect(set.statusCode).toBe(200);
    // What the old password could have made is gone with it.
    expect((await withToken()).statusCode).toBe(401);
  });

  it('refuses an account that signs in through Keycloak and has no password', async () => {
    const [erin] = await db
      .insert(users)
      .values({ name: 'Erin', email: 'erin@example.com', emailVerified: true, role: 'member' })
      .returning({ id: users.id });
    if (!erin) throw new Error('no user');
    await db
      .insert(accounts)
      .values({ userId: erin.id, providerId: 'keycloak', accountId: 'kc-erin' });
    await expect(passwordResetLink(db, config(), 'erin@example.com')).rejects.toThrow(
      'erin@example.com signs in through Keycloak and has no password here to reset',
    );
  });

  it('comes only from the command: nobody can ask the server for a link', async () => {
    const asked = await call('POST', '/api/auth/request-password-reset', {
      body: { email: dana.email },
    });
    expect(asked.statusCode).toBe(404);
    const guessed = await call('POST', '/api/auth/reset-password', {
      body: { token: 'a'.repeat(24), newPassword: 'a guessed token will not do' },
    });
    expect(guessed.statusCode).toBe(400);
    expect(guessed.json()).toMatchObject({ error: { code: 'invalid_token' } });
    await expect(passwordResetLink(db, config(), 'nobody@example.com')).rejects.toThrow(
      'No account with the email nobody@example.com',
    );
  });

  it('says so when the account is disabled, and does not let them in', async () => {
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.email, dana.email));
    const { url, disabled } = await passwordResetLink(db, config(), dana.email);
    expect(disabled).toBe(true);
    const set = await call('POST', '/api/auth/reset-password', {
      body: { token: tokenOf(url), newPassword: 'a password while disabled' },
    });
    expect(set.statusCode).toBe(200);
    const refused = await call('POST', '/api/auth/sign-in/email', {
      body: { email: dana.email, password: 'a password while disabled' },
    });
    expect(refused.statusCode).toBe(403);
    await db.update(users).set({ disabledAt: null }).where(eq(users.email, dana.email));
  });
});

describe('the secret key', () => {
  it('is checked at start against the one the installation was set up with', async () => {
    const url = container.getConnectionUri();
    await expect(prepareInstallation(loadConfig(env(url)), app.log)).resolves.toBeUndefined();
    const changed = loadConfig(
      env(url, { AGENTOME_SECRET_KEY: 'another-key-of-thirty-two-characters' }),
    );
    await expect(prepareInstallation(changed, app.log)).rejects.toThrow(ConfigError);
  });

  it('stops the server from starting when it changed', async () => {
    const server = fileURLToPath(new URL('..', import.meta.url));
    const run = promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      cwd: server,
      env: {
        ...process.env,
        ...env(container.getConnectionUri(), {
          AGENTOME_SECRET_KEY: 'another-key-of-thirty-two-characters',
          AGENTOME_LISTEN: '127.0.0.1:47321',
          AGENTOME_LOG_LEVEL: 'info',
        }),
      },
      timeout: 30_000,
    });
    const failure = await run.then(
      () => undefined,
      (error: { code?: number; stdout?: string }) => error,
    );
    expect(failure?.code).toBe(1);
    expect(failure?.stdout).toContain(
      'The secret key changed; restore AGENTOME_SECRET_KEY or the secrets volume',
    );
  }, 40_000);
});

describe('an automated install', () => {
  it('creates the admin from AGENTOME_SETUP_ADMIN_* on the first start', async () => {
    await db.execute('create database automated');
    const url = container.getConnectionUri().replace(/\/[^/]+$/, '/automated');
    await migrate(url);
    const config = loadConfig(
      env(url, {
        AGENTOME_SETUP_ADMIN_EMAIL: 'Ops@Example.com',
        AGENTOME_SETUP_ADMIN_PASSWORD: 'an automated password',
        AGENTOME_SETUP_ORG_NAME: 'Acme Ops',
      }),
    );
    await prepareInstallation(config, app.log);
    // A second start finds the installation and leaves it alone.
    await prepareInstallation(config, app.log);

    const automated = await buildApp(config);
    try {
      const response = await automated.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        payload: { email: 'ops@example.com', password: 'an automated password' },
        headers: { origin: publicUrl },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ user: { name: 'Administrator', role: 'admin' } });
    } finally {
      await automated.close();
    }
  });
});
