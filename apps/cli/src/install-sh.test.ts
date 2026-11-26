import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// deploy/install.sh, the one line on agentome.ai, run by sh against a docker and a curl of the
// test's own: what it asks for, what it writes to .env, and what it leaves alone on a second run.

const repo = join(import.meta.dirname, '..', '..', '..');
const script = join(repo, 'deploy', 'install.sh');
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentome-install-sh-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Runs the script in `root` with a fake docker and curl; what it said and what curl fetched. */
function install(
  args: string[],
  options: { runtimes?: string; volume?: boolean; runningFrom?: string; cwd?: string } = {},
) {
  const bin = join(root, 'bin');
  const files = join(root, 'release');
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(files, 'deploy'), { recursive: true });
  writeFileSync(join(files, 'compose.yaml'), 'services: {}\n');
  writeFileSync(
    join(files, '.env.example'),
    'AGENTOME_VERSION=\nAGENTOME_HTTP_PORT=\nAGENTOME_POSTGRES_PASSWORD=\nCOMPOSE_PROFILES=\n',
  );
  writeFileSync(join(files, 'deploy', 'Caddyfile'), '{$AGENTOME_PROXY_HOST}\n');
  const log = join(root, 'calls.log');
  // curl -fsSL <base>/<file> -o <out>: the base is the release folder here.
  writeFileSync(
    join(bin, 'curl'),
    `#!/bin/sh\nurl=$2; out=$4; echo "curl $url" >> '${log}'\ncp "${files}/\${url#base/}" "$out"\n`,
  );
  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/sh
echo "docker $*" >> '${log}'
case "$*" in
  "info --format"*) printf '%s' '${options.runtimes ?? 'io.containerd.runc.v2 runc '}' ;;
  "volume inspect"*) ${options.volume === true ? 'exit 0' : 'exit 1'} ;;
  "ps --filter"*) printf '%s' '${options.runningFrom ?? ''}' ;;
  *"printenv AGENTOME_PUBLIC_URL"*) echo 'https://agentome.example.com' ;;
  *"setup-code"*) echo 'CODE-1234' ;;
  *"agentome backup"*) echo 'THE-ARCHIVE' ;;
esac
exit 0
`,
  );
  chmodSync(join(bin, 'curl'), 0o755);
  chmodSync(join(bin, 'docker'), 0o755);
  const run = spawnSync('sh', [script, ...args], {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      AGENTOME_INSTALL_BASE: 'base',
      HOME: join(root, 'home'),
      CI: '1',
      NO_COLOR: '1',
    },
  });
  const env = (() => {
    try {
      return readFileSync(join(root, 'agentome', '.env'), 'utf8');
    } catch {
      return '';
    }
  })();
  const calls = (() => {
    try {
      return readFileSync(log, 'utf8');
    } catch {
      return '';
    }
  })();
  return { code: run.status, out: run.stdout + run.stderr, env, calls };
}

const value = (env: string, name: string) =>
  env
    .split('\n')
    .filter((line) => line.startsWith(`${name}=`))
    .at(-1)
    ?.slice(name.length + 1);

describe('deploy/install.sh', () => {
  it('installs a server for a company: its domain, places, gVisor and a Docker for each run', () => {
    const done = install(['--domain', 'Agentome.Example.com', '--places'], {
      runtimes: 'runc runsc runsc-docker ',
    });
    expect(done.code, done.out).toBe(0);
    expect(value(done.env, 'AGENTOME_VERSION')).toBe('0.4.4');
    expect(value(done.env, 'AGENTOME_PROXY_HOST')).toBe('agentome.example.com');
    expect(value(done.env, 'AGENTOME_PUBLIC_URL')).toBe('https://agentome.example.com');
    expect(value(done.env, 'COMPOSE_PROFILES')).toBe('proxy,places');
    expect(value(done.env, 'AGENTOME_PLACE_LAUNCHER_URL')).toBe('http://place-launcher:8080');
    expect(value(done.env, 'AGENTOME_PLACE_RUNTIME')).toBe('runsc');
    expect(value(done.env, 'AGENTOME_PLACE_DOCKER_RUNTIME')).toBe('runsc-docker');
    expect(value(done.env, 'AGENTOME_POSTGRES_PASSWORD')).toMatch(/^[0-9a-f]{48}$/);
    expect(done.calls).toContain('docker compose up -d --wait');
    expect(done.out).toContain(
      'Open https://agentome.example.com/setup to create the administrator, with the setup code CODE-1234',
    );
  });

  it('without gVisor and nobody to answer, installs places that will not start until told how', () => {
    const done = install(['--places']);
    expect(done.code, done.out).toBe(0);
    expect(done.out).toContain('gVisor (runsc) is not registered with Docker');
    expect(done.out).toContain('Places will not start until gVisor is registered');
    // Never runc unasked: the launcher refuses places until the admin chooses.
    expect(value(done.env, 'AGENTOME_PLACE_RUNTIME')).toBeUndefined();
    expect(value(done.env, 'COMPOSE_PROFILES')).toBe('places');
  });

  it('installs a plain local server with no places, on another port', () => {
    const done = install(['--local', '--no-places', '--port', '3300']);
    expect(done.code, done.out).toBe(0);
    expect(value(done.env, 'COMPOSE_PROFILES')).toBe('');
    expect(value(done.env, 'AGENTOME_HTTP_PORT')).toBe('3300');
    expect(value(done.env, 'AGENTOME_PLACE_LAUNCHER_URL')).toBeUndefined();
  });

  it('updates in the same folder and keeps .env: the password, the domain, the places', () => {
    const first = install(['--domain', 'agentome.example.com', '--places'], { runtimes: 'runsc ' });
    const password = value(first.env, 'AGENTOME_POSTGRES_PASSWORD');
    const again = install([], { runtimes: 'runsc ', volume: true });
    expect(again.code, again.out).toBe(0);
    expect(value(again.env, 'AGENTOME_POSTGRES_PASSWORD')).toBe(password);
    expect(value(again.env, 'AGENTOME_PROXY_HOST')).toBe('agentome.example.com');
    expect(value(again.env, 'COMPOSE_PROFILES')).toBe('proxy,places');
    expect(again.env.match(/^COMPOSE_PROFILES=/gm)).toHaveLength(1);
    expect(again.out).toContain('Keeping deploy/Caddyfile as it is.');
  });

  it('refuses a domain that is not one, and an unknown option', () => {
    const bad = install(['--domain', 'not a domain']);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('is not a domain name');
    const unknown = install(['--colour']);
    expect(unknown.code).toBe(1);
    expect(unknown.out).toContain('unknown option --colour');
  });

  it('names the release compose.yaml pins', () => {
    const release = /^RELEASE=(\S+)$/m.exec(readFileSync(script, 'utf8'))?.[1];
    const compose = readFileSync(join(repo, 'compose.yaml'), 'utf8');
    expect(compose).toContain(`agentome/agentome:\${AGENTOME_VERSION:-${release ?? ''}}`);
  });

  it('refuses to take over an installation that runs from another folder', () => {
    const done = install(['--places'], { runningFrom: '/srv/agentome' });
    expect(done.code).toBe(1);
    expect(done.out).toContain('Agentome already runs on this machine from /srv/agentome');
    expect(done.calls).not.toContain('docker compose up');
  });

  it('updates the installation of the folder it is run in', () => {
    install(['--dir', 'agentome', '--local', '--no-places', '--port', '3300']);
    const again = install([], { cwd: join(root, 'agentome'), volume: true });
    expect(again.code, again.out).toBe(0);
    expect(again.out).toContain('Keeping deploy/Caddyfile as it is.');
    expect(value(again.env, 'AGENTOME_HTTP_PORT')).toBe('3300');
    expect(again.out).toContain('agentome status, agentome update');
  });

  it('puts an agentome command on the machine, which runs this server from anywhere', () => {
    const done = install(['--domain', 'agentome.example.com', '--places'], { runtimes: 'runsc ' });
    expect(done.code, done.out).toBe(0);
    const command = join(root, 'home', '.local', 'bin', 'agentome');
    expect(readFileSync(command, 'utf8')).toContain(`AGENTOME_DIR='`);
    expect(done.out).toContain('agentome status, agentome update');
    const elsewhere = mkdtempSync(join(tmpdir(), 'agentome-elsewhere-'));
    const run = (...args: string[]) =>
      spawnSync('sh', [command, ...args], {
        cwd: elsewhere,
        encoding: 'utf8',
        env: { PATH: `${join(root, 'bin')}:/usr/bin:/bin`, HOME: join(root, 'home') },
      });
    const status = run('status');
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toContain('Version: 0.4.4');
    expect(status.stdout).toContain('Address: https://agentome.example.com');
    expect(run('setup-code').stdout).toContain('CODE-1234');
    // A backup lands where the admin is, not in the server's folder, and only they may read it.
    expect(run('backup', 'nightly.tar.gz').status).toBe(0);
    expect(readFileSync(join(elsewhere, 'nightly.tar.gz'), 'utf8')).toBe('THE-ARCHIVE\n');
    expect(statSync(join(elsewhere, 'nightly.tar.gz')).mode & 0o777).toBe(0o600);
    // The launcher stops with the server for a new key, where places are on.
    expect(run('rotate-key').status).toBe(0);
    expect(readFileSync(join(root, 'calls.log'), 'utf8')).toContain(
      'docker compose stop app place-launcher',
    );
    const unknown = run('deploy');
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('unknown command deploy');
    rmSync(elsewhere, { recursive: true, force: true });
  });
});
