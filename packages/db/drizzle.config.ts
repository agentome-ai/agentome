import { defineConfig } from 'drizzle-kit';

// Used only by `pnpm generate`; the server applies the migrations itself on start.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
});
