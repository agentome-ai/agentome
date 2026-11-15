import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkDocker, type Deps, envValue, rememberServer, withEnv } from './install.js';
import { Refusal } from './system.js';

// The server's admin's commands, run from anywhere: the folder `agentome install` used, or the one
// given, or this one when it holds Agentome's compose.yaml.

/** The folder of this machine's server. */
export function serverDir(
  given: string | undefined,
  configDir = join(homedir(), '.config', 'agentome'),
) {
  const isServer = (dir: string) =>
    existsSync(join(dir, 'compose.yaml')) &&
    /^name: agentome$/m.test(readFileSync(join(dir, 'compose.yaml'), 'utf8'));
  if (given) {
    const dir = resolve(given);
    if (!isServer(dir)) throw new Refusal(`${dir} has no compose.yaml of Agentome`);
    return dir;
  }
  if (isServer(process.cwd())) return process.cwd();
  const remembered = join(configDir, 'server.json');
  if (existsSync(remembered)) {
    const { dir } = JSON.parse(readFileSync(remembered, 'utf8')) as { dir?: string };
    if (dir && isServer(dir)) return dir;
  }
  throw new Refusal(
    'No Agentome server here: agentome install sets one up, or give its folder with --dir',
  );
}

const compose = (deps: Deps, dir: string, args: string[], capture = false) =>
  deps.exec('docker', ['compose', ...args], { cwd: dir, capture });

export async function status(dir: string, deps: Deps) {
  const env = readFileSync(join(dir, '.env'), 'utf8');
  deps.say(
    `Agentome ${envValue(env, 'AGENTOME_VERSION') ?? '(the version compose.yaml names)'} in ${dir}`,
  );
  await compose(deps, dir, ['ps', '--format', 'table {{.Service}}\t{{.Status}}']);
  const url = (
    await compose(deps, dir, ['exec', '-T', 'app', 'printenv', 'AGENTOME_PUBLIC_URL'], true)
  ).stdout.trim();
  if (url) deps.say(`Open ${url}`);
}

/** A backup of the database, into the server's backups/ unless named; the key stays out. */
export async function backup(dir: string, file: string | undefined, deps: Deps) {
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const target = resolve(file ?? join(dir, 'backups', `agentome-${stamp}.tar.gz`));
  mkdirSync(resolve(target, '..'), { recursive: true, mode: 0o700 });
  // The archive holds every secret: the server's key and the database.
  const out = createWriteStream(target, { mode: 0o600 });
  const done = await deps.exec('docker', ['compose', 'exec', '-T', 'app', 'agentome', 'backup'], {
    cwd: dir,
    stdout: out,
  });
  await new Promise((resolve_) => out.end(resolve_));
  if (done.code !== 0)
    throw new Refusal('The backup failed: see the words above. Nothing was kept.');
  deps.say(`Backed up to ${target}`);
  return target;
}

/** A backup first, then the files and images of the release, started again. */
export async function update(dir: string, options: { version: string; base: string }, deps: Deps) {
  await checkDocker(deps);
  const env = readFileSync(join(dir, '.env'), 'utf8');
  const running = envValue(env, 'AGENTOME_VERSION');
  deps.say(
    `Updating Agentome ${running ?? ''} in ${dir} to ${options.version}. A backup first.`.replace(
      '  ',
      ' ',
    ),
  );
  await backup(dir, undefined, deps);
  for (const file of ['compose.yaml', '.env.example']) {
    const answer = await deps.fetch(`${options.base}/${file}`).catch(() => undefined);
    if (!answer?.ok) throw new Refusal(`cannot download ${options.base}/${file}`);
    writeFileSync(join(dir, file), await answer.text());
  }
  writeFileSync(join(dir, '.env'), withEnv(env, 'AGENTOME_VERSION', options.version), {
    mode: 0o600,
  });
  if ((await compose(deps, dir, ['pull'])).code !== 0)
    throw new Refusal('cannot pull the images from Docker Hub');
  if ((await compose(deps, dir, ['up', '-d', '--wait', '--wait-timeout', '300'])).code !== 0) {
    throw new Refusal(
      'not healthy after five minutes: agentome logs app says why. The backup is in backups/.',
    );
  }
  rememberServer(dir, deps.configDir);
  deps.say(`Agentome ${options.version} is running.`);
}

export async function logs(dir: string, service: string | undefined, deps: Deps) {
  await compose(deps, dir, ['logs', '-f', '--tail', '200', ...(service ? [service] : [])]);
}
