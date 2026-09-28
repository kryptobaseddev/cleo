/**
 * Vitest configuration for @cleocode/adapters.
 *
 * Provides path aliases for workspace packages so tests can import from
 * source without requiring a prior build step.
 *
 * @task T566
 */

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { withWorkspaceSubpathAliases } from '../../vitest-workspace-resolver.js';
import { MEMORY_SAFE_TEST_DEFAULTS } from '../../vitest.memory-safe.js';

export default defineConfig({
  test: {
    // Memory-safe fork bounds (T12087) — spread FIRST so anything below
    // can still override deliberately. Applies on a DIRECT per-package run,
    // which `extends: true` does not cover.
    ...MEMORY_SAFE_TEST_DEFAULTS,
    extends: true,
    name: '@cleocode/adapters',
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
    alias: withWorkspaceSubpathAliases({
      // T11762 (T11900): the harness-interop test resolves @cleocode/playbooks to
      // source, and the ST-2 runtime now imports @cleocode/core, which drags the
      // store/schema layer (tasks.ts / provenance/commits.ts / memory-schema.ts)
      // into this test's module graph. Those schema files deep-import
      // @cleocode/contracts/{enums,jobs,provenance,memory/observe}. These subpath
      // aliases MUST appear BEFORE the bare `@cleocode/contracts` alias so vitest
      // matches the longer prefix first; otherwise the broader alias rewrites the
      // path to `index.ts/<subpath>` and Node errors with ENOTDIR. Mirrors the
      // identical ordering in the root, core, and cleo vitest configs (T9955).
      '@cleocode/contracts/enums': new URL(
        '../../packages/contracts/src/enums.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/contracts/jobs': new URL(
        '../../packages/contracts/src/jobs.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/contracts/provenance': new URL(
        '../../packages/contracts/src/provenance.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/contracts/memory/observe': new URL(
        '../../packages/contracts/src/memory/observe.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/contracts': new URL('../../packages/contracts/src/index.ts', import.meta.url)
        .pathname,
      '@cleocode/adapters': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
      // T1919: CAAMP is now imported by adapter install providers. Resolve from
      // source so tests don't require a prior build step for @cleocode/caamp.
      '@cleocode/caamp': fileURLToPath(new URL('../../packages/caamp/src/index.ts', import.meta.url)),
      // T1919: paths is a leaf package needed by caamp source imports in tests.
      '@cleocode/paths': fileURLToPath(new URL('../../packages/paths/src/index.ts', import.meta.url)),
      // T937: harness-interop sandbox resolves @cleocode/playbooks to source so the
      // runtime can be exercised end-to-end without circular build dependencies.
      // Adapters does not depend on @cleocode/playbooks at build time — the alias
      // is test-only and confirms the SDK-consolidation invariant (no provider
      // SDK imports leak into the runtime source).
      '@cleocode/playbooks': new URL('../../packages/playbooks/src/index.ts', import.meta.url)
        .pathname,
    }),
  },
});
