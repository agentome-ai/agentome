/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the browser talks to Vite only, which passes /api on to the server: one
// origin for cookies and better-auth's origin check. Run the server with
// AGENTOME_PUBLIC_URL set to Vite's address. `vite preview` uses the same proxy. The port
// is the one the server listens on: AGENTOME_LISTEN is host:port, 3000 by default.
const apiPort = process.env.AGENTOME_LISTEN?.split(':').at(-1) || '3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy: { '/api': `http://localhost:${apiPort}` } },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test-setup.ts'],
  },
});
