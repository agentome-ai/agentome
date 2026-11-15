import { describe, expect, it } from 'vitest';
import { DEFAULT_REGISTRIES, imageParts, pinImages } from './registry.js';

const digest = `sha256:${'c'.repeat(64)}`;
const service = (image: string) => ({ name: 'db', image, environment: {}, volumes: [] });

describe('an image reference', () => {
  it('is read as Docker reads it', () => {
    expect(imageParts('postgres')).toEqual({
      registry: 'docker.io',
      repository: 'library/postgres',
      tag: 'latest',
      digest: undefined,
    });
    expect(imageParts('bitnami/redis:7.2')).toMatchObject({
      registry: 'docker.io',
      repository: 'bitnami/redis',
      tag: '7.2',
    });
    expect(imageParts('ghcr.io/acme/api:1@' + digest)).toEqual({
      registry: 'ghcr.io',
      repository: 'acme/api',
      tag: '1',
      digest,
    });
    expect(imageParts('registry.acme.internal:5000/redis:7')).toMatchObject({
      registry: 'registry.acme.internal:5000',
      repository: 'redis',
    });
    expect(imageParts('localhost/redis')).toMatchObject({ registry: 'localhost' });
  });
});

describe('pinning images', () => {
  it("takes the tag's digest with the anonymous token the registry points at", async () => {
    const asked: string[] = [];
    const fetchImpl = async (url: string | URL, init?: RequestInit) => {
      const address = String(url);
      asked.push(`${init?.method ?? 'GET'} ${address}`);
      if (address.startsWith('https://auth.docker.io/')) {
        return Response.json({ token: 'anonymous' });
      }
      const authorization = new Headers(init?.headers).get('authorization');
      if (authorization !== 'Bearer anonymous') {
        return new Response(null, {
          status: 401,
          headers: {
            'www-authenticate':
              'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/postgres:pull"',
          },
        });
      }
      return new Response(null, { headers: { 'docker-content-digest': digest } });
    };
    const pinned = await pinImages([service('postgres:16')], DEFAULT_REGISTRIES, fetchImpl);
    expect(pinned).toEqual({ services: [service(`postgres:16@${digest}`)], problems: [] });
    expect(asked).toEqual([
      'HEAD https://registry-1.docker.io/v2/library/postgres/manifests/16',
      'GET https://auth.docker.io/token?service=registry.docker.io&scope=repository%3Alibrary%2Fpostgres%3Apull',
      'HEAD https://registry-1.docker.io/v2/library/postgres/manifests/16',
    ]);
  });

  it('leaves out an image of a registry not listed, or one it cannot pin', async () => {
    const fetchImpl = async () => new Response(null, { status: 404 });
    const pinned = await pinImages(
      [
        service('registry.acme.internal/redis:7'),
        { ...service('ghcr.io/acme/gone:1'), name: 'gone' },
        { ...service(`mcr.microsoft.com/mssql/server@${digest}`), name: 'sql' },
      ],
      DEFAULT_REGISTRIES,
      fetchImpl,
    );
    // An image named by its digest is pinned already.
    expect(pinned.services).toEqual([
      { ...service(`mcr.microsoft.com/mssql/server@${digest}`), name: 'sql' },
    ]);
    expect(pinned.problems).toEqual([
      'db: left out, its image is from registry.acme.internal, which this installation does not pull from (AGENTOME_SERVICE_REGISTRIES)',
      'gone: left out, its image could not be pinned: the registry answered 404',
    ]);
  });

  it('refuses a sign-in that is not a plain HTTPS token', async () => {
    const fetchImpl = async () =>
      new Response(null, { status: 401, headers: { 'www-authenticate': 'Basic realm="x"' } });
    const pinned = await pinImages([service('quay.io/acme/db:1')], DEFAULT_REGISTRIES, fetchImpl);
    expect(pinned.problems[0]).toMatch(/asks for a sign-in; a place pulls public images only/);
  });
});
