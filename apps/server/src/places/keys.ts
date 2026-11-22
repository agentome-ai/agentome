import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deriveKey } from '../derive.js';

// The place launcher holds Docker's socket, the most a break-in could start from. It gets a key of
// its own, derived from the installation's: what it needs of it (the key it checks the app's
// orders with, the egress tokens it gives the places) comes from that, and the installation's
// key, which opens every secret the app keeps, stays with the app.

export const LAUNCHER_PURPOSE = 'place-launcher';

/** The places' key, from the installation's. */
export const placesKey = (secretKey: string) => deriveKey(secretKey, 'places');

/** The key the app signs the launcher's orders with, and the launcher checks them with. */
export const launcherKey = (places: string) => deriveKey(places, LAUNCHER_PURPOSE);

/** The token a person's place gives the egress proxy for its sign-in: the person's, derived. */
export const placeEgressToken = (places: string, personId: string) =>
  deriveKey(places, `place-egress:${personId}`);

/**
 * The token a run's CLI container gives the egress proxy: it opens the model vendors and
 * Agentome, for the CLI alone; the sandbox's commands have the run's token, which does not.
 */
export const cliEgressToken = (places: string, runId: string) =>
  deriveKey(places, `cli-egress:${runId}`);

/**
 * The token a run's own Docker gives the egress proxy: it pulls images from the hosts the run's
 * project allows, and opens nothing else.
 */
export const dockerEgressToken = (places: string, runId: string) =>
  deriveKey(places, `docker-egress:${runId}`);

/**
 * The key the places' egress proxy shows the app with each question and each account of what it
 * did: the app's egress routes take nobody else's word, and the proxy's calls are not counted
 * against an address's limit. Derived, so the proxy holds nothing that opens anything else.
 */
export const egressProxyKey = (places: string) => deriveKey(places, 'egress-proxy');

/** Where the app puts the egress proxy's key, for the proxy to mount alone. */
export const egressKeyFile = (dataDir: string) => join(dataDir, 'egress', 'egress.key');

/** Where the app puts the places' key in its data folder, for the launcher to mount alone. */
export const placesKeyFile = (dataDir: string) => join(dataDir, 'places', 'places.key');

/** Writes the places' key where the launcher reads it; the app does at each start. */
export function writePlacesKey(dataDir: string, secretKey: string): void {
  const file = placesKeyFile(dataDir);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, placesKey(secretKey), { mode: 0o600 });
  const proxy = egressKeyFile(dataDir);
  mkdirSync(dirname(proxy), { recursive: true, mode: 0o700 });
  writeFileSync(proxy, egressProxyKey(placesKey(secretKey)), { mode: 0o600 });
}
