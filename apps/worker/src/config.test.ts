import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readSettings } from './config.js';

describe('readSettings', () => {
  it('has a default for every setting', () => {
    expect(readSettings({})).toEqual({
      home: join(homedir(), '.agentome'),
      idleMinutes: 15,
      keepWorkspaces: false,
      server: false,
    });
  });

  it('reads the settings of the environment', () => {
    const env = {
      AGENTOME_WORKER_HOME: 'worker',
      AGENTOME_WORKER_IDLE_MINUTES: '30',
      AGENTOME_WORKER_KEEP_WORKSPACES: '1',
      AGENTOME_WORKER_SERVER: '1',
    };
    expect(readSettings(env)).toEqual({
      home: resolve('worker'),
      idleMinutes: 30,
      keepWorkspaces: true,
      server: true,
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
