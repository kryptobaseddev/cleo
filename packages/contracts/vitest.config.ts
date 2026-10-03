/**
 * Vitest configuration for @cleocode/contracts.
 *
 * Provides path aliases so tests can import from source without a prior
 * build step.
 *
 * @task T566
 */

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { MEMORY_SAFE_TEST_DEFAULTS } from '../../vitest.memory-safe.js';
import { repoGuardsUnder } from '../../vitest.repo-guards.js';

export default defineConfig({
  test: {
    // Memory-safe fork bounds (T12087) — spread FIRST so anything below
    // can still override deliberately. Applies on a DIRECT per-package run,
    // which `extends: true` does not cover.
    ...MEMORY_SAFE_TEST_DEFAULTS,
    extends: true,
    name: '@cleocode/contracts',
    globals: true,
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: [
      'src/**/*.test.ts',
      'src/**/__tests__/*.test.ts',
      'tests/**/*.test.ts',
    ],
    exclude: [
      'node_modules',
      'dist',
      '**/node_modules/**',
      '**/e2e/**',
      '**/*.integration.test.ts',
      '**/*-integration.test.ts',
      // T13142: run in the root config's `repo-guards` project instead.
      ...repoGuardsUnder('packages/contracts/'),
    ],
    alias: {
      '@cleocode/contracts': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    },
  },
});
