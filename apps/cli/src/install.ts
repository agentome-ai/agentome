import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Ask, Exec } from './system.js';
import { Refusal } from './system.js';

// `agentome install`: the server on this machine with Docker Compose, as deploy/install.sh does it,
// with a few questions on the way. The files are those of the release this program belongs to, so
// a program of 0.2.0 installs 0.2.0; run again in the same folder, it keeps .env and updates.

export interface InstallOptions {
  /** The folder the server's files go into. */
  dir: string;
  port?: number;
  /** A domain for HTTPS through the proxy profile; none serves plain HTTP on the port. */
  domain?: string;
  /** People's places on the server. */
  places?: boolean;
  /** The release to install. */
  version: string;
  /** Where compose.yaml and its files are read from. */
  base: string;
}

export interface Deps {
  exec: Exec;
  fetch: typeof fetch;
  ask: Ask;
  say: (line: string) => void;
  /** Where the program remembers the folder, for status, update and backup. */
  configDir?: string;
}

/** The value of a setting in .env text, or undefined when it is not there or empty. */
export function envValue(text: string, name: string): string | undefined {
  const line = text.split('\n').find((row) => row.startsWith(`${name}=`));
  const value = line?.slice(name.length + 1).trim();
  return value ? value : undefined;
}

/** .env text with a setting set: in place of its line, or added at the end. */
export function withEnv(text: string, name: string, value: string): string {
  const lines = text.split('\n');
  const at = lines.findIndex((row) => row.startsWith(`${name}=`));
  if (at >= 0) lines[at] = `${name}=${value}`;
  else {
    if (lines.at(-1) === '') lines.pop();
    lines.push(`${name}=${value}`, '');
  }
  return lines.join('\n');
}

/** A comma-separated list of compose profiles with one more. */
const withProfile = (profiles: string | undefined, profile: string) =>
  [...new Set([...(profiles ?? '').split(',').filter(Boolean), profile])].join(',');

const DOMAIN =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/** Whether nothing on this machine listens on the port yet. */
export function portFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const probe = createServer();
    probe.once('error', () => done(false));
    probe.listen(port, '0.0.0.0', () => probe.close(() => done(true)));
  });
}

export function rememberServer(dir: string, configDir = join(homedir(), '.config', 'agentome')) {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'server.json'), `${JSON.stringify({ dir }, null, 2)}\n`);
}

async function download(deps: Deps, base: string, file: string, to: string) {
  const answer = await deps.fetch(`${base}/${file}`).catch(() => undefined);
  if (!answer?.ok) throw new Refusal(`cannot download ${base}/${file}`);
  writeFileSync(to, await answer.text());
}

/** Docker and its Compose plugin answer, and the daemon is reachable. */
export async function checkDocker(deps: Deps) {
  if ((await deps.exec('docker', ['--version'], { capture: true })).code !== 0) {
    throw new Refusal('Docker is not installed: https://docs.docker.com/engine/install/');
  }
  if ((await deps.exec('docker', ['compose', 'version'], { capture: true })).code !== 0) {
    throw new Refusal(
      'the Docker Compose plugin is missing: https://docs.docker.com/compose/install/',
    );
  }
  if ((await deps.exec('docker', ['info'], { capture: true })).code !== 0) {
    throw new Refusal('cannot reach Docker: start it, or run this as a user of the docker group');
  }
}

/** Asks what the flags did not say. */
export async function askOptions(
  options: InstallOptions,
  given: Partial<InstallOptions>,
  deps: Deps,
) {
  const dir = given.dir ?? (await deps.ask.text('Folder for the server', options.dir));
  let domain = given.domain;
  if (domain === undefined) {
    const typed = await deps.ask.text(
      'Address people open: a domain for HTTPS, such as agentome.example.com, or Enter for this machine only',
      '',
    );
    domain = typed.replace(/^https?:\/\//, '').replace(/\/+$/, '') || undefined;
  }
  if (domain && !DOMAIN.test(domain)) throw new Refusal(`${domain} is not a domain name`);
  const places =
    given.places ??
    (await deps.ask.yes(
      "Places on the server, so people's agents run here and nobody installs anything",
      true,
    ));
  let port = given.port ?? options.port ?? 3000;
  if (!domain && !(await portFree(port))) {
    const typed = await deps.ask.text(`Port ${port} is taken here. Another port`, '');
    port = Number(typed);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Refusal('Choose a free port with --port, for example --port 3300');
    }
  }
  return { ...options, dir, domain, places, port };
}

export async function install(options: InstallOptions, deps: Deps): Promise<void> {
  await checkDocker(deps);
  const dir = resolve(options.dir);
  mkdirSync(join(dir, 'deploy'), { recursive: true });
  deps.say(`Downloading Agentome ${options.version} into ${dir}`);
  await download(deps, options.base, 'compose.yaml', join(dir, 'compose.yaml'));
  await download(deps, options.base, '.env.example', join(dir, '.env.example'));
  const caddyfile = join(dir, 'deploy', 'Caddyfile');
  if (!existsSync(caddyfile)) await download(deps, options.base, 'deploy/Caddyfile', caddyfile);

  // .env as it is, or a new one from the example; then what this install says.
  const envFile = join(dir, '.env');
  let env = existsSync(envFile)
    ? readFileSync(envFile, 'utf8')
    : readFileSync(join(dir, '.env.example'), 'utf8');
  env = withEnv(env, 'AGENTOME_VERSION', options.version);
  if (options.domain) {
    env = withEnv(env, 'AGENTOME_PROXY_HOST', options.domain);
    env = withEnv(env, 'AGENTOME_PUBLIC_URL', `https://${options.domain}`);
    env = withEnv(env, 'COMPOSE_PROFILES', withProfile(envValue(env, 'COMPOSE_PROFILES'), 'proxy'));
  } else if (options.port !== undefined && options.port !== 3000) {
    env = withEnv(env, 'AGENTOME_HTTP_PORT', String(options.port));
  }
  if (options.places) {
    env = withEnv(env, 'AGENTOME_PLACE_LAUNCHER_URL', 'http://place-launcher:8080');
    env = withEnv(
      env,
      'COMPOSE_PROFILES',
      withProfile(envValue(env, 'COMPOSE_PROFILES'), 'places'),
    );
  }
  // A new installation gets a database password of its own. One whose database exists keeps the
  // password the database was made with: changing it here would lock the app out.
  const project = process.env.COMPOSE_PROJECT_NAME ?? 'agentome';
  const volume = await deps.exec('docker', ['volume', 'inspect', `${project}_agentome-postgres`], {
    capture: true,
  });
  if (!envValue(env, 'AGENTOME_POSTGRES_PASSWORD') && volume.code !== 0) {
    env = withEnv(env, 'AGENTOME_POSTGRES_PASSWORD', randomBytes(24).toString('hex'));
  }
  writeFileSync(envFile, env, { mode: 0o600 });

  const compose = (args: string[], capture = false) =>
    deps.exec('docker', ['compose', ...args], { cwd: dir, capture });
  if ((await compose(['pull'])).code !== 0) {
    throw new Refusal(
      'cannot pull the images from Docker Hub; check that this machine reaches docker.io',
    );
  }
  if ((await compose(['up', '-d', '--wait', '--wait-timeout', '180'])).code !== 0) {
    throw new Refusal(`not healthy after three minutes: see docker compose logs app, in ${dir}`);
  }
  rememberServer(dir, deps.configDir);
  const url = (
    await compose(['exec', '-T', 'app', 'printenv', 'AGENTOME_PUBLIC_URL'], true)
  ).stdout.trim();
  const code = (await compose(['exec', '-T', 'app', 'agentome', 'setup-code'], true)).stdout.trim();
  deps.say('');
  deps.say(
    `Agentome is running. Open ${url.replace(/\/+$/, '')}/setup to create the administrator,`,
  );
  deps.say(`with the setup code ${code}.`);
  deps.say('');
  deps.say(
    `Later, from anywhere: agentome status, agentome update, agentome backup, agentome logs`,
  );
}
