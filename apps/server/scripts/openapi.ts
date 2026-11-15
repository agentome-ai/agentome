// Writes the API's OpenAPI description for agentome.ai, at the version of the latest release in
// CHANGELOG.md; apps/site/docs/build.mjs makes the reference page from it.
//
//   pnpm --filter @agentome/server openapi
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const root = join(import.meta.dirname, '..', '..', '..');
const version = /^## \[(\d+\.\d+\.\d+)\]/m.exec(
  readFileSync(join(root, 'CHANGELOG.md'), 'utf8'),
)?.[1];
if (!version) throw new Error('CHANGELOG.md names no release');

const dataDir = mkdtempSync(join(tmpdir(), 'agentome-openapi-'));
try {
  // The routes are only described, never called: a database that is not there is never asked.
  const app = await buildApp(
    loadConfig({
      AGENTOME_DATABASE_URL: 'postgres://agentome:agentome@127.0.0.1:1/agentome',
      AGENTOME_DATA_DIR: dataDir,
      AGENTOME_LOG_LEVEL: 'silent',
      AGENTOME_BUILD_VERSION: version,
    }),
  );
  await app.ready();
  const out = join(root, 'apps', 'site', 'docs', 'openapi.json');
  writeFileSync(out, `${JSON.stringify(app.swagger(), null, 2)}\n`);
  await app.close();
  console.log(`Wrote the API ${version} to ${out}`);
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
