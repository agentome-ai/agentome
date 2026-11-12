import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['**/dist/', '**/coverage/']),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    // Already an error in the recommended set; stated here because CLAUDE.md forbids `any`.
    rules: { '@typescript-eslint/no-explicit-any': 'error' },
  },
);
