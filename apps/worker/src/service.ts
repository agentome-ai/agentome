import { execFile, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';

import { sleep } from './client.js';
import { UserError } from './config.js';

// The worker as a service of the person's login session — a launchd agent on macOS, a
// `systemd --user` unit on Linux, a scheduled task at logon on Windows — so that it runs only
// while they are logged in; never a system daemon, which runs with nobody at the keyboard. Each
// restarts the worker after a crash but not after a clean exit, which is how it leaves when the
// server disconnects the computer: started again, it would only be refused again. Windows has no
// such restart for a task, so there the task runs `service`, which restarts the worker itself.

export const LAUNCHD_LABEL = 'ai.agentome.worker';
export const SYSTEMD_UNIT = 'agentome-worker.service';
export const WINDOWS_TASK = 'Agentome worker';

export interface ServiceSpec {
  /** This worker as it runs now — the same Node, loader and script — with `run`. */
  program: string[];
  env: Record<string, string>;
  workingDirectory: string;
  logFile: string;
}

/** The service file of this computer's service manager. */
export function serviceFile(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin')
    return join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
  if (platform === 'linux') return join(homedir(), '.config', 'systemd', 'user', SYSTEMD_UNIT);
  if (platform === 'win32') return join(windowsFolder(), 'worker-task.xml');
  throw new UserError(
    'The background service needs macOS, Linux or Windows. Run the worker in a terminal: agentome-worker run',
  );
}

/** Where the Windows task's files are: the person's own, outside a roaming profile. */
function windowsFolder(): string {
  return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Agentome');
}

// What the CLI needs to get online on a company network; none of it is a secret.
const NETWORK = /^((https?|no|all)_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_(FILE|DIR))$/i;

export function serviceSpec(workerHome: string, env: NodeJS.ProcessEnv = process.env): ServiceSpec {
  const passed = Object.entries(env).filter(
    (entry): entry is [string, string] =>
      !!entry[1] && (NETWORK.test(entry[0]) || entry[0].startsWith('AGENTOME_WORKER_')),
  );
  const settings = Object.fromEntries(passed);
  return {
    program: [process.execPath, ...process.execArgv, realpathSync(process.argv[1] ?? ''), 'run'],
    // A service starts with a bare PATH, without `claude`; the shell that installs it knows
    // where `claude` is. The worker's settings go with it, its folder as an absolute path.
    env: { PATH: env.PATH ?? '/usr/bin:/bin', ...settings, AGENTOME_WORKER_HOME: workerHome },
    workingDirectory: workerHome,
    logFile: join(workerHome, 'logs', 'worker.log'),
  };
}

const xml = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** `KeepAlive.SuccessfulExit = false`: restarted after a failure, not after a clean exit. */
export function launchdPlist(spec: ServiceSpec): string {
  const string = (value: string) => `<string>${xml(value)}</string>`;
  const program = spec.program.map((word) => `    ${string(word)}`);
  const env = Object.entries(spec.env).map(
    ([name, value]) => `    <key>${xml(name)}</key>${string(value)}`,
  );
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by agentome-worker install-service; uninstall-service removes it. -->
<plist version="1.0">
<dict>
  <key>Label</key>${string(LAUNCHD_LABEL)}
  <key>ProgramArguments</key>
  <array>
${program.join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env.join('\n')}
  </dict>
  <key>WorkingDirectory</key>${string(spec.workingDirectory)}
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ExitTimeOut</key><integer>60</integer>
  <key>StandardOutPath</key>${string(spec.logFile)}
  <key>StandardErrorPath</key>${string(spec.logFile)}
</dict>
</plist>
`;
}

/** A word of a unit file: systemd expands `%` specifiers everywhere and `$` in `ExecStart`. */
const quote = (word: string) =>
  `"${word.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;

/** `Restart=on-failure`: restarted after a failure, not after a clean exit. */
export function systemdUnit(spec: ServiceSpec): string {
  const exec = spec.program.map((word) => quote(word).replaceAll('$', () => '$$')).join(' ');
  const env = Object.entries(spec.env).map(
    ([name, value]) => `Environment=${quote(`${name}=${value}`)}`,
  );
  // These take the rest of the line as a path: quotes would be part of it.
  const [log, cwd] = [spec.logFile, spec.workingDirectory].map((path) =>
    path.replaceAll('%', '%%'),
  );
  return `# Written by agentome-worker install-service; uninstall-service removes it.
[Unit]
Description=Agentome worker
After=network-online.target

[Service]
ExecStart=${exec}
WorkingDirectory=${cwd}
${env.join('\n')}
Restart=on-failure
RestartSec=10
TimeoutStopSec=60
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=default.target
`;
}

/** A word of a Windows command line, as programs built with the C runtime read it back. */
export function windowsArg(word: string): string {
  if (word !== '' && !/[\s"]/.test(word)) return word;
  // Backslashes are literal but before a quote, where each counts double.
  const escaped = word.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1');
  return `"${escaped}"`;
}

/**
 * The scheduled task: at this person's logon, in their session (so the worker sees their
 * keyboard and their sign-ins), at normal priority, with no time limit. `conhost --headless`
 * keeps Node's console window from opening on their desktop.
 */
export function windowsTask(spec: ServiceSpec, specFile: string, user: string): string {
  const [node = process.execPath, ...rest] = spec.program;
  const supervisor = [node, ...rest.slice(0, -1), 'service', specFile];
  const args = ['--headless', ...supervisor].map(windowsArg).join(' ');
  return `<?xml version="1.0" encoding="UTF-16"?>
<!-- Written by agentome-worker install-service; uninstall-service removes it. -->
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Agentome worker: takes agent runs while you are logged in.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><UserId>${xml(user)}</UserId></LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>5</Priority>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>conhost.exe</Command>
      <Arguments>${xml(args)}</Arguments>
      <WorkingDirectory>${xml(spec.workingDirectory)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

const RESTART_AFTER_MS = 10_000;

/**
 * `agentome-worker service <file>`, what the Windows task runs: the worker as the file says,
 * its output appended to its log, started again ten seconds after a failure and not after a
 * clean exit. Its own pid is kept beside the file, for uninstall-service to end it and the
 * worker under it.
 */
export async function serviceMain(specFile: string | undefined): Promise<number> {
  if (specFile === undefined) return 1;
  const spec = JSON.parse(readFileSync(specFile, 'utf8')) as ServiceSpec;
  writeFileSync(join(dirname(specFile), 'supervisor.pid'), String(process.pid));
  mkdirSync(dirname(spec.logFile), { recursive: true });
  const [program = process.execPath, ...args] = spec.program;
  for (;;) {
    const log = openSync(spec.logFile, 'a');
    const code = await new Promise<number>((resolve) => {
      const child = spawn(program, args, {
        cwd: spec.workingDirectory,
        env: { ...process.env, ...spec.env },
        stdio: ['ignore', log, log],
        windowsHide: true,
      });
      child.on('error', () => resolve(1));
      child.on('exit', (exit) => resolve(exit ?? 1));
    });
    if (code === 0) {
      // Gone for good: a pid left behind could name another process by the next install.
      rmSync(join(dirname(specFile), 'supervisor.pid'), { force: true });
      return 0;
    }
    await sleep(RESTART_AFTER_MS);
  }
}

/**
 * Whether `pid` is still this worker's supervisor: Windows gives a pid to another process soon.
 * The supervisor writes its pid as it starts, so a process under that pid that started later is
 * another one. Get-Process tells a plain user that much of their own processes, where
 * Get-CimInstance is refused outside the desktop session (over SSH, say).
 */
export function isSupervisorProcess(answer: string, written: Date): boolean {
  const [name, started] = answer.trim().split('|');
  const at = Date.parse(started ?? '');
  return name === 'node' && Number.isFinite(at) && at <= written.getTime() + 1000;
}

async function isSupervisor(pid: number, written: Date): Promise<boolean> {
  const query = `$p = Get-Process -Id ${pid} -ErrorAction Stop; '{0}|{1}' -f $p.ProcessName, $p.StartTime.ToUniversalTime().ToString('o')`;
  const answer = await new Promise<string>((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', query],
      { timeout: 15_000, windowsHide: true },
      (error, stdout) => resolve(error === null ? stdout : ''),
    );
  });
  return isSupervisorProcess(answer, written);
}

/** Ends the Windows task's supervisor and the worker under it, a run in progress with it. */
async function stopWindowsTask(): Promise<void> {
  const pidFile = join(windowsFolder(), 'supervisor.pid');
  const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : NaN;
  if (Number.isInteger(pid) && pid > 0 && (await isSupervisor(pid, statSync(pidFile).mtime))) {
    // Refused from another logon of the same person (an SSH session, say): the pid stays, so
    // that the next try from the desktop still ends it, and no second worker starts beside it.
    const result = await exec('taskkill', ['/PID', String(pid), '/T', '/F']);
    if (result.code !== 0) {
      throw new UserError(
        'The worker running on this computer could not be stopped from here. Run this again in PowerShell on the desktop of this computer.',
      );
    }
  }
  rmSync(pidFile, { force: true });
}

/** Writes the service file and (re)starts the service; answers the file. */
export async function installService(spec: ServiceSpec, platform = process.platform) {
  const file = serviceFile(platform);
  mkdirSync(dirname(spec.logFile), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(file), { recursive: true });
  if (platform === 'win32') {
    const specFile = join(dirname(file), 'worker-service.json');
    writeFileSync(specFile, `${JSON.stringify(spec, null, 2)}\n`);
    const user = await windowsUser();
    // Task Scheduler reads its XML as UTF-16, as it writes it.
    writeFileSync(file, Buffer.from(`\ufeff${windowsTask(spec, specFile, user)}`, 'utf16le'));
    await stopWindowsTask();
    for (const args of [
      ['/Create', '/TN', WINDOWS_TASK, '/XML', file, '/F'],
      ['/Run', '/TN', WINDOWS_TASK],
    ]) {
      const result = await exec('schtasks', args);
      if (result.code !== 0) throw new UserError(`schtasks ${args[0]} failed: ${result.message}`);
    }
    return file;
  }
  if (platform === 'darwin') {
    const domain = `gui/${process.getuid?.()}`;
    // A loaded agent would keep running the previous file, and `bootstrap` refuses its label.
    await exec('launchctl', ['bootout', `${domain}/${LAUNCHD_LABEL}`]);
    writeFileSync(file, launchdPlist(spec));
    let result = await exec('launchctl', ['bootstrap', domain, file]);
    // Right after a bootout launchd may still be removing the old job (error 5).
    for (let attempt = 1; result.code !== 0 && attempt < 5; attempt++) {
      await sleep(500 * attempt);
      result = await exec('launchctl', ['bootstrap', domain, file]);
    }
    if (result.code !== 0) throw new UserError(`launchctl bootstrap failed: ${result.message}`);
    return file;
  }
  writeFileSync(file, systemdUnit(spec));
  for (const args of [['daemon-reload'], ['enable', SYSTEMD_UNIT], ['restart', SYSTEMD_UNIT]]) {
    const result = await exec('systemctl', ['--user', ...args]);
    if (result.code !== 0)
      throw new UserError(`systemctl --user ${args.join(' ')} failed: ${result.message}`);
  }
  return file;
}

/** Stops the service, which cancels and finishes a run in progress, and removes its file. */
export async function uninstallService(platform = process.platform): Promise<boolean> {
  const file = serviceFile(platform);
  const installed = existsSync(file);
  if (platform === 'win32') {
    await stopWindowsTask();
    if (installed) await exec('schtasks', ['/Delete', '/TN', WINDOWS_TASK, '/F']);
    rmSync(dirname(file), { recursive: true, force: true });
    return installed;
  }
  if (platform === 'darwin')
    await exec('launchctl', ['bootout', `gui/${process.getuid?.()}/${LAUNCHD_LABEL}`]);
  else if (installed) await exec('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT]);
  rmSync(file, { force: true });
  if (platform !== 'darwin' && installed) await exec('systemctl', ['--user', 'daemon-reload']);
  return installed;
}

/**
 * Who the task runs as: the person's SID, which Task Scheduler maps whatever the session calls the
 * domain (WORKGROUP over SSH, for one); DOMAIN\\name when whoami says nothing usable.
 */
function windowsUser(): Promise<string> {
  const named = () => {
    const domain = process.env.USERDOMAIN;
    return domain ? `${domain}\\${userInfo().username}` : userInfo().username;
  };
  return new Promise((resolve) => {
    execFile('whoami', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true }, (error, stdout) => {
      resolve((error === null && /\bS-1-5-[0-9-]+/.exec(stdout)?.[0]) || named());
    });
  });
}

function exec(command: string, args: string[]): Promise<{ code: number; message: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true }, (error, _stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
      resolve({ code, message: stderr.trim() || (error?.message ?? '') });
    });
  });
}
