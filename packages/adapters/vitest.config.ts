/**
 * Vitest configuration for @cleocode/adapters.
 *
 * Provides path aliases for workspace packages so tests can import from
 * source without requiring a prior build step.
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
      'src/**/*.test.ts',
      'src/**/__tests__/*.test.ts',
      'tests/**/*.test.ts',
    ],
    exclude: ['node_modules', 'dist', '**/node_modules/**', '**/e2e/**'],
    alias: {
      '@cleocode/contracts': new URL('../../packages/contracts/src/index.ts', import.meta.url)
        .pathname,
      '@cleocode/adapters': new URL('./src/index.ts', import.meta.url).pathname,
      // T1919: CAAMP is now imported by adapter install providers. Resolve from
      // source so tests don't require a prior build step for @cleocode/caamp.
      '@cleocode/caamp': new URL('../../packages/caamp/src/index.ts', import.meta.url).pathname,
      // T1919: paths is a leaf package needed by caamp source imports in tests.
      '@cleocode/paths': new URL('../../packages/paths/src/index.ts', import.meta.url).pathname,
      // T937: harness-interop sandbox resolves @cleocode/playbooks to source so the
      // runtime can be exercised end-to-end without circular build dependencies.
      // Adapters does not depend on @cleocode/playbooks at build time — the alias
      // is test-only and confirms the SDK-consolidation invariant (no provider
      // SDK imports leak into the runtime source).
      '@cleocode/playbooks': new URL('../../packages/playbooks/src/index.ts', import.meta.url)
        .pathname,
    },
  },
});
