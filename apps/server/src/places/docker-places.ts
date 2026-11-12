import { type Docker, type DockerAttach, dockerError } from './docker.js';
import type { ServiceSpec } from '../projects/devcontainer.js';
import {
  type PlaceNetwork,
  type Places,
  placeEnv,
  Refusal,
  type Shape,
  SHELL,
} from './launcher.js';

// Places as containers on Docker's socket: the launcher in compose.

export interface DockerPlaceSettings extends PlaceNetwork {
  docker: Docker;
  /** Hands over an exec's stream, for a terminal. */
  attach: DockerAttach;
  /** The seat image of this release. */
  image: string;
  /** The Docker network the places share with the app and the egress proxy, and nothing else. */
  network: string;
}

const NAME = 'agentome-place-';
const LABEL = 'ai.agentome.place';
const SERVICE = 'ai.agentome.service';
const PROJECT = 'ai.agentome.project';
const HASH = 'ai.agentome.hash';

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
const names = (id: string) => ({
  container: `${NAME}${id}`,
  connect: `${NAME}${id}-connect`,
  fresh: `${NAME}${id}-fresh`,
  // The person's sign-in to the CLIs, and the seat: its connection, the CLI it installs, the
  // agents' working folders. Both outlive sleep; deleting the place deletes them.
  home: `${NAME}${id}-home`,
  seat: `${NAME}${id}-seat`,
});

/**
 * A place's container: the worker as the person's place, no capability and no way to gain one,
 * a read-only root, memory, processes and CPU capped, on the places' network only.
 */
export function placeContainer(settings: DockerPlaceSettings, id: string, cmd: string[]) {
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
      NetworkMode: settings.network,
      RestartPolicy: { Name: 'on-failure', MaximumRetryCount: 5 },
    },
  };
}

/**
 * A service beside the agent: its image as the repository names it, on the project's own network
 * only, reached by its name; no privilege to gain, memory, processes and CPU capped. It keeps the
 * image's user and capabilities, as databases need them.
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

async function ensureImage(docker: Docker, image: string) {
  if ((await docker('GET', `/images/${encodeURIComponent(image)}/json`)).status === 200) return;
  const at = image.lastIndexOf(':');
  const [from, tag] =
    at > image.lastIndexOf('/') ? [image.slice(0, at), image.slice(at + 1)] : [image, 'latest'];
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

  async function stopServices(id: string) {
    for (const service of await servicesOf(id)) {
      if (service.running) await docker('POST', `/containers/${service.name}/stop?t=10`);
    }
  }

  async function wake(id: string) {
    const started = await docker('POST', `/containers/${names(id).container}/start`);
    // 304: it was awake already.
    if (started.status === 404) throw new Refusal(404, 'This person has no place');
    if (started.status !== 204 && started.status !== 304)
      throw dockerError(started, 'wake the place');
  }

  return {
    async status(id) {
      const found = await docker('GET', `/containers/${names(id).container}/json`);
      if (found.status === 404) return { state: 'none' };
      if (found.status !== 200) throw dockerError(found, 'read the place');
      const state = (found.body as { State?: { Running?: boolean; StartedAt?: string } }).State;
      return state?.Running === true
        ? { state: 'awake', ...(state.StartedAt && { startedAt: state.StartedAt }) }
        : { state: 'asleep' };
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
      // The one-time code pairs the seat, and the connection stays on the seat volume.
      const exit = await runOnce(
        n.connect,
        placeContainer(settings, id, ['connect', code, '--server', settings.serverUrl]),
        'pair the place',
      );
      if (exit !== 0) throw new Refusal(502, 'The place could not connect to the server');
      const made = await docker(
        'POST',
        `/containers/create?name=${n.container}`,
        placeContainer(settings, id, ['run']),
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
    },

    async remove(id) {
      const n = names(id);
      for (const container of [n.container, n.connect, n.fresh]) {
        const gone = await docker('DELETE', `/containers/${container}?force=true`);
        if (gone.status !== 204 && gone.status !== 404) throw dockerError(gone, 'remove the place');
      }
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
        if (network !== n.network) {
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
        Cmd: SHELL,
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
