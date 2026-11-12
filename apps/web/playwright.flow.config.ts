import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

// The flows against the real server, sign-in and an agent from a template: the production
// build of the web app, the server with its migrations, and an empty PostgreSQL. CI's web-e2e
// job provides the database; locally, build first (pnpm --filter @agentome/web build) and
// point AGENTOME_E2E_DATABASE_URL at an empty, throwaway database.
const databaseUrl = process.env.AGENTOME_E2E_DATABASE_URL;
if (!databaseUrl) throw new Error('Set AGENTOME_E2E_DATABASE_URL to an empty PostgreSQL database');
const webPort = 4327;
// The server listens where its own AGENTOME_LISTEN (host:port) says, port 3000 by default;
// both servers inherit the variable, and the web server's /api proxy reads it too.
const apiPort = process.env.AGENTOME_LISTEN?.split(':').at(-1) || '3000';
// The server generates its secret key here on the first start; the flows read the setup code
// from it with the server's own `agentome setup-code`. The workers load this file again and
// inherit the variable, so all of them name the same directory.
const dataDir = (process.env.AGENTOME_E2E_DATA_DIR ??= mkdtempSync(
  join(tmpdir(), 'agentome-e2e-'),
));

export default defineConfig({
  testDir: 'e2e',
  testMatch: 'flows.spec.ts',
  reporter: 'list',
  use: { baseURL: `http://localhost:${webPort}`, viewport: { width: 1280, height: 800 } },
  webServer: [
    {
      command: 'node --import tsx src/main.ts',
      cwd: '../server',
      url: `http://localhost:${apiPort}/ready`,
      reuseExistingServer: false,
      env: {
        AGENTOME_DATABASE_URL: databaseUrl,
        // The address people use is the web server's: it passes /api on to this one.
        AGENTOME_PUBLIC_URL: `http://localhost:${webPort}`,
        AGENTOME_DATA_DIR: dataDir,
        AGENTOME_LOG_LEVEL: 'warn',
      },
    },
    {
      command: `node node_modules/vite/bin/vite.js preview --port ${webPort} --strictPort`,
      url: `http://localhost:${webPort}`,
      reuseExistingServer: false,
    },
  ],
});
