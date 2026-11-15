import { type Docker, type DockerAttach, dockerError } from './docker.js';
import type { ServiceSpec } from '../projects/devcontainer.js';
import {
  type PlaceNetwork,
  type Places,
  placeEnv,
  sandboxMounts,
  newRunKey,
  Refusal,
  RUN_PORTS,
  runEnv,
  runMounts,
  type RunSpec,
  SERVICE_CAP_DROP,
  type Shape,
  shellFor,
  SIGN_IN,
} from './launcher.js';

// Places as containers on Docker's socket: the launcher in compose.

export interface DockerPlaceSettings extends PlaceNetwork {
  docker: Docker;
  /** Hands over an exec's stream, for a terminal. */
  attach: DockerAttach;
  /** The seat image of this release. */
  image: string;
  /**
   * The app's and the egress proxy's containers, with the names a place calls them by: each
   * place's own network joins them, and nothing else of Agentome or of another place.
   */
  peers: () => Promise<{ container: string; alias: string }[]>;
  /**
   * The runtime of places and runs (AGENTOME_PLACE_RUNTIME): `runsc` for gVisor, a kernel of
   * their own; unset, Docker's default.
   */
  runtime?: string;
  /**
   * The runtime of a run's own Docker (AGENTOME_PLACE_DOCKER_RUNTIME), gVisor's with its raw
   * network; unset, runs have none.
   */
  dockerRuntime?: string;
}

/** Docker's own image, for a run's Docker: the engine, run as root inside gVisor's kernel. */
export const DOCKER_IMAGE = 'docker.io/library/docker:28.5.2-dind';

/**
 * A run's own Docker, beside its sandbox, for testcontainers and compose: dockerd on the place's
 * network, inside gVisor's kernel (its root is the sandbox's, not the host's), its images and
 * containers in a volume of the run's, gone with it. It pulls through the egress proxy under a
 * token of its own, which opens what the run's project allows; its containers reach nothing
 * outside, the place's network being internal. The agent's folder is mounted at the same path,
 * so what a command binds from it is there. gVisor's netfilter is the legacy one, not nft.
 */
export function dockerContainer(
  settings: DockerPlaceSettings,
  id: string,
  runId: string,
  folder: string | undefined,
  hosts: string[],
) {
  const token = settings.egress.dockerTokenOf?.(runId) ?? '';
  const proxy = `http://docker-${runId}:${encodeURIComponent(token)}@${settings.egress.proxy}`;
  const { seat } = names(id);
  return {
    Image: DOCKER_IMAGE,
    Entrypoint: [
      'sh',
      '-c',
      'for t in iptables iptables-save iptables-restore ip6tables ip6tables-save ip6tables-restore; do ln -sf xtables-legacy-multi /usr/sbin/$t; done; exec dockerd -H tcp://0.0.0.0:2375 --tls=false',
    ],
    Cmd: [],
    Env: [`HTTPS_PROXY=${proxy}`, `HTTP_PROXY=${proxy}`, `NO_PROXY=localhost,127.0.0.1`],
    Labels: { [LABEL]: id, [RUN]: runId, [ROLE]: 'docker' },
    HostConfig: {
      Runtime: settings.dockerRuntime,
      // Inside gVisor: the capabilities and the syscalls are the sandbox's kernel's, which dockerd
      // needs to make its containers; none of it reaches the host's.
      CapAdd: ['ALL'],
      SecurityOpt: ['seccomp=unconfined', 'no-new-privileges:true'],
      Init: true,
      Mounts: [
        { Type: 'volume', Source: dockerVolume(runId), Target: '/var/lib/docker' },
        ...(folder
          ? [
              {
                Type: 'volume',
                Source: seat,
                Target: `/seat/${folder}`,
                VolumeOptions: { Subpath: folder },
              },
            ]
          : []),
      ],
      Memory: 8 * 1024 ** 3,
      PidsLimit: 2048,
      NanoCpus: 2_000_000_000,
      NetworkMode: placeNetwork(id),
      ExtraHosts: hosts,
      Dns: NO_RESOLVER,
    },
  };
}

/** A run's Docker's images and containers: a volume of the run's, deleted with it. */
const dockerVolume = (runId: string) => `agentome-run-${runId}-docker`;

/** A place's own network: internal, its place and runs, the app and the egress proxy on it. */
export const placeNetwork = (id: string) => `agentome-place-${id}`;

const NAME = 'agentome-place-';
const LABEL = 'ai.agentome.place';
const SERVICE = 'ai.agentome.service';
const PROJECT = 'ai.agentome.project';
const HASH = 'ai.agentome.hash';
const RUN = 'ai.agentome.run';
const ROLE = 'ai.agentome.role';

/** A project's services in a place: a network of their own, their containers and volumes. */
const projectNames = (id: string, project: string) => {
  const network = `${NAME}${id}-${project.replaceAll('-', '').slice(0, 12)}`;
  return {
    network,
    container: (service: string) => `${network}-${service}`,
    volume: (volume: string) => `${network}-${volume}`,
  };
};

const filters = (labels: string[]) => encodeURIComponent(JSON.stringify({ label: labels }));
const runName = (runId: string, role: 'cli' | 'sandbox' | 'docker' = 'cli') =>
  role === 'cli' ? `agentome-run-${runId}` : `agentome-run-${runId}-${role}`;
const names = (id: string) => ({
  container: `${NAME}${id}`,
  connect: `${NAME}${id}-connect`,
  fresh: `${NAME}${id}-fresh`,
  // The person's sign-in to the CLIs, and the seat: its connection, the CLI it installs, the
  // agents' working folders. Both outlive sleep; deleting the place deletes them.
  home: `${NAME}${id}-home`,
  seat: `${NAME}${id}-seat`,
});

/** A resolver nobody answers on: Docker forwards names it does not know here, and they fail. */
const NO_RESOLVER = ['127.0.0.1'];

/**
 * A place's container: the worker as the person's place, no capability and no way to gain one,
 * a read-only root, memory, processes and CPU capped, on the places' network only.
 */
export function placeContainer(
  settings: DockerPlaceSettings,
  id: string,
  cmd: string[],
  hosts: string[] = [],
) {
  const { home, seat } = names(id);
  return {
    Image: settings.image,
    Cmd: cmd,
    Env: placeEnv(settings, id).map(([name, value]) => `${name}=${value}`),
    User: '1000:1000',
    Labels: { [LABEL]: id },
    HostConfig: {
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      ReadonlyRootfs: true,
      // exec: builds and test runs start programs from /tmp, as Go's do.
      Tmpfs: { '/tmp': 'mode=1777,size=2g,exec' },
      Mounts: [
        { Type: 'volume', Source: home, Target: '/home/node' },
        { Type: 'volume', Source: seat, Target: '/seat' },
      ],
      Memory: 8 * 1024 ** 3,
      PidsLimit: 1024,
      NanoCpus: 2_000_000_000,
      NetworkMode: placeNetwork(id),
      // The app and the proxy by name, from /etc/hosts: under gVisor Docker's resolver does not
      // answer. A name outside has nowhere to be asked, so no data leaves in a lookup; the proxy
      // resolves for itself.
      ExtraHosts: hosts,
      Dns: NO_RESOLVER,
      ...(settings.runtime && { Runtime: settings.runtime }),
      RestartPolicy: { Name: 'on-failure', MaximumRetryCount: 5 },
    },
  };
}

/** What a run's two containers take: the key each serves with, and the names they call. */
export interface RunContainers {
  keys: { cli: string; sandbox: string };
  /** `name:address` for /etc/hosts: the app and the proxy; the services too, for the sandbox. */
  hosts: { cli: string[]; sandbox: string[] };
}

/**
 * A run's two containers, the place's image and user, locked down as the place is.
 * The CLI container holds the CLI, read-only from the seat volume, the person's sign-in from the home
 * volume, the run's folder and its agent's folder for the repository. The sandbox, where every
 * command of the agent runs, hold the agent's folder, the run's folder read-only and nothing of
 * the sign-in. Each has its own /tmp and home, in memory: a command leaves nothing where the
 * the CLI reads (the working folder a command leaves comes back with its exit).
 */
export function runContainers(
  settings: DockerPlaceSettings,
  id: string,
  runId: string,
  folder: string | undefined,
  given: RunContainers,
) {
  const { home, seat } = names(id);
  const container = (role: 'cli' | 'sandbox', mounts: object[]) => ({
    Image: settings.image,
    Cmd: ['run-server', runId],
    Env: [
      ...runEnv(settings),
      ['AGENTOME_RUN_KEY', given.keys[role]],
      ['AGENTOME_RUN_PORT', String(RUN_PORTS[role])],
      ['AGENTOME_RUN_ROLE', role],
    ].map(([name, value]) => `${name}=${value}`),
    User: '1000:1000',
    Labels: { [LABEL]: id, [RUN]: runId, [ROLE]: role },
    HostConfig: {
      // Docker's init as the first process: it reaps what a killed command left behind.
      Init: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      ReadonlyRootfs: true,
      // Each its own /tmp and home, in memory: the sandbox leaves nothing where the CLI container reads.
      Tmpfs: {
        '/tmp': 'mode=1777,size=2g,exec',
        '/home/node': 'mode=0755,uid=1000,gid=1000,size=2g,exec',
      },
      Mounts: mounts,
      Memory: 8 * 1024 ** 3,
      PidsLimit: 1024,
      NanoCpus: 2_000_000_000,
      NetworkMode: placeNetwork(id),
      ExtraHosts: given.hosts[role],
      Dns: NO_RESOLVER,
      ...(settings.runtime && { Runtime: settings.runtime }),
    },
  });
  const onSeat = (mount: { subPath: string; path: string; readOnly: boolean }) => ({
    Type: 'volume',
    Source: seat,
    Target: mount.path,
    ReadOnly: mount.readOnly,
    VolumeOptions: { Subpath: mount.subPath },
  });
  const all = runMounts(runId, folder);
  return {
    cli: container('cli', [
      ...all.map(onSeat),
      ...Object.values(SIGN_IN).map((path) => ({
        Type: 'volume',
        Source: home,
        Target: path,
        VolumeOptions: { Subpath: path.slice('/home/node/'.length) },
      })),
    ]),
    // No CLI and no sign-in; of the run's folder, what a command works in and reads.
    sandbox: container(
      'sandbox',
      all
        .filter((mount) => mount.subPath !== 'cli')
        .flatMap((mount) =>
          (mount.subPath === `runs/${runId}` ? sandboxMounts(runId) : [mount]).map(onSeat),
        ),
    ),
  };
}

/**
 * A service beside the agent: its image as the repository names it, on the project's own network
 * only, reached by its name; no privilege to gain, memory, processes and CPU capped. It keeps the
 * image's user and the capabilities a database needs to set itself up (owning and switching to
 * its user); the ones that reach past it — raw packets, device files — are dropped.
 */
export function serviceContainer(id: string, shape: Shape, service: ServiceSpec) {
  const n = projectNames(id, shape.project);
  return {
    Image: service.image,
    ...(service.command && { Cmd: service.command }),
    Env: Object.entries(service.environment).map(([name, value]) => `${name}=${value}`),
    Labels: { [LABEL]: id, [SERVICE]: service.name, [PROJECT]: shape.project, [HASH]: shape.hash },
    HostConfig: {
      NetworkMode: n.network,
      SecurityOpt: ['no-new-privileges:true'],
      CapDrop: SERVICE_CAP_DROP,
      Mounts: service.volumes.map((volume) => ({
        Type: 'volume',
        Source: n.volume(volume.name),
        Target: volume.target,
      })),
      Memory: 2 * 1024 ** 3,
      PidsLimit: 512,
      NanoCpus: 1_000_000_000,
      RestartPolicy: { Name: 'on-failure', MaximumRetryCount: 5 },
    },
    NetworkingConfig: { EndpointsConfig: { [n.network]: { Aliases: [service.name] } } },
  };
}

/** The repository and tag (or digest) Docker pulls an image reference by. */
export function pullOf(image: string): { from: string; tag: string } {
  const digest = image.indexOf('@');
  if (digest > 0) {
    // name[:tag]@sha256:…: the digest is what is pulled; a tag beside it says nothing more.
    const name = image.slice(0, digest);
    const colon = name.lastIndexOf(':');
    return {
      from: colon > name.lastIndexOf('/') ? name.slice(0, colon) : name,
      tag: image.slice(digest + 1),
    };
  }
  const at = image.lastIndexOf(':');
  return at > image.lastIndexOf('/')
    ? { from: image.slice(0, at), tag: image.slice(at + 1) }
    : { from: image, tag: 'latest' };
}

async function ensureImage(docker: Docker, image: string) {
  if ((await docker('GET', `/images/${encodeURIComponent(image)}/json`)).status === 200) return;
  const { from, tag } = pullOf(image);
  const pulled = await docker(
    'POST',
    `/images/create?fromImage=${encodeURIComponent(from)}&tag=${encodeURIComponent(tag)}`,
  );
  if (pulled.status !== 200) throw dockerError(pulled, `pull ${image}`);
}

export function dockerPlaces(settings: DockerPlaceSettings): Places {
  const { docker } = settings;

  /** Runs a throw-away container of the place's kind to its end; its exit code. */
  async function runOnce(name: string, body: object, what: string): Promise<number | undefined> {
    await docker('DELETE', `/containers/${name}?force=true`);
    const made = await docker('POST', `/containers/create?name=${name}`, body);
    if (made.status !== 201) throw dockerError(made, `make the container to ${what}`);
    try {
      const started = await docker('POST', `/containers/${name}/start`);
      if (started.status !== 204) throw dockerError(started, what);
      const waited = await docker('POST', `/containers/${name}/wait`);
      return (waited.body as { StatusCode?: number } | undefined)?.StatusCode;
    } finally {
      await docker('DELETE', `/containers/${name}?force=true`);
    }
  }

  /** The service containers of a place, of every project. */
  async function servicesOf(id: string) {
    const found = await docker(
      'GET',
      `/containers/json?all=true&filters=${filters([`${LABEL}=${id}`, SERVICE])}`,
    );
    if (found.status !== 200) throw dockerError(found, 'list the place’s services');
    return (
      found.body as { Names?: string[]; Labels?: Record<string, string>; State?: string }[]
    ).map((container) => ({
      name: (container.Names?.[0] ?? '').replace(/^\//, ''),
      project: container.Labels?.[PROJECT],
      hash: container.Labels?.[HASH],
      running: container.State === 'running',
    }));
  }

  /** The networks of a place's projects. */
  async function networksOf(id: string) {
    const found = await docker('GET', `/networks?filters=${filters([`${LABEL}=${id}`])}`);
    if (found.status !== 200) throw dockerError(found, 'list the place’s networks');
    return (found.body as { Name: string }[]).map((network) => network.Name);
  }

  /**
   * The place's own network, made if it is not there, with the app and the egress proxy on it
   * by their names: places do not see each other, and a recreated app finds its places again
   * the next time the place is looked at.
   */
  async function ensureNetwork(id: string) {
    const name = placeNetwork(id);
    const found = await docker('GET', `/networks/${name}`);
    if (found.status === 404) {
      const made = await docker('POST', '/networks/create', {
        Name: name,
        Internal: true,
        Labels: { [LABEL]: id },
      });
      if (made.status !== 201 && made.status !== 409)
        throw dockerError(made, 'make the place’s network');
    } else if (found.status !== 200) throw dockerError(found, 'read the place’s network');
    const on = new Set(
      Object.keys(
        (found.body as { Containers?: Record<string, unknown> } | undefined)?.Containers ?? {},
      ),
    );
    for (const peer of await settings.peers()) {
      if (
        [...on].some((idOn) => idOn.startsWith(peer.container) || peer.container.startsWith(idOn))
      )
        continue;
      const joined = await docker('POST', `/networks/${name}/connect`, {
        Container: peer.container,
        EndpointConfig: { Aliases: [peer.alias] },
      });
      const already = /already exists/.test(JSON.stringify(joined.body ?? ''));
      if (joined.status !== 200 && !already)
        throw dockerError(joined, `join ${peer.alias} to the place`);
    }
    const peers = await settings.peers();
    return hostsOn(
      name,
      peers.map((peer) => ({ match: peer.container, alias: peer.alias })),
    );
  }

  /**
   * `alias:address` on `network` of each container `match` names (by its name, or its id or a
   * prefix of it), for a container's /etc/hosts: under gVisor Docker's resolver does not answer.
   */
  async function hostsOn(network: string, wanted: { match: string; alias: string }[]) {
    const found = await docker('GET', `/networks/${network}`);
    if (found.status !== 200) throw dockerError(found, 'read a place’s network');
    const on = Object.entries(
      (found.body as { Containers?: Record<string, { Name?: string; IPv4Address?: string }> })
        .Containers ?? {},
    );
    return wanted.flatMap(({ match, alias }) => {
      const hit = on.find(
        ([idOn, container]) =>
          container.Name === match || idOn.startsWith(match) || match.startsWith(idOn),
      );
      const address = hit?.[1].IPv4Address?.split('/')[0];
      return address ? [`${alias}:${address}`] : [];
    });
  }

  /**
   * Starts a run's own Docker and answers `docker:<address>` for its sandbox's /etc/hosts, once
   * dockerd answers there.
   */
  async function startDocker(
    id: string,
    runId: string,
    folder: string | undefined,
    hosts: string[],
  ) {
    const name = runName(runId, 'docker');
    await docker('DELETE', `/containers/${name}?force=true`);
    await ensureImage(docker, DOCKER_IMAGE);
    const volume = await docker('POST', '/volumes/create', {
      Name: dockerVolume(runId),
      Labels: { [LABEL]: id, [RUN]: runId },
    });
    if (volume.status !== 201) throw dockerError(volume, 'make the run’s Docker’s volume');
    const made = await docker(
      'POST',
      `/containers/create?name=${name}`,
      dockerContainer(settings, id, runId, folder, hosts),
    );
    if (made.status !== 201) throw dockerError(made, 'make the run’s Docker');
    const started = await docker('POST', `/containers/${name}/start`);
    if (started.status !== 204) throw dockerError(started, 'start the run’s Docker');
    const [address] = await hostsOn(placeNetwork(id), [{ match: name, alias: 'docker' }]);
    if (!address) throw new Error('The run’s Docker has no address on the place’s network');
    return [address];
  }

  /** A place's run containers: none outlives the place awake. */
  async function removeRuns(id: string) {
    const found = await docker(
      'GET',
      `/containers/json?all=true&filters=${filters([`${LABEL}=${id}`, RUN])}`,
    );
    if (found.status !== 200) throw dockerError(found, 'list the place’s runs');
    for (const container of found.body as { Names?: string[] }[]) {
      const name = (container.Names?.[0] ?? '').replace(/^\//, '');
      if (name) await docker('DELETE', `/containers/${name}?force=true`);
    }
    // And their Docker's images and containers.
    const volumes = await docker('GET', `/volumes?filters=${filters([`${LABEL}=${id}`, RUN])}`);
    if (volumes.status !== 200) throw dockerError(volumes, 'list the place’s runs’ volumes');
    for (const volume of (volumes.body as { Volumes?: { Name: string }[] }).Volumes ?? []) {
      await docker('DELETE', `/volumes/${volume.Name}?force=true`);
    }
  }

  async function stopServices(id: string) {
    for (const service of await servicesOf(id)) {
      if (service.running) await docker('POST', `/containers/${service.name}/stop?t=10`);
    }
  }

  /**
   * Wakes a place: one asleep is made anew from this release's image and settings, on the same
   * volumes, so an update reaches it and nothing of its last waking stays; one awake is left as
   * it is (its services' network joined, a run going).
   */
  async function wake(id: string) {
    const name = names(id).container;
    const found = await docker('GET', `/containers/${name}/json`);
    if (found.status === 404) throw new Refusal(404, 'This person has no place');
    if (found.status !== 200) throw dockerError(found, 'read the place');
    if ((found.body as { State?: { Running?: boolean } }).State?.Running === true) return;
    const hosts = await ensureNetwork(id);
    const gone = await docker('DELETE', `/containers/${name}?force=true`);
    if (gone.status !== 204 && gone.status !== 404) throw dockerError(gone, 'wake the place');
    await ensureImage(docker, settings.image);
    const made = await docker(
      'POST',
      `/containers/create?name=${name}`,
      placeContainer(settings, id, ['run'], hosts),
    );
    if (made.status !== 201) throw dockerError(made, 'wake the place');
    const started = await docker('POST', `/containers/${name}/start`);
    if (started.status !== 204) throw dockerError(started, 'wake the place');
  }

  /**
   * A place that no longer reaches the app or the proxy, since either came back at another
   * address: stopped with its run's containers, which hold the old addresses too, and woken
   * anew. Its run was lost already: it could not report.
   */
  async function renew(id: string) {
    const stopped = await docker('POST', `/containers/${names(id).container}/stop?t=10`);
    if (stopped.status !== 204 && stopped.status !== 304 && stopped.status !== 404)
      throw dockerError(stopped, 'restart the place');
    await removeRuns(id);
    await wake(id);
  }

  // Docker's local volumes have no size limit: what each place's hold is read from Docker's own
  // accounting, at most once a minute for all of them, which may take Docker a while.
  let usage: { at: number; bytes: Promise<Map<string, number>> } | undefined;
  function volumeBytes(): Promise<Map<string, number>> {
    if (usage && Date.now() - usage.at < 60_000) return usage.bytes;
    const bytes = docker('GET', '/system/df?type=volume').then((answer) => {
      if (answer.status !== 200) throw dockerError(answer, 'read how much the volumes hold');
      const volumes =
        (
          answer.body as {
            Volumes?: { Labels?: Record<string, string> | null; UsageData?: { Size?: number } }[];
          }
        ).Volumes ?? [];
      const byPlace = new Map<string, number>();
      for (const volume of volumes) {
        const place = volume.Labels?.[LABEL];
        const size = volume.UsageData?.Size ?? -1;
        if (place && size > 0) byPlace.set(place, (byPlace.get(place) ?? 0) + size);
      }
      return byPlace;
    });
    usage = { at: Date.now(), bytes };
    // A failure is asked again next time, not kept for a minute.
    bytes.catch(() => (usage = undefined));
    return bytes;
  }

  return {
    async status(id) {
      const found = await docker('GET', `/containers/${names(id).container}/json`);
      if (found.status === 404) return { state: 'none' };
      if (found.status !== 200) throw dockerError(found, 'read the place');
      const body = found.body as {
        State?: { Running?: boolean; StartedAt?: string };
        HostConfig?: { ExtraHosts?: string[] | null };
      };
      const state = body.State;
      // Looked at once a minute while awake: the app or the proxy made anew joins it again, at
      // an address of its own. The place knows the two by the addresses it was made with, in its
      // /etc/hosts, which cannot change while it runs: when they did, it is made anew, as on waking.
      if (state?.Running === true) {
        const hosts = await ensureNetwork(id);
        const given = body.HostConfig?.ExtraHosts ?? [];
        if ([...given].sort().join() !== [...hosts].sort().join()) await renew(id);
      }
      const diskBytes = (await volumeBytes()).get(id) ?? 0;
      return state?.Running === true
        ? { state: 'awake', diskBytes, ...(state.StartedAt && { startedAt: state.StartedAt }) }
        : { state: 'asleep', diskBytes };
    },

    async create(id, code) {
      const n = names(id);
      await ensureImage(docker, settings.image);
      for (const volume of [n.home, n.seat]) {
        const made = await docker('POST', '/volumes/create', {
          Name: volume,
          Labels: { [LABEL]: id },
        });
        if (made.status !== 201) throw dockerError(made, 'make the place’s volume');
      }
      const hosts = await ensureNetwork(id);
      // The one-time code pairs the seat, and the connection stays on the seat volume.
      const exit = await runOnce(
        n.connect,
        placeContainer(settings, id, ['connect', code, '--server', settings.serverUrl], hosts),
        'pair the place',
      );
      if (exit !== 0) throw new Refusal(502, 'The place could not connect to the server');
      const made = await docker(
        'POST',
        `/containers/create?name=${n.container}`,
        placeContainer(settings, id, ['run'], hosts),
      );
      if (made.status !== 201) throw dockerError(made, 'make the place');
      const started = await docker('POST', `/containers/${n.container}/start`);
      if (started.status !== 204) throw dockerError(started, 'start the place');
    },

    wake,

    async sleep(id) {
      // The worker is told to stop and given time to: a run in progress is finished as cancelled.
      await stopServices(id);
      const stopped = await docker('POST', `/containers/${names(id).container}/stop?t=30`);
      if (stopped.status === 404) throw new Refusal(404, 'This person has no place');
      if (stopped.status !== 204 && stopped.status !== 304)
        throw dockerError(stopped, 'put the place to sleep');
      // After the worker had its time to finish its run: whatever the run left goes.
      await removeRuns(id);
    },

    async remove(id) {
      const n = names(id);
      for (const container of [n.container, n.connect, n.fresh]) {
        const gone = await docker('DELETE', `/containers/${container}?force=true`);
        if (gone.status !== 204 && gone.status !== 404) throw dockerError(gone, 'remove the place');
      }
      await removeRuns(id);
      for (const service of await servicesOf(id)) {
        await docker('DELETE', `/containers/${service.name}?force=true`);
      }
      for (const network of await networksOf(id)) await docker('DELETE', `/networks/${network}`);
      const volumes = await docker('GET', `/volumes?filters=${filters([`${LABEL}=${id}`])}`);
      const named = (volumes.body as { Volumes?: { Name: string }[] } | undefined)?.Volumes ?? [];
      for (const volume of new Set([n.home, n.seat, ...named.map((found) => found.Name)])) {
        const gone = await docker('DELETE', `/volumes/${volume}`);
        if (gone.status !== 204 && gone.status !== 404)
          throw dockerError(gone, 'remove the place’s volume');
      }
    },

    async services(id, shape) {
      const n = projectNames(id, shape.project);
      const place = names(id).container;
      if ((await docker('GET', `/networks/${n.network}`)).status === 404) {
        // Internal: the services reach each other and the agent, and nothing outside.
        const made = await docker('POST', '/networks/create', {
          Name: n.network,
          Internal: true,
          Labels: { [LABEL]: id, [PROJECT]: shape.project },
        });
        if (made.status !== 201) throw dockerError(made, 'make the services’ network');
      }
      // Another project's services stop, and the place leaves their network: two projects may
      // both have a `db`. This project's that are gone or changed are made anew.
      const wanted = new Set(shape.services.map((service) => n.container(service.name)));
      for (const service of await servicesOf(id)) {
        if (service.project !== shape.project) {
          if (service.running) await docker('POST', `/containers/${service.name}/stop?t=10`);
        } else if (!wanted.has(service.name) || service.hash !== shape.hash) {
          await docker('DELETE', `/containers/${service.name}?force=true`);
        }
      }
      for (const network of await networksOf(id)) {
        // The place's own network stays: it is how the place reaches the app.
        if (network !== n.network && network !== placeNetwork(id)) {
          await docker('POST', `/networks/${network}/disconnect`, {
            Container: place,
            Force: true,
          });
        }
      }
      const joined = await docker('POST', `/networks/${n.network}/connect`, { Container: place });
      const already = /already exists/.test(JSON.stringify(joined.body ?? ''));
      if (joined.status !== 200 && !already)
        throw dockerError(joined, 'join the services’ network');
      for (const service of shape.services) {
        const name = n.container(service.name);
        if ((await docker('GET', `/containers/${name}/json`)).status === 404) {
          await ensureImage(docker, service.image);
          for (const volume of service.volumes) {
            const made = await docker('POST', '/volumes/create', {
              Name: n.volume(volume.name),
              Labels: { [LABEL]: id, [PROJECT]: shape.project },
            });
            if (made.status !== 201) throw dockerError(made, `make the volume of ${service.name}`);
          }
          const made = await docker(
            'POST',
            `/containers/create?name=${name}`,
            serviceContainer(id, shape, service),
          );
          if (made.status !== 201) throw dockerError(made, `make ${service.name}`);
        }
        const started = await docker('POST', `/containers/${name}/start`);
        if (started.status !== 204 && started.status !== 304) {
          throw dockerError(started, `start ${service.name}`);
        }
      }
      await wake(id);
    },

    async startRun(id, runId, run: RunSpec) {
      const keys = { cli: newRunKey(), sandbox: newRunKey() };
      const place = await ensureNetwork(id);
      const project = run.shape && projectNames(id, run.shape.project);
      // The sandbox reaches the project's services by their names, from /etc/hosts too.
      const services =
        project && run.shape
          ? await hostsOn(
              project.network,
              run.shape.services.map((service) => ({
                match: project.container(service.name),
                alias: service.name,
              })),
            )
          : [];
      // The run's own Docker first: the sandbox finds it by name.
      const ownDocker = settings.dockerRuntime
        ? await startDocker(id, runId, run.folder, place)
        : [];
      // The place too, by its address: the run's containers knock on it as they start.
      const self = await hostsOn(placeNetwork(id), [
        { match: names(id).container, alias: 'place' },
      ]);
      const bodies = runContainers(settings, id, runId, run.folder, {
        keys,
        hosts: {
          cli: [...place, ...self],
          sandbox: [...place, ...self, ...services, ...ownDocker],
        },
      });
      const at: Partial<Record<'cli' | 'sandbox', string>> = {};
      for (const role of ['sandbox', 'cli'] as const) {
        const name = runName(runId, role);
        await docker('DELETE', `/containers/${name}?force=true`);
        const made = await docker('POST', `/containers/create?name=${name}`, bodies[role]);
        if (made.status !== 201) throw dockerError(made, `make the run’s ${role}`);
        if (role === 'sandbox' && project) {
          const joined = await docker('POST', `/networks/${project.network}/connect`, {
            Container: name,
          });
          if (joined.status !== 200) throw dockerError(joined, 'join the services’ network');
        }
        const started = await docker('POST', `/containers/${name}/start`);
        if (started.status !== 204) throw dockerError(started, `start the run’s ${role}`);
        const [address] = await hostsOn(placeNetwork(id), [{ match: name, alias: role }]);
        if (!address) throw new Error(`The run’s ${role} has no address on the place’s network`);
        at[role] = address.slice(role.length + 1);
      }
      return {
        cli: { host: at.cli ?? '', port: RUN_PORTS.cli, key: keys.cli },
        sandbox: { host: at.sandbox ?? '', port: RUN_PORTS.sandbox, key: keys.sandbox },
        ...(ownDocker.length > 0 && { docker: true }),
      };
    },

    async endRun(_id, runId) {
      for (const role of ['cli', 'sandbox', 'docker'] as const) {
        const gone = await docker('DELETE', `/containers/${runName(runId, role)}?force=true`);
        if (gone.status !== 204 && gone.status !== 404) throw dockerError(gone, 'end the run');
      }
      const volume = await docker('DELETE', `/volumes/${dockerVolume(runId)}?force=true`);
      if (volume.status !== 204 && volume.status !== 404) {
        throw dockerError(volume, 'delete the run’s Docker');
      }
    },

    // In a throw-away container of the place's own kind: nothing else of the place is touched.
    async removeFolders(id, agent) {
      await runOnce(
        names(id).fresh,
        {
          ...placeContainer(settings, id, []),
          Entrypoint: ['rm', '-rf', `/seat/folders/${agent}`],
        },
        'empty the folders',
      );
    },

    async shell(id) {
      const made = await docker('POST', `/containers/${names(id).container}/exec`, {
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: true,
        User: '1000:1000',
        Cmd: shellFor(settings, id),
      });
      if (made.status !== 201) throw dockerError(made, 'open a terminal');
      const exec = (made.body as { Id: string }).Id;
      const stream = await settings.attach(exec);
      return {
        stream,
        resize: async (cols, rows) =>
          void (await docker('POST', `/exec/${exec}/resize?h=${String(rows)}&w=${String(cols)}`)),
      };
    },
  };
}
