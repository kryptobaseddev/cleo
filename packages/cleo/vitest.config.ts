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
      // Store sub-path exports — must be listed before the root alias so the
      // more-specific pattern wins.  Production code uses `import(x as string)`
      // which vitest's transform cannot statically hoist; registering these aliases
      // ensures vi.mock('@cleocode/core/store/…') resolves to the source tree and
      // is correctly intercepted at runtime.
      '@cleocode/core/store/nexus-sqlite': new URL(
        '../../packages/core/src/store/nexus-sqlite.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/core/store/nexus-schema': new URL(
        '../../packages/core/src/store/nexus-schema.ts',
        import.meta.url,
      ).pathname,
      // T946 sentient daemon consumes these subpath exports at runtime.
      '@cleocode/core/sdk': new URL('../../packages/core/src/cleo.ts', import.meta.url).pathname,
      '@cleocode/core/tasks': new URL(
        '../../packages/core/src/tasks/index.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/core': new URL('../../packages/core/src/index.ts', import.meta.url).pathname,
      '@cleocode/lafs': new URL('../../packages/lafs/src/index.ts', import.meta.url).pathname,
    },
  },
});
