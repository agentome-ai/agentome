import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { askOptions, type Deps, envValue, install, withEnv } from './install.js';
import { backup, serverDir, update } from './server.js';
import type { Exec } from './system.js';

// `agentome install` and the admin's commands against a Docker and a GitHub of the test's own.

const EXAMPLE =
  'AGENTOME_VERSION=\nAGENTOME_HTTP_PORT=\nAGENTOME_POSTGRES_PASSWORD=\nCOMPOSE_PROFILES=\n';
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentome-cli-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function fakes(options: { volume?: boolean; failUp?: boolean } = {}) {
  const ran: string[] = [];
  const fetched: string[] = [];
  const exec: Exec = async (command, args, opts) => {
    const line = [command, ...args].join(' ');
    ran.push(line);
    if (line === 'docker volume inspect agentome_agentome-postgres')
      return { code: options.volume ? 0 : 1, stdout: '' };
    if (line.endsWith('up -d --wait --wait-timeout 180') && options.failUp)
      return { code: 1, stdout: '' };
    if (line.endsWith('printenv AGENTOME_PUBLIC_URL'))
      return { code: 0, stdout: 'http://localhost:3300\n' };
    if (line.endsWith('agentome setup-code')) return { code: 0, stdout: 'K7QX-M2PH-ABCD\n' };
    if (line.endsWith('agentome backup')) opts?.stdout?.write('the archive');
    return { code: 0, stdout: '' };
  };
  const fetchImpl = (async (url: string) => {
    fetched.push(url);
    const file = url.split('/v0.2.0/')[1] ?? url.split('/v0.3.0/')[1];
    const body =
      file === '.env.example'
        ? EXAMPLE
        : file === 'compose.yaml'
          ? 'name: agentome\n'
          : '# caddy\n';
    return new Response(body);
  }) as typeof fetch;
  const said: string[] = [];
  const deps: Deps = {
    exec,
    fetch: fetchImpl,
    ask: { text: async (_q, fallback) => fallback, yes: async (_q, fallback) => fallback },
    say: (line) => said.push(line),
    configDir: join(root, 'config'),
  };
  return { deps, ran, fetched, said };
}

const base = 'https://raw.githubusercontent.com/agentome-ai/agentome/v0.2.0';

describe('agentome install', () => {
  it('sets up the release it belongs to, with places and a password of its own, and says how to begin', async () => {
    const { deps, ran, fetched, said } = fakes();
    const dir = join(root, 'agentome');
    await install({ dir, version: '0.2.0', base, places: true, port: 3300 }, deps);
    expect(fetched).toEqual([
      `${base}/compose.yaml`,
      `${base}/.env.example`,
      `${base}/deploy/Caddyfile`,
    ]);
    const env = readFileSync(join(dir, '.env'), 'utf8');
    expect(envValue(env, 'AGENTOME_VERSION')).toBe('0.2.0');
    expect(envValue(env, 'AGENTOME_HTTP_PORT')).toBe('3300');
    expect(envValue(env, 'AGENTOME_PLACE_LAUNCHER_URL')).toBe('http://place-launcher:8080');
    expect(envValue(env, 'COMPOSE_PROFILES')).toBe('places');
    expect(envValue(env, 'AGENTOME_POSTGRES_PASSWORD')).toMatch(/^[0-9a-f]{48}$/);
    expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600);
    expect(ran).toEqual(
      expect.arrayContaining([
        'docker compose pull',
        'docker compose up -d --wait --wait-timeout 180',
        'docker compose exec -T app agentome setup-code',
      ]),
    );
    expect(said.join('\n')).toContain('Open http://localhost:3300/setup');
    expect(said.join('\n')).toContain('K7QX-M2PH-ABCD');
    // Remembered, so that `agentome status` finds it from anywhere.
    expect(serverDir(undefined, join(root, 'config'))).toBe(dir);
  });

  it('serves a domain over HTTPS through the proxy, and keeps the password of a database that exists', async () => {
    const { deps } = fakes({ volume: true });
    const dir = join(root, 'agentome');
    await install({ dir, version: '0.2.0', base, domain: 'agentome.corp.example' }, deps);
    const env = readFileSync(join(dir, '.env'), 'utf8');
    expect(envValue(env, 'AGENTOME_PROXY_HOST')).toBe('agentome.corp.example');
    expect(envValue(env, 'AGENTOME_PUBLIC_URL')).toBe('https://agentome.corp.example');
    expect(envValue(env, 'COMPOSE_PROFILES')).toBe('proxy');
    expect(envValue(env, 'AGENTOME_POSTGRES_PASSWORD')).toBeUndefined();
  });

  it('keeps .env and the Caddyfile when run again, and says why it stopped when the server is not healthy', async () => {
    const { deps } = fakes({ failUp: true });
    const dir = join(root, 'agentome');
    await expect(install({ dir, version: '0.2.0', base }, deps)).rejects.toThrow(/not healthy/);
    writeFileSync(
      join(dir, '.env'),
      withEnv(readFileSync(join(dir, '.env'), 'utf8'), 'AGENTOME_LOG_LEVEL', 'debug'),
    );
    writeFileSync(join(dir, 'deploy', 'Caddyfile'), '# mine\n');
    const again = fakes();
    await install({ dir, version: '0.2.0', base }, again.deps);
    expect(envValue(readFileSync(join(dir, '.env'), 'utf8'), 'AGENTOME_LOG_LEVEL')).toBe('debug');
    expect(readFileSync(join(dir, 'deploy', 'Caddyfile'), 'utf8')).toBe('# mine\n');
    expect(again.fetched).not.toContain(`${base}/deploy/Caddyfile`);
  });

  it('refuses an address that is not a domain', async () => {
    const { deps } = fakes();
    await expect(
      askOptions({ dir: './agentome', version: '0.2.0', base }, { domain: 'http://x y' }, deps),
    ).rejects.toThrow(/not a domain name/);
  });
});

describe("the server's admin", () => {
  it('backs up into backups/, the archive theirs alone, and updates after a backup', async () => {
    const { deps, ran } = fakes();
    const dir = join(root, 'agentome');
    await install({ dir, version: '0.2.0', base }, deps);
    const archive = await backup(dir, undefined, deps);
    expect(readFileSync(archive, 'utf8')).toBe('the archive');
    expect(statSync(archive).mode & 0o777).toBe(0o600);

    ran.length = 0;
    await update(dir, { version: '0.3.0', base: base.replace('v0.2.0', 'v0.3.0') }, deps);
    expect(envValue(readFileSync(join(dir, '.env'), 'utf8'), 'AGENTOME_VERSION')).toBe('0.3.0');
    const order = [
      'docker compose exec -T app agentome backup',
      'docker compose pull',
      'docker compose up -d --wait --wait-timeout 300',
    ];
    expect(ran.filter((line) => order.includes(line))).toEqual(order);
  });

  it('finds no server where there is none', () => {
    expect(() => serverDir(root, join(root, 'config'))).toThrow(/has no compose.yaml of Agentome/);
  });
});
