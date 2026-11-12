import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, loadStorageConfig } from './config.js';

const key = 'k'.repeat(32);
let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'agentome-config-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('falls back to the documented defaults', () => {
    expect(loadConfig({ AGENTOME_DATA_DIR: dataDir })).toEqual({
      databaseUrl: 'postgres://agentome:agentome@localhost:5432/agentome',
      listen: { host: '0.0.0.0', port: 3000 },
      publicUrl: 'http://localhost:3000',
      oauthReturnUrl: 'http://localhost:3000',
      dataDir,
      secretKey: expect.any(String),
      webDir: undefined,
      logLevel: 'info',
      runLimits: { maxMinutes: 60, maxTurns: 50, maxTokens: 2_000_000 },
      orphanMinutes: 3,
      knowledgeSyncMinutes: 60,
      jiraPollMinutes: 5,
      logRetentionDays: 30,
      setupAdmin: undefined,
      trustProxy: false,
      updateCheck: true,
      build: { version: null, commit: null },
    });
    // A key is given so that the test does not create .data in the working directory.
    expect(loadConfig({ AGENTOME_SECRET_KEY: key }).dataDir).toBe(resolve('.data'));
  });

  it('reads every setting from the environment', () => {
    writeFileSync(join(dataDir, 'index.html'), '<!doctype html>');
    const config = loadConfig({
      AGENTOME_DATABASE_URL: 'postgresql://app:pw@db:5432/app',
      AGENTOME_LISTEN: '127.0.0.1:8080',
      AGENTOME_PUBLIC_URL: 'https://agentome.example.com',
      AGENTOME_OAUTH_RETURN_URL: 'http://localhost:3100',
      AGENTOME_DATA_DIR: dataDir,
      AGENTOME_SECRET_KEY: key,
      AGENTOME_WEB_DIR: dataDir,
      AGENTOME_LOG_LEVEL: 'debug',
      AGENTOME_RUN_MAX_MINUTES: '30',
      AGENTOME_RUN_MAX_TURNS: '120',
      AGENTOME_RUN_MAX_TOKENS: '500000',
      AGENTOME_RUN_ORPHAN_MINUTES: '5',
      AGENTOME_KNOWLEDGE_SYNC_MINUTES: '15',
      AGENTOME_JIRA_POLL_MINUTES: '2',
      AGENTOME_LOG_RETENTION_DAYS: '7',
      AGENTOME_TRUST_PROXY: 'true',
      AGENTOME_UPDATE_CHECK: 'false',
      AGENTOME_BUILD_VERSION: '0.2.0',
      AGENTOME_BUILD_COMMIT: '572776f',
    });
    expect(config).toEqual({
      databaseUrl: 'postgresql://app:pw@db:5432/app',
      listen: { host: '127.0.0.1', port: 8080 },
      publicUrl: 'https://agentome.example.com',
      oauthReturnUrl: 'http://localhost:3100',
      dataDir,
      secretKey: key,
      webDir: dataDir,
      logLevel: 'debug',
      runLimits: { maxMinutes: 30, maxTurns: 120, maxTokens: 500_000 },
      orphanMinutes: 5,
      knowledgeSyncMinutes: 15,
      jiraPollMinutes: 2,
      logRetentionDays: 7,
      setupAdmin: undefined,
      trustProxy: true,
      updateCheck: false,
      build: { version: '0.2.0', commit: '572776f' },
    });
  });

  it('treats an empty variable as unset', () => {
    const config = loadConfig({ AGENTOME_DATA_DIR: dataDir, AGENTOME_LISTEN: '' });
    expect(config.listen).toEqual({ host: '0.0.0.0', port: 3000 });
  });

  it('listens on host:port, IPv6 hosts in brackets', () => {
    const listen = (value: string) =>
      loadConfig({ AGENTOME_DATA_DIR: dataDir, AGENTOME_LISTEN: value }).listen;
    expect(listen('[::]:3000')).toEqual({ host: '::', port: 3000 });
    expect(listen('localhost:3100')).toEqual({ host: 'localhost', port: 3100 });
    expect(() => listen('3000')).toThrow(/AGENTOME_LISTEN: Expected host:port/);
    expect(() => listen('0.0.0.0:70000')).toThrow(/AGENTOME_LISTEN: The port must be between/);
  });

  it('stops on the port variables of earlier versions and of compose.yaml', () => {
    const load = (env: Record<string, string>) => () =>
      loadConfig({ AGENTOME_DATA_DIR: dataDir, ...env });
    expect(load({ AGENTOME_PORT: '8080' })).toThrow(/AGENTOME_PORT: renamed to AGENTOME_LISTEN/);
    expect(load({ AGENTOME_HTTP_PORT: '3100' })).toThrow(
      /AGENTOME_HTTP_PORT: this is the host port that compose.yaml publishes; the server listens on AGENTOME_LISTEN/,
    );
  });

  // Kubernetes puts AGENTOME_PORT=tcp://10.0.0.1:3000 into the pods next to a Service agentome.
  it('lets the service links of Kubernetes pass', () => {
    const config = loadConfig({
      AGENTOME_DATA_DIR: dataDir,
      AGENTOME_PORT: 'tcp://10.0.0.1:3000',
      AGENTOME_HTTP_PORT: 'tcp://10.0.0.2:80',
    });
    expect(config.listen).toEqual({ host: '0.0.0.0', port: 3000 });
  });

  it('names every invalid variable', () => {
    const load = () =>
      loadConfig({
        AGENTOME_DATA_DIR: dataDir,
        AGENTOME_DATABASE_URL: 'mysql://localhost/agentome',
        AGENTOME_LISTEN: '0.0.0.0',
        AGENTOME_LOG_LEVEL: 'loud',
        AGENTOME_SECRET_KEY: 'short',
        AGENTOME_RUN_MAX_TURNS: '0',
      });
    expect(load).toThrow(ConfigError);
    expect(load).toThrow(
      /AGENTOME_DATABASE_URL[\s\S]*AGENTOME_LISTEN[\s\S]*AGENTOME_SECRET_KEY[\s\S]*AGENTOME_LOG_LEVEL[\s\S]*AGENTOME_RUN_MAX_TURNS/,
    );
  });

  it('fails when AGENTOME_WEB_DIR holds no built web app', () => {
    expect(() => loadConfig({ AGENTOME_DATA_DIR: dataDir, AGENTOME_WEB_DIR: dataDir })).toThrow(
      /AGENTOME_WEB_DIR: .* has no index.html/,
    );
  });

  it('returns OAuth sign-ins to the public address unless told another', () => {
    const base = { AGENTOME_DATA_DIR: dataDir, AGENTOME_PUBLIC_URL: 'https://192.168.1.233' };
    expect(loadConfig(base).oauthReturnUrl).toBe('https://192.168.1.233');
    expect(
      loadConfig({ ...base, AGENTOME_OAUTH_RETURN_URL: 'http://localhost:3100/' }).oauthReturnUrl,
    ).toBe('http://localhost:3100');
    expect(() =>
      loadConfig({ ...base, AGENTOME_OAUTH_RETURN_URL: 'http://localhost:3100/cb' }),
    ).toThrow(/AGENTOME_OAUTH_RETURN_URL: Expected an address without a path/);
  });

  it('takes a public address without a path, and drops its trailing slash', () => {
    const publicUrl = (value: string) =>
      loadConfig({ AGENTOME_DATA_DIR: dataDir, AGENTOME_PUBLIC_URL: value }).publicUrl;
    expect(publicUrl('https://agentome.example.com/')).toBe('https://agentome.example.com');
    expect(publicUrl('http://10.0.0.5:3100')).toBe('http://10.0.0.5:3100');
    expect(() => publicUrl('https://example.com/agentome')).toThrow(
      /AGENTOME_PUBLIC_URL: Expected an address without a path/,
    );
  });

  it('gives the CLI the database and the data directory even when the rest is broken', () => {
    const env = {
      AGENTOME_DATA_DIR: dataDir,
      AGENTOME_DATABASE_URL: 'postgres://app@db:5432/app',
      AGENTOME_SECRET_KEY_FILE: join(dataDir, 'missing'),
      AGENTOME_LOG_LEVEL: 'loud',
    };
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(loadStorageConfig(env)).toEqual({ databaseUrl: 'postgres://app@db:5432/app', dataDir });
  });

  it('accepts the database URLs postgres.js accepts and rejects the ones it would misread', () => {
    const databaseUrl = (url: string) =>
      loadConfig({ AGENTOME_DATA_DIR: dataDir, AGENTOME_DATABASE_URL: url }).databaseUrl;
    expect(databaseUrl('postgres://app:pw@db1:5432,db2:5432/app')).toBe(
      'postgres://app:pw@db1:5432,db2:5432/app',
    );
    expect(databaseUrl('postgres://app:50%25off@db:5432/app')).toBe(
      'postgres://app:50%25off@db:5432/app',
    );
    expect(() => databaseUrl('postgres://app:50%off@db:5432/app')).toThrow(/write it as %25/);
    expect(() => databaseUrl('postgres:/app:pw@db:5432/app')).toThrow(/Expected postgres:\/\//);
  });

  // postgres.js would throw on these with the whole URL in the error, and Node prints it.
  it('rejects a raw / # or ? in the password without printing it', () => {
    for (const password of ['Secr#t42', 'Secr/t42', 'Secr?t42']) {
      const load = () =>
        loadConfig({
          AGENTOME_DATA_DIR: dataDir,
          AGENTOME_DATABASE_URL: `postgres://agentome:${password}@postgres:5432/agentome`,
        });
      expect(load).toThrow(/is not a valid URL: .* in the password must be percent-encoded/);
      expect(load).not.toThrow(/t42/);
    }
    const encoded = 'postgres://agentome:Secr%23t42@postgres:5432/agentome';
    expect(
      loadConfig({ AGENTOME_DATA_DIR: dataDir, AGENTOME_DATABASE_URL: encoded }),
    ).toMatchObject({ databaseUrl: encoded });
  });
});

describe('the database URL', () => {
  const url = 'postgres://app:s3cret@db:5432/app';
  const urlFile = () => join(dataDir, 'database-url');

  it('comes from AGENTOME_DATABASE_URL_FILE, without the trailing newline', () => {
    writeFileSync(urlFile(), `${url}\n`);
    const config = loadConfig({
      AGENTOME_DATA_DIR: dataDir,
      AGENTOME_DATABASE_URL_FILE: urlFile(),
    });
    expect(config.databaseUrl).toBe(url);
  });

  it('takes AGENTOME_DATABASE_URL or the file, not both', () => {
    writeFileSync(urlFile(), url);
    const both = {
      AGENTOME_DATA_DIR: dataDir,
      AGENTOME_DATABASE_URL: 'postgres://other:pw@db:5432/other',
      AGENTOME_DATABASE_URL_FILE: urlFile(),
    };
    expect(() => loadConfig(both)).toThrow(
      /AGENTOME_DATABASE_URL_FILE: set one of AGENTOME_DATABASE_URL and AGENTOME_DATABASE_URL_FILE/,
    );
    // The way compose.override.yaml turns off the URL that compose.yaml sets.
    expect(loadConfig({ ...both, AGENTOME_DATABASE_URL: '' }).databaseUrl).toBe(url);
  });

  it('fails when the file is missing or invalid, without printing its contents', () => {
    const load = () =>
      loadConfig({ AGENTOME_DATA_DIR: dataDir, AGENTOME_DATABASE_URL_FILE: urlFile() });
    expect(load).toThrow(/AGENTOME_DATABASE_URL_FILE: cannot read the database URL/);
    writeFileSync(urlFile(), 'mysql://app:s3cret@db/app');
    expect(load).toThrow(/AGENTOME_DATABASE_URL_FILE: .* is invalid: Expected postgres:\/\//);
    expect(load).not.toThrow(/s3cret/);
  });
});

describe('the administrator of an automated install', () => {
  const load = (env: Record<string, string>) =>
    loadConfig({ AGENTOME_DATA_DIR: dataDir, AGENTOME_SECRET_KEY: key, ...env }).setupAdmin;

  it('is absent unless asked for', () => {
    expect(load({ AGENTOME_SETUP_ORG_NAME: 'Acme' })).toBeUndefined();
  });

  it('comes from the environment, with the email in lower case and Agentome as the company', () => {
    expect(
      load({
        AGENTOME_SETUP_ADMIN_EMAIL: 'Ops@Acme.com',
        AGENTOME_SETUP_ADMIN_PASSWORD: 'p'.repeat(12),
      }),
    ).toEqual({ email: 'ops@acme.com', password: 'p'.repeat(12), orgName: 'Agentome' });
  });

  it('takes the password from AGENTOME_SETUP_ADMIN_PASSWORD_FILE, without the newline', () => {
    const file = join(dataDir, 'admin-password');
    writeFileSync(file, ' spaces count too \n');
    expect(
      load({
        AGENTOME_SETUP_ADMIN_EMAIL: 'ops@acme.com',
        AGENTOME_SETUP_ADMIN_PASSWORD_FILE: file,
        AGENTOME_SETUP_ORG_NAME: 'Acme',
      }),
    ).toEqual({ email: 'ops@acme.com', password: ' spaces count too ', orgName: 'Acme' });
  });

  it('needs both the email and a password of at least 12 characters', () => {
    expect(() => load({ AGENTOME_SETUP_ADMIN_EMAIL: 'ops@acme.com' })).toThrow(/go together/);
    expect(() => load({ AGENTOME_SETUP_ADMIN_PASSWORD: 'p'.repeat(12) })).toThrow(/go together/);
    expect(() =>
      load({ AGENTOME_SETUP_ADMIN_EMAIL: 'ops@acme.com', AGENTOME_SETUP_ADMIN_PASSWORD: 'short' }),
    ).toThrow(/AGENTOME_SETUP_ADMIN_PASSWORD: Use at least 12 characters/);
    const file = join(dataDir, 'admin-password');
    writeFileSync(file, 'short\n');
    expect(() =>
      load({
        AGENTOME_SETUP_ADMIN_EMAIL: 'ops@acme.com',
        AGENTOME_SETUP_ADMIN_PASSWORD_FILE: file,
      }),
    ).toThrow(/AGENTOME_SETUP_ADMIN_PASSWORD_FILE: Use at least 12 characters/);
  });
});

describe('the secret key', () => {
  const keyFile = () => join(dataDir, 'secrets', 'secret.key');

  it('is generated on the first start, readable only by the owner, and kept', () => {
    const first = loadConfig({ AGENTOME_DATA_DIR: dataDir }).secretKey;
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(keyFile(), 'utf8')).toBe(first);
    expect(statSync(keyFile()).mode & 0o777).toBe(0o600);
    expect(statSync(join(dataDir, 'secrets')).mode & 0o777).toBe(0o700);
    expect(loadConfig({ AGENTOME_DATA_DIR: dataDir }).secretKey).toBe(first);
  });

  it('comes from AGENTOME_SECRET_KEY_FILE, without the trailing newline', () => {
    const file = join(dataDir, 'docker-secret');
    writeFileSync(file, `${key}\n`);
    const config = loadConfig({ AGENTOME_DATA_DIR: dataDir, AGENTOME_SECRET_KEY_FILE: file });
    expect(config.secretKey).toBe(key);
  });

  it('prefers AGENTOME_SECRET_KEY to the file and to the generated key', () => {
    const file = join(dataDir, 'docker-secret');
    writeFileSync(file, 'f'.repeat(32));
    const config = loadConfig({
      AGENTOME_DATA_DIR: dataDir,
      AGENTOME_SECRET_KEY: ` ${key}\n`,
      AGENTOME_SECRET_KEY_FILE: file,
    });
    expect(config.secretKey).toBe(key);
    expect(() => statSync(keyFile())).toThrow();
  });

  // Root ignores directory permissions, so the write would succeed.
  it.skipIf(process.getuid?.() === 0)('leaves no file behind when it cannot be written', () => {
    mkdirSync(join(dataDir, 'secrets'), { mode: 0o500 });
    expect(() => loadConfig({ AGENTOME_DATA_DIR: dataDir })).toThrow(
      /Cannot create the secret key/,
    );
    expect(readdirSync(join(dataDir, 'secrets'))).toEqual([]);
  });

  it('fails when AGENTOME_SECRET_KEY_FILE is missing or too short', () => {
    const file = join(dataDir, 'docker-secret');
    expect(() =>
      loadConfig({ AGENTOME_DATA_DIR: dataDir, AGENTOME_SECRET_KEY_FILE: file }),
    ).toThrow(/AGENTOME_SECRET_KEY_FILE: cannot read/);
    writeFileSync(file, 'short\n');
    expect(() =>
      loadConfig({ AGENTOME_DATA_DIR: dataDir, AGENTOME_SECRET_KEY_FILE: file }),
    ).toThrow(/shorter than 32 characters/);
  });

  it('fails clearly when the data directory cannot be written', () => {
    const file = join(dataDir, 'not-a-directory');
    writeFileSync(file, '');
    expect(() => loadConfig({ AGENTOME_DATA_DIR: file })).toThrow(/Cannot create the secret key/);
  });
});

describe('sign-in with Keycloak', () => {
  const load = (env: Record<string, string>) =>
    loadConfig({ AGENTOME_DATA_DIR: dataDir, AGENTOME_SECRET_KEY: 'k'.repeat(32), ...env })
      .keycloak;

  it('is off without its settings, and takes the realm without its trailing slash', () => {
    expect(load({})).toBeUndefined();
    expect(
      load({
        AGENTOME_KEYCLOAK_ISSUER: 'https://sso.acme.com/realms/acme/',
        AGENTOME_KEYCLOAK_CLIENT_ID: 'agentome',
        AGENTOME_KEYCLOAK_CLIENT_SECRET: 'secret',
      }),
    ).toEqual({
      issuer: 'https://sso.acme.com/realms/acme',
      clientId: 'agentome',
      clientSecret: 'secret',
    });
  });

  it('needs all three settings', () => {
    expect(() => load({ AGENTOME_KEYCLOAK_ISSUER: 'https://sso.acme.com/realms/acme' })).toThrow(
      /go together/,
    );
  });
});
