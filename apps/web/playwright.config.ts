import { defineConfig } from '@playwright/test';

// Runs against the Vite dev server: /styleguide exists only in dev builds.
// The port can be moved, to take screenshots while the checks run on this machine and hold it.
const port = Number(process.env.AGENTOME_E2E_PORT ?? 4317);

export default defineConfig({
  testDir: 'e2e',
  reporter: 'list',
  use: { baseURL: `http://localhost:${port}`, viewport: { width: 1280, height: 800 } },
  projects: [
    { name: 'smoke', testMatch: 'smoke.spec.ts' },
    { name: 'screenshots', testMatch: 'screenshots.spec.ts' },
  ],
  webServer: {
    // Vite directly, not through pnpm exec: Playwright must be able to stop it after the run.
    command: `node node_modules/vite/bin/vite.js --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
  },
});
