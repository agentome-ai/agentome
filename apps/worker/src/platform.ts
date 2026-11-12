import { type ChildProcess, execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { posix, win32 } from 'node:path';

// What Windows does differently, kept here so the launchers read alike on every computer. It has
// no process groups and no POSIX signals, a console program started from a background task gets a
// window unless told otherwise, npm's commands are `.cmd` files that `spawn` cannot start, and
// there is no sandbox for an agent's commands: a Windows computer takes runs only after an admin
// has allowed it to run them without one (Admin, Computers).

/** Whether this computer runs the agent's commands without a sandbox: Windows has none. */
export const unsandboxed = (platform: NodeJS.Platform = process.platform) => platform === 'win32';

/**
 * How a CLI is started: as the leader of a process group of its own, so that a stop reaches what
 * it started; on Windows, where `detached` would open a console of its own, without a window.
 */
export function childOptions(platform: NodeJS.Platform = process.platform) {
  return platform === 'win32' ? { detached: false, windowsHide: true } : { detached: true };
}

/**
 * Stops a CLI and what it started. Elsewhere the signal goes to its process group; on Windows
 * `taskkill /T /F` ends the process and everything under it at once, since there is nothing
 * like SIGTERM to ask first with. What a finished CLI left behind has no parent to be found by
 * there: a known limit of a Windows computer.
 */
export function stopTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
): void {
  if (child.pid === undefined) return;
  if (platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const args = ['/PID', String(child.pid), '/T', '/F'];
    execFile('taskkill', args, { windowsHide: true }, () => undefined);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    // ESRCH: the group is gone. Otherwise the CLI alone gets the signal (failures: `error`).
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signal);
  }
}

/**
 * The program and its first arguments that start the CLI `name`. On Windows the PATH is searched
 * for `name.exe`, and an npm `name.cmd` is read for the script it runs, which this Node then
 * starts: `spawn` cannot start a `.cmd`, and through a shell the prompt's words would be read as
 * cmd syntax. A path, or a name found nowhere, is left as it is, to fail as a missing CLI.
 */
export function cliCommand(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): [string, ...string[]] {
  if (platform !== 'win32' || /[\\/]/.test(name)) return [name];
  const path = (env.PATH ?? env.Path ?? '').split(';');
  // Where the CLIs land without reaching the PATH: Claude Code's installer asks the person to add
  // its folder by hand, and npm's global folder is on the PATH of whoever installed Node.
  const home = [
    env.USERPROFILE && win32.join(env.USERPROFILE, '.local', 'bin'),
    env.APPDATA && win32.join(env.APPDATA, 'npm'),
  ];
  for (const dir of [...path, ...home].filter((entry): entry is string => !!entry)) {
    const exe = win32.join(dir, `${name}.exe`);
    if (exists(exe)) return [exe];
    const cmd = win32.join(dir, `${name}.cmd`);
    if (!exists(cmd)) continue;
    // npm's shim: "%_prog%" "%dp0%\node_modules\@openai\codex\bin\codex.js" %*
    const script = /"%~?dp0%?\\([^"]+\.[cm]?js)"/i.exec(read(cmd))?.[1];
    if (script !== undefined) return [process.execPath, win32.join(dir, script)];
  }
  return [name];
}

/** The rule path of the CLI's permission rules: `//c/Users/…` for `C:\Users\…` on Windows. */
export function rulePath(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return `/${path}`;
  const drive = /^([A-Za-z]):[\\/]/.exec(path);
  const rest = path.replaceAll('\\', '/');
  return drive ? `//${drive[1]?.toLowerCase()}${rest.slice(2)}` : `/${posix.normalize(rest)}`;
}

/**
 * What a program needs of the environment on Windows to work at all: its system folders, its
 * shell, its temporary and profile folders, and the Git Bash that Claude Code runs commands in.
 */
const WINDOWS_VARS = [
  ...['Path', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'TEMP', 'TMP'],
  ...['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME'],
  ...['USERDOMAIN', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432'],
  ...['CommonProgramFiles', 'CommonProgramFiles(x86)', 'PROCESSOR_ARCHITECTURE'],
  ...['NUMBER_OF_PROCESSORS', 'OS', 'CLAUDE_CODE_GIT_BASH_PATH'],
].map((name) => name.toUpperCase());

/**
 * Whether a CLI inherits the variable `name`, one of `names` or, on Windows, of what every
 * program there needs. Windows reads the names of its environment in any case.
 */
export function inheritedVar(
  name: string,
  names: ReadonlySet<string>,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (names.has(name)) return true;
  if (platform !== 'win32') return false;
  const upper = name.toUpperCase();
  return WINDOWS_VARS.includes(upper) || [...names].some((known) => known.toUpperCase() === upper);
}
