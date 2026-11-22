import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { Kube, KubeExec } from './kube.js';
import { kubePlaces, type KubePlaceSettings } from './kube-places.js';
import { handleOrder, type LauncherSettings, shellFor } from './launcher.js';
import { newNonce, signOrder } from './protocol.js';

// The launcher on Kubernetes, against an API that writes down what it is asked and answers as
// the cluster does: a pod made runs at once, a pairing pod succeeds unless told otherwise.

const ID = '6f1c2a7e-0b5d-4e3a-9c8f-1a2b3c4d5e6f';
const AGENT = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

type PodBody = {
  metadata: { name: string; uid?: string; labels: Record<string, string> };
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
  const policies = new Map<string, Record<string, unknown>>();
  // gVisor's RuntimeClass, and one named so that runs runc.
  const classes: Record<string, string> = { gvisor: 'runsc', 'gvisor-fake': 'runc' };
  const kube: Kube = async (method, path, body) => {
    asked.push({ method, path, ...(body !== undefined && { body }) });
    const runtimeClass = /^\/apis\/node\.k8s\.io\/v1\/runtimeclasses\/(.+)$/.exec(path)?.[1];
    if (runtimeClass !== undefined && method === 'GET') {
      const handler = classes[runtimeClass];
      return handler ? { status: 200, body: { handler } } : { status: 404, body: {} };
    }
    const policyPath = '/apis/networking.k8s.io/v1/namespaces/{namespace}/networkpolicies';
    if (method === 'POST' && path === policyPath) {
      const made = body as { metadata: { name: string } };
      if (policies.has(made.metadata.name)) return { status: 409, body: {} };
      policies.set(made.metadata.name, made as Record<string, unknown>);
      return { status: 201, body };
    }
    if (method === 'DELETE' && path.startsWith(`${policyPath}/`)) {
      return policies.delete(path.slice(policyPath.length + 1))
        ? { status: 200, body: {} }
        : { status: 404, body: {} };
    }
    const pod = /^\/pods\/([^/?]+)/.exec(path)?.[1];
    const claim = /^\/persistentvolumeclaims\/([^/?]+)/.exec(path)?.[1];
    if (method === 'POST' && path === '/pods') {
      const made = body as PodBody;
      if (pods.has(made.metadata.name)) return { status: 409, body: { message: 'exists' } };
      const once =
        made.spec.restartPolicy === 'Never' && !made.metadata.name.startsWith('agentome-run-');
      made.metadata.uid = `uid-${made.metadata.name}`;
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
    if (method === 'GET' && path.startsWith('/pods?labelSelector=')) {
      const wanted = decodeURIComponent(path.slice('/pods?labelSelector='.length)).split(',');
      const items = [...pods.values()]
        .filter(({ body: made }) =>
          wanted.every((term) => {
            const [key = '', value] = term.split('=');
            return value === undefined
              ? key in made.metadata.labels
              : made.metadata.labels[key] === value;
          }),
        )
        .map(({ body: made }) => ({ metadata: made.metadata }));
      return { status: 200, body: { items } };
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
              spec: { nodeName: 'node-1' },
              status: {
                phase: found.phase,
                podIP: '10.244.1.9',
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
  return { kube, exec, asked, pods, claims, policies, ran, resized };
}

/** What a place's environment is made of, as `settingsOf` gives it. */
const settingsShape = {
  serverUrl: 'http://agentome:3000',
  egress: { proxy: 'place-egress:3128', tokenOf: (id: string) => `token-of-${id}` },
};

function settingsOf(cluster: ReturnType<typeof fakeCluster>, runtime = 'runc'): LauncherSettings {
  const places: KubePlaceSettings = {
    kube: cluster.kube,
    exec: cluster.exec,
    image: 'docker.io/agentome/agentome-seat:0.1.0',
    // The nodes' kernel, asked for by name, unless a test gives a RuntimeClass.
    runtime,
    serverUrl: 'http://agentome:3000',
    egress: { proxy: 'place-egress:3128', tokenOf: (id) => `token-of-${id}` },
    patience: { tries: 3, everyMs: 1 },
    aliases: [
      { ip: '10.96.0.20', hostnames: ['agentome'] },
      { ip: '10.96.0.21', hostnames: ['place-egress'] },
    ],
  };
  return { key: 'the shared key', places: kubePlaces(places) };
}

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

  it('makes a place under a RuntimeClass that runs gVisor only', async () => {
    const real = fakeCluster();
    const made = await order(settingsOf(real, 'gvisor'), 'POST', `/places/${ID}`, {
      code: 'K7QX-M2PH',
    });
    expect(made.status).toBe(201);
    for (const runtime of ['gvisor-fake', 'absent']) {
      const cluster = fakeCluster();
      const refused = await order(settingsOf(cluster, runtime), 'POST', `/places/${ID}`, {
        code: 'K7QX-M2PH',
      });
      expect(refused.status, runtime).toBe(409);
      expect(
        cluster.asked.some((call) => call.method === 'POST'),
        runtime,
      ).toBe(false);
    }
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
    expect(cluster.ran).toEqual([
      { pod: `agentome-place-${ID}`, command: shellFor(settingsShape, ID), tty: true },
    ]);
    expect((await order(settings, 'GET', `/places/${ID}`)).body).toMatchObject({
      state: 'awake',
      terminals: 1,
    });
    await order(settings, 'POST', `/places/${ID}/resize`, { cols: 120, rows: 40 });
    expect(cluster.resized).toEqual([[120, 40]]);
    done();
    expect((await order(settings, 'GET', `/places/${ID}`)).body).toMatchObject({ terminals: 0 });
  });

  it("runs a run in a pod of its own on the place's node, with only its folders and its services", async () => {
    const cluster = fakeCluster();
    const settings = settingsOf(cluster);
    await order(settings, 'POST', `/places/${ID}`, { code: 'K7QX-M2PH' });
    const RUN = '9e8d7c6b-5a49-4382-a1b0-c9d8e7f6a5b4';
    const folder = `folders/${AGENT}/0123456789abcdef`;
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

    // The services start with each run: the place itself is not made again for them.
    const before = cluster.asked.length;
    expect((await order(settings, 'PUT', `/places/${ID}/services`, shape)).status).toBe(204);
    expect(cluster.asked.slice(before).some((call) => call.method === 'POST')).toBe(false);

    const started = await order(settings, 'PUT', `/places/${ID}/runs/${RUN}`, { folder, shape });
    expect(started.status).toBe(200);
    // The worker reaches the CLI container at the pod; the CLI container its sandbox beside it.
    const at = started.body as Record<'cli' | 'sandbox', { host: string; port: number }>;
    expect([at.cli.host, at.cli.port, at.sandbox.host, at.sandbox.port]).toEqual([
      '10.244.1.9',
      7419,
      '127.0.0.1',
      7420,
    ]);
    const pod = cluster.pods.get(`agentome-run-${RUN}`)?.body as PodBody & {
      spec: { nodeName?: string; hostAliases?: unknown; dnsPolicy?: string };
    };
    // Only the person's own pods reach the run's CLI container, by a policy that goes with the pod.
    expect(cluster.policies.get(`agentome-run-${RUN}`)).toMatchObject({
      metadata: { ownerReferences: [{ kind: 'Pod', uid: `uid-agentome-run-${RUN}` }] },
      spec: {
        podSelector: { matchLabels: { 'ai.agentome.run': RUN } },
        ingress: [
          {
            from: [{ podSelector: { matchLabels: { 'ai.agentome.place': ID } } }],
            ports: [{ port: 7419, protocol: 'TCP' }],
          },
        ],
      },
    });
    // On the place's node, where its volumes are; a place's label, so the places' policy holds.
    expect(pod.spec.nodeName).toBe('node-1');
    expect(pod.metadata.labels).toMatchObject({
      'ai.agentome.place': ID,
      'ai.agentome.run': RUN,
      'app.kubernetes.io/name': 'agentome-place',
    });
    expect(pod.spec.dnsPolicy).toBe('None');
    expect(pod.spec.hostAliases).toEqual([
      { ip: '10.96.0.20', hostnames: ['agentome'] },
      { ip: '10.96.0.21', hostnames: ['place-egress'] },
      { ip: '127.0.0.1', hostnames: ['db', 'my_cache'] },
    ]);
    const [cli, sandbox, db, cache] = pod.spec
      .containers as (PodBody['spec']['containers'][number] & {
      name: string;
    })[];
    expect([cli?.name, sandbox?.name]).toEqual(['cli', 'sandbox']);
    for (const run of [cli, sandbox]) {
      expect(run?.args).toEqual(['run-server', RUN]);
      expect(run?.securityContext).toMatchObject({
        runAsNonRoot: true,
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        capabilities: { drop: ['ALL'] },
      });
      // No egress token of the place: the worker gives the CLI its CLI container's, the commands the run's.
      expect(run?.env.map((pair) => pair.name)).not.toContain('HTTPS_PROXY');
    }
    // The CLI container: its run's folder, its agent's folder, the CLI read-only and the sign-in; not the
    // seat's connection, nor another agent's folders, nor the rest of the home.
    expect(cli?.volumeMounts).toEqual([
      { name: 'cli-home', mountPath: '/home/node' },
      { name: 'cli-tmp', mountPath: '/tmp' },
      { name: 'seat', mountPath: `/seat/runs/${RUN}`, subPath: `runs/${RUN}`, readOnly: false },
      { name: 'seat', mountPath: `/seat/${folder}`, subPath: folder, readOnly: false },
      { name: 'seat', mountPath: '/seat/cli', subPath: 'cli', readOnly: true },
      { name: 'home', mountPath: '/home/node/.claude', subPath: '.claude' },
      { name: 'home', mountPath: '/home/node/.codex', subPath: '.codex' },
      // Its mark, which its bash and git look for, and nothing in it can remove.
      { name: 'cli-mark', mountPath: '/run/agentome-cli', readOnly: true },
    ]);
    // The sandbox: no CLI, no sign-in; of the run's folder what a command reads and works in,
    // not the gateway's config.
    const ofRun = (name: string, readOnly: boolean) => ({
      name: 'seat',
      mountPath: `/seat/runs/${RUN}/${name}`,
      subPath: `runs/${RUN}/${name}`,
      readOnly,
    });
    expect(sandbox?.volumeMounts).toEqual([
      { name: 'sandbox-home', mountPath: '/home/node' },
      { name: 'sandbox-tmp', mountPath: '/tmp' },
      ofRun('git', true),
      ofRun('profile', true),
      ofRun('repo', false),
      { name: 'seat', mountPath: `/seat/${folder}`, subPath: folder, readOnly: false },
    ]);
    expect(cli?.env).toContainEqual({ name: 'CLAUDE_CONFIG_DIR', value: '/home/node/.claude' });
    expect(db).toMatchObject({
      name: 'service-db',
      image: 'postgres:16',
      securityContext: {
        allowPrivilegeEscalation: false,
        capabilities: { drop: ['NET_RAW', 'MKNOD', 'SETFCAP', 'AUDIT_WRITE', 'SYS_CHROOT'] },
      },
      volumeMounts: [
        {
          name: 'seat',
          mountPath: '/var/lib/postgresql/data',
          subPath: `services/${AGENT.replaceAll('-', '').slice(0, 12)}/pgdata`,
        },
      ],
    });
    expect(cache).toMatchObject({ name: 'service-my-cache', args: ['redis-server'] });

    // Another agent's folder, a path out of shape: refused.
    for (const odd of [`folders/${AGENT}/../..`, '../config.json', 'cli']) {
      expect(
        (await order(settings, 'PUT', `/places/${ID}/runs/${RUN}`, { folder: odd })).status,
      ).toBe(400);
    }
    // Ended, it is gone with whatever ran in it; sleeping, the place leaves none behind.
    expect((await order(settings, 'DELETE', `/places/${ID}/runs/${RUN}`)).status).toBe(204);
    expect(cluster.pods.has(`agentome-run-${RUN}`)).toBe(false);
    await order(settings, 'PUT', `/places/${ID}/runs/${RUN}`, { folder });
    await order(settings, 'POST', `/places/${ID}/sleep`);
    expect([...cluster.pods.keys()].filter((name) => name.startsWith('agentome-run-'))).toEqual([]);
  });
});
