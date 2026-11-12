import { execFile } from 'node:child_process';

// "Only while the person is working" is kept here, because only this computer
// can see a keyboard. The idle time is the time since the last keyboard or mouse input; where it
// cannot be read, the person counts as present, and what remains of the rule is that the worker
// runs as a service of their login session (README).

/** Milliseconds since the last keyboard or mouse input; 0 when this computer cannot say. */
export async function idleMs(platform: NodeJS.Platform = process.platform): Promise<number> {
  if (platform === 'darwin') {
    return fromIoreg(await output('ioreg', ['-c', 'IOHIDSystem', '-r', '-d', '1'])) ?? 0;
  }
  if (platform === 'win32') {
    return (
      fromDigits(
        await output('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', IDLE_PS]),
      ) ?? 0
    );
  }
  if (platform !== 'linux') return 0;
  // X11 only: it fails under Wayland and without a display, which a systemd unit has not.
  const x11 = fromDigits(await output('xprintidle', []));
  if (x11 !== undefined) return x11;
  const uid = String(process.getuid?.() ?? '');
  const properties = ['--property=IdleHint', '--property=IdleSinceHint'];
  return fromLoginctl(await output('loginctl', ['show-user', uid, ...properties]), Date.now()) ?? 0;
}

/**
 * Windows: GetLastInputInfo, the last input in this person's session, which on a remote desktop
 * is the last input from its client. Milliseconds since then, from the tick counts of both.
 */
const IDLE_PS = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class AgentomeIdle { [StructLayout(LayoutKind.Sequential)] struct Info { public uint Size; public uint Time; } [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref Info info); public static uint Ms() { Info info = new Info(); info.Size = 8; if (!GetLastInputInfo(ref info)) return 0; return unchecked((uint)Environment.TickCount - info.Time); } }'; [AgentomeIdle]::Ms()`;

/** `"HIDIdleTime" = <nanoseconds>` of `ioreg -c IOHIDSystem`. */
export function fromIoreg(text: string | undefined): number | undefined {
  const nanoseconds = /"HIDIdleTime" = (\d+)/.exec(text ?? '')?.[1];
  return nanoseconds === undefined ? undefined : Math.floor(Number(nanoseconds) / 1e6);
}

/** Milliseconds, as `xprintidle` and the Windows check print them. */
export function fromDigits(text: string | undefined): number | undefined {
  const value = text?.trim() ?? '';
  return /^\d+$/.test(value) ? Number(value) : undefined;
}

/** `IdleHint` and `IdleSinceHint` (microseconds since the epoch) of `loginctl show-user`. */
export function fromLoginctl(text: string | undefined, now: number): number | undefined {
  const field = (name: string) => new RegExp(`^${name}=(.*)$`, 'm').exec(text ?? '')?.[1]?.trim();
  const hint = field('IdleHint');
  if (hint === 'no') return 0;
  const since = Number(field('IdleSinceHint'));
  return hint === 'yes' && since > 0 ? Math.max(0, now - Math.floor(since / 1000)) : undefined;
}

/** What the command printed, or nothing when it is missing or failed. */
function output(command: string, args: readonly string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    // PowerShell takes a few seconds to start on a busy computer: it gets ten.
    execFile(command, args, { timeout: 10_000, windowsHide: true }, (error, stdout) => {
      resolve(error === null ? stdout : undefined);
    });
  });
}
