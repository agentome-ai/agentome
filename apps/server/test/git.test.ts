import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { migrate } from '@agentome/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { emptyPack, FLUSH, pkt } from '../src/git/pktline.js';
import { LaunchPackage } from '../src/protocol.js';
import { licenseEnterpriseAt, setupCodeIn } from './app.js';

// The git proxy with the real git on both sides: the agent's git clones and pushes
// through this server, and behind it a GitLab made of `git http-backend` over a bare repository,
// which answers the one API call the proxy makes (the merge base) with `git merge-base`.

const HOST_TOKEN = 'glpat-the-organizations-token-nobody-sees';
const UPSTREAM_AUTH = `Basic ${Buffer.from(`oauth2:${HOST_TOKEN}`).toString('base64')}`;
const run_ = promisify(execFile);

let container: StartedPostgreSqlContainer;
let app: Awaited<ReturnType<typeof buildApp>>;
let base: string;
let admin: { cookie: string };
let dir: string;
let upstream: Server;
let gitlab: string;
/** What reached the host's git, by Authorization header. */
const seenByHost: (string | undefined)[] = [];

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  dir = mkdtempSync(join(tmpdir(), 'agentome-git-'));
  await migrate(container.getConnectionUri());
  app = await buildApp(
    loadConfig({
      AGENTOME_DATABASE_URL: container.getConnectionUri(),
      AGENTOME_DATA_DIR: join(dir, 'data'),
      AGENTOME_LOG_LEVEL: 'silent',
    }),
  );
  base = await app.listen({ host: '127.0.0.1', port: 0 });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: {
      code: setupCodeIn(join(dir, 'data')),
      orgName: 'Acme',
      admin: { name: 'Ann Admin', email: 'admin@example.com', password: 'the admin password' },
    },
  });
  await licenseEnterpriseAt(container.getConnectionUri());
  admin = { cookie: cookieOf(setup) };
  upstream = createServer((request, response) => void host(request, response));
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  gitlab = `http://127.0.0.1:${String((upstream.address() as AddressInfo).port)}`;
}, 120_000);

afterAll(async () => {
  upstream?.close();
  await app?.close();
  await container?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** A fresh acme/repo on the host, with one commit on main. */
let bare: string;
beforeEach(async () => {
  seenByHost.length = 0;
  rmSync(join(dir, 'host'), { recursive: true, force: true });
  bare = join(dir, 'host', 'acme', 'repo.git');
  await git(['init', '--quiet', '--bare', '--initial-branch=main', bare], dir);
  const seed = mkdtempSync(join(dir, 'seed-'));
  await git(['init', '--quiet', '--initial-branch=main'], seed);
  writeFileSync(join(seed, 'README.md'), 'acme\n');
  await git(['add', '.'], seed);
  await git(['commit', '--quiet', '-m', 'Start'], seed);
  await git(['push', '--quiet', bare, 'main'], seed);
});

/** The GitLab behind the proxy: its git over smart HTTP, and the merge base API. */
async function host(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? '/', gitlab);
  const project = /^\/api\/v4\/projects\/([^/]+)\/repository\/merge_base$/.exec(url.pathname);
  if (project) {
    // A list as GitLab documents it, `refs[]=a&refs[]=b`.
    const refs = url.searchParams.getAll('refs[]');
    const found = await git(['merge-base', ...refs], bare).catch(() => undefined);
    response.writeHead(found ? 200 : 404, { 'content-type': 'application/json' });
    response.end(JSON.stringify(found ? { id: found.trim() } : { message: '404 Not Found' }));
    return;
  }
  seenByHost.push(request.headers.authorization);
  if (request.headers.authorization !== UPSTREAM_AUTH) {
    response.writeHead(401, { 'www-authenticate': 'Basic realm="GitLab"' }).end();
    return;
  }
  const backend = spawn('git', ['http-backend'], {
    env: {
      PATH: process.env.PATH,
      GIT_PROJECT_ROOT: join(dir, 'host'),
      GIT_HTTP_EXPORT_ALL: '1',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: devNull,
      REMOTE_USER: 'oauth2',
      REMOTE_ADDR: '127.0.0.1',
      REQUEST_METHOD: request.method,
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1),
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
}

const gitEnv = {
  PATH: process.env.PATH,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: devNull,
  GIT_TERMINAL_PROMPT: '0',
};
async function git(args: string[], cwd: string): Promise<string> {
  const flags = ['-c', 'user.name=Agent', '-c', 'user.email=agent@agentome.ai'];
  const { stdout } = await run_('git', [...flags, ...args], { cwd, env: { ...gitEnv, HOME: dir } });
  return stdout;
}
/** git that may fail: what it printed, and whether it did. */
async function tryGit(args: string[], cwd: string) {
  return git(args, cwd).then(
    (out) => ({ ok: true, said: out }),
    (error: { stderr?: string }) => ({ ok: false, said: error.stderr ?? '' }),
  );
}

function cookieOf(response: LightMyRequestResponse): string {
  const setCookie = response.headers['set-cookie'] ?? [];
  return (Array.isArray(setCookie) ? setCookie : [setCookie])
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');
}

const asAdmin = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
  app.inject({ method, url, payload, headers: { cookie: admin.cookie } });

let made = 0;
/** A live run on acme/repo, claimed by a seat: its launch package and its run token. */
async function liveRun(repository = `${gitlab}/acme/repo.git`) {
  made += 1;
  const agent = (await asAdmin('POST', '/api/agents', { name: `Agent ${made}` })).json<{
    id: string;
  }>();
  const project = (await asAdmin('POST', '/api/projects', { name: `Project ${made}` })).json<{
    id: string;
  }>();
  await asAdmin('POST', '/api/connections', {
    projectId: project.id,
    config: { kind: 'gitlab', baseUrl: gitlab, group: 'acme' },
    token: HOST_TOKEN,
  });
  await asAdmin('PUT', `/api/projects/${project.id}/agents/${agent.id}`);
  const task = await asAdmin('POST', '/api/tasks', {
    agentId: agent.id,
    projectId: project.id,
    title: 'Add',
    repository,
  });
  const runId = task.json<{ run: { id: string } }>().run.id;
  const code = (await asAdmin('POST', '/api/seats/pairing-codes')).json<{ code: string }>().code;
  const seat = await app.inject({
    method: 'POST',
    url: '/api/seats/pair',
    payload: {
      code,
      name: `seat ${made}`,
      kind: 'subscription-laptop',
      engines: ['claude-code'],
      capabilities: { sandbox: true },
    },
  });
  const seatToken = seat.json<{ token: string }>().token;
  for (;;) {
    const claim = await app.inject({
      method: 'GET',
      url: '/api/seats/claim?wait=0',
      headers: { authorization: `Bearer ${seatToken}` },
    });
    const launch = LaunchPackage.parse(claim.json());
    if (launch.run.id === runId) return { launch, token: launch.run.token };
    await finish(launch.run.id, launch.run.token);
  }
}

const finish = (runId: string, token: string) =>
  app.inject({
    method: 'POST',
    url: `/api/runs/${runId}/finish`,
    headers: { authorization: `Bearer ${token}` },
    payload: { status: 'done' },
  });

/** The proxy's URL with the run's git password in it, as a credential helper would give it. */
function signedIn(launch: LaunchPackage, password = launch.workspace.git?.password ?? '') {
  // The server names itself by its public URL; this one listens on a port of its own.
  const url = new URL(new URL(launch.workspace.git?.url ?? '').pathname, base);
  url.username = launch.workspace.git?.username ?? '';
  url.password = password;
  return url.toString();
}

/** A clone of acme/repo through the proxy, as the agent's workspace. */
async function cloneThrough(launch: LaunchPackage) {
  const work = mkdtempSync(join(dir, 'work-'));
  await git(['clone', '--quiet', signedIn(launch), work], dir);
  return work;
}

const tipOf = (ref: string) =>
  git(['rev-parse', '--verify', '--quiet', ref], bare).then(
    (s) => s.trim(),
    () => '',
  );

describe('the git proxy', () => {
  it('names itself in the launch package, with a password that is not the run token', async () => {
    const { launch, token } = await liveRun();
    expect(launch.workspace.git).toEqual({
      url: 'http://localhost:3000/git/acme/repo.git',
      username: launch.run.id,
      password: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) as unknown as string,
    });
    expect(launch.workspace.git?.password).not.toBe(token);
  });

  it('clones with the connection token on the host side only', async () => {
    const { launch } = await liveRun();
    const work = await cloneThrough(launch);
    expect(await git(['log', '--format=%s'], work)).toBe('Start\n');
    expect(seenByHost.length).toBeGreaterThan(0);
    expect(seenByHost.every((auth) => auth === UPSTREAM_AUTH)).toBe(true);
  });

  it('passes a push to an agent branch, and a fast-forward of it', async () => {
    const { launch } = await liveRun();
    const work = await cloneThrough(launch);
    await git(['checkout', '--quiet', '-b', 'agent/readme'], work);
    await git(['commit', '--quiet', '--allow-empty', '-m', 'One'], work);
    await git(['push', '--quiet', 'origin', 'agent/readme'], work);
    await git(['commit', '--quiet', '--allow-empty', '-m', 'Two'], work);
    await git(['push', '--quiet', 'origin', 'agent/readme'], work);
    expect(await tipOf('refs/heads/agent/readme')).toBe(
      (await git(['rev-parse', 'HEAD'], work)).trim(),
    );
  });

  it('refuses a push to main and to a tag, in words git prints', async () => {
    const { launch } = await liveRun();
    const work = await cloneThrough(launch);
    const before = await tipOf('refs/heads/main');
    await git(['commit', '--quiet', '--allow-empty', '-m', 'Straight to main'], work);
    const main = await tryGit(['push', 'origin', 'main'], work);
    expect(main.ok).toBe(false);
    expect(main.said).toContain('agent/* branches only');
    await git(['tag', 'v1'], work);
    expect((await tryGit(['push', 'origin', 'v1'], work)).ok).toBe(false);
    expect(await tipOf('refs/heads/main')).toBe(before);
    expect(await tipOf('refs/tags/v1')).toBe('');
  });

  it('refuses push options, which GitLab would act on as the token user', async () => {
    const { launch } = await liveRun();
    const work = await cloneThrough(launch);
    // http-backend does not advertise push options; GitLab does, and git sends them then.
    await git(['config', 'receive.advertisePushOptions', 'true'], bare);
    const pushed = await tryGit(
      ['push', '-o', 'merge_request.create', 'origin', 'HEAD:refs/heads/agent/mr'],
      work,
    );
    expect(pushed.ok).toBe(false);
    expect(pushed.said).toContain('does not pass push options on');
    expect(await tipOf('refs/heads/agent/mr')).toBe('');
  });

  it('refuses push options however a push spells the capability, and a capability it does not know', async () => {
    const { launch } = await liveRun();
    await git(['config', 'receive.advertisePushOptions', 'true'], bare);
    const main = await tipOf('refs/heads/main');
    const basic = Buffer.from(`${launch.run.id}:${launch.workspace.git?.password ?? ''}`).toString(
      'base64',
    );
    // A push written by hand, as a run's own program may: a new branch at main's commit, the
    // push option after the commands, then a pack of nothing.
    const push = (capabilities: string) =>
      fetch(`${base}/git/acme/repo.git/git-receive-pack`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${basic}`,
          'content-type': 'application/x-git-receive-pack-request',
        },
        body: Buffer.concat([
          pkt(`${'0'.repeat(40)} ${main} refs/heads/agent/mr\0${capabilities}\n`),
          FLUSH,
          pkt('merge_request.create\n'),
          FLUSH,
          emptyPack(false),
        ]),
      }).then((response) => response.text());

    for (const capabilities of ['report-status push-options=1', 'report-status\tpush-options']) {
      expect(await push(capabilities)).toContain('does not pass push options on');
    }
    expect(await push('report-status no-such-capability=1')).toContain(
      'does not pass on a push that asks for no-such-capability',
    );
    expect(await tipOf('refs/heads/agent/mr')).toBe('');
  });

  it('refuses to delete a branch', async () => {
    const { launch } = await liveRun();
    const work = await cloneThrough(launch);
    await git(['push', '--quiet', 'origin', 'HEAD:refs/heads/agent/keep'], work);
    const deleted = await tryGit(['push', 'origin', '--delete', 'agent/keep'], work);
    expect(deleted.ok).toBe(false);
    expect(deleted.said).toContain('does not delete branches');
    expect(await tipOf('refs/heads/agent/keep')).not.toBe('');
  });

  it('puts a force-pushed branch back where it was', async () => {
    const { launch } = await liveRun();
    const work = await cloneThrough(launch);
    await git(['checkout', '--quiet', '-b', 'agent/work'], work);
    await git(['commit', '--quiet', '--allow-empty', '-m', 'Work'], work);
    await git(['push', '--quiet', 'origin', 'agent/work'], work);
    const kept = await tipOf('refs/heads/agent/work');
    await git(['reset', '--quiet', '--hard', 'HEAD~1'], work);
    await git(['commit', '--quiet', '--allow-empty', '-m', 'Other history'], work);
    const forced = await tryGit(['push', '--force', 'origin', 'agent/work'], work);
    expect(forced.ok).toBe(false);
    expect(forced.said).toContain('put the branch back');
    expect(await tipOf('refs/heads/agent/work')).toBe(kept);
  });

  it('puts a branch back that a push replaced with unrelated history', async () => {
    const { launch } = await liveRun();
    const work = await cloneThrough(launch);
    await git(['checkout', '--quiet', '-b', 'agent/work'], work);
    await git(['commit', '--quiet', '--allow-empty', '-m', 'Work'], work);
    await git(['push', '--quiet', 'origin', 'agent/work'], work);
    const kept = await tipOf('refs/heads/agent/work');
    // No merge base with the branch, which the host's ancestry check answers with a 404.
    await git(['checkout', '--quiet', '--orphan', 'other'], work);
    await git(['commit', '--quiet', '--allow-empty', '-m', 'Nothing in common'], work);
    const forced = await tryGit(['push', '--force', 'origin', 'other:agent/work'], work);
    expect(forced.ok).toBe(false);
    expect(forced.said).toContain('put the branch back');
    expect(await tipOf('refs/heads/agent/work')).toBe(kept);
  });

  it('puts back a branch rewritten by a push that asked the host for no report', async () => {
    const { launch } = await liveRun();
    const work = await cloneThrough(launch);
    await git(['checkout', '--quiet', '-b', 'agent/work'], work);
    await git(['commit', '--quiet', '--allow-empty', '-m', 'Work'], work);
    await git(['push', '--quiet', 'origin', 'agent/work'], work);
    const kept = await tipOf('refs/heads/agent/work');
    const main = await tipOf('refs/heads/main');
    const basic = Buffer.from(`${launch.run.id}:${launch.workspace.git?.password ?? ''}`).toString(
      'base64',
    );
    // Written by hand, as a run's own program may: the branch back to main's commit, with no
    // report-status among the capabilities, so the host answers with nothing.
    const pushed = await fetch(`${base}/git/acme/repo.git/git-receive-pack`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-git-receive-pack-request',
      },
      body: Buffer.concat([
        pkt(`${kept} ${main} refs/heads/agent/work\0agent=by-hand\n`),
        FLUSH,
        emptyPack(false),
      ]),
    });
    expect(await pushed.text()).toContain('put the branch back');
    expect(await tipOf('refs/heads/agent/work')).toBe(kept);
  });

  it('opens nothing for a wrong password, a finished run or another repository', async () => {
    const { launch, token } = await liveRun();
    const work = mkdtempSync(join(dir, 'work-'));
    const wrong = await tryGit(['clone', signedIn(launch, 'x'.repeat(43)), work], dir);
    expect(wrong.said).toMatch(/Authentication failed|401/);
    expect(seenByHost).toEqual([]);

    const proxy = `${base}/git/acme/other.git/info/refs?service=git-upload-pack`;
    const basic = Buffer.from(`${launch.run.id}:${launch.workspace.git?.password ?? ''}`).toString(
      'base64',
    );
    const other = await fetch(proxy, { headers: { authorization: `Basic ${basic}` } });
    expect(other.status).toBe(404);

    await finish(launch.run.id, token);
    const ended = await fetch(proxy.replace('other', 'repo'), {
      headers: { authorization: `Basic ${basic}` },
    });
    expect(ended.status).toBe(401);
    expect(ended.headers.get('www-authenticate')).toContain('Basic');
  });

  it('closes to a run its owner cancelled, while its seat has not stopped yet', async () => {
    const { launch } = await liveRun();
    const proxy = `${base}/git/acme/repo.git/info/refs?service=git-upload-pack`;
    const basic = Buffer.from(`${launch.run.id}:${launch.workspace.git?.password ?? ''}`).toString(
      'base64',
    );
    const headers = { authorization: `Basic ${basic}` };
    expect((await fetch(proxy, { headers })).status).toBe(200);
    expect((await asAdmin('POST', `/api/runs/${launch.run.id}/cancel`)).statusCode).toBe(200);
    expect((await fetch(proxy, { headers })).status).toBe(401);
  });

  it('speaks only the smart protocol', async () => {
    const { launch } = await liveRun();
    const basic = Buffer.from(`${launch.run.id}:${launch.workspace.git?.password ?? ''}`).toString(
      'base64',
    );
    const dumb = await fetch(`${base}/git/acme/repo.git/info/refs`, {
      headers: { authorization: `Basic ${basic}` },
    });
    expect(dumb.status).toBe(404);
    const object = await fetch(`${base}/git/acme/repo.git/HEAD`, {
      headers: { authorization: `Basic ${basic}` },
    });
    expect(object.status).toBe(404);
  });
});
