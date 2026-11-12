import { setTimeout as wait } from 'node:timers/promises';
import { type Kube, type KubeExec, kubeError } from './kube.js';
import type { ServiceSpec } from '../projects/devcontainer.js';
import {
  type PlaceNetwork,
  type Places,
  placeEnv,
  Refusal,
  type Shape,
  SHELL,
} from './launcher.js';

// Places as pods in the launcher's own namespace: the launcher on Kubernetes. A place is a pod
// with two volume claims; sleeping deletes the pod and keeps the claims, waking makes it again.
// The manifests' NetworkPolicies let a place reach the app and the egress proxy only.

export interface KubePlaceSettings extends PlaceNetwork {
  kube: Kube;
  exec: KubeExec;
  /** The seat image of this release. */
  image: string;
  /** How long to wait for a pod to start, end or go. */
  patience?: { tries: number; everyMs: number };
}

const NAME = 'agentome-place-';
const LABEL = 'ai.agentome.place';
const names = (id: string) => ({
  pod: `${NAME}${id}`,
  connect: `${NAME}${id}-connect`,
  fresh: `${NAME}${id}-fresh`,
  // The person's sign-in to the CLIs, and the seat: its connection, the CLI it installs, the
  // agents' working folders. Both outlive sleep; deleting the place deletes them.
  home: `${NAME}${id}-home`,
  seat: `${NAME}${id}-seat`,
});

const CLAIMS = { home: '1Gi', seat: '20Gi' } as const;
/** The project and services a pod was made with. */
const SHAPE = 'ai.agentome.shape';
const shapeOf = (shape: Shape) => `${shape.project}:${shape.hash}`;

/**
 * A service beside the agent, in the place's pod: its image as the repository names it, no
 * privilege to gain, its volumes on the place's seat volume, memory and CPU capped. It keeps the
 * image's user and capabilities, as databases need them.
 */
function serviceContainer(shape: Shape, service: ServiceSpec) {
  return {
    // A container's name is a DNS label; a compose service's may have an underscore.
    name: `service-${service.name.replaceAll('_', '-')}`.slice(0, 63),
    image: service.image,
    imagePullPolicy: 'IfNotPresent',
    ...(service.command && { args: service.command }),
    env: Object.entries(service.environment).map(([name, value]) => ({ name, value })),
    securityContext: { allowPrivilegeEscalation: false },
    resources: {
      requests: { cpu: '100m', memory: '128Mi' },
      limits: { cpu: '1', memory: '2Gi' },
    },
    volumeMounts: service.volumes.map((volume) => ({
      name: 'seat',
      mountPath: volume.target,
      subPath: `services/${shape.project.replaceAll('-', '').slice(0, 12)}/${volume.name}`,
    })),
  };
}

type Pod = {
  metadata?: { deletionTimestamp?: string; annotations?: Record<string, string> };
  status?: { phase?: string; startTime?: string };
};

/**
 * A place's pod: the worker as the person's place, as the place's user, no capability and no way
 * to gain one, a read-only root, memory and CPU capped, no token of the cluster.
 */
export function placePod(
  settings: KubePlaceSettings,
  id: string,
  name: string,
  run: { args: string[]; command?: string[]; restart: 'OnFailure' | 'Never' },
  shape?: Shape,
) {
  const n = names(id);
  const services = shape?.services ?? [];
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      labels: { [LABEL]: id, 'app.kubernetes.io/name': 'agentome-place' },
      ...(shape && { annotations: { [SHAPE]: shapeOf(shape) } }),
    },
    spec: {
      restartPolicy: run.restart,
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      terminationGracePeriodSeconds: 30,
      // The place's user is its container's: a service keeps its image's own, as databases need.
      securityContext: { fsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } },
      // The project's services share the pod's network: their names are this pod's own address.
      ...(services.length > 0 && {
        hostAliases: [{ ip: '127.0.0.1', hostnames: services.map((service) => service.name) }],
      }),
      containers: [
        {
          name: 'place',
          image: settings.image,
          imagePullPolicy: 'IfNotPresent',
          ...(run.command && { command: run.command }),
          args: run.args,
          env: placeEnv(settings, id).map(([key, value]) => ({ name: key, value })),
          securityContext: {
            runAsUser: 1000,
            runAsGroup: 1000,
            runAsNonRoot: true,
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ['ALL'] },
          },
          resources: {
            requests: { cpu: '250m', memory: '512Mi' },
            limits: { cpu: '2', memory: '8Gi' },
          },
          volumeMounts: [
            { name: 'home', mountPath: '/home/node' },
            { name: 'seat', mountPath: '/seat' },
            { name: 'tmp', mountPath: '/tmp' },
          ],
        },
        ...(shape ? services.map((service) => serviceContainer(shape, service)) : []),
      ],
      volumes: [
        { name: 'home', persistentVolumeClaim: { claimName: n.home } },
        { name: 'seat', persistentVolumeClaim: { claimName: n.seat } },
        { name: 'tmp', emptyDir: { sizeLimit: '2Gi' } },
      ],
    },
  };
}

export function kubePlaces(settings: KubePlaceSettings): Places {
  const { kube } = settings;
  const patience = settings.patience ?? { tries: 170, everyMs: 1000 };

  const readPod = async (name: string): Promise<Pod | undefined> => {
    const found = await kube('GET', `/pods/${name}`);
    if (found.status === 404) return undefined;
    if (found.status !== 200) throw kubeError(found, 'read the place');
    return found.body as Pod;
  };

  /** Deletes a pod and waits until it is gone. */
  async function removePod(name: string, graceSeconds: number) {
    const gone = await kube('DELETE', `/pods/${name}?gracePeriodSeconds=${String(graceSeconds)}`);
    if (gone.status !== 200 && gone.status !== 202 && gone.status !== 404) {
      throw kubeError(gone, 'remove the place’s pod');
    }
    for (let tries = 0; tries < patience.tries; tries++) {
      if (!(await readPod(name))) return;
      await wait(patience.everyMs);
    }
    throw new Error(`Kubernetes did not remove ${name} in time`);
  }

  /** The last line a pod wrote: why it failed, in the worker's words. */
  async function lastLine(name: string): Promise<string> {
    const log = await kube('GET', `/pods/${name}/log?tailLines=5`);
    const text = typeof log.body === 'string' ? log.body : '';
    return text.trim().split('\n').at(-1)?.trim() ?? '';
  }

  /** Runs a pod of the place's kind to its end: whether it succeeded, and its last line. */
  async function runOnce(name: string, body: object, what: string) {
    await removePod(name, 0);
    const made = await kube('POST', '/pods', body);
    if (made.status !== 201) throw kubeError(made, what);
    try {
      for (let tries = 0; tries < patience.tries; tries++) {
        const phase = (await readPod(name))?.status?.phase;
        if (phase === 'Succeeded') return { ok: true, said: '' };
        if (phase === 'Failed') return { ok: false, said: await lastLine(name) };
        await wait(patience.everyMs);
      }
      throw new Error(`Kubernetes did not ${what} in time`);
    } finally {
      await removePod(name, 0);
    }
  }

  async function hasClaim(id: string) {
    const found = await kube('GET', `/persistentvolumeclaims/${names(id).home}`);
    if (found.status === 404) return false;
    if (found.status !== 200) throw kubeError(found, 'read the place’s volume');
    return true;
  }

  /** A pod that is or will be running, not one on its way out or ended. */
  const alive = (pod: Pod | undefined) =>
    pod !== undefined &&
    !pod.metadata?.deletionTimestamp &&
    (pod.status?.phase === 'Running' || pod.status?.phase === 'Pending');

  async function wake(id: string) {
    const n = names(id);
    const pod = await readPod(n.pod);
    if (alive(pod)) return;
    if (!(await hasClaim(id))) throw new Refusal(404, 'This person has no place');
    // An ended pod, or one on its way out, makes way for the new one.
    if (pod) await removePod(n.pod, 30);
    const made = await kube(
      'POST',
      '/pods',
      placePod(settings, id, n.pod, { args: ['run'], restart: 'OnFailure' }),
    );
    if (made.status !== 201 && made.status !== 409) throw kubeError(made, 'wake the place');
  }

  return {
    async status(id) {
      const pod = await readPod(names(id).pod);
      if (alive(pod)) {
        const startedAt = pod?.status?.startTime;
        return { state: 'awake', ...(startedAt && { startedAt }) };
      }
      return { state: (await hasClaim(id)) ? 'asleep' : 'none' };
    },

    async create(id, code) {
      const n = names(id);
      for (const [claim, size] of [
        [n.home, CLAIMS.home],
        [n.seat, CLAIMS.seat],
      ] as const) {
        const made = await kube('POST', '/persistentvolumeclaims', {
          apiVersion: 'v1',
          kind: 'PersistentVolumeClaim',
          metadata: { name: claim, labels: { [LABEL]: id } },
          spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: size } } },
        });
        // 409: a claim a failed create left behind.
        if (made.status !== 201 && made.status !== 409) {
          throw kubeError(made, 'make the place’s volume');
        }
      }
      // The one-time code pairs the seat, and the connection stays on the seat volume.
      const paired = await runOnce(
        n.connect,
        placePod(settings, id, n.connect, {
          args: ['connect', code, '--server', settings.serverUrl],
          restart: 'Never',
        }),
        'pair the place',
      );
      if (!paired.ok) {
        // The claims hold nothing yet, and a place with claims counts as made.
        for (const claim of [n.home, n.seat])
          await kube('DELETE', `/persistentvolumeclaims/${claim}`);
        const said = paired.said ? `: ${paired.said}` : '';
        throw new Refusal(502, `The place could not connect to the server${said}`);
      }
      await wake(id);
    },

    wake,

    async sleep(id) {
      // The worker is told to stop and given time to: a run in progress is finished as cancelled.
      if (!(await hasClaim(id))) throw new Refusal(404, 'This person has no place');
      await removePod(names(id).pod, 30);
    },

    async remove(id) {
      const n = names(id);
      for (const pod of [n.pod, n.connect, n.fresh]) await removePod(pod, 0);
      for (const claim of [n.home, n.seat]) {
        const gone = await kube('DELETE', `/persistentvolumeclaims/${claim}`);
        if (gone.status !== 200 && gone.status !== 202 && gone.status !== 404) {
          throw kubeError(gone, 'remove the place’s volume');
        }
      }
    },

    // In the place itself while it is awake: a volume of one node may not be mounted by a second
    // pod elsewhere. Asleep, in a pod of the place's kind that ends with it.
    async removeFolders(id, agent) {
      const n = names(id);
      const target = `/seat/folders/${agent}`;
      if (alive(await readPod(n.pod))) {
        const removing = await settings.exec(n.pod, ['rm', '-rf', target], { tty: false });
        removing.stream.resume();
        if (!(await removing.ended)) throw new Error('The place could not empty the folders');
        return;
      }
      const emptied = await runOnce(
        n.fresh,
        placePod(settings, id, n.fresh, {
          command: ['rm'],
          args: ['-rf', target],
          restart: 'Never',
        }),
        'empty the folders',
      );
      if (!emptied.ok) throw new Error(`The place could not empty the folders: ${emptied.said}`);
    },

    // A pod's containers are set when it is made: the place is made again with the services.
    // Only between runs, when the worker has no run to lose.
    async services(id, shape) {
      const n = names(id);
      const pod = await readPod(n.pod);
      if (alive(pod) && pod?.metadata?.annotations?.[SHAPE] === shapeOf(shape)) return;
      if (!(await hasClaim(id))) throw new Refusal(404, 'This person has no place');
      if (pod) await removePod(n.pod, 30);
      const made = await kube(
        'POST',
        '/pods',
        placePod(settings, id, n.pod, { args: ['run'], restart: 'OnFailure' }, shape),
      );
      if (made.status !== 201) throw kubeError(made, 'make the place with its services');
      // Ready once every container runs: the images are pulled and the services started.
      for (let tries = 0; tries < patience.tries * 3; tries++) {
        const status = (await kube('GET', `/pods/${n.pod}`)).body as {
          status?: {
            containerStatuses?: {
              ready?: boolean;
              state?: { waiting?: { reason?: string; message?: string } };
            }[];
          };
        };
        const containers = status.status?.containerStatuses ?? [];
        const stuck = containers.find((container) =>
          [
            'ErrImagePull',
            'ImagePullBackOff',
            'InvalidImageName',
            'CreateContainerConfigError',
          ].includes(container.state?.waiting?.reason ?? ''),
        );
        if (stuck) {
          throw new Error(
            `Kubernetes could not start a service: ${stuck.state?.waiting?.reason ?? ''} ${stuck.state?.waiting?.message ?? ''}`.trim(),
          );
        }
        if (containers.length === shape.services.length + 1 && containers.every((c) => c.ready))
          return;
        await wait(patience.everyMs);
      }
      throw new Error('Kubernetes did not start the services in time');
    },

    async shell(id) {
      const n = names(id);
      // A woken pod takes a moment to run its container.
      for (let tries = 0; tries < patience.tries; tries++) {
        if ((await readPod(n.pod))?.status?.phase === 'Running') break;
        await wait(patience.everyMs);
      }
      const opened = await settings.exec(n.pod, SHELL, { tty: true });
      return {
        stream: opened.stream,
        resize: async (cols, rows) => opened.resize(cols, rows),
      };
    },
  };
}
