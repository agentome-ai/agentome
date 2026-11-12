import { describe, expect, it } from 'vitest';

import {
  isSupervisorProcess,
  launchdPlist,
  serviceSpec,
  systemdUnit,
  windowsArg,
  windowsTask,
} from './service.js';
import type { ServiceSpec } from './service.js';

// Only the files: installing a service in a test would start a worker on the machine running it.

const spec: ServiceSpec = {
  program: [
    '/opt/node/bin/node',
    '--import',
    'file:///opt/tsx/loader.mjs',
    '/home/maria/R&D 100% $x/cli.ts',
    'run',
  ],
  env: { PATH: '/home/maria/.local/bin:/usr/bin:/bin', AGENTOME_WORKER_IDLE_MINUTES: '30' },
  workingDirectory: '/home/maria/.agentome',
  logFile: '/home/maria/.agentome/logs/worker.log',
};

describe('the service files', () => {
  it('make a launchd agent that starts at login and is restarted after a crash only', () => {
    expect(launchdPlist(spec)).toMatchInlineSnapshot(`
      "<?xml version="1.0" encoding="UTF-8"?>
      <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
      <!-- Written by agentome-worker install-service; uninstall-service removes it. -->
      <plist version="1.0">
      <dict>
        <key>Label</key><string>ai.agentome.worker</string>
        <key>ProgramArguments</key>
        <array>
          <string>/opt/node/bin/node</string>
          <string>--import</string>
          <string>file:///opt/tsx/loader.mjs</string>
          <string>/home/maria/R&amp;D 100% $x/cli.ts</string>
          <string>run</string>
        </array>
        <key>EnvironmentVariables</key>
        <dict>
          <key>PATH</key><string>/home/maria/.local/bin:/usr/bin:/bin</string>
          <key>AGENTOME_WORKER_IDLE_MINUTES</key><string>30</string>
        </dict>
        <key>WorkingDirectory</key><string>/home/maria/.agentome</string>
        <key>RunAtLoad</key><true/>
        <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
        <key>ExitTimeOut</key><integer>60</integer>
        <key>StandardOutPath</key><string>/home/maria/.agentome/logs/worker.log</string>
        <key>StandardErrorPath</key><string>/home/maria/.agentome/logs/worker.log</string>
      </dict>
      </plist>
      "
    `);
  });

  it('make a systemd user unit with the same policy', () => {
    expect(systemdUnit(spec)).toMatchInlineSnapshot(`
      "# Written by agentome-worker install-service; uninstall-service removes it.
      [Unit]
      Description=Agentome worker
      After=network-online.target

      [Service]
      ExecStart="/opt/node/bin/node" "--import" "file:///opt/tsx/loader.mjs" "/home/maria/R&D 100%% $$x/cli.ts" "run"
      WorkingDirectory=/home/maria/.agentome
      Environment="PATH=/home/maria/.local/bin:/usr/bin:/bin"
      Environment="AGENTOME_WORKER_IDLE_MINUTES=30"
      Restart=on-failure
      RestartSec=10
      TimeoutStopSec=60
      StandardOutput=append:/home/maria/.agentome/logs/worker.log
      StandardError=append:/home/maria/.agentome/logs/worker.log

      [Install]
      WantedBy=default.target
      "
    `);
  });

  it('start this worker as it runs now, with the PATH, the network and the worker settings', () => {
    const env = {
      PATH: '/bin',
      AGENTOME_WORKER_HOME: 'relative',
      AGENTOME_WORKER_IDLE_MINUTES: '30',
      AGENTOME_WORKER_KEEP_WORKSPACES: '',
      HTTPS_PROXY: 'http://proxy.corp:3128',
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      CLAUDE_CODE_OAUTH_TOKEN: 'secret',
    };
    const { program, env: serviceEnv } = serviceSpec('/home/maria/relative', env);
    expect(program.slice(0, -2)).toEqual([process.execPath, ...process.execArgv]);
    expect(program.at(-1)).toBe('run');
    // The folder as the installing shell resolved it; no key or token of the person.
    expect(serviceEnv).toEqual({
      PATH: '/bin',
      HTTPS_PROXY: 'http://proxy.corp:3128',
      AGENTOME_WORKER_HOME: '/home/maria/relative',
      AGENTOME_WORKER_IDLE_MINUTES: '30',
    });
  });
});

describe('the Windows task', () => {
  const windows: ServiceSpec = {
    program: [
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\Users\\maria\\.agentome\\bin\\agentome-worker.mjs',
      'run',
    ],
    env: { PATH: 'C:\\Windows\\system32', AGENTOME_WORKER_HOME: 'C:\\Users\\maria\\.agentome' },
    workingDirectory: 'C:\\Users\\maria\\.agentome',
    logFile: 'C:\\Users\\maria\\.agentome\\logs\\worker.log',
  };
  const file = 'C:\\Users\\maria\\AppData\\Local\\Agentome\\worker-service.json';

  it('runs the supervisor at logon, in the session, without a window or a time limit', () => {
    const task = windowsTask(windows, file, 'CORP\\maria');
    expect(task).toContain(
      '<LogonTrigger><Enabled>true</Enabled><UserId>CORP\\maria</UserId></LogonTrigger>',
    );
    expect(task).toContain('<LogonType>InteractiveToken</LogonType>');
    expect(task).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
    expect(task).toContain('<Command>conhost.exe</Command>');
    expect(task).toContain(
      '<Arguments>--headless "C:\\Program Files\\nodejs\\node.exe" C:\\Users\\maria\\.agentome\\bin\\agentome-worker.mjs service C:\\Users\\maria\\AppData\\Local\\Agentome\\worker-service.json</Arguments>',
    );
  });

  it('quotes command-line words as the C runtime reads them back', () => {
    expect(windowsArg('plain')).toBe('plain');
    expect(windowsArg('')).toBe('""');
    expect(windowsArg('C:\\Program Files\\x')).toBe('"C:\\Program Files\\x"');
    expect(windowsArg('C:\\a b\\')).toBe('"C:\\a b\\\\"');
    expect(windowsArg('say "hi"')).toBe('"say \\"hi\\""');
  });
});

describe("the Windows task's supervisor, by its pid file", () => {
  const written = new Date('2026-11-12T12:22:15.000Z');

  it('is the node process that started before the file was written', () => {
    expect(isSupervisorProcess('node|2026-11-12T12:22:14.6000000Z\r\n', written)).toBe(true);
  });

  it('is not a process that took the pid later, nor another program, nor no answer', () => {
    expect(isSupervisorProcess('node|2026-11-12T14:05:00.0000000Z', written)).toBe(false);
    expect(isSupervisorProcess('chrome|2026-11-12T12:20:00.0000000Z', written)).toBe(false);
    expect(isSupervisorProcess('', written)).toBe(false);
  });
});
