import { describe, expect, it } from 'vitest';
import type { CodeHost } from '../code-host/types.js';
import { parseJsonc, readEnvironmentFrom, servicesOf, splitCommand } from './devcontainer.js';

// What a repository's devcontainer gives a place: images that run as they are, nothing more.

describe('a devcontainer', () => {
  it('is read with its comments and trailing commas, and strings left as they are', () => {
    expect(
      parseJsonc(`{
        // the app
        "name": "a // b /* c */",
        /* several
           lines */
        "runServices": ["db", "cache",],
        "quote": "say \\"hi\\",",
      }`),
    ).toEqual({ name: 'a // b /* c */', runServices: ['db', 'cache'], quote: 'say "hi",' });
  });

  it('splits a command as a shell splits words and quotes', () => {
    expect(splitCommand(`redis-server --save "" --appendonly 'yes please'`)).toEqual([
      'redis-server',
      '--save',
      '',
      '--appendonly',
      'yes please',
    ]);
  });

  it('gives the services but the main one, their images, environment, command and volumes', () => {
    const { services, problems } = servicesOf(
      { service: 'app', dockerComposeFile: 'compose.yml' },
      {
        app: { build: { context: '..' }, volumes: ['..:/workspaces:cached'] },
        db: {
          image: 'postgres:16-alpine',
          restart: 'unless-stopped',
          environment: {
            POSTGRES_PASSWORD: '${DB_PASSWORD:-postgres}',
            POSTGRES_DB: 'shop',
            PORT: 5432,
          },
          volumes: ['pgdata:/var/lib/postgresql/data'],
          ports: ['5432:5432'],
        },
        cache: {
          image: 'registry.corp.example:5000/infra/redis:7@sha256:' + 'a'.repeat(64),
          command: 'redis-server --appendonly yes',
          environment: ['MODE=${MODE}', 'TIER=dev'],
        },
      },
    );
    expect(services).toEqual([
      {
        name: 'db',
        image: 'postgres:16-alpine',
        environment: { POSTGRES_PASSWORD: 'postgres', POSTGRES_DB: 'shop', PORT: '5432' },
        volumes: [{ name: 'pgdata', target: '/var/lib/postgresql/data' }],
      },
      {
        name: 'cache',
        image: `registry.corp.example:5000/infra/redis:7@sha256:${'a'.repeat(64)}`,
        environment: { MODE: '', TIER: 'dev' },
        command: ['redis-server', '--appendonly', 'yes'],
        volumes: [],
      },
    ]);
    expect(problems).toEqual([]);
  });

  it('leaves out what reaches past its container, or is built, and says why', () => {
    const { services, problems } = servicesOf(
      { runServices: ['root', 'built', 'docker', 'odd', 'missing'] },
      {
        root: { image: 'alpine', privileged: true },
        built: { image: 'mine', build: '.' },
        docker: {
          image: 'docker:dind',
          volumes: ['/var/run/docker.sock:/var/run/docker.sock', './data:/data'],
          env_file: '.env',
        },
        odd: { image: 'Not An Image!' },
      },
    );
    expect(services.map((service) => service.name)).toEqual(['docker']);
    expect(services[0]?.volumes).toEqual([]);
    expect(problems).toEqual([
      'root: left out, it asks for privileged',
      'built: left out, it is built from a Dockerfile; a place runs images only',
      'docker: a folder of the host is not mounted (/var/run/docker.sock)',
      'docker: a folder of the host is not mounted (./data)',
      'docker: env_file is not used',
      expect.stringMatching(/^odd: left out/),
      'missing: not in the compose file',
    ]);
  });

  it('is found in the repository with the compose files it names, merged in order', async () => {
    const texts: Record<string, string> = {
      'sha-dc': `{ "service": "app", "dockerComposeFile": ["../compose.yml", "compose.extra.yml"] }`,
      'sha-base': `services:\n  app:\n    build: .\n  db:\n    image: postgres:15\n    environment:\n      POSTGRES_DB: shop\n`,
      'sha-extra': `services:\n  db:\n    image: postgres:16\n    environment:\n      - POSTGRES_PASSWORD=dev\n`,
    };
    const host = {
      repository: async (url: string) => ({ path: 'corp/shop', defaultBranch: 'main', url }),
      tree: async () => ({
        files: [
          { path: '.devcontainer/devcontainer.json', sha: 'sha-dc' },
          { path: 'compose.yml', sha: 'sha-base' },
          { path: '.devcontainer/compose.extra.yml', sha: 'sha-extra' },
        ],
        truncated: false,
      }),
      file: async (_: string, sha: string) => texts[sha] ?? '',
    } as unknown as CodeHost;
    const read = await readEnvironmentFrom(host, 'https://gitlab.corp.example/corp/shop');
    expect(read).toEqual({
      repository: 'https://gitlab.corp.example/corp/shop',
      devcontainer: '.devcontainer/devcontainer.json',
      services: [
        {
          name: 'db',
          image: 'postgres:16',
          environment: { POSTGRES_DB: 'shop', POSTGRES_PASSWORD: 'dev' },
          volumes: [],
        },
      ],
      problems: [],
    });
  });

  it('is nothing in a repository without one', async () => {
    const host = {
      repository: async () => ({ path: 'corp/site', defaultBranch: 'main' }),
      tree: async () => ({ files: [{ path: 'README.md', sha: 'x' }], truncated: false }),
    } as unknown as CodeHost;
    expect(await readEnvironmentFrom(host, 'https://github.com/corp/site')).toEqual({
      repository: 'https://github.com/corp/site',
      devcontainer: null,
      services: [],
      problems: [],
    });
  });
});
