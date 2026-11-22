import { describe, expect, it } from 'vitest';
import type { Docker } from './docker.js';
import { PassThrough } from 'node:stream';
import { callAllowed } from './docker-guard.js';
import { dockerPlaces, pullOf } from './docker-places.js';
import { handleOrder, type LauncherSettings, openTerminal } from './launcher.js';
import { newNonce, signOrder } from './protocol.js';

// The launcher against a Docker that writes down what it is asked and answers as Docker does.

const ID = '6f1c2a7e-0b5d-4e3a-9c8f-1a2b3c4d5e6f';

function fakeDocker() {
  const asked: { method: string; path: string; body?: unknown }[] = [];
  const containers = new Map<string, { running: boolean; body: unknown }>();
  const networks = new Map<string, Set<string>>();
  const volumes = new Map<string, Record<string, string>>();
  // What a one-off container (the pairing) exits with.
  const exits = { code: 0 };
  const labelsOf = (body: unknown) => (body as { Labels?: Record<string, string> }).Labels ?? {};
  const docker: Docker = async (method, path, body) => {
    asked.push({ method, path, ...(body !== undefined && { body }) });
    // Every call a launcher makes passes the docker guard, which stands before the real socket.
    const passes = callAllowed(method, path, body as Record<string, unknown> | undefined, {
      runtimes: ['runsc', 'runsc-docker'],
      sandboxRuntime: 'runsc-docker',
      peers: ['app', 'place-egress'],
    });
    if (!passes.ok)
      throw new Error(`the docker guard would refuse ${method} ${path}: ${passes.why}`);
    if (method === 'GET' && path === '/info') {
      return {
        status: 200,
        body: {
          Runtimes: {
            runc: { path: 'runc' },
            runsc: { path: '/usr/local/bin/runsc' },
            'runsc-docker': { path: '/usr/local/bin/runsc' },
            // A name that sounds right, run by runc.
            gvisor: { path: '/usr/bin/runc' },
          },
        },
      };
    }
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
      } else if (network[2] === 'disconnect') members.delete(container.replace(/^id-/, ''));
      else if (method === 'DELETE') {
        // As Docker: not a network anyone is still on.
        if (members.size > 0)
          return {
            status: 403,
            body: { message: 'error while removing network: has active endpoints' },
          };
        networks.delete(network[1]);
        return { status: 204, body: undefined };
      }
      // Who is on it, and at which address, as Docker says it; with the containers whose own
      // network it is.
      const on = [
        ...members,
        ...[...containers]
          .filter(
            ([, c]) =>
              (c.body as { HostConfig?: { NetworkMode?: string } }).HostConfig?.NetworkMode ===
              network[1],
          )
          .map(([n]) => n),
      ];
      const Containers = Object.fromEntries(
        [...new Set(on)].map((n, i) => [
          `id-${n}`,
          { Name: n, IPv4Address: `10.9.0.${String(i + 2)}/24` },
        ]),
      );
      return { status: 200, body: { Containers } };
    }
    if (method === 'GET' && path.startsWith('/volumes?')) {
      // By their labels, as Docker filters them.
      const wanted = path.includes('filters=')
        ? (JSON.parse(decodeURIComponent(path.split('filters=')[1] ?? '{}')) as { label: string[] })
            .label
        : [];
      const matches = (labels: Record<string, string>) =>
        wanted.every((label) => {
          const [key, value] = label.split('=');
          return key !== undefined && (value === undefined ? key in labels : labels[key] === value);
        });
      return {
        status: 200,
        body: {
          Volumes: [...volumes].filter(([, labels]) => matches(labels)).map(([Name]) => ({ Name })),
        },
      };
    }
    // Each volume holds a megabyte, by Docker's accounting.
    if (method === 'GET' && path === '/system/df?type=volume') {
      return {
        status: 200,
        body: {
          Volumes: [...volumes].map(([Name, Labels]) => ({
            Name,
            Labels,
            UsageData: { Size: 1024 ** 2 },
          })),
        },
      };
    }
    const name = /\/containers\/([^/?]+)/.exec(path)?.[1];
    const made = /\/containers\/create\?name=(.+)$/.exec(path)?.[1];
    if (method === 'GET' && path.startsWith('/images/')) return { status: 200, body: {} };
    if (method === 'POST' && path === '/volumes/create') {
      volumes.set((body as { Name: string }).Name, labelsOf(body));
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
            body: {
              State: { Running: found.running, StartedAt: '2026-11-12T10:00:00Z' },
              HostConfig: (found.body as { HostConfig?: unknown }).HostConfig,
            },
          }
        : { status: 404, body: { message: 'No such container' } };
    }
    if (method === 'POST' && path.endsWith('/start')) {
      if (!found) return { status: 404, body: {} };
      found.running = true;
      return { status: 204, body: undefined };
    }
    if (method === 'POST' && path.endsWith('/wait'))
      return { status: 200, body: { StatusCode: exits.code } };
    if (method === 'POST' && path.includes('/stop')) {
      if (!found) return { status: 404, body: {} };
      found.running = false;
      return { status: 204, body: undefined };
    }
    if (method === 'DELETE' && name) {
      // A container that goes leaves its networks, as with Docker.
      for (const members of networks.values()) members.delete(name);
      return containers.delete(name) ? { status: 204, body: undefined } : { status: 404, body: {} };
    }
    if (method === 'DELETE' && path.startsWith('/volumes/')) {
      volumes.delete(path.slice('/volumes/'.length).split('?')[0] ?? '');
      return { status: 204, body: undefined };
    }
    return { status: 500, body: { message: `unexpected ${method} ${path}` } };
  };
  return { docker, asked, containers, networks, volumes, exits };
}

const settingsWith = (
  docker: Docker,
  attach: () => Promise<PassThrough> = async () => {
    throw new Error('no terminal here');
  },
  // The host's kernel, asked for by name, unless a test gives gVisor or nothing.
  runtime: string | null = 'runc',
  dockerRuntime?: string,
): LauncherSettings => ({
  key: 'the shared key',
  places: dockerPlaces({
    docker,
    image: 'docker.io/agentome/agentome-seat:0.1.0',
    ...(runtime !== null && { runtime }),
    ...(dockerRuntime && { dockerRuntime }),
    peers: async () => [
      { container: 'the-app', alias: 'app' },
      { container: 'the-egress-proxy', alias: 'place-egress' },
    ],
    serverUrl: 'http://agentome.internal:3000',
    egress: {
      proxy: 'place-egress:3128',
      tokenOf: (id) => `token-of-${id}`,
      dockerTokenOf: (runId) => `docker-token-of-${runId}`,
    },
    attach,
  }),
});

function order(settings: LauncherSettings, method: string, path: string, body?: unknown) {
  const text = body === undefined ? '' : JSON.stringify(body);
  const time = String(Date.now());
  const nonce = newNonce();
  return handleOrder(settings, {
    method,
    path,
    time,
    nonce,
    signature: signOrder(settings.key, method, path, time, nonce, text),
    body: text,
  });
}

describe('the place launcher', () => {
  it('takes no order that is not signed with the key, nor an old one, nor for a name that is not an id', async () => {
    const { docker, asked } = fakeDocker();
    const settings = settingsWith(docker);
    const time = String(Date.now());
    const nonce = newNonce();
    const forged = await handleOrder(settings, {
      method: 'GET',
      path: `/places/${ID}`,
      time,
      nonce,
      signature: signOrder('another key', 'GET', `/places/${ID}`, time, nonce, ''),
      body: '',
    });
    expect(forged.status).toBe(401);
    const old = String(Date.now() - 5 * 60_000);
    const stale = await handleOrder(settings, {
      method: 'GET',
      path: `/places/${ID}`,
      time: old,
      nonce,
      signature: signOrder(settings.key, 'GET', `/places/${ID}`, old, nonce, ''),
      body: '',
    });
    expect(stale.status).toBe(401);
    expect((await order(settings, 'GET', '/places/..%2Fetc')).status).toBe(404);
    expect((await order(settings, 'POST', `/places/${ID}/exec`)).status).toBe(404);
    expect(asked).toEqual([]);
    // An order taken once is not taken again, though its signature and minute are good.
    const once = {
      method: 'GET',
      path: `/places/${ID}`,
      time,
      nonce,
      signature: signOrder(settings.key, 'GET', `/places/${ID}`, time, nonce, ''),
      body: '',
    };
    expect((await handleOrder(settings, once)).status).toBe(200);
    const asks = asked.length;
    expect((await handleOrder(settings, once)).status).toBe(401);
    // Nor one without a number.
    expect(
      (
        await handleOrder(settings, {
          ...once,
          nonce: undefined,
          signature: signOrder(settings.key, 'GET', `/places/${ID}`, time, '', ''),
        })
      ).status,
    ).toBe(401);
    expect((await order(settings, 'GET', '/places/..%2Fetc')).status).toBe(404);
    expect((await order(settings, 'POST', `/places/${ID}/exec`)).status).toBe(404);
    expect(asked.length).toBe(asks);
  });

  it('makes a place with its own settings only: pairs it, then starts it, with two volumes', async () => {
    const { docker, asked, containers, networks } = fakeDocker();
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
    expect(pairing?.Cmd).toEqual([
      'connect',
      'K7QX-M2PH',
      '--server',
      'http://agentome.internal:3000',
    ]);
    expect(place?.Cmd).toEqual(['run']);
    expect(place?.Image).toBe('docker.io/agentome/agentome-seat:0.1.0');
    // Every call out goes through the egress proxy under the place's token; the app is direct.
    const proxy = `http://${ID}:token-of-${ID}@place-egress:3128`;
    expect(place?.Env).toEqual([
      'AGENTOME_WORKER_SERVER=',
      'AGENTOME_WORKER_PLACE=1',
      'AGENTOME_PLACE_EGRESS=place-egress:3128',
      'AGENTOME_PLACE_SERVER=http://agentome.internal:3000',
      `HTTPS_PROXY=${proxy}`,
      `HTTP_PROXY=${proxy}`,
      `https_proxy=${proxy}`,
      `http_proxy=${proxy}`,
      // Never a bare `app`: curl and Codex would take every host in `.app` around the proxy.
      'NO_PROXY=agentome.internal,localhost,127.0.0.1',
      'no_proxy=agentome.internal,localhost,127.0.0.1',
      'NODE_USE_ENV_PROXY=1',
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
      'DISABLE_AUTOUPDATER=1',
      'CLAUDE_CONFIG_DIR=/home/node/.claude',
    ]);
    expect(place?.User).toBe('1000:1000');
    expect(place?.HostConfig).toMatchObject({
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      ReadonlyRootfs: true,
      NetworkMode: `agentome-place-${ID}`,
      // No resolver out: a name looked up cannot carry data past the proxy.
      Dns: ['127.0.0.1'],
      PidsLimit: 1024,
      Mounts: [
        { Type: 'volume', Source: `agentome-place-${ID}-home`, Target: '/home/node' },
        { Type: 'volume', Source: `agentome-place-${ID}-seat`, Target: '/seat' },
      ],
    });
    expect(place?.HostConfig).not.toHaveProperty('Privileged');
    expect(place?.HostConfig).not.toHaveProperty('Binds');
    // The place has a network of its own, with the app and the egress proxy on it, by their names:
    // another place is not on it.
    expect([...(networks.get(`agentome-place-${ID}`) ?? [])]).toEqual([
      'the-app',
      'the-egress-proxy',
    ]);
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
    const { docker, asked, networks } = fakeDocker();
    const settings = settingsWith(docker);
    await order(settings, 'POST', `/places/${ID}`, { code: 'K7QX-M2PH' });
    expect((await order(settings, 'POST', `/places/${ID}/sleep`)).body).toEqual({
      state: 'asleep',
    });
    // Its two volumes, a megabyte each by Docker's accounting: what the app holds to its limit.
    expect((await order(settings, 'GET', `/places/${ID}`)).body).toEqual({
      state: 'asleep',
      diskBytes: 2 * 1024 ** 2,
    });
    const before = asked.length;
    expect((await order(settings, 'POST', `/places/${ID}/wake`)).body).toEqual({ state: 'awake' });
    // Asleep, it is made anew on waking, from this release's image and settings.
    expect(asked.slice(before).map((call) => `${call.method} ${call.path}`)).toEqual(
      expect.arrayContaining([
        `DELETE /containers/agentome-place-${ID}?force=true`,
        `POST /containers/create?name=agentome-place-${ID}`,
        `POST /containers/agentome-place-${ID}/start`,
      ]),
    );
    // Awake, waking again leaves it as it is.
    const awake = asked.length;
    await order(settings, 'POST', `/places/${ID}/wake`);
    expect(asked.slice(awake).some((call) => call.path.includes('/create'))).toBe(false);
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
    // Its network goes too, the app and the proxy taken off it first.
    expect([...networks.keys()].filter((name) => name.includes(ID))).toEqual([]);
    expect((await order(settings, 'GET', `/places/${ID}`)).body).toEqual({ state: 'none' });
  });

  it('leaves nothing of a new place whose pairing failed, and keeps the volumes of one made again', async () => {
    const { docker, networks, volumes, exits } = fakeDocker();
    const settings = settingsWith(docker);
    exits.code = 1;
    expect((await order(settings, 'POST', `/places/${ID}`, { code: 'K7QX-M2PH' })).status).toBe(
      502,
    );
    expect([...volumes.keys()].filter((name) => name.includes(ID))).toEqual([]);
    expect([...networks.keys()].filter((name) => name.includes(ID))).toEqual([]);
    // A place whose container went: its sign-in stays, whatever the new pairing does.
    exits.code = 0;
    expect((await order(settings, 'POST', `/places/${ID}`, { code: 'K7QX-M2PH' })).status).toBe(
      201,
    );
    await docker('DELETE', `/containers/agentome-place-${ID}?force=true`);
    exits.code = 1;
    expect((await order(settings, 'POST', `/places/${ID}`, { code: 'K7QX-M2PH' })).status).toBe(
      502,
    );
    expect(volumes.has(`agentome-place-${ID}-home`)).toBe(true);
  });

  it('makes an awake place anew when the app came back at another address', async () => {
    const { docker, asked, containers, networks } = fakeDocker();
    const settings = settingsWith(docker);
    await order(settings, 'POST', `/places/${ID}`, { code: 'K7QX-M2PH' });
    const hostsOf = () =>
      (containers.get(`agentome-place-${ID}`)?.body as { HostConfig: { ExtraHosts: string[] } })
        .HostConfig.ExtraHosts;
    const first = hostsOf();
    // Nothing changed: the place is left as it is.
    const steady = asked.length;
    expect((await order(settings, 'GET', `/places/${ID}`)).body).toMatchObject({ state: 'awake' });
    expect(asked.slice(steady).some((call) => call.path.includes('/create'))).toBe(false);

    // The app made anew leaves the place's network, as Docker does; the launcher joins it again,
    // and it is given the address the proxy had.
    networks.get(`agentome-place-${ID}`)?.delete('the-app');
    const before = asked.length;
    expect((await order(settings, 'GET', `/places/${ID}`)).body).toMatchObject({ state: 'awake' });
    expect(asked.slice(before).map((call) => `${call.method} ${call.path}`)).toEqual(
      expect.arrayContaining([
        `POST /containers/agentome-place-${ID}/stop?t=10`,
        `POST /containers/create?name=agentome-place-${ID}`,
        `POST /containers/agentome-place-${ID}/start`,
      ]),
    );
    expect(hostsOf()).not.toEqual(first);
    expect(hostsOf()).toEqual(expect.arrayContaining(['place-egress:10.9.0.2', 'app:10.9.0.3']));
  });

  it('opens a terminal as the place’s user, with its CLI on the path, keeps the place awake while it is open, and resizes it', async () => {
    const { docker, asked } = fakeDocker();
    const shell = new PassThrough();
    const settings = settingsWith(docker, async () => shell);
    await order(settings, 'POST', `/places/${ID}`, { code: 'K7QX-M2PH' });
    await order(settings, 'POST', `/places/${ID}/sleep`);

    const { done } = await openTerminal(settings, ID);
    // Opening woke it, and the shell is the place's own user's, reading nothing of the home.
    expect((await order(settings, 'GET', `/places/${ID}`)).body).toMatchObject({
      state: 'awake',
      terminals: 1,
    });
    const cmd = (asked.find((call) => call.path.endsWith('/exec'))?.body as { Cmd: string[] }).Cmd;
    expect(asked.find((call) => call.path.endsWith('/exec'))?.body).toMatchObject({
      Tty: true,
      User: '1000:1000',
    });
    expect(cmd.slice(0, 2)).toEqual(['env', '-i']);
    expect(cmd.slice(-4)).toEqual(['bash', '--noprofile', '--norc', '-i']);
    // The image's folders first: what a run wrote in the volume cannot stand in for `ls`.
    expect(cmd).toContain('PATH=/usr/local/bin:/usr/bin:/bin:/seat/cli/node_modules/.bin');
    // The proxy as the place's worker has it, so signing in reaches the vendor.
    expect(cmd).toContain(`HTTPS_PROXY=http://${ID}:token-of-${ID}@place-egress:3128`);
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
      HostConfig: { CapDrop: ['ALL'], NetworkMode: `agentome-place-${ID}` },
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
        CapDrop: ['NET_RAW', 'MKNOD', 'SETFCAP', 'AUDIT_WRITE', 'SYS_CHROOT'],
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

describe("a place's run", () => {
  it('runs in a CLI container and sandbox of its own, each with only its folders, and goes with what ran', async () => {
    const { docker, containers, networks } = fakeDocker();
    const settings = settingsWith(docker);
    await order(settings, 'POST', `/places/${ID}`, { code: 'K7QX-M2PH' });
    const SHOP = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
    const RUN = '9e8d7c6b-5a49-4382-a1b0-c9d8e7f6a5b4';
    const folder = `folders/${SHOP}/0123456789abcdef`;
    const shape = {
      project: SHOP,
      hash: 'a'.repeat(64),
      services: [{ name: 'db', image: 'postgres:16', environment: {}, volumes: [] }],
    };
    await order(settings, 'PUT', `/places/${ID}/services`, shape);

    const started = await order(settings, 'PUT', `/places/${ID}/runs/${RUN}`, { folder, shape });
    expect(started.status).toBe(200);
    const at = started.body as Record<
      'cli' | 'sandbox',
      { host: string; port: number; key: string }
    >;
    expect([at.cli.port, at.sandbox.port]).toEqual([7419, 7420]);
    expect(at.cli.key).not.toBe(at.sandbox.key);
    expect(at.cli.host).toMatch(/^10\.9\.0\.\d+$/);
    type Body = {
      Cmd: string[];
      Env: string[];
      User: string;
      HostConfig: {
        CapDrop: string[];
        ReadonlyRootfs: boolean;
        Tmpfs: Record<string, string>;
        Mounts: {
          Source: string;
          Target: string;
          ReadOnly?: boolean;
          VolumeOptions?: { Subpath: string };
        }[];
        NetworkMode: string;
        ExtraHosts: string[];
        Dns: string[];
      };
    };
    const cli = containers.get(`agentome-run-${RUN}`);
    const sandbox = containers.get(`agentome-run-${RUN}-sandbox`);
    expect([cli?.running, sandbox?.running]).toEqual([true, true]);
    const seat = `agentome-place-${ID}-seat`;
    const home = `agentome-place-${ID}-home`;
    const mounts = (body: Body) =>
      body.HostConfig.Mounts.map((mount) => [
        mount.Source,
        mount.VolumeOptions?.Subpath,
        mount.Target,
        mount.ReadOnly === true,
      ]);
    for (const [role, container] of [
      ['cli', cli],
      ['sandbox', sandbox],
    ] as const) {
      const body = container?.body as Body;
      expect(body.Cmd).toEqual(['run-server', RUN]);
      expect(body.User).toBe('1000:1000');
      expect(body.HostConfig).toMatchObject({
        CapDrop: ['ALL'],
        ReadonlyRootfs: true,
        NetworkMode: `agentome-place-${ID}`,
        Dns: ['127.0.0.1'],
      });
      // The rest of the home is its own memory: what a run leaves there goes with it.
      // The CLI container alone has its mark, read-only, which its bash and git look for.
      expect(body.HostConfig.Tmpfs).toEqual({
        '/tmp': expect.any(String),
        '/home/node': expect.any(String),
        ...(role === 'cli' && { '/run/agentome-cli': 'ro,size=4k,mode=0555' }),
      });
      // Each its own key, and never the place's egress token.
      expect(body.Env).toContain(`AGENTOME_RUN_KEY=${at[role].key}`);
      expect(body.Env.some((pair) => pair.includes(`token-of-${ID}`))).toBe(false);
      // The app and the proxy from /etc/hosts: under gVisor Docker's resolver does not answer.
      // The place too, which each knocks on as it starts.
      expect(body.HostConfig.ExtraHosts.map((host) => host.split(':')[0])).toEqual(
        role === 'cli'
          ? ['app', 'agentome.internal', 'place-egress', 'place']
          : ['app', 'agentome.internal', 'place-egress', 'place', 'db'],
      );
    }
    expect(mounts(cli?.body as Body)).toEqual([
      [seat, `runs/${RUN}`, `/seat/runs/${RUN}`, false],
      [seat, folder, `/seat/${folder}`, false],
      [seat, 'cli', '/seat/cli', true],
      [home, '.claude', '/home/node/.claude', false],
      [home, '.codex', '/home/node/.codex', false],
    ]);
    // The sandbox: no CLI, no sign-in; of the run's folder the git proxy's password and the
    // profile to read, and the working folder of a run without its agent's; not the gateway's
    // config, with the tokens.
    expect(mounts(sandbox?.body as Body)).toEqual([
      [seat, `runs/${RUN}/git`, `/seat/runs/${RUN}/git`, true],
      [seat, `runs/${RUN}/profile`, `/seat/runs/${RUN}/profile`, true],
      [seat, `runs/${RUN}/repo`, `/seat/runs/${RUN}/repo`, false],
      [seat, folder, `/seat/${folder}`, false],
    ]);
    // The project's services by their names: the sandbox only.
    const net = `agentome-place-${ID}-${SHOP.replaceAll('-', '').slice(0, 12)}`;
    expect(networks.get(net)?.has(`agentome-run-${RUN}-sandbox`)).toBe(true);
    expect(networks.get(net)?.has(`agentome-run-${RUN}`)).toBe(false);

    // Out of shape, or not under folders/<agent>: refused.
    for (const odd of ['../config.json', 'cli', `folders/${SHOP}/x/..`]) {
      expect(
        (await order(settings, 'PUT', `/places/${ID}/runs/${RUN}`, { folder: odd })).status,
      ).toBe(400);
    }
    expect((await order(settings, 'DELETE', `/places/${ID}/runs/${RUN}`)).status).toBe(204);
    expect(containers.has(`agentome-run-${RUN}`)).toBe(false);
    expect(containers.has(`agentome-run-${RUN}-sandbox`)).toBe(false);
    // Gone already: nothing to do.
    expect((await order(settings, 'DELETE', `/places/${ID}/runs/${RUN}`)).status).toBe(204);
    // Asleep, the place leaves no run behind.
    await order(settings, 'PUT', `/places/${ID}/runs/${RUN}`, { folder });
    await order(settings, 'POST', `/places/${ID}/sleep`);
    expect(containers.has(`agentome-run-${RUN}`)).toBe(false);
    expect(containers.has(`agentome-run-${RUN}-sandbox`)).toBe(false);
  });

  it('gives a run a Docker of its own under gVisor, which its sandbox reaches, and which goes with it', async () => {
    const { docker, containers, volumes, networks } = fakeDocker();
    const settings = settingsWith(docker, undefined, undefined, 'runsc-docker');
    await order(settings, 'POST', `/places/${ID}`, { code: 'K7QX-M2PH' });
    const SHOP = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
    const RUN = '9e8d7c6b-5a49-4382-a1b0-c9d8e7f6a5b4';
    const folder = `folders/${SHOP}/0123456789abcdef`;
    const started = await order(settings, 'PUT', `/places/${ID}/runs/${RUN}`, { folder });
    expect((started.body as { docker?: boolean }).docker).toBe(true);
    const own = containers.get(`agentome-run-${RUN}-docker`)?.body as {
      Image: string;
      Env: string[];
      HostConfig: {
        Runtime: string;
        CapAdd: string[];
        Mounts: { Source: string; Target: string }[];
        NetworkMode: string;
      };
    };
    expect(own.Image).toMatch(/^docker\.io\/library\/docker:[\d.]+-dind$/);
    // Not on the place's network, where the place's worker talks to the app: a network of the
    // run's, with its sandbox and the egress proxy alone.
    const net = `agentome-run-${RUN}-docker-net`;
    expect(own.HostConfig).toMatchObject({
      Runtime: 'runsc-docker',
      CapAdd: ['ALL'],
      NetworkMode: net,
    });
    expect([...(networks.get(net) ?? [])].sort()).toEqual(
      [`agentome-run-${RUN}-sandbox`, 'the-egress-proxy'].sort(),
    );
    expect(networks.get(`agentome-place-${ID}`)?.has(`agentome-run-${RUN}-docker`)).toBe(false);
    // Its pulls under its own token; the agent's folder at the same path, for what is bound.
    expect(own.Env).toContain(
      `HTTPS_PROXY=http://docker-${RUN}:docker-token-of-${RUN}@place-egress:3128`,
    );
    expect(own.HostConfig.Mounts.map((mount) => mount.Target)).toEqual([
      '/var/lib/docker',
      `/seat/${folder}`,
    ]);
    const sandbox = containers.get(`agentome-run-${RUN}-sandbox`)?.body as {
      HostConfig: { ExtraHosts: string[] };
    };
    expect(sandbox.HostConfig.ExtraHosts.some((host) => host.startsWith('docker:'))).toBe(true);
    expect(volumes.has(`agentome-run-${RUN}-docker`)).toBe(true);
    await order(settings, 'DELETE', `/places/${ID}/runs/${RUN}`);
    expect(containers.has(`agentome-run-${RUN}-docker`)).toBe(false);
    expect(volumes.has(`agentome-run-${RUN}-docker`)).toBe(false);
    expect(networks.has(net)).toBe(false);
    // Without the runtime, no Docker.
    const plain = fakeDocker();
    const without = settingsWith(plain.docker);
    await order(without, 'POST', `/places/${ID}`, { code: 'K7QX-M2PH' });
    const bare = await order(without, 'PUT', `/places/${ID}/runs/${RUN}`, { folder });
    expect((bare.body as { docker?: boolean }).docker).toBeUndefined();
    expect(plain.containers.has(`agentome-run-${RUN}-docker`)).toBe(false);
    // A run's Docker has every capability inside its kernel: a name Docker runs with runc is refused.
    const posing = fakeDocker();
    const posed = settingsWith(posing.docker, undefined, 'runc', 'gvisor');
    await order(posed, 'POST', `/places/${ID}`, { code: 'K7QX-M2PH' });
    const refused = await order(posed, 'PUT', `/places/${ID}/runs/${RUN}`, { folder });
    expect(refused.status).toBe(409);
    expect(posing.containers.has(`agentome-run-${RUN}-docker`)).toBe(false);
  });

  it("gives a Codex run's CLI container the CLI and the sign-in, and its folders empty", async () => {
    const { docker, containers } = fakeDocker();
    const settings = settingsWith(docker);
    await order(settings, 'POST', `/places/${ID}`, { code: 'K7QX-M2PH' });
    const SHOP = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
    const RUN = '9e8d7c6b-5a49-4382-a1b0-c9d8e7f6a5b4';
    const folder = `folders/${SHOP}/0123456789abcdef`;
    await order(settings, 'PUT', `/places/${ID}/runs/${RUN}`, { folder, engine: 'codex' });
    const cli = containers.get(`agentome-run-${RUN}`)?.body as {
      HostConfig: { Mounts: { Target: string }[]; Tmpfs: Record<string, string> };
    };
    // No working folder of the agent's, so no repository's .codex beside the sign-in.
    expect(cli.HostConfig.Mounts.map((mount) => mount.Target)).toEqual([
      '/seat/cli',
      '/home/node/.claude',
      '/home/node/.codex',
    ]);
    expect(Object.keys(cli.HostConfig.Tmpfs)).toEqual(
      expect.arrayContaining([`/seat/runs/${RUN}`, `/seat/${folder}`]),
    );
    // The sandbox, where its executor runs, has them as before.
    const sandbox = containers.get(`agentome-run-${RUN}-sandbox`)?.body as {
      HostConfig: { Mounts: { Target: string }[] };
    };
    expect(sandbox.HostConfig.Mounts.map((mount) => mount.Target)).toContain(`/seat/${folder}`);
    // Without a kept folder Codex works in the run's own repo, which must be there to start in.
    const LONE = '1f2e3d4c-5b6a-4987-a6b5-c4d3e2f1a0b9';
    await order(settings, 'PUT', `/places/${ID}/runs/${LONE}`, { engine: 'codex' });
    const lone = containers.get(`agentome-run-${LONE}`)?.body as {
      HostConfig: { Tmpfs: Record<string, string> };
    };
    expect(Object.keys(lone.HostConfig.Tmpfs)).toEqual(
      expect.arrayContaining([`/seat/runs/${LONE}`, `/seat/runs/${LONE}/repo`]),
    );
  });

  it('makes no place without gVisor, unless runc is asked for by name', async () => {
    // No runtime at all: refused, with what to do.
    const none = fakeDocker();
    const bare = await order(settingsWith(none.docker, undefined, null), 'POST', `/places/${ID}`, {
      code: 'K7QX-M2PH',
    });
    expect(bare.status).toBe(409);
    expect(JSON.stringify(bare.body)).toContain('AGENTOME_PLACE_RUNTIME=runsc');
    expect(none.containers.size).toBe(0);
    // A name Docker runs with runc is not gVisor, whatever it is called; one it has not, neither.
    for (const name of ['gvisor', 'kata']) {
      const posing = fakeDocker();
      const refused = await order(
        settingsWith(posing.docker, undefined, name),
        'POST',
        `/places/${ID}`,
        {
          code: 'K7QX-M2PH',
        },
      );
      expect(refused.status).toBe(409);
      expect(posing.containers.size).toBe(0);
    }
    // runc by name: the host's kernel, the admin's choice, with no Runtime of its own.
    const host = fakeDocker();
    await order(settingsWith(host.docker), 'POST', `/places/${ID}`, { code: 'K7QX-M2PH' });
    const place = host.containers.get(`agentome-place-${ID}`)?.body as {
      HostConfig: { Runtime?: string };
    };
    expect(place.HostConfig.Runtime).toBeUndefined();
  });

  it('gives places and runs the runtime it is set to', async () => {
    const { docker, containers } = fakeDocker();
    const settings = settingsWith(docker, undefined, 'runsc');
    await order(settings, 'POST', `/places/${ID}`, { code: 'K7QX-M2PH' });
    const RUN = '9e8d7c6b-5a49-4382-a1b0-c9d8e7f6a5b4';
    await order(settings, 'PUT', `/places/${ID}/runs/${RUN}`, {});
    for (const name of [
      `agentome-place-${ID}`,
      `agentome-run-${RUN}`,
      `agentome-run-${RUN}-sandbox`,
    ]) {
      expect(
        (containers.get(name)?.body as { HostConfig: { Runtime?: string } }).HostConfig.Runtime,
      ).toBe('runsc');
    }
  });

  it("gives a project's services the runtime too, and makes one made under another anew", async () => {
    const { docker, containers } = fakeDocker();
    const before = settingsWith(docker);
    await order(before, 'POST', `/places/${ID}`, { code: 'K7QX-M2PH' });
    const SHOP = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
    const db = `agentome-place-${ID}-${SHOP.replaceAll('-', '').slice(0, 12)}-db`;
    const shape = {
      project: SHOP,
      hash: 'a'.repeat(64),
      services: [{ name: 'db', image: 'postgres:16', environment: {}, volumes: [] }],
    };
    const runtime = () =>
      (containers.get(db)?.body as { HostConfig: { Runtime?: string } }).HostConfig.Runtime;
    await order(before, 'PUT', `/places/${ID}/services`, shape);
    expect(runtime()).toBeUndefined();
    // The server moved to gVisor: the service made on the host's kernel goes, and comes back under it.
    const after = settingsWith(docker, undefined, 'runsc');
    expect((await order(after, 'PUT', `/places/${ID}/services`, shape)).status).toBe(204);
    expect(runtime()).toBe('runsc');
    expect(containers.get(db)?.running).toBe(true);
  });
});

describe("a service's image", () => {
  it('is pulled by its tag, or by its digest when it has one', () => {
    expect(pullOf('postgres:16')).toEqual({ from: 'postgres', tag: '16' });
    expect(pullOf('registry.example.com:5000/team/db')).toEqual({
      from: 'registry.example.com:5000/team/db',
      tag: 'latest',
    });
    const digest = `sha256:${'a'.repeat(64)}`;
    expect(pullOf(`postgres@${digest}`)).toEqual({ from: 'postgres', tag: digest });
    expect(pullOf(`registry.example.com:5000/db:16@${digest}`)).toEqual({
      from: 'registry.example.com:5000/db',
      tag: digest,
    });
  });
});
