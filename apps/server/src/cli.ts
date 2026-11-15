#!/usr/bin/env node
// `agentome backup` and `agentome restore` (deploy/OPERATIONS.md): the database as a .tar.gz
// on stdout, and back from stdin. pg_dump, psql and the system tar do the work, so a backup
// opens with any tar. The data directory holds the secret key and what is derived from it, and
// stays out: with the key beside it, one backup that leaked would open every token in it.
import { spawn, type StdioOptions } from 'node:child_process';
import { createPrivateKey, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import postgres from 'postgres';
import { loadConfig, loadStorageConfig } from './config.js';
// The signing alone: the CLI runs without the workspace packages' build (license/sign.ts).
import { signLicense } from './license/sign.js';
import { setupCode } from './setup-code.js';

type Storage = ReturnType<typeof loadStorageConfig>;

const USAGE = `Usage:
  agentome backup > backup.tar.gz    the database, to stdout; the secret key stays out of it
  agentome restore < backup.tar.gz   replace the database with a backup; stop the server first
  agentome setup-code                the code the first admin types at /setup, to stdout
  agentome reset-password <email>    a one-time link that sets a new password for an account,
                                     to stdout; it works once, for an hour
  agentome rotate-key                a new secret key, for one that may have leaked: everything
                                     sealed under the old one again; stop the server first
  agentome license sign --key <private.pem> --company <name> --until <YYYY-MM-DD> [--agents <n>]
                       [--installation <id>]
                                     a license key for Admin → License, to stdout; only the
                                     owner has the private key
  agentome place-launcher            the service that makes people's places on the server; it
                                     needs Docker's socket and the app's data, read-only
  agentome place-egress              the places' only way out: a proxy that lets a place reach
                                     the hosts its run's project opens, and nothing else
`;

// stdin, stdout and stderr of a tool. During a backup our stdout is the archive, so only tar
// may write to it; stderr shows the tools' own messages.
const QUIET: StdioOptions = ['ignore', 'ignore', 'inherit'];

// Runs in the transaction of the restore: every schema goes, so that the database becomes
// the backup and nothing else, even when it had newer migrations. The dump never creates
// the public schema itself.
const EMPTY_DATABASE = `SET client_min_messages = warning;
DO $$ DECLARE s name; BEGIN
  FOR s IN SELECT nspname FROM pg_namespace
    WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'
  LOOP EXECUTE format('DROP SCHEMA %I CASCADE', s); END LOOP;
END $$;
CREATE SCHEMA public;`;

const SSL_MODES = ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'];

class CliError extends Error {
  override name = 'CliError';
}

/**
 * libpq's variables for the database the server uses, as postgres.js reads the URL and
 * PGPASSWORD. The tools get no connection argument, so the password never shows in `ps` on
 * the host, which lists the arguments of every process in every container.
 */
export async function pgEnvironment(databaseUrl: string): Promise<NodeJS.ProcessEnv> {
  const sql = postgres(databaseUrl, { max: 1 });
  const { host, port, user, database, ssl } = sql.options;
  // Typed as null: postgres.js keeps the password out of its types, not out of its options.
  const pass: unknown = Reflect.get(sql.options, 'pass');
  await sql.end();
  return {
    ...process.env,
    PGHOST: host.join(','),
    PGPORT: port.join(','),
    PGUSER: user,
    PGDATABASE: database,
    ...(typeof pass === 'string' && pass !== '' && { PGPASSWORD: pass }),
    ...(typeof ssl === 'string' && SSL_MODES.includes(ssl) && { PGSSLMODE: ssl }),
  };
}

async function backup(storage: Storage): Promise<void> {
  if (process.stdout.isTTY) throw new CliError('the archive goes to stdout: redirect it');
  const env = await pgEnvironment(storage.databaseUrl);
  await inStaging(async (staging) => {
    await run('pg_dump', ['-Fc', `--file=${join(staging, 'db.dump')}`], QUIET, env);
    await run('tar', ['-czf', '-', '-C', staging, 'db.dump'], ['ignore', 'inherit', 'inherit']);
  });
  process.stderr.write(
    'Backed up the database. The secret key is not in the backup: keep a copy of it apart from your backups (deploy/OPERATIONS.md), since a restore on another machine needs it.\n',
  );
}

async function restore(storage: Storage): Promise<void> {
  if (process.stdin.isTTY) throw new CliError('the archive comes from stdin: < backup.tar.gz');
  const env = await pgEnvironment(storage.databaseUrl);
  await inStaging(async (staging) => {
    await run('tar', ['-xzf', '-', '-C', staging], ['inherit', 'ignore', 'inherit']);
    const dump = join(staging, 'db.dump');
    const data = join(staging, 'data');
    const sql = join(staging, 'restore.sql');
    // A backup made before 0.2.1 holds the data directory too, and the key in it.
    const [dumpFound, dataFound] = await Promise.all([present(dump), present(data)]);
    if (!dumpFound?.isFile()) {
      throw new CliError('the archive has no db.dump: it is not from agentome backup');
    }
    // The database first, in one transaction: if it fails, nothing has changed and the old
    // installation keeps the key that reads it. The SQL goes through a file rather than a
    // pipe, so that psql starts only on a dump that pg_restore read to the end. The owners
    // and grants of the machine that made the dump stay behind.
    await run('pg_restore', ['--no-owner', '--no-privileges', `--file=${sql}`, dump], QUIET);
    const psql = ['--no-psqlrc', '--quiet', '--single-transaction', '--set=ON_ERROR_STOP=1'];
    await run('psql', [...psql, `--command=${EMPTY_DATABASE}`, `--file=${sql}`], QUIET, env);
    // Only from a backup that holds it: otherwise the key here stays, and must be the one the
    // database was made with, or the server says so when it starts.
    if (dataFound?.isDirectory()) {
      await mkdir(storage.dataDir, { recursive: true });
      for (const entry of await readdir(storage.dataDir)) {
        await rm(join(storage.dataDir, entry), { recursive: true, force: true });
      }
      await cp(data, storage.dataDir, { recursive: true });
    }
  });
  process.stderr.write('Restored the database. Start the server again.\n');
}

/** What is at a path of the unpacked archive, or nothing: an entry it does not hold. */
async function present(path: string) {
  try {
    return await stat(path);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw new CliError(`cannot read the unpacked archive: ${String(error)}`, { cause: error });
  }
}

async function run(command: string, args: string[], stdio: StdioOptions, env = process.env) {
  const [code] = await once(spawn(command, args, { stdio, env }), 'close');
  if (code !== 0) throw new CliError(`${command} failed (exit code ${code}); its message is above`);
}

// mkdtemp makes the directory 0700, and it goes whatever happens.
async function inStaging(work: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'agentome-'));
  try {
    await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** `agentome license sign`: a license key signed with the owner's private key. */
async function signCommand(args: string[]): Promise<string> {
  const { values } = parseArgs({
    args,
    options: {
      key: { type: 'string' },
      company: { type: 'string' },
      until: { type: 'string' },
      agents: { type: 'string' },
      installation: { type: 'string' },
    },
    strict: true,
  });
  if (!values.key || !values.company?.trim() || !values.until) {
    throw new CliError('--key, --company and --until are required');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.until) || Number.isNaN(Date.parse(values.until))) {
    throw new CliError('--until takes a date such as 2027-11-02');
  }
  const agents = values.agents === undefined ? null : Number(values.agents);
  if (agents !== null && (!Number.isInteger(agents) || agents < 1)) {
    throw new CliError('--agents takes a whole number of at least 1');
  }
  const privateKey = createPrivateKey(await readFile(values.key, 'utf8'));
  return signLicense(privateKey, {
    id: randomUUID(),
    company: values.company.trim(),
    issuedAt: new Date().toISOString(),
    // Through the whole of the last day, in UTC.
    expiresAt: new Date(`${values.until}T23:59:59.999Z`).toISOString(),
    agents,
    ...(values.installation?.trim() && { installation: values.installation.trim() }),
  });
}

/**
 * The link for an account's new password, and what to know about it on stderr, so that stdout
 * is the link alone. The modules that need the built workspace packages load here, not at the
 * top: the other commands run without them.
 */
async function resetPasswordCommand(email: string): Promise<string> {
  const config = loadConfig(process.env);
  const { createDb } = await import('@agentome/db');
  const { passwordResetLink, RESET_LINK_MINUTES } = await import('./password-reset.js');
  const db = createDb(config.databaseUrl, () => {});
  try {
    const { url, disabled } = await passwordResetLink(db, config, email);
    process.stderr.write(
      `Give this link to the person. It works once, for ${RESET_LINK_MINUTES} minutes. A new password signs them out everywhere, revokes their API tokens and turns off their sign-in code, for a lost phone; their computers stay connected.\n`,
    );
    if (disabled) {
      process.stderr.write(
        'This account is disabled: a new password does not let them in until an admin enables it.\n',
      );
    }
    return url;
  } finally {
    await db.$client.end();
  }
}

/**
 * A new secret key, with the server stopped. The key of the data folder is replaced in place:
 * a new one written beside it first, and moved over it once the database is sealed under it. A
 * key given in AGENTOME_SECRET_KEY or AGENTOME_SECRET_KEY_FILE is not ours to write: the admin
 * makes the new one and hands it in on stdin, so that it is kept before the database changes and
 * never shows in a log.
 */
async function rotateKeyCommand(): Promise<void> {
  const config = loadConfig(process.env);
  const { createDb } = await import('@agentome/db');
  const { rotateKey } = await import('./rotate-key.js');
  const { keyFingerprint } = await import('./setup.js');
  const { randomBytes } = await import('node:crypto');
  const { renameSync, rmSync, writeFileSync } = await import('node:fs');
  // As the settings are read: an empty value is no value.
  const given = Boolean(process.env.AGENTOME_SECRET_KEY || process.env.AGENTOME_SECRET_KEY_FILE);
  const file = join(config.dataDir, 'secrets', 'secret.key');
  const next = `${file}.next`;
  const key = given ? await newKeyFromStdin() : randomBytes(32).toString('hex');
  if (key === config.secretKey) throw new CliError('The new key is the one in use');
  const db = createDb(config.databaseUrl, () => {});
  try {
    // The server keeps the old key in memory: running, it would seal new secrets under it.
    const [others] = await db.$client<{ count: number }[]>`
      select count(*)::int as count from pg_stat_activity
      where datname = current_database() and pid <> pg_backend_pid()
        and backend_type = 'client backend'`;
    if ((others?.count ?? 0) > 0) {
      throw new CliError(
        `Stop the server and the place launcher first: ${String(others?.count)} other connections to the database are open`,
      );
    }
    if (!given) {
      try {
        writeFileSync(next, key, { flag: 'wx', mode: 0o600, flush: true });
      } catch (error) {
        throw new CliError(
          `Cannot write ${next}: ${String(error)}. If an earlier rotation stopped half way, that file may hold the key the database is sealed under: if the server refuses the key in secret.key, move secret.key.next over it.`,
        );
      }
    }
    let done: Awaited<ReturnType<typeof rotateKey>> | undefined;
    try {
      done = await rotateKey(db, config.secretKey, key, { alone: true });
    } catch (error) {
      // A commit whose answer was lost may have happened all the same: the database says.
      // Not for long: a connection cut mid-commit may hold the lock until its database notices.
      const asked = createDb(config.databaseUrl, () => {});
      const fingerprint = await asked.$client
        .begin(async (t) => {
          await t`set local lock_timeout = '10s'`;
          const [row] = await t<{ fingerprint: string }[]>`
            select secret_key_fingerprint as fingerprint from installation`;
          return row?.fingerprint;
        })
        .catch(() => undefined)
        .finally(() => asked.$client.end());
      if (fingerprint !== keyFingerprint(key)) {
        if (fingerprint === keyFingerprint(config.secretKey) && !given)
          rmSync(next, { force: true });
        if (fingerprint === undefined) {
          throw new CliError(
            `${error instanceof Error ? error.message : String(error)}. The database could not be asked whether the rotation happened: keep ${given ? 'the new key' : next} until the server starts under one of the two keys.`,
          );
        }
        throw error;
      }
    }
    if (!given) renameSync(next, file);
    process.stderr.write(
      [
        done
          ? `Sealed again under the new key: ${String(done.connections)} code host and Jira connections, ${String(done.modelKeys)} model keys, ${String(done.libraryServers)} library servers, ${String(done.mcpSignIns)} MCP sign-ins, ${String(done.secondSteps)} sign-in codes. Ended ${String(done.sessionsEnded)} sessions.`
          : 'The database is sealed under the new key.',
        'Everyone signs in again, and turns notifications on again in Settings.',
        given
          ? 'Put the new key where AGENTOME_SECRET_KEY comes from, in place of the old one, then start the server and the place launcher.'
          : `The new key is in ${file}. Start the server and the place launcher.`,
        '',
      ].join('\n'),
    );
  } finally {
    await db.$client.end();
  }
}

/** The new key, piped in: never typed at a terminal, where it would stay in the history. */
async function newKeyFromStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new CliError(
      'Your key comes from AGENTOME_SECRET_KEY: make the new one first and pipe it in, as in deploy/OPERATIONS.md (openssl rand -hex 32 > new.key; agentome rotate-key < new.key)',
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const key = Buffer.concat(chunks).toString('utf8').trim();
  if (key.length < 32) throw new CliError('The new key on stdin is shorter than 32 characters');
  return key;
}

/**
 * Runs the place launcher until it is stopped: on port 8080 of the internal network, with
 * Docker's socket, or in a cluster with its service account. A place reaches the app directly and
 * nothing else but the egress proxy.
 */
async function placeLauncherCommand(): Promise<void> {
  const { loadLauncherConfig } = await import('./config.js');
  const { dockerAt, dockerAttachAt } = await import('./places/docker.js');
  const { launcherServer } = await import('./places/launcher.js');
  const { dockerPlaces } = await import('./places/docker-places.js');
  const { kubePlaces } = await import('./places/kube-places.js');
  const { inCluster } = await import('./places/kube.js');
  // In a cluster, places are pods in the launcher's namespace; elsewhere, Docker's containers.
  const cluster = inCluster();
  const { dockerEgressToken, launcherKey, placeEgressToken } = await import('./places/keys.js');
  const { lookup } = await import('node:dns/promises');
  const config = loadLauncherConfig(process.env);
  // Agentome's services by their names, in compose as in the manifests.
  const network = {
    serverUrl: cluster ? 'http://agentome:3000' : 'http://app:3000',
    egress: {
      proxy: 'place-egress:3128',
      tokenOf: (id: string) => placeEgressToken(config.placesKey, id),
      dockerTokenOf: (runId: string) => dockerEgressToken(config.placesKey, runId),
    },
  };
  // A place asks no DNS: on Kubernetes it is given the app's and the proxy's addresses.
  const aliases = cluster
    ? await Promise.all(
        ['agentome', 'place-egress'].map(async (name) => ({
          ip: (await lookup(name)).address,
          hostnames: [name],
        })),
      )
    : [];
  const socket = await launcherSocket();
  const places = cluster
    ? kubePlaces({
        ...network,
        kube: cluster.kube,
        exec: cluster.exec,
        image: config.image,
        aliases,
        runtime: config.runtime,
      })
    : dockerPlaces({
        ...network,
        docker: dockerAt(socket),
        attach: dockerAttachAt(socket),
        image: config.image,
        peers: composePeers(dockerAt(socket)),
        runtime: config.runtime,
        dockerRuntime: config.dockerRuntime,
      });
  const server = launcherServer({ key: launcherKey(config.placesKey), places }, (line) =>
    process.stderr.write(`${new Date().toISOString()} ${line}\n`),
  );
  await new Promise<void>((resolve) => server.listen(8080, '0.0.0.0', resolve));
  const where = cluster ? `pods in ${cluster.namespace}` : 'Docker containers';
  process.stderr.write(
    `The place launcher listens on 8080, making places as ${where} from ${config.image}.\n`,
  );
  await new Promise<void>((resolve) => {
    const stop = () => server.close(() => resolve());
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  });
}

/** Where the docker guard listens, in a volume it shares with the launcher alone. */
const GUARD_SOCKET = '/run/agentome-guard/docker.sock';

/**
 * Docker's socket for the launcher: the guard's where compose puts one before it, Docker's own
 * otherwise (an installation from before the guard, or tried out by hand).
 */
async function launcherSocket(): Promise<string> {
  const { existsSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  // Its folder mounted, the guard is there: its socket comes as it starts.
  if (!existsSync(dirname(GUARD_SOCKET))) return '/var/run/docker.sock';
  for (let tries = 0; tries < 60 && !existsSync(GUARD_SOCKET); tries++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!existsSync(GUARD_SOCKET))
    throw new Error(`The docker guard is not listening on ${GUARD_SOCKET}`);
  return GUARD_SOCKET;
}

async function dockerGuardCommand(): Promise<void> {
  const { chmodSync, rmSync } = await import('node:fs');
  const { dockerGuard } = await import('./places/docker-guard.js');
  const runtimes = [process.env.AGENTOME_PLACE_RUNTIME, process.env.AGENTOME_PLACE_DOCKER_RUNTIME]
    .map((runtime) => runtime?.trim())
    .filter((runtime): runtime is string => !!runtime);
  const sandboxRuntime = process.env.AGENTOME_PLACE_DOCKER_RUNTIME?.trim() || undefined;
  const server = dockerGuard(
    '/var/run/docker.sock',
    { runtimes, ...(sandboxRuntime && { sandboxRuntime }), peers: ['app', 'place-egress'] },
    (line) => process.stderr.write(`${new Date().toISOString()} ${line}\n`),
  );
  rmSync(GUARD_SOCKET, { force: true });
  await new Promise<void>((resolve) => server.listen(GUARD_SOCKET, resolve));
  // The launcher runs as the node user; the folder is theirs alone, in a volume of the two.
  chmodSync(GUARD_SOCKET, 0o666);
  process.stderr.write(`The docker guard listens on ${GUARD_SOCKET}.\n`);
  await new Promise<void>((resolve) => {
    const stop = () => server.close(() => resolve());
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  });
}

async function placeEgressCommand(): Promise<void> {
  const { egressProxy, hostsFromServer, reportToServer } = await import('./places/egress-proxy.js');
  // The server by its service's name: `agentome` in the manifests, `app` in compose.
  const serverUrl = process.env.KUBERNETES_SERVICE_HOST
    ? 'http://agentome:3000'
    : 'http://app:3000';
  const server = egressProxy({
    hostsOf: hostsFromServer(serverUrl),
    report: reportToServer(serverUrl),
    log: (line) => process.stderr.write(`${new Date().toISOString()} ${line}\n`),
  });
  await new Promise<void>((resolve) => server.listen(3128, '0.0.0.0', resolve));
  process.stderr.write("The places' egress proxy listens on 3128.\n");
  await new Promise<void>((resolve) => {
    const stop = () => server.close(() => resolve());
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  });
}

async function main([command, ...rest]: string[]): Promise<number> {
  if (command === 'license' && rest[0] === 'sign') {
    try {
      process.stdout.write(`${await signCommand(rest.slice(1))}\n`);
      return 0;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      process.stderr.write(`agentome license sign: ${error.message}\n`);
      return 1;
    }
  }
  if (command === 'setup-code' && rest.length === 0) {
    try {
      process.stdout.write(`${setupCode(loadConfig(process.env).secretKey)}\n`);
      return 0;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      process.stderr.write(`agentome setup-code: ${error.message}\n`);
      return 1;
    }
  }
  if (command === 'reset-password' && rest.length === 1 && rest[0]) {
    try {
      process.stdout.write(`${await resetPasswordCommand(rest[0])}\n`);
      return 0;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      process.stderr.write(`agentome reset-password: ${error.message}\n`);
      return 1;
    }
  }
  if (command === 'rotate-key' && rest.length === 0) {
    try {
      await rotateKeyCommand();
      return 0;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      process.stderr.write(`agentome rotate-key: ${error.message}\n`);
      return 1;
    }
  }
  if (command === 'place-launcher' && rest.length === 0) {
    try {
      await placeLauncherCommand();
      return 0;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      process.stderr.write(`agentome place-launcher: ${error.message}\n`);
      return 1;
    }
  }
  if (command === 'docker-guard' && rest.length === 0) {
    try {
      await dockerGuardCommand();
      return 0;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      process.stderr.write(`agentome docker-guard: ${error.message}\n`);
      return 1;
    }
  }
  if (command === 'place-egress' && rest.length === 0) {
    try {
      await placeEgressCommand();
      return 0;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      process.stderr.write(`agentome place-egress: ${error.message}\n`);
      return 1;
    }
  }
  if ((command !== 'backup' && command !== 'restore') || rest.length > 0) {
    process.stderr.write(USAGE);
    return command === '--help' || command === 'help' ? 0 : 2;
  }
  // The dump and the unpacked archive hold every secret: what the tools write is ours only.
  process.umask(0o077);
  try {
    const storage = loadStorageConfig(process.env);
    await (command === 'backup' ? backup(storage) : restore(storage));
    return 0;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    process.stderr.write(`agentome ${command}: ${error.message}\n`);
    return 1;
  }
}

// Imported by its tests; in the image /usr/local/bin/agentome runs this file.
if (import.meta.main) process.exitCode = await main(process.argv.slice(2));

/**
 * The app's and the egress proxy's containers in the launcher's own compose project, by the
 * names a place calls them: the launcher puts them on each place's network.
 */
function composePeers(docker: import('./places/docker.js').Docker) {
  return async () => {
    const { hostname } = await import('node:os');
    const self = await docker('GET', `/containers/${hostname()}/json`);
    const project = (self.body as { Config?: { Labels?: Record<string, string> } } | undefined)
      ?.Config?.Labels?.['com.docker.compose.project'];
    if (!project) throw new Error('The place launcher is not in a compose project');
    const filters = encodeURIComponent(
      JSON.stringify({ label: [`com.docker.compose.project=${project}`] }),
    );
    const found = await docker('GET', `/containers/json?filters=${filters}`);
    const peers: { container: string; alias: string }[] = [];
    for (const container of (found.body ?? []) as {
      Id: string;
      Labels?: Record<string, string>;
    }[]) {
      const service = container.Labels?.['com.docker.compose.service'];
      if (service === 'app') peers.push({ container: container.Id, alias: 'app' });
      if (service === 'place-egress')
        peers.push({ container: container.Id, alias: 'place-egress' });
    }
    return peers;
  };
}
