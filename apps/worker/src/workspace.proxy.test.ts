import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { launchPackage } from '../test/fake-server.js';
import { branchArtifact, prepareWorkspace, removeRun, removeWorkspace } from './workspace.js';

// The clone and the kept commits through the git proxy, played here by `git
// http-backend` behind Basic authentication with the run's git name and password.

const ACCESS = { username: 'run-1', password: 'the-run-git-password' };
const EXPECTED = `Basic ${Buffer.from(`${ACCESS.username}:${ACCESS.password}`).toString('base64')}`;
const options = { signal: new AbortController().signal, timeout: 60_000 };

let dir: string;
let server: Server;
let url: string;
let bare: string;

// Never the sync form: the proxy below answers on this same event loop.
const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> {
  const env = {
    PATH: process.env.PATH,
    HOME: dir,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_TERMINAL_PROMPT: '0',
  };
  const identity = ['-c', 'user.name=Agent', '-c', 'user.email=agent@agentome.invalid'];
  return (await exec('git', [...identity, ...args], { cwd, env, encoding: 'utf8' })).stdout;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentome-proxy-'));
  server = createServer((request, response) => {
    if (request.headers.authorization !== EXPECTED) {
      response.writeHead(401, { 'www-authenticate': 'Basic realm="Agentome"' }).end();
      return;
    }
    const path = new URL(request.url ?? '/', 'http://proxy');
    const backend = spawn('git', ['http-backend'], {
      env: {
        PATH: process.env.PATH,
        GIT_PROJECT_ROOT: join(dir, 'host'),
        GIT_HTTP_EXPORT_ALL: '1',
        GIT_CONFIG_GLOBAL: devNull,
        REMOTE_USER: ACCESS.username,
        REQUEST_METHOD: request.method,
        PATH_INFO: path.pathname.replace(/^\/git/, ''),
        QUERY_STRING: path.search.slice(1),
        CONTENT_TYPE: request.headers['content-type'] ?? '',
        HTTP_CONTENT_ENCODING: request.headers['content-encoding'] ?? '',
        GIT_PROTOCOL: String(request.headers['git-protocol'] ?? ''),
      },
    });
    request.pipe(backend.stdin);
    const out: Buffer[] = [];
    backend.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    backend.on('close', () => {
      const all = Buffer.concat(out);
      const split = all.indexOf('\r\n\r\n');
      const headers: Record<string, string> = {};
      for (const line of all.subarray(0, split).toString().split('\r\n')) {
        const [name = '', ...value] = line.split(': ');
        headers[name.toLowerCase()] = value.join(': ');
      }
      const status = Number.parseInt(headers.status ?? '200', 10);
      delete headers.status;
      response.writeHead(status, headers).end(all.subarray(split + 4));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/git/acme/repo.git`;
});

afterAll(() => {
  server.close();
  removeWorkspace(dir);
});

beforeEach(async () => {
  bare = join(dir, 'host', 'acme', `repo.git`);
  removeWorkspace(join(dir, 'host'));
  await git(dir, 'init', '--quiet', '--bare', '--initial-branch=main', bare);
  const seed = mkdtempSync(join(dir, 'seed-'));
  await git(seed, 'init', '--quiet', '--initial-branch=main');
  writeFileSync(join(seed, 'README.md'), 'acme\n');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '--quiet', '-m', 'Start');
  await git(seed, 'push', '--quiet', bare, 'main');
});

function proxied() {
  const launch = launchPackage({ repository: 'https://gitlab.example.com/acme/repo.git' });
  launch.workspace.git = { url, ...ACCESS };
  return launch;
}

describe('a workspace behind the git proxy', () => {
  it('clones through the proxy and leaves the agent a helper that only reads the password', async () => {
    const home = join(dir, 'home-clone');
    const workspace = await prepareWorkspace(home, proxied(), options);
    expect(await git(workspace.repo, 'log', '--format=%s')).toBe('Start\n');
    expect((await git(workspace.repo, 'remote', 'get-url', 'origin')).trim()).toBe(url);
    // The person's helpers dropped first, then ours; the password is not in the config.
    const helpers = await git(
      workspace.repo,
      'config',
      '--local',
      '--get-all',
      'credential.helper',
    );
    expect(helpers.split('\n')[0]).toBe('');
    expect(helpers).toContain('git-credentials');
    expect(readFileSync(join(workspace.repo, '.git', 'config'), 'utf8')).not.toContain(
      ACCESS.password,
    );
    const file = join(workspace.dir, 'git-credentials');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(file.startsWith(workspace.repo)).toBe(false);

    // The agent's own git pushes with it, as the agent would.
    await git(workspace.repo, 'checkout', '--quiet', '-b', 'agent/readme');
    await git(workspace.repo, 'commit', '--quiet', '--allow-empty', '-m', 'Readme');
    await git(workspace.repo, 'push', '--quiet', 'origin', 'agent/readme');
    expect((await git(bare, 'log', '-1', '--format=%s', 'agent/readme')).trim()).toBe('Readme');
  });

  it("ignores a .git/config the agent rewrote: the worker's push goes where it clones from", async () => {
    const workspace = await prepareWorkspace(join(dir, 'home-config'), proxied(), options);
    // What the agent is now allowed to do, and what it must not gain by it: the worker's own
    // push would follow this rewrite to another server and hand the password to it.
    await git(workspace.repo, 'config', 'url.http://127.0.0.1:1/elsewhere/.insteadOf', url);
    await git(workspace.repo, 'config', 'branch.agent/x.remote', 'origin');
    await git(workspace.repo, 'commit', '--quiet', '--allow-empty', '-m', 'Rewritten config');
    const { artifact, failure } = await branchArtifact(workspace, 'r4', true);
    expect(failure).toBeUndefined();
    expect(artifact?.meta).toMatchObject({ pushedTo: url });
    expect((await git(bare, 'log', '-1', '--format=%s', 'agent/run-r4')).trim()).toBe(
      'Rewritten config',
    );
    const config = readFileSync(join(workspace.repo, '.git', 'config'), 'utf8');
    expect(config).not.toContain('insteadOf');
    expect(config).toContain('git-credentials');
  });

  it('pushes the commits the agent left unpushed to a branch of the run', async () => {
    const workspace = await prepareWorkspace(join(dir, 'home-push'), proxied(), options);
    await git(workspace.repo, 'commit', '--quiet', '--allow-empty', '-m', 'Unpushed');
    const { artifact, failure } = await branchArtifact(workspace, 'r1', true);
    expect(failure).toBeUndefined();
    expect(artifact).toMatchObject({
      kind: 'branch',
      ref: 'agent/run-r1',
      meta: { pushedTo: url },
    });
    expect((await git(bare, 'log', '-1', '--format=%s', 'agent/run-r1')).trim()).toBe('Unpushed');
  });

  it('names the branch the agent pushed, and pushes nothing more', async () => {
    const workspace = await prepareWorkspace(join(dir, 'home-pushed'), proxied(), options);
    await git(workspace.repo, 'checkout', '--quiet', '-b', 'agent/fix');
    await git(workspace.repo, 'commit', '--quiet', '--allow-empty', '-m', 'Fix');
    await git(workspace.repo, 'push', '--quiet', 'origin', 'agent/fix');
    // A remote-tracking ref the agent moved by hand is not a push: the host is asked.
    await git(workspace.repo, 'commit', '--quiet', '--allow-empty', '-m', 'Not pushed');
    await git(workspace.repo, 'update-ref', 'refs/remotes/origin/agent/fix', 'HEAD');
    const { artifact } = await branchArtifact(workspace, 'r2', true);
    expect(artifact?.ref).toBe('agent/run-r2');

    await git(workspace.repo, 'push', '--quiet', 'origin', 'agent/fix');
    const again = await branchArtifact(workspace, 'r3', true);
    expect(again.artifact?.ref).toBe('agent/fix');
    expect(await git(bare, 'branch', '--list', 'agent/run-r3')).toBe('');
  });
});

describe("an agent's folder that stays, in a person's place", () => {
  const place = { ...options, place: true };

  it('is cloned once into the place, and outlives the run', async () => {
    const home = join(dir, 'home-place-first');
    const launch = proxied();
    const workspace = await prepareWorkspace(home, launch, place);
    expect(workspace.repo.startsWith(join(home, 'folders', launch.agent.id))).toBe(true);
    expect(await git(workspace.repo, 'log', '--format=%s')).toBe('Start\n');
    removeRun(home, launch.run.id, process.env);
    expect(existsSync(join(workspace.repo, 'README.md'))).toBe(true);
  });

  it("keeps what git ignores, saves what the last run left, and trusts none of the folder's git", async () => {
    const home = join(dir, 'home-place-again');
    const first = proxied();
    const before = await prepareWorkspace(home, first, place);
    const folder = before.repo;
    // The first run: a dependency git ignores, a change it did not commit, and a hook and a
    // setting of its own in the folder's git.
    writeFileSync(join(folder, '.gitignore'), 'node_modules/\n');
    await git(folder, 'add', '.gitignore');
    await git(folder, 'commit', '--quiet', '-m', 'Ignore dependencies');
    await git(folder, 'push', '--quiet', 'origin', 'main');
    mkdirSync(join(folder, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(join(folder, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
    writeFileSync(join(folder, 'README.md'), 'acme, half done\n');
    writeFileSync(join(folder, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', {
      mode: 0o755,
    });
    await git(folder, 'config', 'alias.st', '!echo planted');
    removeRun(home, first.run.id, process.env);

    const second = proxied();
    second.run.id = '9c8f1a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b';
    second.agent.id = first.agent.id;
    const after = await prepareWorkspace(home, second, place);
    expect(after.repo).toBe(folder);
    expect(after.leftover).toBe('agent/leftover-9c8f1a2b');
    // The change is on its branch, here and on the host; the tracked files are main's again.
    expect(readFileSync(join(folder, 'README.md'), 'utf8')).toBe('acme\n');
    expect(await git(bare, 'show', 'agent/leftover-9c8f1a2b:README.md')).toBe('acme, half done\n');
    expect((await git(folder, 'rev-parse', '--abbrev-ref', 'HEAD')).trim()).toBe('main');
    // What git ignores stayed.
    expect(existsSync(join(folder, 'node_modules', 'left-pad', 'index.js'))).toBe(true);
    // The hook and the setting the run planted are gone.
    expect(existsSync(join(folder, '.git', 'hooks', 'pre-commit'))).toBe(false);
    expect(readFileSync(join(folder, '.git', 'config'), 'utf8')).not.toContain('planted');
  });
});
