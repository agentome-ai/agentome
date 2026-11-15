import { type FetchLike, guardedFetch } from '../mcp/remote.js';
import type { ServiceSpec } from './devcontainer.js';

// A service's image is approved as the bytes it named when an admin saw it: its tag is read
// from the registry and pinned to the digest it pointed at, so a tag moved after the approval
// runs nothing new. Only registries the installation lists are read; a service from another is
// left out, as an internal registry should not hand a repository's author its images.

/** Registries a service's image may come from when the installation names none. */
export const DEFAULT_REGISTRIES = [
  'docker.io',
  'ghcr.io',
  'mcr.microsoft.com',
  'quay.io',
  'public.ecr.aws',
];

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const MANIFESTS = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/** Docker's reading of a reference: the registry, the repository in it, and its tag or digest. */
export function imageParts(image: string) {
  const at = image.indexOf('@');
  const named = at > 0 ? image.slice(0, at) : image;
  const digest = at > 0 ? image.slice(at + 1) : undefined;
  const colon = named.lastIndexOf(':');
  const tagged = colon > named.lastIndexOf('/');
  const name = tagged ? named.slice(0, colon) : named;
  const tag = tagged ? named.slice(colon + 1) : 'latest';
  const first = name.split('/')[0] ?? '';
  // A first part with a dot or a port, or localhost, is a registry; anything else is Docker Hub.
  const own = name.includes('/') && (/[.:]/.test(first) || first === 'localhost');
  const registry = own ? first : 'docker.io';
  const path = own ? name.slice(first.length + 1) : name;
  const repository = registry === 'docker.io' && !path.includes('/') ? `library/${path}` : path;
  return { registry, repository, tag, digest };
}

/** The digest a tag points at now, from the registry's manifest, with an anonymous token. */
async function digestOf(
  parts: ReturnType<typeof imageParts>,
  fetchImpl: FetchLike,
): Promise<string> {
  const host = parts.registry === 'docker.io' ? 'registry-1.docker.io' : parts.registry;
  const url = `https://${host}/v2/${parts.repository}/manifests/${encodeURIComponent(parts.tag)}`;
  const ask = (authorization?: string) =>
    fetchImpl(url, {
      method: 'HEAD',
      headers: { accept: MANIFESTS, ...(authorization && { authorization }) },
      signal: AbortSignal.timeout(15_000),
    });
  let answer = await ask();
  if (answer.status === 401) {
    answer = await ask(`Bearer ${await anonymousToken(answer, fetchImpl)}`);
  }
  if (!answer.ok) throw new Error(`the registry answered ${answer.status}`);
  const digest = answer.headers.get('docker-content-digest') ?? '';
  if (!DIGEST.test(digest)) throw new Error('the registry named no sha256 digest');
  return digest;
}

/** The pull token a registry's 401 points at (`WWW-Authenticate: Bearer realm=…`). */
async function anonymousToken(refusal: Response, fetchImpl: FetchLike): Promise<string> {
  const challenge = refusal.headers.get('www-authenticate') ?? '';
  const fields = Object.fromEntries(
    [...challenge.matchAll(/(\w+)="([^"]*)"/g)].map((match) => [match[1], match[2]]),
  );
  if (!/^bearer /i.test(challenge) || !fields.realm?.startsWith('https://')) {
    throw new Error('the registry asks for a sign-in; a place pulls public images only');
  }
  const realm = new URL(fields.realm);
  if (fields.service) realm.searchParams.set('service', fields.service);
  if (fields.scope) realm.searchParams.set('scope', fields.scope);
  const answer = await fetchImpl(realm, { signal: AbortSignal.timeout(15_000) });
  if (!answer.ok) throw new Error(`the registry's sign-in answered ${answer.status}`);
  const body = (await answer.json()) as { token?: unknown; access_token?: unknown };
  const token = body.token ?? body.access_token;
  if (typeof token !== 'string' || token === '') throw new Error('the registry gave no token');
  return token;
}

/**
 * The services with each image pinned to its digest (`name:tag@sha256:…`), and what was left
 * out: an image from a registry not listed, or one whose digest could not be read.
 */
export async function pinImages(
  services: ServiceSpec[],
  registries: readonly string[],
  fetchImpl: FetchLike = guardedFetch,
): Promise<{ services: ServiceSpec[]; problems: string[] }> {
  const pinned: ServiceSpec[] = [];
  const problems: string[] = [];
  for (const service of services) {
    const parts = imageParts(service.image);
    if (!registries.includes(parts.registry)) {
      problems.push(
        `${service.name}: left out, its image is from ${parts.registry}, which this installation does not pull from (AGENTOME_SERVICE_REGISTRIES)`,
      );
      continue;
    }
    if (parts.digest) {
      pinned.push(service);
      continue;
    }
    try {
      pinned.push({ ...service, image: `${service.image}@${await digestOf(parts, fetchImpl)}` });
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      problems.push(
        `${service.name}: left out, its image could not be pinned: ${why}`.slice(0, 200),
      );
    }
  }
  return { services: pinned, problems };
}

/** Whether every image of an approved list is pinned: a list approved before pinning is not. */
export const allPinned = (services: ServiceSpec[]) =>
  services.every((service) => imageParts(service.image).digest !== undefined);
