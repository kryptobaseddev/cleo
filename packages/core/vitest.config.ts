/**
 * Vitest configuration for @cleocode/core.
 *
 * Extends the root workspace configuration. Adds an explicit include for
 * integration test files (excluded from the root config because they require
 * real filesystem and database setup). The standard `pnpm run test` script
 * runs unit tests only; `pnpm run test:integration` runs integration tests.
 *
 * globalSetup wires the T1914 sweep that removes stale cleo-injection-chain-*
 * directories from os.tmpdir() before and after the suite, catching orphans
 * from crashed or aborted test runs that bypassed per-test afterEach cleanup.
 *
 * @task T308
 * @epic T299
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    extends: true,
    name: '@cleocode/core',
    globals: true,
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // T753: Force-kill worker forks that fail to exit after teardown.
    teardownTimeout: 10_000,
    // Pairs with the openNativeDatabase isolation guard. vitest.setup.ts
    // pins CLEO_HOME / NEXUS_HOME to a per-fork tmpdir so tests cannot
    // accidentally write to the user's global signaldock/nexus dbs.
    setupFiles: ['../../vitest.setup.ts'],
    // T1914: Sweep stale cleo-injection-chain-* dirs before/after the suite.
    globalSetup: ['src/__tests__/setup-global.ts'],
    // Include both unit tests and integration tests when running in this package.
    include: [
      'src/**/*.test.ts',
      'src/**/__tests__/*.test.ts',
      'src/**/__tests__/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    // Exclude the same patterns as root config so integration tests do not run
    // in the global project sweep (pnpm test / CI shard). Integration tests
    // require real filesystem/DB setup and run explicitly via test:integration.
    exclude: [
      'node_modules',
      'dist',
      '**/node_modules/**',
      '**/e2e/**',
      '**/*.integration.test.ts',
      '**/*-integration.test.ts',
    ],
    // Path aliases matching the root tsconfig.
    alias: {
      '@cleocode/contracts': new URL('../../packages/contracts/src/index.ts', import.meta.url)
        .pathname,
      '@cleocode/core/internal': new URL('./src/internal.ts', import.meta.url).pathname,
      '@cleocode/core': new URL('./src/index.ts', import.meta.url).pathname,
      '@cleocode/adapters': new URL('../../packages/adapters/src/index.ts', import.meta.url)
        .pathname,
      '@cleocode/lafs': new URL('../../packages/lafs/src/index.ts', import.meta.url).pathname,
      // @cleocode/paths — workspace-local canonical path utilities (env-paths wrapper).
      // Must be aliased so vitest resolves packages/core/src/paths.ts without a build step.
      '@cleocode/paths': new URL('../../packages/paths/src/index.ts', import.meta.url).pathname,
      // caamp and cant — required to resolve @cleocode/core/internal transitive deps
      '@cleocode/caamp': new URL('../../packages/caamp/src/index.ts', import.meta.url).pathname,
      '@cleocode/cant': new URL('../../packages/cant/src/index.ts', import.meta.url).pathname,
    },
  },
});
