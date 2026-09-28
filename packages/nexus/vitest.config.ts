/**
 * Vitest configuration for @cleocode/nexus.
 *
 * Provides path aliases for workspace packages so tests can import from
 * source without requiring a prior build step.
 *
 * @task T532
 */

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { MEMORY_SAFE_TEST_DEFAULTS } from '../../vitest.memory-safe.js';

export default defineConfig({
  test: {
    // Memory-safe fork bounds (T12087) — spread FIRST so anything below
    // can still override deliberately. Applies on a DIRECT per-package run,
    // which `extends: true` does not cover.
    ...MEMORY_SAFE_TEST_DEFAULTS,
    extends: true,
    name: '@cleocode/nexus',
    globals: true,
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: [
      'src/**/*.test.ts',
      'src/**/__tests__/*.test.ts',
      'tests/**/*.test.ts',
    ],
    exclude: ['node_modules', 'dist', '**/node_modules/**', '**/e2e/**', '**/*.integration.test.ts', '**/*-integration.test.ts'],
    alias: {
      '@cleocode/contracts': fileURLToPath(new URL('../../packages/contracts/src/index.ts', import.meta.url)),
    },
  },
});
