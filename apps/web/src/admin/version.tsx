import { useEffect, useState } from 'react';
import { api } from '../api';

// The installation's version, and a newer release when there is one. The admin's browser asks
// GitHub, at most once a day: the server asks nobody, so an installation behind a VPN only goes
// without the line.

/** Where releases are published, and the page that says how to update. */
export const RELEASES = 'https://api.github.com/repos/agentome-ai/agentome/releases/latest';
export const HOW_TO_UPDATE =
  'https://github.com/agentome-ai/agentome/blob/main/deploy/OPERATIONS.md#updating';
const KEY = 'agentome-latest-release';
const DAY_MS = 86_400_000;

export type Build = { version: string | null; commit: string | null; updateCheck: boolean };
export type Release = { version: string; url: string };

/** "v0.2.0" or "0.2.0" as numbers to compare; anything else is no release. */
function parts(version: string): number[] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return match ? match.slice(1).map(Number) : undefined;
}

/** True when `latest` is a later release than `running`. */
export function isNewer(latest: string, running: string): boolean {
  const [a, b] = [parts(latest), parts(running)];
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

/** How the build reads in Admin: "Agentome 0.2.0, build 572776f", or a development build. */
export function buildLabel(build: Pick<Build, 'version' | 'commit'>): string {
  const commit = build.commit ? build.commit.slice(0, 7) : undefined;
  if (!build.version) return commit ? `Development build ${commit}` : 'Development build';
  return `Agentome ${build.version}${commit ? `, build ${commit}` : ''}`;
}

function remembered(): { at: number; release: Release | null } | undefined {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (value && typeof value === 'object' && 'at' in value && 'release' in value) {
      return value as { at: number; release: Release | null };
    }
  } catch {
    // Storage off or a value of another shape: ask again.
  }
  return undefined;
}

function remember(release: Release | null) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), release }));
  } catch {
    // Storage off: the next visit asks again.
  }
}

/** The latest release GitHub names, or null when it names none or cannot be reached. */
async function latestRelease(): Promise<Release | null> {
  const known = remembered();
  if (known && Date.now() - known.at < DAY_MS) return known.release;
  try {
    const response = await fetch(RELEASES, { headers: { accept: 'application/vnd.github+json' } });
    if (!response.ok) {
      remember(null);
      return null;
    }
    const body = (await response.json()) as { tag_name?: unknown; html_url?: unknown };
    const release =
      typeof body.tag_name === 'string' && typeof body.html_url === 'string' && parts(body.tag_name)
        ? { version: body.tag_name.replace(/^v/, ''), url: body.html_url }
        : null;
    remember(release);
    return release;
  } catch {
    // Offline or blocked: say nothing, and ask on the next visit.
    return null;
  }
}

/**
 * The build this server runs, and the latest release when the check is on and this is a
 * release: undefined while loading or when the server could not say.
 */
export function useVersion() {
  const [build, setBuild] = useState<Build>();
  const [latest, setLatest] = useState<Release | null>(null);
  useEffect(() => {
    let current = true;
    api<Build>('/api/admin/version').then(
      async (found) => {
        if (!current) return;
        setBuild(found);
        if (!found.updateCheck || !found.version) return;
        const release = await latestRelease();
        if (current) setLatest(release);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, []);
  const newer = build?.version && latest && isNewer(latest.version, build.version) ? latest : null;
  return { build, newer, checked: Boolean(build?.updateCheck && build.version && latest) };
}
