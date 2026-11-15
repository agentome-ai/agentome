import { describe, expect, it } from 'vitest';
import { callAllowed, containerAllowed, cutInspect, joinAllowed } from './docker-guard.js';

// What the docker guard keeps from a launcher broken into: each a way to the host's root.

const settings = {
  runtimes: ['runsc', 'runsc-docker'],
  sandboxRuntime: 'runsc-docker',
  peers: ['app', 'place-egress'],
};
const place = 'agentome-place-0a1b2c3d';
const base = { HostConfig: { NetworkMode: place } };
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
    ]) {
      expect(refused({ HostConfig: host }), JSON.stringify(host)).toBe(false);
    }
    expect(refused({}, 'portainer')).toBe(false);
  });

  it("lets a run's own Docker have its capabilities under gVisor alone", () => {
    expect(
      refused(
        {
          HostConfig: {
            CapAdd: ['ALL'],
            SecurityOpt: ['seccomp=unconfined'],
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
});
