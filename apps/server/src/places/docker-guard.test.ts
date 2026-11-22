import { describe, expect, it } from 'vitest';
import {
  callAllowed,
  containerAllowed,
  cutInfo,
  cutInspect,
  joinAllowed,
  madeByLauncher,
} from './docker-guard.js';

// What the docker guard keeps from a launcher broken into: each a way to the host's root.

const settings = {
  runtimes: ['runsc', 'runsc-docker'],
  sandboxRuntime: 'runsc-docker',
  peers: ['app', 'place-egress'],
};
const place = 'agentome-place-0a1b2c3d';
const base = {
  Labels: { 'ai.agentome.place': '0a1b2c3d' },
  HostConfig: { NetworkMode: place, Runtime: 'runsc', SecurityOpt: ['no-new-privileges:true'] },
};
const refused = (body: Record<string, unknown>, name = `${place}-x`) =>
  containerAllowed(
    name,
    { ...base, ...body, HostConfig: { ...base.HostConfig, ...(body.HostConfig as object) } },
    settings,
  ).ok;

describe('the docker guard', () => {
  it('lets a place’s container be made as a launcher makes it', () => {
    expect(containerAllowed(`${place}-x`, base, settings).ok).toBe(true);
  });

  it('refuses what would reach the host', () => {
    for (const host of [
      { Privileged: true },
      { Binds: ['/:/host'] },
      { Mounts: [{ Type: 'bind', Source: '/var/run/docker.sock', Target: '/s' }] },
      { Mounts: [{ Type: 'volume', Source: 'someone-elses', Target: '/v' }] },
      { Devices: [{ PathOnHost: '/dev/sda' }] },
      { PortBindings: { '22/tcp': [{ HostPort: '2222' }] } },
      { PublishAllPorts: true },
      { PidMode: 'host' },
      { IpcMode: 'host' },
      { UsernsMode: 'host' },
      { NetworkMode: 'host' },
      { NetworkMode: 'bridge' },
      { Sysctls: { 'net.ipv4.ip_forward': '1' } },
      { CapAdd: ['SYS_ADMIN'] },
      { SecurityOpt: ['seccomp=unconfined'] },
      { SecurityOpt: ['apparmor=unconfined'] },
      { Runtime: 'runc-privileged' },
      // Capabilities on runc, under the sandbox runtime's name or not: only gVisor's Docker.
      { CapAdd: ['ALL'], Runtime: 'runsc' },
      // A profile of the caller's own, or none against gaining privileges.
      { SecurityOpt: ['no-new-privileges:true', 'seccomp=/etc/own-profile.json'] },
      { SecurityOpt: [] },
    ]) {
      expect(refused({ HostConfig: host }), JSON.stringify(host)).toBe(false);
    }
    expect(refused({}, 'portainer')).toBe(false);
    // Docker's default runtime, the host's kernel, where the installation did not choose runc.
    const defaulted = { NetworkMode: place, SecurityOpt: ['no-new-privileges:true'] };
    expect(containerAllowed(`${place}-x`, { ...base, HostConfig: defaulted }, settings).ok).toBe(
      false,
    );
    expect(refused({ User: '0:0' })).toBe(false);
    expect(refused({ User: '1000:1000' })).toBe(true);
    // Where the installation chose the host's kernel, the launcher names no runtime.
    const onRunc = { ...settings, runtimes: ['runc'] };
    const plain = { ...base, HostConfig: defaulted };
    expect(containerAllowed(`${place}-x`, plain, onRunc).ok).toBe(true);
  });

  it('pulls an image by its name, and imports none from an address under any name', () => {
    const allowed = (path: string) => callAllowed('POST', path, undefined, settings).ok;
    expect(allowed('/images/create?fromImage=docker.io%2Flibrary%2Fpostgres&tag=16')).toBe(true);
    expect(
      allowed(
        '/images/create?fromSrc=http%3A%2F%2Fx.example%2Fa.tar&repo=docker.io%2Fagentome%2Fagentome&tag=0.4.0',
      ),
    ).toBe(false);
    expect(allowed('/images/create?fromImage=postgres&tag=16&repo=agentome%2Fagentome')).toBe(
      false,
    );
    expect(allowed('/images/create?tag=16')).toBe(false);
  });

  it('refuses a field in another case, a field it does not know, and the host by a volume', () => {
    // Docker reads `privileged` as Privileged and `binds` as Binds.
    for (const host of [
      { privileged: true },
      { binds: ['/:/h'] },
      { PidMode: 'container:agentome-app-1' },
      { IpcMode: 'container:agentome-app-1' },
      { SecurityOpt: ['seccomp=/etc/own-profile.json'], CapAdd: ['NET_ADMIN'] },
    ]) {
      expect(refused({ HostConfig: host }), JSON.stringify(host)).toBe(false);
    }
    for (const top of [
      { privileged: true },
      // Into the database's network, besides the place's own.
      { NetworkingConfig: { EndpointsConfig: { agentome_default: {} } } },
      { Labels: { 'ai.agentome.place': 'x', 'com.docker.compose.service': 'app' } },
      { Labels: {} },
    ]) {
      expect(refused(top), JSON.stringify(top)).toBe(false);
    }
    const allowed = (method: string, path: string, body?: Record<string, unknown>) =>
      callAllowed(method, path, body, settings).ok;
    // A volume that is a folder of the host, by its driver's options.
    expect(
      allowed('POST', '/volumes/create', {
        Name: 'agentome-place-0a1b2c3d-home',
        DriverOpts: { type: 'none', o: 'bind', device: '/' },
      }),
    ).toBe(false);
    expect(allowed('POST', `/containers/${place}/exec`, { user: 'root', User: '1000:1000' })).toBe(
      false,
    );
    expect(allowed('POST', `/containers/${place}/start`, { anything: true })).toBe(false);
  });

  it("acts on containers a launcher made, by their labels, not the installation's own", () => {
    expect(madeByLauncher({ 'ai.agentome.place': '0a1b' })).toBe(true);
    // The egress proxy's name looks like a place's; its labels are compose's.
    expect(
      madeByLauncher({
        'com.docker.compose.project': 'agentome',
        'com.docker.compose.service': 'place-egress',
      }),
    ).toBe(false);
    expect(
      madeByLauncher({ 'ai.agentome.place': 'x', 'com.docker.compose.project': 'agentome' }),
    ).toBe(false);
    expect(madeByLauncher(undefined)).toBe(false);
  });

  it("lets a run's own Docker have its capabilities under gVisor alone", () => {
    expect(
      refused(
        {
          HostConfig: {
            CapAdd: ['ALL'],
            SecurityOpt: ['seccomp=unconfined', 'no-new-privileges:true'],
            Runtime: 'runsc-docker',
          },
        },
        'agentome-run-9e8d-docker',
      ),
    ).toBe(true);
  });

  it('passes only the calls a launcher makes', () => {
    const allowed = (method: string, path: string, body?: Record<string, unknown>) =>
      callAllowed(method, path, body, settings).ok;
    expect(allowed('GET', '/containers/json?all=true')).toBe(false);
    expect(allowed('POST', '/containers/portainer/start')).toBe(false);
    expect(allowed('DELETE', '/containers/agentome-app-1?force=true')).toBe(false);
    expect(allowed('POST', `/containers/${place}/exec`, { User: 'root', Cmd: ['sh'] })).toBe(false);
    expect(
      allowed('POST', `/containers/${place}/exec`, { User: '1000:1000', Privileged: true }),
    ).toBe(false);
    expect(allowed('POST', '/networks/create', { Name: `${place}-n`, Internal: false })).toBe(
      false,
    );
    expect(allowed('POST', '/networks/create', { Name: 'bridge2', Internal: true })).toBe(false);
    expect(allowed('POST', '/networks/agentome-places/connect', { Container: place })).toBe(false);
    expect(allowed('DELETE', '/volumes/agentome-data')).toBe(false);
    expect(allowed('POST', '/swarm/init')).toBe(false);
    expect(allowed('POST', '/build')).toBe(false);
    // What it does make.
    expect(allowed('POST', `/containers/${place}/stop?t=10`)).toBe(true);
    expect(allowed('POST', `/containers/${place}/exec`, { User: '1000:1000', Cmd: ['bash'] })).toBe(
      true,
    );
    expect(allowed('POST', '/networks/create', { Name: `${place}-n`, Internal: true })).toBe(true);
    expect(allowed('POST', '/volumes/create', { Name: 'agentome-run-9e8d-docker' })).toBe(true);
  });

  it("joins a place's network with places, runs and the installation's app and proxy only", () => {
    expect(joinAllowed(`${place}-x`, {}, settings)).toBe(true);
    expect(joinAllowed('agentome-app-1', { 'com.docker.compose.service': 'app' }, settings)).toBe(
      true,
    );
    expect(
      joinAllowed('agentome-postgres-1', { 'com.docker.compose.service': 'postgres' }, settings),
    ).toBe(false);
    expect(joinAllowed('someone', undefined, settings)).toBe(false);
  });

  it('shows of a container not ours its name and labels, not its environment', () => {
    const app = {
      Id: 'abc',
      Name: '/agentome-app-1',
      Config: { Labels: { a: 'b' }, Env: ['AGENTOME_POSTGRES_PASSWORD=secret'] },
      Mounts: [{ Source: '/srv/data' }],
    };
    expect(cutInspect('agentome-app-1', app)).toEqual({
      Id: 'abc',
      Name: '/agentome-app-1',
      Config: { Labels: { a: 'b' } },
    });
    expect(cutInspect(place, app)).toBe(app);
  });

  it("answers Docker's info with its runtimes alone", () => {
    expect(callAllowed('GET', '/info', undefined, settings).ok).toBe(true);
    const info = {
      Name: 'host-1',
      Runtimes: { runsc: { path: '/usr/local/bin/runsc', runtimeArgs: ['--net-raw'] } },
      SecurityOptions: ['name=seccomp'],
      Swarm: { NodeAddr: '10.0.0.5' },
    };
    expect(cutInfo(info)).toEqual({ Runtimes: { runsc: { path: '/usr/local/bin/runsc' } } });
  });
});
