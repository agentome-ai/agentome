import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

// The license as the API answers it.

export type OverFree = 'agents' | 'teams' | 'server_agents' | 'budgets';

export type License = {
  /** free: no key, within Free; valid, grace: a key; read_only: over Free without one. */
  status: 'free' | 'valid' | 'grace' | 'read_only';
  enterprise: boolean;
  installationId: string;
  id: string | null;
  company: string | null;
  expiresAt: string | null;
  /** The end of the key's grace; null without a key. */
  graceEndsAt: string | null;
  agents: { limit: number | null; active: number; peak: number };
  /** Where the installation is over Free, whatever the key. */
  over: OverFree[];
};

/** What Free allows, as the server counts it. */
export const FREE_AGENTS = 5;

/** Where an installation is over Free, in words for a list. */
export const overWords: Record<OverFree, string> = {
  agents: `More than ${FREE_AGENTS} active agents`,
  teams: 'More than one team',
  server_agents: 'Agents on the server',
  budgets: 'Monthly budgets',
};

const months = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
/**
 * A day of the license, as formatDate writes one but in UTC: a key "until 2 Nov" ends at its
 * last moment in UTC, which is already 3 Nov east of Greenwich.
 */
export function licenseDay(iso: string): string {
  const date = new Date(iso);
  return `${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** The license, read once and again every ten minutes: the banner follows a key that ends. */
export function useLicense() {
  const [license, setLicense] = useState<License>();
  const load = useCallback(() => {
    api<License>('/api/license').then(setLicense, () => undefined);
  }, []);
  useEffect(() => {
    load();
    const timer = window.setInterval(load, 10 * 60_000);
    return () => window.clearInterval(timer);
  }, [load]);
  return { license, setLicense, reload: load };
}

/**
 * Whether Enterprise works here: undefined until the license is read, so that nothing
 * is marked on a guess.
 */
export function useEnterprise(): boolean | undefined {
  return useLicense().license?.enterprise;
}
