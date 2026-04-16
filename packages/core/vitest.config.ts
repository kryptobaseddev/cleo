/**
 * Vitest configuration for @cleocode/core.
 *
 * Extends the root workspace configuration. Adds an explicit include for
 * integration test files (excluded from the root config because they require
 * real filesystem and database setup). The standard `pnpm run test` script
 * runs unit tests only; `pnpm run test:integration` runs integration tests.
 *
 * @task T308
 * @epic T299
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // T753: Force-kill worker forks that fail to exit after teardown.
    teardownTimeout: 10_000,
    // Include both unit tests and integration tests when running in this package.
    include: [
      'src/**/*.test.ts',
      'src/**/__tests__/*.test.ts',
      'tests/**/*.test.ts',
    ],
    // Only exclude node_modules and dist — integration tests are permitted here.
    exclude: ['node_modules', 'dist', '**/node_modules/**', '**/e2e/**'],
    // Path aliases matching the root tsconfig.
    alias: {
      '@cleocode/contracts': new URL('../../packages/contracts/src/index.ts', import.meta.url)
        .pathname,
      '@cleocode/core/internal': new URL('./src/internal.ts', import.meta.url).pathname,
      '@cleocode/core': new URL('./src/index.ts', import.meta.url).pathname,
      '@cleocode/adapters': new URL('../../packages/adapters/src/index.ts', import.meta.url)
        .pathname,
      '@cleocode/lafs': new URL('../../packages/lafs/src/index.ts', import.meta.url).pathname,
    },
  },
});
