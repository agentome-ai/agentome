import { defineConfig } from 'vitest/config';

// Shared by every workspace package: each package's `test` script passes this file
// with --config, because Vitest only looks for a config in the directory it runs in.
// Unit tests sit next to the code in src/; tests that need the whole app live in test/.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
});
