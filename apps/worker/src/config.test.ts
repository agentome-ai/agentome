import { chmodSync, mkdtempSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { privateFolder, readSettings } from './config.js';

describe('readSettings', () => {
  it('has a default for every setting', () => {
    expect(readSettings({})).toEqual({
      home: join(homedir(), '.agentome'),
      idleMinutes: 15,
      keepWorkspaces: false,
      server: false,
      place: false,
    });
  });

  it('reads the settings of the environment', () => {
    const env = {
      AGENTOME_WORKER_HOME: 'worker',
      AGENTOME_WORKER_IDLE_MINUTES: '30',
      AGENTOME_WORKER_KEEP_WORKSPACES: '1',
      AGENTOME_WORKER_SERVER: '1',
      AGENTOME_WORKER_PLACE: '1',
    };
    expect(readSettings(env)).toEqual({
      home: resolve('worker'),
      idleMinutes: 30,
      keepWorkspaces: true,
      server: true,
      place: true,
    });
  });

  it('refuses an idle time that is not a whole number of minutes', () => {
    for (const minutes of ['0', '1.5', 'soon']) {
      expect(() => readSettings({ AGENTOME_WORKER_IDLE_MINUTES: minutes })).toThrow(
        'AGENTOME_WORKER_IDLE_MINUTES',
      );
    }
  });
});

describe('privateFolder', () => {
  const folder = () => mkdtempSync(join(tmpdir(), 'agentome-private-'));
  const modeOf = (path: string) => statSync(path).mode & 0o777;

  it("makes the worker's own folder its alone", () => {
    const own = folder();
    chmodSync(own, 0o755);
    privateFolder(own);
    expect(modeOf(own)).toBe(0o700);
  });

  it("takes a volume's root that is another's as it is", () => {
    const shared = folder();
    chmodSync(shared, 0o777);
    privateFolder(shared, 99_999);
    expect(modeOf(shared)).toBe(0o777);
  });
});
