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

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { withWorkspaceSubpathAliases } from '../../vitest-workspace-resolver.js';
import { CLEO_TEST_QUARANTINE } from './vitest.quarantine.js';
import { MEMORY_SAFE_TEST_DEFAULTS } from '../../vitest.memory-safe.js';
import { repoGuardsUnder } from '../../vitest.repo-guards.js';

export default defineConfig({
  test: {
    // Memory-safe fork bounds (T12087) — spread FIRST so anything below
    // can still override deliberately. Applies on a DIRECT per-package run,
    // which `extends: true` does not cover.
    ...MEMORY_SAFE_TEST_DEFAULTS,
    extends: true,
    name: '@cleocode/cleo',
    globals: true,
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // T12067: pin the project root to the MONOREPO root.
    //
    // Vitest resolves a project's `include` (and each test's `process.cwd()`)
    // against the project root, which defaults to the directory holding this
    // config — `packages/cleo/`. The root-relative globs below then expanded to
    // `packages/cleo/packages/cleo/src/**` and matched NOTHING, so the
    // `@cleocode/cleo` project contributed ZERO test files to `pnpm test`,
    // `pnpm test:pkg`, and the sharded CI job (`vitest run --shard=N/2`).
    // 281 test files were silently skipped while CI reported green.
    //
    // The globs are not the bug — the missing `root` is. This package's tests
    // are WRITTEN against the monorepo root, exactly as the header note says:
    // they mock `/src/dispatch/engines/*.js`, call `join(process.cwd(),
    // 'packages', 'cleo', …)`, and expect to be inside a CLEO project. Running
    // them from `packages/cleo/` fails 74 files for reasons that have nothing
    // to do with the code under test. Restoring the intended root fixes the
    // discovery hole AND keeps every one of those tests valid.
    //
    // Third occurrence of the silent-skip class — cf. T10177 (`scripts`) and
    // T11414 (`@cleocode/utils`). Those were a missing `projects:` entry; this
    // one had the entry and still ran nothing, so
    // `scripts/__tests__/vitest-project-include.test.mjs` now asserts every
    // project resolves at least one file.
    root: resolve(import.meta.dirname, '../..'),
    include: [
      'packages/cleo/src/**/*.test.ts',
      'packages/cleo/src/**/__tests__/*.test.ts',
      'packages/cleo/tests/**/*.test.ts',
      // T9532: template snapshot tests live under packages/cleo/test/templates
      // (singular `test/`, matching the existing fixtures dir convention).
      'packages/cleo/test/templates/**/*.test.ts',
      // T9543: release-pipeline integration scenarios live under
      // packages/cleo/test/integration/release-pipeline/. They mock gh + git
      // and consume fixtures from packages/cleo/test/fixtures/release-test-*.
      'packages/cleo/test/integration/release-pipeline/**/*.test.ts',
      // T9928 / Saga T9855 / E9.1: stdout-envelope-only discipline tests.
      // Spawn the built CLI as a subprocess and assert stdout parses as
      // a single LAFS envelope with no log-line contamination.
      'packages/cleo/__tests__/integration/**/*.test.ts',
    ],
    exclude: [
      'node_modules',
      'dist',
      '**/node_modules/**',
      '**/e2e/**',
      '**/*.integration.test.ts',
      '**/*-integration.test.ts',
      // T13142: run in the root config's `repo-guards` project instead (this
      // project is rooted at the repo, so the paths stay repo-relative). From the
      // repo root: pnpm exec vitest run --project repo-guards <file>
      ...repoGuardsUnder('packages/cleo/').map((p) => `packages/cleo/${p}`),
      // T12067: 73 files that were already failing when discovery was fixed —
      // they had never run, so they had never gated a PR. Excluding them lets
      // the other 199 files / 3428 tests start protecting the repo now.
      // The list may only shrink; burn-down is T12072.
      //
      // T12072: `CLEO_RUN_QUARANTINED=1` lifts the exclusion so a single file can
      // be investigated. The burn-down is otherwise unworkable: the list is the
      // only thing naming these files, and it is also what prevents running them.
      // CI never sets this, so the quarantine still holds for every PR.
      ...(process.env['CLEO_RUN_QUARANTINED'] === '1' ? [] : CLEO_TEST_QUARANTINE),
    ],
    // T11953 / DHQ-070 · T14525: `withWorkspaceSubpathAliases` PREPENDS the one
    // `@cleocode/<pkg>[/<subpath>]` → source resolver; list only non-workspace
    // aliases below.
    alias: withWorkspaceSubpathAliases({
      // T9965: js-yaml + @iarna/toml are deps of @cleocode/caamp; in worktrees
      // they resolve through caamp/node_modules rather than root node_modules.
      '@iarna/toml': fileURLToPath(new URL('../../packages/caamp/node_modules/@iarna/toml/toml.js', import.meta.url)),
      'js-yaml': fileURLToPath(new URL('../../packages/caamp/node_modules/js-yaml/index.js', import.meta.url)),
      // T9315: citty is not symlinked into root node_modules in sparse worktrees;
      // alias it to the pnpm store copy so tests that import CLI command files
      // (which use defineCommand) resolve without node_modules setup.
      'citty': fileURLToPath(new URL('../../node_modules/.pnpm/citty@0.2.1/node_modules/citty/dist/index.mjs', import.meta.url)),
    }),
  },
});
