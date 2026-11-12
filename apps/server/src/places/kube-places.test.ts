import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { Kube, KubeExec } from './kube.js';
import { kubePlaces, type KubePlaceSettings } from './kube-places.js';
import { handleOrder, type LauncherSettings, SHELL } from './launcher.js';
import { signOrder } from './protocol.js';

// The launcher on Kubernetes, against an API that writes down what it is asked and answers as
// the cluster does: a pod made runs at once, a pairing pod succeeds unless told otherwise.

const ID = '6f1c2a7e-0b5d-4e3a-9c8f-1a2b3c4d5e6f';
const AGENT = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

type PodBody = {
  metadata: { name: string; labels: Record<string, string> };
  spec: {
    restartPolicy: string;
    automountServiceAccountToken: boolean;
    securityContext: Record<string, unknown>;
    containers: {
      image: string;
      command?: string[];
      args: string[];
      env: { name: string; value: string }[];
      securityContext: Record<string, unknown>;
      volumeMounts: { name: string; mountPath: string }[];
    }[];
    volumes: Record<string, unknown>[];
  };
};

function fakeCluster(options: { pairing?: 'Succeeded' | 'Failed' } = {}) {
  const asked: { method: string; path: string; body?: unknown }[] = [];
  const pods = new Map<string, { body: PodBody; phase: string }>();
  const claims = new Set<string>();
  const kube: Kube = async (method, path, body) => {
    asked.push({ method, path, ...(body !== undefined && { body }) });
    const pod = /^\/pods\/([^/?]+)/.exec(path)?.[1];
    const claim = /^\/persistentvolumeclaims\/([^/?]+)/.exec(path)?.[1];
    if (method === 'POST' && path === '/pods') {
      const made = body as PodBody;
      if (pods.has(made.metadata.name)) return { status: 409, body: { message: 'exists' } };
      const once = made.spec.restartPolicy === 'Never';
      pods.set(made.metadata.name, {
        body: made,
        phase: once
          ? made.metadata.name.endsWith('-connect')
            ? (options.pairing ?? 'Succeeded')
            : 'Succeeded'
          : 'Running',
      });
      return { status: 201, body: made };
    }
    if (method === 'POST' && path === '/persistentvolumeclaims') {
      const name = (body as { metadata: { name: string } }).metadata.name;
      if (claims.has(name)) return { status: 409, body: {} };
      claims.add(name);
      return { status: 201, body };
    }
    if (pod && method === 'GET' && path.endsWith('/log?tailLines=5')) {
      return { status: 200, body: 'agentome connect\nThis code is not valid.\n' };
    }
    if (pod && method === 'GET') {
      const found = pods.get(pod);
      return found
        ? {
            status: 200,
            body: {
              metadata: found.body.metadata,
              status: {
                phase: found.phase,
                startTime: '2026-11-12T10:00:00Z',
                containerStatuses: found.body.spec.containers.map(() => ({ ready: true })),
              },
            },
          }
        : { status: 404, body: { message: 'not found' } };
    }
    if (pod && method === 'DELETE') {
      return pods.delete(pod) ? { status: 200, body: {} } : { status: 404, body: {} };
    }
    if (claim && method === 'GET')
      return claims.has(claim) ? { status: 200, body: {} } : { status: 404, body: {} };
    if (claim && method === 'DELETE') {
      return claims.delete(claim) ? { status: 200, body: {} } : { status: 404, body: {} };
    }
    return { status: 500, body: { message: `unexpected ${method} ${path}` } };
  };
  const ran: { pod: string; command: string[]; tty: boolean }[] = [];
  const resized: [number, number][] = [];
  const exec: KubeExec = async (pod, command, { tty }) => {
    ran.push({ pod, command, tty });
    const stream = new PassThrough();
    if (!tty) setImmediate(() => stream.end());
    return {
      stream,
      ended: Promise.resolve(true),
      resize: (cols, rows) => void resized.push([cols, rows]),
    };
  };
  return { kube, exec, asked, pods, claims, ran, resized };
}

function settingsOf(cluster: ReturnType<typeof fakeCluster>): LauncherSettings {
  const places: KubePlaceSettings = {
    kube: cluster.kube,
    exec: cluster.exec,
    image: 'docker.io/agentome/agentome-seat:0.1.0',
    serverUrl: 'http://agentome:3000',
    egress: { proxy: 'place-egress:3128', tokenOf: (id) => `token-of-${id}` },
    patience: { tries: 3, everyMs: 1 },
  };
  return { key: 'the shared key', places: kubePlaces(places) };
}

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

describe('the place launcher on Kubernetes', () => {
  it('makes a place: two claims, a pairing pod that goes, then the place’s pod, locked down', async () => {
    const cluster = fakeCluster();
    const settings = settingsOf(cluster);
    expect((await order(settings, 'GET', `/places/${ID}`)).body).toEqual({ state: 'none' });
    expect(await order(settings, 'POST', `/places/${ID}`, { code: 'K7QX-M2PH' })).toEqual({
      status: 201,
      body: { state: 'awake' },
    });
    expect([...cluster.claims]).toEqual([`agentome-place-${ID}-home`, `agentome-place-${ID}-seat`]);
    const made = cluster.asked
      .filter((call) => call.method === 'POST' && call.path === '/pods')
      .map((call) => call.body as PodBody);
    expect(made.map((pod) => pod.metadata.name)).toEqual([
      `agentome-place-${ID}-connect`,
      `agentome-place-${ID}`,
    ]);
    expect(made[0]?.spec.containers[0]?.args).toEqual([
      'connect',
      'K7QX-M2PH',
      '--server',
      'http://agentome:3000',
    ]);
    const place = made[1];
    expect(place?.metadata.labels).toEqual({
      'ai.agentome.place': ID,
      'app.kubernetes.io/name': 'agentome-place',
    });
    expect(place?.spec).toMatchObject({
      restartPolicy: 'OnFailure',
      automountServiceAccountToken: false,
      securityContext: { fsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } },
    });
    const container = place?.spec.containers[0];
    expect(container?.args).toEqual(['run']);
    expect(container?.securityContext).toEqual({
      runAsUser: 1000,
      runAsGroup: 1000,
      runAsNonRoot: true,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ['ALL'] },
    });
    expect(container?.env).toContainEqual({
      name: 'HTTPS_PROXY',
      value: `http://${ID}:token-of-${ID}@place-egress:3128`,
    });
    expect(container?.env).toContainEqual({
      name: 'NO_PROXY',
      value: 'agentome,localhost,127.0.0.1',
    });
    expect(place?.spec.volumes).toEqual([
      { name: 'home', persistentVolumeClaim: { claimName: `agentome-place-${ID}-home` } },
      { name: 'seat', persistentVolumeClaim: { claimName: `agentome-place-${ID}-seat` } },
      { name: 'tmp', emptyDir: { sizeLimit: '2Gi' } },
    ]);
    // The pairing pod is gone; the place is up; one place a person.
    expect([...cluster.pods.keys()]).toEqual([`agentome-place-${ID}`]);
    expect((await order(settings, 'GET', `/places/${ID}`)).body).toMatchObject({ state: 'awake' });
    expect((await order(settings, 'POST', `/places/${ID}`, { code: 'K7QX-M2PH' })).status).toBe(
      409,
    );
  });

  it('makes no place when the pairing fails', async () => {
    const cluster = fakeCluster({ pairing: 'Failed' });
    const made = await order(settingsOf(cluster), 'POST', `/places/${ID}`, { code: 'K7QX-M2PH' });
    // Why, in the worker's words.
    expect(made).toEqual({
      status: 502,
      body: { error: 'The place could not connect to the server: This code is not valid.' },
    });
    expect(cluster.pods.size).toBe(0);
    expect(cluster.claims.size).toBe(0);
  });

  it('sleeps by deleting the pod and keeping the claims, wakes it again, and deletes it all', async () => {
    const cluster = fakeCluster();
    const settings = settingsOf(cluster);
    await order(settings, 'POST', `/places/${ID}`, { code: 'K7QX-M2PH' });
    expect((await order(settings, 'POST', `/places/${ID}/sleep`)).status).toBe(200);
    expect(cluster.pods.size).toBe(0);
    expect(cluster.claims.size).toBe(2);
    expect((await order(settings, 'GET', `/places/${ID}`)).body).toEqual({ state: 'asleep' });
    expect((await order(settings, 'POST', `/places/${ID}/wake`)).status).toBe(200);
    expect((await order(settings, 'GET', `/places/${ID}`)).body).toMatchObject({ state: 'awake' });
    // A worker that ended leaves a pod that is not running: waking makes a new one.
    const pod = cluster.pods.get(`agentome-place-${ID}`);
    if (pod) pod.phase = 'Succeeded';
    expect((await order(settings, 'GET', `/places/${ID}`)).body).toEqual({ state: 'asleep' });
    await order(settings, 'POST', `/places/${ID}/wake`);
    expect(cluster.pods.get(`agentome-place-${ID}`)?.phase).toBe('Running');

    expect((await order(settings, 'DELETE', `/places/${ID}`)).status).toBe(204);
    expect(cluster.pods.size).toBe(0);
    expect(cluster.claims.size).toBe(0);
    expect((await order(settings, 'GET', `/places/${ID}`)).body).toEqual({ state: 'none' });
    expect((await order(settings, 'POST', `/places/${ID}/wake`)).status).toBe(404);
  });

  it('empties folders in the place while it is awake, and in a pod of its kind while it sleeps', async () => {
    const cluster = fakeCluster();
    const settings = settingsOf(cluster);
    await order(settings, 'POST', `/places/${ID}`, { code: 'K7QX-M2PH' });
    expect((await order(settings, 'DELETE', `/places/${ID}/folders/${AGENT}`)).status).toBe(204);
    expect(cluster.ran).toEqual([
      { pod: `agentome-place-${ID}`, command: ['rm', '-rf', `/seat/folders/${AGENT}`], tty: false },
    ]);
    await order(settings, 'POST', `/places/${ID}/sleep`);
    expect((await order(settings, 'DELETE', `/places/${ID}/folders/${AGENT}`)).status).toBe(204);
    const fresh = cluster.asked
      .filter((call) => call.method === 'POST' && call.path === '/pods')
      .map((call) => call.body as PodBody)
      .find((pod) => pod.metadata.name.endsWith('-fresh'));
    expect(fresh?.spec.containers[0]).toMatchObject({
      command: ['rm'],
      args: ['-rf', `/seat/folders/${AGENT}`],
    });
    // The throw-away pod is gone, and the place still sleeps.
    expect(cluster.pods.size).toBe(0);
  });

  it('opens a terminal in the place’s pod and resizes it', async () => {
    const cluster = fakeCluster();
    const settings = settingsOf(cluster);
    await order(settings, 'POST', `/places/${ID}`, { code: 'K7QX-M2PH' });
    await order(settings, 'POST', `/places/${ID}/sleep`);
    const { openTerminal } = await import('./launcher.js');
    const { done } = await openTerminal(settings, ID);
    expect(cluster.ran).toEqual([{ pod: `agentome-place-${ID}`, command: SHELL, tty: true }]);
    expect((await order(settings, 'GET', `/places/${ID}`)).body).toMatchObject({
      state: 'awake',
      terminals: 1,
    });
    await order(settings, 'POST', `/places/${ID}/resize`, { cols: 120, rows: 40 });
    expect(cluster.resized).toEqual([[120, 40]]);
    done();
    expect((await order(settings, 'GET', `/places/${ID}`)).body).toMatchObject({ terminals: 0 });
  });

  it("makes the place again with its project's services beside the agent, reached by their names", async () => {
    const cluster = fakeCluster();
    const settings = settingsOf(cluster);
    await order(settings, 'POST', `/places/${ID}`, { code: 'K7QX-M2PH' });
    const shape = {
      project: AGENT,
      hash: 'b'.repeat(64),
      services: [
        {
          name: 'db',
          image: 'postgres:16',
          environment: { POSTGRES_PASSWORD: 'dev' },
          volumes: [{ name: 'pgdata', target: '/var/lib/postgresql/data' }],
        },
        {
          name: 'my_cache',
          image: 'redis:7',
          environment: {},
          command: ['redis-server'],
          volumes: [],
        },
      ],
    };
    expect((await order(settings, 'PUT', `/places/${ID}/services`, shape)).status).toBe(204);
    const pod = cluster.pods.get(`agentome-place-${ID}`)?.body as PodBody & {
      metadata: { annotations?: Record<string, string> };
      spec: { hostAliases?: unknown };
    };
    expect(pod.metadata.annotations).toEqual({ 'ai.agentome.shape': `${AGENT}:${'b'.repeat(64)}` });
    expect(pod.spec.hostAliases).toEqual([{ ip: '127.0.0.1', hostnames: ['db', 'my_cache'] }]);
    const [place, db, cache] = pod.spec.containers as (PodBody['spec']['containers'][number] & {
      name: string;
    })[];
    expect(place?.name).toBe('place');
    expect(db).toMatchObject({
      name: 'service-db',
      image: 'postgres:16',
      env: [{ name: 'POSTGRES_PASSWORD', value: 'dev' }],
      securityContext: { allowPrivilegeEscalation: false },
      volumeMounts: [
        {
          name: 'seat',
          mountPath: '/var/lib/postgresql/data',
          subPath: `services/${AGENT.replaceAll('-', '').slice(0, 12)}/pgdata`,
        },
      ],
    });
    expect(cache).toMatchObject({ name: 'service-my-cache', args: ['redis-server'] });
    // Made for the same list, the place is left as it is.
    const made = cluster.asked.filter(
      (call) => call.method === 'POST' && call.path === '/pods',
    ).length;
    await order(settings, 'PUT', `/places/${ID}/services`, shape);
    expect(
      cluster.asked.filter((call) => call.method === 'POST' && call.path === '/pods'),
    ).toHaveLength(made);
    // What a service may not have is not passed on; anything but a list of services is refused.
    const odd = await order(settings, 'PUT', `/places/${ID}/services`, {
      ...shape,
      services: [{ name: 'x', image: 'alpine', environment: {}, volumes: [], privileged: true }],
    });
    expect(odd.status).toBe(204);
    const bad = await order(settings, 'PUT', `/places/${ID}/services`, {
      project: 'x',
      hash: 'y',
      services: [],
    });
    expect(bad.status).toBe(400);
  });
});
