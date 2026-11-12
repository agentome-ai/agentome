import { describe, expect, it } from 'vitest';
import type { Docker } from './docker.js';
import { PassThrough } from 'node:stream';
import { dockerPlaces } from './docker-places.js';
import { handleOrder, type LauncherSettings, openTerminal, SHELL } from './launcher.js';
import { signOrder } from './protocol.js';

// The launcher against a Docker that writes down what it is asked and answers as Docker does.

const ID = '6f1c2a7e-0b5d-4e3a-9c8f-1a2b3c4d5e6f';

function fakeDocker() {
  const asked: { method: string; path: string; body?: unknown }[] = [];
  const containers = new Map<string, { running: boolean; body: unknown }>();
  const networks = new Map<string, Set<string>>();
  const volumes = new Set<string>();
  const labelsOf = (body: unknown) => (body as { Labels?: Record<string, string> }).Labels ?? {};
  const docker: Docker = async (method, path, body) => {
    asked.push({ method, path, ...(body !== undefined && { body }) });
    if (method === 'GET' && path.startsWith('/containers/json?all=true')) {
      const wanted = JSON.parse(decodeURIComponent(path.split('filters=')[1] ?? '{}')) as {
        label: string[];
      };
      const matches = (labels: Record<string, string>) =>
        wanted.label.every((label) => {
          const [key, value] = label.split('=');
          return key !== undefined && (value === undefined ? key in labels : labels[key] === value);
        });
      return {
        status: 200,
        body: [...containers]
          .filter(([, container]) => matches(labelsOf(container.body)))
          .map(([name, container]) => ({
            Names: [`/${name}`],
            Labels: labelsOf(container.body),
            State: container.running ? 'running' : 'exited',
          })),
      };
    }
    if (method === 'GET' && path.startsWith('/networks?')) {
      return { status: 200, body: [...networks.keys()].map((Name) => ({ Name })) };
    }
    const network = /^\/networks\/([^/?]+)(?:\/(connect|disconnect))?$/.exec(path);
    if (method === 'POST' && path === '/networks/create') {
      networks.set((body as { Name: string }).Name, new Set());
      return { status: 201, body: {} };
    }
    if (network?.[1]) {
      const members = networks.get(network[1]);
      if (!members) return { status: 404, body: { message: 'network not found' } };
      const container = (body as { Container?: string } | undefined)?.Container ?? '';
      if (network[2] === 'connect') {
        if (members.has(container))
          return { status: 403, body: { message: 'endpoint already exists' } };
        members.add(container);
      } else if (network[2] === 'disconnect') members.delete(container);
      else if (method === 'DELETE') networks.delete(network[1]);
      return { status: 200, body: {} };
    }
    if (method === 'GET' && path.startsWith('/volumes?')) {
      return { status: 200, body: { Volumes: [...volumes].map((Name) => ({ Name })) } };
    }
    const name = /\/containers\/([^/?]+)/.exec(path)?.[1];
    const made = /\/containers\/create\?name=(.+)$/.exec(path)?.[1];
    if (method === 'GET' && path.startsWith('/images/')) return { status: 200, body: {} };
    if (method === 'POST' && path === '/volumes/create') {
      volumes.add((body as { Name: string }).Name);
      return { status: 201, body: {} };
    }
    if (method === 'POST' && /^\/containers\/[^/]+\/exec$/.test(path)) {
      return { status: 201, body: { Id: 'e1' } };
    }
    if (method === 'POST' && path.startsWith('/exec/e1/resize'))
      return { status: 201, body: undefined };
    if (made) {
      containers.set(made, { running: false, body });
      return { status: 201, body: { Id: made } };
    }
    const found = name ? containers.get(name) : undefined;
    if (method === 'GET' && path.endsWith('/json')) {
      return found
        ? {
            status: 200,
            body: { State: { Running: found.running, StartedAt: '2026-11-12T10:00:00Z' } },
          }
        : { status: 404, body: { message: 'No such container' } };
    }
    if (method === 'POST' && path.endsWith('/start')) {
      if (!found) return { status: 404, body: {} };
      found.running = true;
      return { status: 204, body: undefined };
    }
    if (method === 'POST' && path.endsWith('/wait'))
      return { status: 200, body: { StatusCode: 0 } };
    if (method === 'POST' && path.includes('/stop')) {
      if (!found) return { status: 404, body: {} };
      found.running = false;
      return { status: 204, body: undefined };
    }
    if (method === 'DELETE' && name) {
      return containers.delete(name) ? { status: 204, body: undefined } : { status: 404, body: {} };
    }
    if (method === 'DELETE' && path.startsWith('/volumes/')) {
      volumes.delete(path.slice('/volumes/'.length));
      return { status: 204, body: undefined };
    }
    return { status: 500, body: { message: `unexpected ${method} ${path}` } };
  };
  return { docker, asked, containers, networks, volumes };
}

const settingsWith = (
  docker: Docker,
  attach: () => Promise<PassThrough> = async () => {
    throw new Error('no terminal here');
  },
): LauncherSettings => ({
  key: 'the shared key',
  places: dockerPlaces({
    docker,
    image: 'docker.io/agentome/agentome-seat:0.1.0',
    network: 'agentome-places',
    serverUrl: 'http://app:3000',
    egress: { proxy: 'place-egress:3128', tokenOf: (id) => `token-of-${id}` },
    attach,
  }),
});

function order(settings: LauncherSettings, method: string, path: string, body?: unknown) {
  const text = body === undefined ? '' : JSON.stringify(body);
  const time = String(Date.now());
  return handleOrder(settings, {
    method,
    path,
    time,
    signature: signOrder(settings.key, method, path, time, text),
    body: text,
  });
}

describe('the place launcher', () => {
  it('takes no order that is not signed with the key, nor an old one, nor for a name that is not an id', async () => {
    const { docker, asked } = fakeDocker();
    const settings = settingsWith(docker);
    const time = String(Date.now());
    const forged = await handleOrder(settings, {
      method: 'GET',
      path: `/places/${ID}`,
      time,
      signature: signOrder('another key', 'GET', `/places/${ID}`, time, ''),
      body: '',
    });
    expect(forged.status).toBe(401);
    const old = String(Date.now() - 5 * 60_000);
    const stale = await handleOrder(settings, {
      method: 'GET',
      path: `/places/${ID}`,
      time: old,
      signature: signOrder(settings.key, 'GET', `/places/${ID}`, old, ''),
      body: '',
    });
    expect(stale.status).toBe(401);
    expect((await order(settings, 'GET', '/places/..%2Fetc')).status).toBe(404);
    expect((await order(settings, 'POST', `/places/${ID}/exec`)).status).toBe(404);
    expect(asked).toEqual([]);
  });

  it('makes a place with its own settings only: pairs it, then starts it, with two volumes', async () => {
    const { docker, asked, containers } = fakeDocker();
    const settings = settingsWith(docker);
    expect((await order(settings, 'GET', `/places/${ID}`)).body).toEqual({ state: 'none' });
    const made = await order(settings, 'POST', `/places/${ID}`, { code: 'K7QX-M2PH' });
    expect(made).toEqual({ status: 201, body: { state: 'awake' } });

    const created = asked.filter((call) => call.path.startsWith('/containers/create'));
    expect(created.map((call) => call.path)).toEqual([
      `/containers/create?name=agentome-place-${ID}-connect`,
      `/containers/create?name=agentome-place-${ID}`,
    ]);
    const [pairing, place] = created.map((call) => call.body) as {
      Cmd: string[];
      Image: string;
      Env: string[];
      User: string;
      HostConfig: Record<string, unknown>;
    }[];
    expect(pairing?.Cmd).toEqual(['connect', 'K7QX-M2PH', '--server', 'http://app:3000']);
    expect(place?.Cmd).toEqual(['run']);
    expect(place?.Image).toBe('docker.io/agentome/agentome-seat:0.1.0');
    // Every call out goes through the egress proxy under the place's token; the app is direct.
    const proxy = `http://${ID}:token-of-${ID}@place-egress:3128`;
    expect(place?.Env).toEqual([
      'AGENTOME_WORKER_SERVER=',
      'AGENTOME_WORKER_PLACE=1',
      'AGENTOME_PLACE_EGRESS=place-egress:3128',
      `HTTPS_PROXY=${proxy}`,
      `HTTP_PROXY=${proxy}`,
      `https_proxy=${proxy}`,
      `http_proxy=${proxy}`,
      'NO_PROXY=app,localhost,127.0.0.1',
      'no_proxy=app,localhost,127.0.0.1',
      'NODE_USE_ENV_PROXY=1',
    ]);
    expect(place?.User).toBe('1000:1000');
    expect(place?.HostConfig).toMatchObject({
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      ReadonlyRootfs: true,
      NetworkMode: 'agentome-places',
      PidsLimit: 1024,
      Mounts: [
        { Type: 'volume', Source: `agentome-place-${ID}-home`, Target: '/home/node' },
        { Type: 'volume', Source: `agentome-place-${ID}-seat`, Target: '/seat' },
      ],
    });
    expect(place?.HostConfig).not.toHaveProperty('Privileged');
    expect(place?.HostConfig).not.toHaveProperty('Binds');
    // The pairing container is gone; the place is up.
    expect([...containers.keys()]).toEqual([`agentome-place-${ID}`]);
    expect((await order(settings, 'GET', `/places/${ID}`)).body).toMatchObject({ state: 'awake' });
    // One place a person.
    expect((await order(settings, 'POST', `/places/${ID}`, { code: 'K7QX-M2PH' })).status).toBe(
      409,
    );
  });

  it('refuses a create with anything but a pairing code', async () => {
    const { docker, asked } = fakeDocker();
    const settings = settingsWith(docker);
    const odd = await order(settings, 'POST', `/places/${ID}`, { code: '$(reboot)' });
    expect(odd.status).toBe(400);
    expect(asked).toEqual([]);
  });

  it('puts a place to sleep and wakes it, keeping its volumes, and deletes it with them', async () => {
    const { docker, asked } = fakeDocker();
    const settings = settingsWith(docker);
    await order(settings, 'POST', `/places/${ID}`, { code: 'K7QX-M2PH' });
    expect((await order(settings, 'POST', `/places/${ID}/sleep`)).body).toEqual({
      state: 'asleep',
    });
    expect((await order(settings, 'GET', `/places/${ID}`)).body).toEqual({ state: 'asleep' });
    expect((await order(settings, 'POST', `/places/${ID}/wake`)).body).toEqual({ state: 'awake' });
    expect(
      asked.some((call) => call.method === 'DELETE' && call.path.startsWith('/volumes/')),
    ).toBe(false);

    expect((await order(settings, 'DELETE', `/places/${ID}`)).status).toBe(204);
    const removed = asked.filter((call) => call.method === 'DELETE').map((call) => call.path);
    expect(removed).toEqual(
      expect.arrayContaining([
        `/containers/agentome-place-${ID}?force=true`,
        `/volumes/agentome-place-${ID}-home`,
        `/volumes/agentome-place-${ID}-seat`,
      ]),
    );
    expect((await order(settings, 'GET', `/places/${ID}`)).body).toEqual({ state: 'none' });
  });

  it('opens a terminal as the place’s user, with its CLI on the path, keeps the place awake while it is open, and resizes it', async () => {
    const { docker, asked } = fakeDocker();
    const shell = new PassThrough();
    const settings = settingsWith(docker, async () => shell);
    await order(settings, 'POST', `/places/${ID}`, { code: 'K7QX-M2PH' });
    await order(settings, 'POST', `/places/${ID}/sleep`);

    const { done } = await openTerminal(settings, ID);
    // Opening woke it, and the shell is a login shell of the place's own user.
    expect((await order(settings, 'GET', `/places/${ID}`)).body).toMatchObject({
      state: 'awake',
      terminals: 1,
    });
    expect(asked.find((call) => call.path.endsWith('/exec'))?.body).toMatchObject({
      Tty: true,
      User: '1000:1000',
      Cmd: SHELL,
    });
    expect(
      (await order(settings, 'POST', `/places/${ID}/resize`, { cols: 120, rows: 40 })).status,
    ).toBe(204);
    expect(asked.map((call) => call.path)).toContain('/exec/e1/resize?h=40&w=120');
    expect(
      (await order(settings, 'POST', `/places/${ID}/resize`, { cols: 0, rows: 'x' })).status,
    ).toBe(400);

    done();
    expect((await order(settings, 'GET', `/places/${ID}`)).body).toMatchObject({ terminals: 0 });
  });

  it("empties an agent's folders in a container of the place's kind, and nothing else", async () => {
    const { docker, asked } = fakeDocker();
    const settings = settingsWith(docker);
    await order(settings, 'POST', `/places/${ID}`, { code: 'K7QX-M2PH' });
    const agent = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
    expect((await order(settings, 'DELETE', `/places/${ID}/folders/${agent}`)).status).toBe(204);
    const made = asked.find(
      (call) => call.path === `/containers/create?name=agentome-place-${ID}-fresh`,
    );
    expect(made?.body).toMatchObject({
      Entrypoint: ['rm', '-rf', `/seat/folders/${agent}`],
      User: '1000:1000',
      HostConfig: { CapDrop: ['ALL'], NetworkMode: 'agentome-places' },
    });
    expect((await order(settings, 'DELETE', `/places/${ID}/folders/..`)).status).toBe(404);
  });

  it("runs a project's services on a network of their own, and stops another project's", async () => {
    const { docker, containers, networks, volumes } = fakeDocker();
    const settings = settingsWith(docker);
    await order(settings, 'POST', `/places/${ID}`, { code: 'K7QX-M2PH' });
    const SHOP = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
    const BLOG = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e';
    const net = (project: string) =>
      `agentome-place-${ID}-${project.replaceAll('-', '').slice(0, 12)}`;
    const shop = {
      project: SHOP,
      hash: 'a'.repeat(64),
      services: [
        {
          name: 'db',
          image: 'postgres:16',
          environment: { POSTGRES_PASSWORD: 'dev' },
          volumes: [{ name: 'pgdata', target: '/var/lib/postgresql/data' }],
        },
      ],
    };
    expect((await order(settings, 'PUT', `/places/${ID}/services`, shop)).status).toBe(204);
    const db = containers.get(`${net(SHOP)}-db`);
    expect(db?.running).toBe(true);
    expect(db?.body).toMatchObject({
      Image: 'postgres:16',
      Env: ['POSTGRES_PASSWORD=dev'],
      HostConfig: {
        NetworkMode: net(SHOP),
        SecurityOpt: ['no-new-privileges:true'],
        Mounts: [
          { Type: 'volume', Source: `${net(SHOP)}-pgdata`, Target: '/var/lib/postgresql/data' },
        ],
      },
      NetworkingConfig: { EndpointsConfig: { [net(SHOP)]: { Aliases: ['db'] } } },
    });
    expect(db?.body).not.toHaveProperty('HostConfig.Privileged');
    expect(db?.body).not.toHaveProperty('HostConfig.Binds');
    // The network is internal, and the place is on it.
    expect([...(networks.get(net(SHOP)) ?? [])]).toEqual([`agentome-place-${ID}`]);
    // Again for the same list: nothing made anew.
    expect((await order(settings, 'PUT', `/places/${ID}/services`, shop)).status).toBe(204);

    const blog = {
      project: BLOG,
      hash: 'b'.repeat(64),
      services: [{ name: 'db', image: 'mysql:8', environment: {}, volumes: [] }],
    };
    await order(settings, 'PUT', `/places/${ID}/services`, blog);
    // Both have a `db`: the place sees only the blog's now, and the shop's is stopped, kept.
    expect(containers.get(`${net(SHOP)}-db`)?.running).toBe(false);
    expect(containers.get(`${net(BLOG)}-db`)?.running).toBe(true);
    expect([...(networks.get(net(SHOP)) ?? [])]).toEqual([]);
    expect([...(networks.get(net(BLOG)) ?? [])]).toEqual([`agentome-place-${ID}`]);

    // Asleep, the services stop; deleted, they go with their networks and volumes.
    await order(settings, 'POST', `/places/${ID}/sleep`);
    expect(containers.get(`${net(BLOG)}-db`)?.running).toBe(false);
    expect((await order(settings, 'DELETE', `/places/${ID}`)).status).toBe(204);
    expect([...containers.keys()]).toEqual([]);
    expect([...networks.keys()]).toEqual([]);
    expect([...volumes]).toEqual([]);
  });
});
