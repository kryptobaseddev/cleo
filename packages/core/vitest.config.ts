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

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { withWorkspaceSubpathAliases } from '../../vitest-workspace-resolver.js';
import { MEMORY_SAFE_TEST_DEFAULTS } from '../../vitest.memory-safe.js';
import { repoGuardsUnder } from '../../vitest.repo-guards.js';

export default defineConfig({
  test: {
    // Memory-safe fork bounds (T12087) — spread FIRST so anything below
    // can still override deliberately. Applies on a DIRECT per-package run,
    // which `extends: true` does not cover.
    ...MEMORY_SAFE_TEST_DEFAULTS,
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
      // T13142: run in the root config's `repo-guards` project instead.
      ...repoGuardsUnder('packages/core/'),
    ],
    // Path aliases matching the root tsconfig.
    //
    // T11953 / DHQ-070: `withWorkspaceSubpathAliases` PREPENDS a generic
    // `@cleocode/<pkg>/<subpath>` → source resolver so a fresh worktree run via
    // `pnpm --filter @cleocode/core exec vitest` (which loads THIS config)
    // resolves any subpath without per-PR ad-hoc aliases.
    alias: withWorkspaceSubpathAliases({
      // T9955: explicit subpath aliases for provenance/jobs/enums modules.
      // These MUST appear BEFORE the bare `@cleocode/contracts` alias so
      // vitest matches the longer prefix first; otherwise the broader alias
      // rewrites the path to `index.ts/<subpath>` and Node errors with ENOTDIR.
      '@cleocode/contracts/enums': fileURLToPath(new URL('../../packages/contracts/src/enums.ts', import.meta.url)),
      '@cleocode/contracts/provenance': fileURLToPath(new URL('../../packages/contracts/src/provenance.ts', import.meta.url)),
      '@cleocode/contracts/jobs': fileURLToPath(new URL('../../packages/contracts/src/jobs.ts', import.meta.url)),
      '@cleocode/contracts': fileURLToPath(new URL('../../packages/contracts/src/index.ts', import.meta.url)),
      '@cleocode/core/internal': fileURLToPath(new URL('./src/internal.ts', import.meta.url)),
      // T9747: caamp source files import `@cleocode/core/skills/skill-root.js`.
      // When those files are loaded by vitest during core's own test suite,
      // Node's package-self-reference resolution fails because we're already
      // inside @cleocode/core. Alias the subpath to the TS source directly.
      '@cleocode/core/skills/skill-root.js': fileURLToPath(new URL('./src/skills/skill-root.ts', import.meta.url)),
      '@cleocode/core': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
      '@cleocode/adapters': fileURLToPath(new URL('../../packages/adapters/src/index.ts', import.meta.url)),
      '@cleocode/lafs': fileURLToPath(new URL('../../packages/lafs/src/index.ts', import.meta.url)),
      // @cleocode/paths — workspace-local canonical path utilities (env-paths wrapper).
      // Must be aliased so vitest resolves packages/core/src/paths.ts without a build step.
      '@cleocode/paths': fileURLToPath(new URL('../../packages/paths/src/index.ts', import.meta.url)),
      // @cleocode/utils — pure zero-dependency leaf (formatBytes, redact, …).
      // Aliased to source so vitest resolves redaction.ts / plugin-facade.ts
      // imports without first building utils' dist/ (T11414 · E5).
      '@cleocode/utils': fileURLToPath(new URL('../../packages/utils/src/index.ts', import.meta.url)),
      // caamp and cant — required to resolve @cleocode/core/internal transitive deps
      '@cleocode/caamp': fileURLToPath(new URL('../../packages/caamp/src/index.ts', import.meta.url)),
      '@cleocode/cant': fileURLToPath(new URL('../../packages/cant/src/index.ts', import.meta.url)),
    }),
  },
});
