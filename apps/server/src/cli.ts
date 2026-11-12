#!/usr/bin/env node
// `agentome backup` and `agentome restore` (deploy/OPERATIONS.md): the database and the data
// directory as one .tar.gz on stdout, and back from stdin. pg_dump, psql and the system tar
// do the work, so a backup opens with any tar.
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
  agentome backup > backup.tar.gz    the database and the data directory, to stdout
  agentome restore < backup.tar.gz   replace both with a backup; stop the server first
  agentome setup-code                the code the first admin types at /setup, to stdout
  agentome reset-password <email>    a one-time link that sets a new password for an account,
                                     to stdout; it works once, for an hour
  agentome license sign --key <private.pem> --company <name> --until <YYYY-MM-DD> [--agents <n>]
                       [--installation <id>]
                                     a license key for Admin → License, to stdout; only the
                                     owner has the private key
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
    // Copied next to the dump because busybox tar takes a single -C.
    await mkdir(storage.dataDir, { recursive: true });
    await cp(storage.dataDir, join(staging, 'data'), { recursive: true });
    const archive = ['-czf', '-', '-C', staging, 'db.dump', 'data'];
    await run('tar', archive, ['ignore', 'inherit', 'inherit']);
  });
  process.stderr.write('Backed up the database and the data directory.\n');
}

async function restore(storage: Storage): Promise<void> {
  if (process.stdin.isTTY) throw new CliError('the archive comes from stdin: < backup.tar.gz');
  const env = await pgEnvironment(storage.databaseUrl);
  await inStaging(async (staging) => {
    await run('tar', ['-xzf', '-', '-C', staging], ['inherit', 'ignore', 'inherit']);
    const dump = join(staging, 'db.dump');
    const data = join(staging, 'data');
    const sql = join(staging, 'restore.sql');
    const found = await Promise.all([stat(dump), stat(data)]).catch((error: unknown) => {
      // A missing entry means an archive of another kind; anything else is a failure.
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
      throw new CliError(`cannot read the unpacked archive: ${String(error)}`, { cause: error });
    });
    if (!found?.[0].isFile() || !found[1].isDirectory()) {
      throw new CliError('the archive has no db.dump and data/: it is not from agentome backup');
    }
    // The database first, in one transaction: if it fails, nothing has changed and the old
    // installation keeps the key that reads it. The SQL goes through a file rather than a
    // pipe, so that psql starts only on a dump that pg_restore read to the end. The owners
    // and grants of the machine that made the dump stay behind.
    await run('pg_restore', ['--no-owner', '--no-privileges', `--file=${sql}`, dump], QUIET);
    const psql = ['--no-psqlrc', '--quiet', '--single-transaction', '--set=ON_ERROR_STOP=1'];
    await run('psql', [...psql, `--command=${EMPTY_DATABASE}`, `--file=${sql}`], QUIET, env);
    await mkdir(storage.dataDir, { recursive: true });
    for (const entry of await readdir(storage.dataDir)) {
      await rm(join(storage.dataDir, entry), { recursive: true, force: true });
    }
    await cp(data, storage.dataDir, { recursive: true });
  });
  process.stderr.write('Restored the database and the data directory. Start the server again.\n');
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
      `Give this link to the person. It works once, for ${RESET_LINK_MINUTES} minutes. A new password signs them out everywhere and revokes their API tokens; their computers stay connected.\n`,
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
