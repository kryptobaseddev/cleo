/**
 * Vitest configuration for @cleocode/skills.
 *
 * Test files live under skills/ (not src/) because this package ships
 * bundled skill definitions rather than compiled TypeScript source.
 *
 * @task T566
 */

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
    name: '@cleocode/skills',
    globals: true,
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: [
      'skills/**/__tests__/*.test.ts',
      'skills/**/*.test.ts',
      '__tests__/*.test.ts',
    ],
    exclude: [
      'node_modules',
      'dist',
      '**/node_modules/**',
      '**/e2e/**',
      '**/*.integration.test.ts',
      '**/*-integration.test.ts',
      // T13142: run in the root config's `repo-guards` project instead.
      ...repoGuardsUnder('packages/skills/'),
    ],
  },
});
