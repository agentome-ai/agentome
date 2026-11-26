import { DEFAULT_REGISTRIES } from './projects/registry.js';
import { randomBytes } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { placesKey, placesKeyFile } from './places/keys.js';

// Checked the way postgres.js reads the URL, not as a WHATWG URL: it accepts several
// hosts (h1:5432,h2:5432) and decodes the password, failing on a stray %.
const DatabaseUrl = z
  .string()
  .regex(/^postgres(ql)?:\/\/\S+$/, 'Expected postgres://user:password@host:port/database')
  .refine(isDecodable, 'A % in the URL must be escaped: write it as %25')
  .refine(
    isParsable,
    'the database URL is not a valid URL: characters like / # ? @ in the password must be ' +
      'percent-encoded',
  );

// The address without a path, since the server serves from the root, and without the slash,
// so that links built from it come out right.
const PublicUrl = z
  .url({ protocol: /^https?$/ })
  .refine((value) => {
    const url = new URL(value);
    return url.pathname === '/' && url.search === '' && url.hash === '';
  }, 'Expected an address without a path, such as https://agentome.example.com')
  .transform((value) => new URL(value).origin);

// One rule for a key from the environment, from a file and from the data directory.
const SecretKey = z.string().trim().min(32);

/** The rule for every password a person sets: the setup, an invitation, the environment. */
export const Password = z
  .string()
  .min(12, 'Use at least 12 characters')
  .max(128, 'Use at most 128 characters');

// host:port, with an IPv6 host in brackets: [::]:3000.
const Listen = z
  .string()
  .regex(/^(\[[\da-fA-F:.]+\]|[^\s:[\]]+):(\d{1,5})$/, 'Expected host:port, such as 0.0.0.0:3000')
  .transform((value) => {
    const colon = value.lastIndexOf(':');
    return {
      host: value.slice(0, colon).replace(/^\[|\]$/g, ''),
      port: Number(value.slice(colon + 1)),
    };
  })
  .refine(({ port }) => port >= 1 && port <= 65_535, 'The port must be between 1 and 65535');

// Names that once meant the server's port. Kubernetes still sets them, as <SERVICE>_PORT=
// tcp://ip:port, in the pods next to a Service named agentome or agentome-http: a value of
// that form is Kubernetes' and passes, any other one stops the start instead of being lost.
const retired = (message: string) =>
  z
    .string()
    .refine((value) => /^(tcp|udp|sctp):\/\//.test(value), message)
    .optional();

const Limit = (fallback: number) => z.coerce.number().int().min(1).default(fallback);
// A limit with no default: unset, or set empty as compose passes an unset variable, is none.
const OptionalLimit = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.coerce.number().int().min(1).optional(),
);

const DEFAULT_DATABASE_URL = 'postgres://agentome:agentome@localhost:5432/agentome';

// Every setting is documented in deploy/CONFIG.md; keep the two in step.
const Env = z.object({
  AGENTOME_DATABASE_URL: DatabaseUrl.optional(),
  AGENTOME_DATABASE_URL_FILE: z.string().optional(),
  AGENTOME_LISTEN: Listen.default({ host: '0.0.0.0', port: 3000 }),
  AGENTOME_PORT: retired('renamed to AGENTOME_LISTEN, which takes host:port'),
  AGENTOME_HTTP_PORT: retired(
    'this is the host port that compose.yaml publishes; the server listens on AGENTOME_LISTEN',
  ),
  AGENTOME_PUBLIC_URL: PublicUrl.default('http://localhost:3000'),
  // Where an MCP server's authorization server sends the browser back after a sign-in, when it
  // takes only some addresses, such as localhost.
  AGENTOME_OAUTH_RETURN_URL: PublicUrl.optional(),
  AGENTOME_DATA_DIR: z.string().default('./.data'),
  AGENTOME_SECRET_KEY: SecretKey.optional(),
  AGENTOME_SECRET_KEY_FILE: z.string().optional(),
  // The place launcher's key: the places' key the app writes in its data at each start, which
  // compose mounts into the launcher alone.
  AGENTOME_PLACES_KEY_FILE: z.string().optional(),
  AGENTOME_WEB_DIR: z.string().optional(),
  AGENTOME_LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  // Run limits for agents whose budget does not set its own; none unless set. Until 0.4.4 they
  // were 60 minutes, 50 turns and 2M tokens, which stopped long administration and engineering
  // tasks halfway: the owner asked for none by default.
  AGENTOME_RUN_MAX_MINUTES: OptionalLimit,
  AGENTOME_RUN_MAX_TURNS: OptionalLimit,
  AGENTOME_RUN_MAX_TOKENS: OptionalLimit,
  AGENTOME_RUN_ORPHAN_MINUTES: Limit(3),
  AGENTOME_KNOWLEDGE_SYNC_MINUTES: Limit(60),
  AGENTOME_JIRA_POLL_MINUTES: Limit(5),
  // How long the log lines in Admin → Logs are kept.
  AGENTOME_LOG_RETENTION_DAYS: Limit(30),
  AGENTOME_SETUP_ADMIN_EMAIL: z.email().optional(),
  AGENTOME_SETUP_ADMIN_PASSWORD: Password.optional(),
  AGENTOME_SETUP_ADMIN_PASSWORD_FILE: z.string().optional(),
  AGENTOME_SETUP_ORG_NAME: z.string().trim().min(1).default('Agentome'),
  // Behind a reverse proxy: take the client's address from X-Forwarded-For.
  // `true` is the one proxy in front: the client's address is the last one that proxy added. A
  // number trusts that many proxies; `false`, none. A list of the proxy's addresses, networks
  // or names (compose gives `proxy`, Caddy's service) trusts the header only from those, so a
  // place or a seat that reaches the app directly cannot claim another address.
  AGENTOME_TRUST_PROXY: z
    .union([
      z.stringbool(),
      z.coerce.number().int().min(1).max(10),
      z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9.:/_-]+(,[A-Za-z0-9.:/_-]+)*$/)
        .transform((value) => value.split(',')),
    ])
    .default(false)
    .transform((value) => (value === true ? 1 : value)),
  // Sign-in with the company's Keycloak: the realm's address, as its issuer, and the
  // client Agentome is in it.
  AGENTOME_KEYCLOAK_ISSUER: z
    .url({ protocol: /^https?$/ })
    .optional()
    .transform((value) => value?.replace(/\/$/, '')),
  AGENTOME_KEYCLOAK_CLIENT_ID: z.string().trim().min(1).optional(),
  AGENTOME_KEYCLOAK_CLIENT_SECRET: z.string().trim().min(1).optional(),
  // `false` turns signing in with a password off, so that everyone signs in through Keycloak and
  // its second factor; Keycloak must be set. Turned off, the server takes no password, and an
  // invitation is not how people join.
  AGENTOME_PASSWORD_SIGN_IN: z.stringbool().default(true),
  // The place launcher (`agentome place-launcher`): with it, people make their own place on
  // the server from Computers. Unset, there are no places.
  AGENTOME_PLACE_LAUNCHER_URL: z
    .url({ protocol: /^https?$/ })
    .optional()
    .transform((value) => value?.replace(/\/$/, '')),
  // The launcher's: the seat image a place runs, when not this release's.
  AGENTOME_PLACE_IMAGE: z.string().trim().min(1).optional(),
  // The launcher's: the runtime its places and runs get, `runsc` for gVisor on Docker or a
  // RuntimeClass on Kubernetes; unset, the default one.
  AGENTOME_PLACE_RUNTIME: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9.-]*$/)
    .optional(),
  // The launcher's: the runtime of a Docker of a run's own, beside its sandbox, for testcontainers
  // and compose. gVisor's with its raw network (runsc --net-raw); unset, runs have no Docker.
  // Never runc: Docker there would need the host's root.
  AGENTOME_PLACE_DOCKER_RUNTIME: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9.-]*$/)
    .refine((name) => name !== 'runc', 'Docker in a run needs gVisor, not runc')
    .optional(),
  // What each person's place on Docker may hold on disk, in GB: past it the place sleeps until
  // its person empties an agent's folders. A cluster's claims have their own size.
  AGENTOME_PLACE_DISK_GB: Limit(20),
  // How many places the server may have: anyone who can sign in can make one.
  AGENTOME_PLACES_MAX: Limit(50),
  // The registries a project's services may come from, comma-separated (docker.io, ghcr.io…):
  // each image is pinned to its digest there when the project is read. Others are left out.
  AGENTOME_SERVICE_REGISTRIES: z
    .string()
    .trim()
    .regex(/^[a-z0-9.-]+(:\d+)?(,[a-z0-9.-]+(:\d+)?)*$/)
    .transform((value) => value.split(','))
    .optional(),
  // Admin's browser asks GitHub once a day whether a newer release is out; off for an
  // installation whose people must not reach outside.
  AGENTOME_UPDATE_CHECK: z.stringbool().default(true),
  // People's own computers run their agents; off, agents run only on the server (places and the
  // server seat), and a computer neither connects nor takes a run.
  AGENTOME_COMPUTERS: z.stringbool().default(true),
  // The image's release and commit, set when it is built, not by an operator; an image built
  // without them is a development build. Empty is unset: a build argument not given is empty.
  AGENTOME_BUILD_VERSION: z
    .string()
    .trim()
    .optional()
    .transform((value) => value || null),
  AGENTOME_BUILD_COMMIT: z
    .string()
    .trim()
    .optional()
    .transform((value) => value || null),
});

// What `agentome backup` and `restore` read: a restore has to work on an installation whose
// other settings, or whose key, are broken, since repairing that is what it is for.
const StorageEnv = Env.pick({
  AGENTOME_DATABASE_URL: true,
  AGENTOME_DATABASE_URL_FILE: true,
  AGENTOME_DATA_DIR: true,
});

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Reads the settings from `env`; throws ConfigError with every problem it finds. */
export function loadConfig(env: Record<string, string | undefined>) {
  const values = parse(Env, env);
  const dataDir = resolve(values.AGENTOME_DATA_DIR);
  return {
    databaseUrl: readDatabaseUrl(values.AGENTOME_DATABASE_URL, values.AGENTOME_DATABASE_URL_FILE),
    listen: values.AGENTOME_LISTEN,
    publicUrl: values.AGENTOME_PUBLIC_URL,
    oauthReturnUrl: values.AGENTOME_OAUTH_RETURN_URL ?? values.AGENTOME_PUBLIC_URL,
    dataDir,
    secretKey:
      values.AGENTOME_SECRET_KEY ?? readSecretKey(values.AGENTOME_SECRET_KEY_FILE, dataDir),
    webDir: checkWebDir(values.AGENTOME_WEB_DIR),
    logLevel: values.AGENTOME_LOG_LEVEL,
    runLimits: {
      maxMinutes: values.AGENTOME_RUN_MAX_MINUTES ?? null,
      maxTurns: values.AGENTOME_RUN_MAX_TURNS ?? null,
      maxTokens: values.AGENTOME_RUN_MAX_TOKENS ?? null,
    },
    orphanMinutes: values.AGENTOME_RUN_ORPHAN_MINUTES,
    knowledgeSyncMinutes: values.AGENTOME_KNOWLEDGE_SYNC_MINUTES,
    jiraPollMinutes: values.AGENTOME_JIRA_POLL_MINUTES,
    logRetentionDays: values.AGENTOME_LOG_RETENTION_DAYS,
    setupAdmin: readSetupAdmin(values),
    trustProxy: values.AGENTOME_TRUST_PROXY,
    keycloak: readKeycloak(values),
    passwordSignIn: readPasswordSignIn(values),
    updateCheck: values.AGENTOME_UPDATE_CHECK,
    computers: values.AGENTOME_COMPUTERS,
    build: { version: values.AGENTOME_BUILD_VERSION, commit: values.AGENTOME_BUILD_COMMIT },
    placeLauncherUrl: values.AGENTOME_PLACE_LAUNCHER_URL,
    serviceRegistries: values.AGENTOME_SERVICE_REGISTRIES ?? DEFAULT_REGISTRIES,
    placeLimits: {
      diskBytes: values.AGENTOME_PLACE_DISK_GB * 1024 ** 3,
      places: values.AGENTOME_PLACES_MAX,
    },
  };
}

export type Config = ReturnType<typeof loadConfig>;

const LauncherEnv = Env.pick({
  AGENTOME_DATA_DIR: true,
  AGENTOME_SECRET_KEY: true,
  AGENTOME_SECRET_KEY_FILE: true,
  AGENTOME_PLACES_KEY_FILE: true,
  AGENTOME_PLACE_IMAGE: true,
  AGENTOME_PLACE_RUNTIME: true,
  AGENTOME_PLACE_DOCKER_RUNTIME: true,
  AGENTOME_BUILD_VERSION: true,
});

/**
 * What the place launcher reads: the installation's key, which the app made at its first start
 * (the launcher reads it and never makes one), and the seat image of this release.
 */
export function loadLauncherConfig(env: Record<string, string | undefined>) {
  const values = parse(LauncherEnv, env);
  const dataDir = resolve(values.AGENTOME_DATA_DIR);
  const version = values.AGENTOME_BUILD_VERSION ?? 'latest';
  const image = values.AGENTOME_PLACE_IMAGE ?? `docker.io/agentome/agentome-seat:${version}`;
  // The installation's key, where the launcher is given it (a cluster's Secret): the places' key
  // is derived from it here. Otherwise the places' key alone, which the app writes at its start.
  const runtime = values.AGENTOME_PLACE_RUNTIME;
  const dockerRuntime = values.AGENTOME_PLACE_DOCKER_RUNTIME;
  if (values.AGENTOME_SECRET_KEY !== undefined) {
    return { placesKey: placesKey(values.AGENTOME_SECRET_KEY), image, runtime, dockerRuntime };
  }
  const keyFile = values.AGENTOME_PLACES_KEY_FILE ?? placesKeyFile(dataDir);
  if (!existsSync(keyFile)) {
    throw new ConfigError(`The places' key is not in ${keyFile} yet: start the app first.`);
  }
  return {
    placesKey: readKeyFile(resolve(keyFile), 'AGENTOME_PLACES_KEY_FILE'),
    image,
    runtime,
    dockerRuntime,
  };
}

/** The database and the data directory only, for the CLI. */
export function loadStorageConfig(env: Record<string, string | undefined>) {
  const values = parse(StorageEnv, env);
  return {
    databaseUrl: readDatabaseUrl(values.AGENTOME_DATABASE_URL, values.AGENTOME_DATABASE_URL_FILE),
    dataDir: resolve(values.AGENTOME_DATA_DIR),
  };
}

function parse<T extends z.ZodType>(schema: T, env: Record<string, string | undefined>) {
  // Compose files often pass `VAR=` for a variable the user did not set.
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const parsed = schema.safeParse(present);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`);
    throw new ConfigError(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return parsed.data;
}

function isDecodable(value: string): boolean {
  try {
    decodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}

// The steps of postgres.js (src/index.js, parseUrl): it keeps the first of the hosts and
// hands the rest to WHATWG URL, which fails on a raw / # or ? in the password, and Node then
// prints the error with the whole URL, password and all, in its `input`.
function isParsable(value: string): boolean {
  const authority = value.slice(value.indexOf('://') + 3).split(/[?/]/)[0] ?? '';
  const hosts = authority.slice(authority.indexOf('@') + 1);
  // A stray % is the rule above's to report.
  if (!isDecodable(hosts)) return true;
  const decoded = decodeURIComponent(hosts);
  return URL.canParse(value.replace(decoded, decoded.split(',')[0] ?? ''));
}

// The administrator an automated install creates on the first start, instead of /setup.
function readSetupAdmin(values: z.infer<typeof Env>) {
  const email = values.AGENTOME_SETUP_ADMIN_EMAIL;
  const passwordFile = values.AGENTOME_SETUP_ADMIN_PASSWORD_FILE;
  let password = values.AGENTOME_SETUP_ADMIN_PASSWORD;
  if (password === undefined && passwordFile !== undefined) {
    const read = Password.safeParse(readFile(passwordFile, 'AGENTOME_SETUP_ADMIN_PASSWORD_FILE'));
    if (!read.success) {
      throw new ConfigError(`AGENTOME_SETUP_ADMIN_PASSWORD_FILE: ${read.error.issues[0]?.message}`);
    }
    password = read.data;
  }
  if (email === undefined && password === undefined) return undefined;
  if (email === undefined || password === undefined) {
    throw new ConfigError(
      'AGENTOME_SETUP_ADMIN_EMAIL and AGENTOME_SETUP_ADMIN_PASSWORD go together: set both or neither',
    );
  }
  return { email: email.toLowerCase(), password, orgName: values.AGENTOME_SETUP_ORG_NAME };
}

function readPasswordSignIn(values: z.infer<typeof Env>): boolean {
  if (!values.AGENTOME_PASSWORD_SIGN_IN && readKeycloak(values) === undefined) {
    throw new ConfigError(
      'AGENTOME_PASSWORD_SIGN_IN=false needs Keycloak: set AGENTOME_KEYCLOAK_ISSUER, AGENTOME_KEYCLOAK_CLIENT_ID and AGENTOME_KEYCLOAK_CLIENT_SECRET, or nobody could sign in',
    );
  }
  return values.AGENTOME_PASSWORD_SIGN_IN;
}

function readKeycloak(values: z.infer<typeof Env>) {
  const issuer = values.AGENTOME_KEYCLOAK_ISSUER;
  const clientId = values.AGENTOME_KEYCLOAK_CLIENT_ID;
  const clientSecret = values.AGENTOME_KEYCLOAK_CLIENT_SECRET;
  if (issuer === undefined && clientId === undefined && clientSecret === undefined)
    return undefined;
  if (issuer === undefined || clientId === undefined || clientSecret === undefined) {
    throw new ConfigError(
      'AGENTOME_KEYCLOAK_ISSUER, AGENTOME_KEYCLOAK_CLIENT_ID and AGENTOME_KEYCLOAK_CLIENT_SECRET go together: set all three or none',
    );
  }
  return { issuer, clientId, clientSecret };
}

// Without the trailing newline that files from Docker secrets and editors usually end with.
function readFile(file: string, setting: string): string {
  try {
    return readFileSync(resolve(file), 'utf8').replace(/\r?\n$/, '');
  } catch (error) {
    throw new ConfigError(`${setting}: cannot read ${file}: ${String(error)}`);
  }
}

function readSecretKey(keyFile: string | undefined, dataDir: string): string {
  if (keyFile !== undefined) return readKeyFile(resolve(keyFile), 'AGENTOME_SECRET_KEY_FILE');
  // No key given: the first start generates one, so that a fresh install needs no .env.
  const file = join(dataDir, 'secrets', 'secret.key');
  if (!existsSync(file)) createKeyFile(file);
  return readKeyFile(file, 'AGENTOME_DATA_DIR');
}

// The key is written to a temporary file and linked into place, so secret.key never exists
// half written: a failed first start leaves nothing behind, and when two instances start
// together, link() refuses to replace the winner's key and the other one reads it.
function createKeyFile(file: string): void {
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, randomBytes(32).toString('hex'), {
      flag: 'wx',
      mode: 0o600,
      flush: true,
    });
    linkSync(temporary, file);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
      throw new ConfigError(`Cannot create the secret key ${file}: ${String(error)}`);
    }
  } finally {
    // existsSync never throws, even when the data directory turns out to be a file.
    if (existsSync(temporary)) rmSync(temporary);
  }
}

function readKeyFile(file: string, setting: string): string {
  const key = SecretKey.safeParse(readSettingFile(file, setting, 'the secret key'));
  if (!key.success) {
    throw new ConfigError(`${setting}: the secret key in ${file} is shorter than 32 characters`);
  }
  return key.data;
}

// As with the *_FILE variables of Docker's own images, the two exclude each other: with both
// set, one of them is a mistake, and nothing tells which.
function readDatabaseUrl(url: string | undefined, urlFile: string | undefined): string {
  const setting = 'AGENTOME_DATABASE_URL_FILE';
  if (url !== undefined && urlFile !== undefined) {
    throw new ConfigError(`${setting}: set one of AGENTOME_DATABASE_URL and ${setting}`);
  }
  if (url !== undefined) return url;
  if (urlFile === undefined) return DEFAULT_DATABASE_URL;
  const file = resolve(urlFile);
  const parsed = DatabaseUrl.safeParse(readSettingFile(file, setting, 'the database URL'));
  if (!parsed.success) {
    // Only the rules' own messages: the URL itself holds the password.
    const problems = parsed.error.issues.map((issue) => issue.message).join('; ');
    throw new ConfigError(`${setting}: the database URL in ${file} is invalid: ${problems}`);
  }
  return parsed.data;
}

// Trimmed, because files from Docker secrets and editors usually end with a newline.
function readSettingFile(file: string, setting: string, what: string): string {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch (error) {
    throw new ConfigError(`${setting}: cannot read ${what} ${file}: ${String(error)}`);
  }
}

// Unset in development, where Vite serves the web app. Checked here, so that a wrong path
// fails the start instead of every page load.
function checkWebDir(dir: string | undefined): string | undefined {
  if (dir === undefined) return undefined;
  const webDir = resolve(dir);
  if (!existsSync(join(webDir, 'index.html'))) {
    throw new ConfigError(`AGENTOME_WEB_DIR: ${webDir} has no index.html`);
  }
  return webDir;
}
