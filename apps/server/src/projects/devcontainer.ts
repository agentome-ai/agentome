import { posix } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { CodeHost } from '../code-host/types.js';

// What a project's repository says its work needs next to it: the services of its devcontainer's
// compose file — databases, queues, other services. A person's place runs them beside the agent,
// on a network of their own, by the names the compose file gives them. Only what runs an image
// as it is comes through: nothing built, no privilege, no folder of the host. The agent itself
// works in the place's own image, which has the common toolchains.

const NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
/** An image reference: [registry[:port]/]path[:tag][@sha256:digest]. */
const IMAGE =
  /^(?:[a-z0-9.-]+(?::\d+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[\w][\w.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/;

export const MAX_SERVICES = 10;

export const ServiceSpec = z.object({
  name: z.string().regex(NAME),
  image: z.string().max(255).regex(IMAGE),
  environment: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_.]*$/), z.string().max(4096)),
  command: z.array(z.string().max(4096)).max(64).optional(),
  volumes: z
    .array(
      z.object({
        name: z.string().regex(NAME),
        target: z
          .string()
          .max(255)
          .regex(/^\/[^\0:]*$/),
      }),
    )
    .max(8),
});
export type ServiceSpec = z.infer<typeof ServiceSpec>;

/** A project's environment as its repository said it when it was last read. */
export const ProjectEnvironment = z.object({
  repository: z.string(),
  /** The devcontainer file read, or null when the repository has none. */
  devcontainer: z.string().nullable(),
  services: z.array(ServiceSpec),
  /** What was left out, and why, for a person to read. */
  problems: z.array(z.string()),
  readAt: z.string(),
  /** The services' fingerprint: what an admin approves, and what a place is made for. */
  hash: z.string(),
});
export type ProjectEnvironment = z.infer<typeof ProjectEnvironment>;

/** devcontainer.json is JSON with comments and trailing commas. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (inString) {
      out += char;
      if (char === '\\') {
        out += next ?? '';
        i++;
      } else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
    } else if (char === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (char === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else out += char;
  }
  // A comma before a closing bracket, outside strings: strings no longer hold a bare one here
  // only when they are skipped, so walk once more.
  let clean = '';
  inString = false;
  for (let i = 0; i < out.length; i++) {
    const char = out[i];
    if (inString) {
      clean += char;
      if (char === '\\') {
        clean += out[i + 1] ?? '';
        i++;
      } else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    if (char === ',') {
      const rest = out.slice(i + 1).trimStart();
      if (rest.startsWith('}') || rest.startsWith(']')) continue;
    }
    clean += char;
  }
  return JSON.parse(clean);
}

/** Compose's `${VAR:-default}`: nothing of this server's environment goes in, only defaults. */
function interpolate(value: string): string {
  return value
    .replace(
      /\$\{[A-Za-z_][A-Za-z0-9_]*(?::?-([^}]*))?\}/g,
      (_, fallback?: string) => fallback ?? '',
    )
    .replace(/\$\$/g, '$');
}

/** A compose command given as one string, split as a shell would split plain words and quotes. */
export function splitCommand(text: string): string[] {
  const words: string[] = [];
  let word = '';
  let quote: string | null = null;
  let started = false;
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started || word) words.push(word);
      word = '';
      started = false;
    } else word += char;
  }
  if (started || word) words.push(word);
  return words;
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** What a service may not have: each would reach past its own container. */
const REFUSED = [
  'privileged',
  'cap_add',
  'devices',
  'network_mode',
  'pid',
  'ipc',
  'userns_mode',
  'security_opt',
  'sysctls',
  'volumes_from',
  'cgroup_parent',
];
/** What a service may have that the place does not use. */
const IGNORED = new Set([
  'ports',
  'expose',
  'depends_on',
  'healthcheck',
  'restart',
  'container_name',
  'hostname',
  'labels',
  'networks',
  'deploy',
  'logging',
  'profiles',
  'stop_grace_period',
  'ulimits',
  'tty',
  'stdin_open',
  'shm_size',
  'mem_limit',
  'cpus',
]);

/** What a service may have that the place takes no part of, said back to a person. */
const NOT_USED = ['env_file', 'entrypoint', 'user', 'working_dir'];
const KNOWN = new Set([...IGNORED, ...NOT_USED, 'image', 'environment', 'volumes', 'command']);

/** The services of merged compose files a devcontainer names; the main one is the agent's. */
export function servicesOf(
  devcontainer: unknown,
  composeServices: Record<string, unknown>,
): { services: ServiceSpec[]; problems: string[] } {
  const config = record(devcontainer);
  const main = typeof config.service === 'string' ? config.service : undefined;
  const wanted = Array.isArray(config.runServices)
    ? config.runServices.filter((name): name is string => typeof name === 'string')
    : Object.keys(composeServices);
  const problems: string[] = [];
  const services: ServiceSpec[] = [];
  for (const name of wanted) {
    if (name === main) continue;
    const raw = record(composeServices[name]);
    if (Object.keys(raw).length === 0) {
      problems.push(`${name}: not in the compose file`);
      continue;
    }
    if (services.length >= MAX_SERVICES) {
      problems.push(`${name}: a place runs at most ${MAX_SERVICES} services`);
      continue;
    }
    const refused = REFUSED.filter((key) => key in raw);
    if (refused.length > 0) {
      problems.push(`${name}: left out, it asks for ${refused.join(', ')}`);
      continue;
    }
    if (typeof raw.image !== 'string' || 'build' in raw) {
      problems.push(`${name}: left out, it is built from a Dockerfile; a place runs images only`);
      continue;
    }
    const environment: Record<string, string> = {};
    const env = raw.environment;
    if (Array.isArray(env)) {
      for (const line of env) {
        if (typeof line !== 'string') continue;
        const at = line.indexOf('=');
        if (at > 0) environment[line.slice(0, at)] = interpolate(line.slice(at + 1));
      }
    } else {
      for (const [key, value] of Object.entries(record(env))) {
        if (value !== null && value !== undefined) environment[key] = interpolate(String(value));
      }
    }
    const volumes: ServiceSpec['volumes'] = [];
    for (const volume of Array.isArray(raw.volumes) ? raw.volumes : []) {
      const [source, target] =
        typeof volume === 'string'
          ? volume.split(':')
          : [record(volume).source, record(volume).target].map((part) =>
              typeof part === 'string' ? part : undefined,
            );
      const named = typeof volume === 'string' || record(volume).type === 'volume';
      if (named && source && target && NAME.test(source)) {
        volumes.push({ name: source, target });
      } else {
        problems.push(`${name}: a folder of the host is not mounted (${String(source)})`);
      }
    }
    const command =
      typeof raw.command === 'string'
        ? splitCommand(interpolate(raw.command))
        : Array.isArray(raw.command)
          ? raw.command.map((part) => interpolate(String(part)))
          : undefined;
    for (const key of NOT_USED) if (key in raw) problems.push(`${name}: ${key} is not used`);
    const unknown = Object.keys(raw).filter((key) => !KNOWN.has(key));
    if (unknown.length > 0) problems.push(`${name}: ${unknown.join(', ')} not used`);
    const parsed = ServiceSpec.safeParse({
      name,
      image: interpolate(raw.image),
      environment,
      ...(command && { command }),
      volumes,
    });
    if (parsed.success) services.push(parsed.data);
    else problems.push(`${name}: left out, ${parsed.error.issues[0]?.message ?? 'not valid'}`);
  }
  return { services, problems };
}

/** The devcontainer files a repository may have, in the order the standard looks for them. */
const DEVCONTAINER = ['.devcontainer/devcontainer.json', '.devcontainer.json'];

/**
 * Reads a repository's devcontainer and the compose files it names, from its default branch.
 * A repository without one has no services; what cannot be read is a problem, not an error.
 */
export async function readEnvironmentFrom(
  host: CodeHost,
  repositoryUrl: string,
): Promise<Omit<ProjectEnvironment, 'readAt' | 'hash'>> {
  const repository = await host.repository(repositoryUrl);
  const { files } = await host.tree(repository.path, repository.defaultBranch);
  const byPath = new Map(files.map((file) => [file.path, file.sha]));
  const found = DEVCONTAINER.find((path) => byPath.has(path));
  const none = { repository: repositoryUrl, services: [], problems: [] };
  if (!found) return { ...none, devcontainer: null };
  let devcontainer: unknown;
  try {
    devcontainer = parseJsonc(await host.file(repository.path, byPath.get(found) ?? ''));
  } catch (error) {
    return {
      ...none,
      devcontainer: found,
      problems: [`${found} is not valid JSON: ${error instanceof Error ? error.message : ''}`],
    };
  }
  const named = record(devcontainer).dockerComposeFile;
  const composeFiles = (Array.isArray(named) ? named : [named]).filter(
    (file): file is string => typeof file === 'string',
  );
  if (composeFiles.length === 0) return { ...none, devcontainer: found };
  const merged: Record<string, Record<string, unknown>> = {};
  const problems: string[] = [];
  for (const file of composeFiles) {
    const path = posix.normalize(posix.join(posix.dirname(found), file));
    const sha = byPath.get(path);
    if (!sha || path.startsWith('..')) {
      problems.push(`${path}: not in the repository`);
      continue;
    }
    try {
      const compose = record(parseYaml(await host.file(repository.path, sha)));
      for (const [name, service] of Object.entries(record(compose.services))) {
        const before = merged[name] ?? {};
        const next = record(service);
        merged[name] = {
          ...before,
          ...next,
          ...('environment' in before &&
            'environment' in next && {
              environment: { ...envMap(before.environment), ...envMap(next.environment) },
            }),
        };
      }
    } catch (error) {
      problems.push(`${path} is not valid YAML: ${error instanceof Error ? error.message : ''}`);
    }
  }
  const { services, problems: more } = servicesOf(devcontainer, merged);
  return {
    repository: repositoryUrl,
    devcontainer: found,
    services,
    problems: [...problems, ...more],
  };
}

/** Compose's environment as a map, from either of its two forms. */
function envMap(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value)) return record(value);
  return Object.fromEntries(
    value
      .filter((line): line is string => typeof line === 'string' && line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
}
