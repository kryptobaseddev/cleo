/**
 * Vitest configuration for @cleocode/cleo.
 *
 * The test script invokes vitest from the monorepo root (`cd ../.. && vitest
 * run packages/cleo/src`) so that tests using `process.cwd()` to build paths
 * like `join(process.cwd(), 'packages', 'cleo', ...)` resolve correctly. This
 * config is read from the monorepo root in that case, so all include/alias
 * entries use root-relative paths.
 *
 * Integration tests (*.integration.test.ts) require a live CLI + DB and are
 * excluded from this run.
 *
 * @task T566
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: [
      'packages/cleo/src/**/*.test.ts',
      'packages/cleo/src/**/__tests__/*.test.ts',
      'packages/cleo/tests/**/*.test.ts',
    ],
    exclude: [
      'node_modules',
      'dist',
      '**/node_modules/**',
      '**/e2e/**',
      '**/*.integration.test.ts',
      '**/*-integration.test.ts',
    ],
    alias: {
      '@cleocode/contracts': new URL('../../packages/contracts/src/index.ts', import.meta.url)
        .pathname,
      '@cleocode/core/internal': new URL('../../packages/core/src/internal.ts', import.meta.url)
        .pathname,
      '@cleocode/core': new URL('../../packages/core/src/index.ts', import.meta.url).pathname,
      '@cleocode/lafs': new URL('../../packages/lafs/src/index.ts', import.meta.url).pathname,
    },
  },
});
