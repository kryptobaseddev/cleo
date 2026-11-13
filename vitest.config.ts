import { fileURLToPath } from 'node:url';
import { svelte, vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
import { DurationShardSequencer } from './scripts/ci-duration-sequencer.mjs';
import { MEMORY_SAFE_TEST_DEFAULTS } from './vitest.memory-safe.js';
import { REPO_GUARD_TESTS } from './vitest.repo-guards.js';
import { withWorkspaceSubpathAliases } from './vitest-workspace-resolver.js';

// ---------------------------------------------------------------------------
// Memory-safe fork concurrency (session-crash fix · T11839).
//
// `pool: 'forks'` with the default `maxWorkers` (CPU-1) spawned ~23 fork
// processes on a 24-core box, each loading the heavy @cleocode/core graph
// (sqlite/vec0 native + the full SDK) → ~23 × ~2.7 GB ≈ 62 GB → an OOM that
// froze the whole machine and killed the session. CI never hit it (GitHub
// runners have 2-4 cores → ≤3 forks).
//
// Bound concurrency by BOTH cpu AND physical RAM (with a hard ceiling) so a
// large local box can never exceed memory, and cap each fork's V8 heap so a
// single leaky/heavy test OOMs only its OWN fork (failing that one test)
// instead of freezing the machine.
// ---------------------------------------------------------------------------
// Memory-safe fork settings now live in ./vitest.memory-safe.ts so a DIRECT
// per-package run inherits them too (T12087).

export default defineConfig({
  // ---------------------------------------------------------------------------
  // Svelte plugin — required so that `.svelte` component files imported by
  // packages/studio tests (GraphTab.test.ts, HierarchyTab.test.ts) are
  // compiled by the Svelte compiler before vite:import-analysis sees them.
  //
  // Without this plugin the CI sharded runner (`pnpm exec vitest run --shard`)
  // which uses this root config — not the per-package vitest.config.ts — would
  // fail with "content contains invalid JS syntax" on every `.svelte` import.
  //
  // `runes: true` matches the studio package's compiler options; without it
  // Svelte 5 rune syntax in `.svelte.ts` modules is rejected at compile time.
  // ---------------------------------------------------------------------------
  plugins: [
    svelte({
      preprocess: vitePreprocess(),
      compilerOptions: { runes: true },
    }),
  ],
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 120000,
    hookTimeout: 120000,
    // Force deterministic color output: disable ANSI codes so renderer snapshots
    // are stable regardless of CI environment (FORCE_COLOR=1 on GitHub Actions).
    // Without this, brain-renderers snapshot tests fail in CI (T1731).
    env: { NO_COLOR: '1', FORCE_COLOR: '0' },
    // ---------------------------------------------------------------------------
    // Pool strategy: 'forks' (child_process) with per-file module isolation.
    //
    // Vitest 4.x defaults to pool:'forks', but we set it explicitly here so the
    // choice is canonical, greppable, and cannot regress if the default changes.
    //
    // Why forks over threads?
    //   - child_process forks give each test file a completely independent V8
    //     heap + module registry.  vi.mock() factory stubs registered in one
    //     file CANNOT bleed into another file's module cache.
    //   - threads (worker_threads) share the parent's module cache unless
    //     isolate:true is also set, but even with isolate they share the same
    //     Node.js process and some globals (e.g. process.env mutations in one
    //     worker can race with reads in another).
    //   - The T630/T633 regression (71 nexus-e2e failures across v2026.4.52-56)
    //     was caused by synchronous vi.mock(paths.js) factories sharing the
    //     module cache across shards.  Explicit forks+isolate prevents the whole
    //     class of cross-file mock pollution.
    //
    // In Vitest 4.x the poolOptions.forks.isolate and poolOptions.forks.singleFork
    // fields were promoted to top-level test.isolate and test.maxWorkers.
    // We set pool + isolate here; maxWorkers is left at vitest's default (CPU-1).
    //
    // @see T658 Phase 1: vitest fork isolation
    // @see T630/T633 root-cause: vi.mock pollution across shards
    // ---------------------------------------------------------------------------
    // Memory-safe concurrency (T11839 · T12087). Spread from the SSoT rather
    // than declared here, because `test.extends: true` does NOT reach a direct
    // `vitest run --root packages/<pkg>` invocation — that package IS the root,
    // so there is nothing to extend. Every package config spreads the same
    // object; `scripts/lint-vitest-memory-safe.mjs` enforces it.
    ...MEMORY_SAFE_TEST_DEFAULTS,
    // T753: Force-kill worker forks that fail to exit after teardown.
    // Without this, workers with open SQLite handles or process.once('SIGTERM')
    // handlers that call async code can block the runner indefinitely.
    teardownTimeout: 10_000,
    // T14369: `--shard` splits by measured file duration when
    // VITEST_SHARD_TIMINGS names a timings file; vitest's file-count split otherwise.
    sequence: { sequencer: DurationShardSequencer },
    // Per-fork global isolation. vitest.setup.ts redirects CLEO_HOME and
    // NEXUS_HOME to a throwaway tmp dir so any test that resolves a "global"
    // path (signaldock.db, nexus global registry, etc.) without explicit
    // overrides cannot leak into ~/.local/share/cleo. Pairs with the
    // path-isolation guard in packages/core/src/store/sqlite-native.ts.
    setupFiles: ['./vitest.setup.ts'],
    // T1914: Sweep stale cleo-injection-chain-* dirs from os.tmpdir() before
    // and after the full suite.  Catches orphans left by crashed/aborted runs
    // that bypassed per-test afterEach cleanup.
    globalSetup: ['packages/core/src/__tests__/setup-global.ts'],
    // Note: VITEST env var is auto-set by vitest. Enforcement code checks
    // process.env.VITEST to disable enforcement during test runs.
    // Tests that validate enforcement directly must clear VITEST in beforeAll.
    //
    // scripts unit tests (.mjs) are not covered by per-package project configs —
    // include them only at the root level.
    include: ['scripts/__tests__/*.test.mjs'],
    exclude: [
      'node_modules',
      'dist',
      '**/node_modules/**',
      // E2E and integration tests require CLI/DB setup — run separately
      '**/e2e/**',
      '**/*.integration.test.ts',
      '**/*-integration.test.ts',
    ],
    // Path aliases matching tsconfig — resolve workspace packages to source
    // TypeScript so Vitest can import them without a build step.
    //
    // T11953 / DHQ-070 · T14525: `withWorkspaceSubpathAliases` PREPENDS the one
    // `@cleocode/<pkg>[/<subpath>]` → source resolver, so ANY workspace import
    // resolves in a fresh (un-built) worktree. It is the only `@cleocode/*`
    // mapping: list only non-workspace aliases below.
    alias: withWorkspaceSubpathAliases({
      // SvelteKit $lib alias for studio package tests (run from root with --shard).
      // The Svelte plugin (above) handles .svelte/.svelte.ts compilation; this
      // alias is still required so vitest resolves $lib/server/* imports correctly.
      '$lib': fileURLToPath(new URL('./packages/studio/src/lib', import.meta.url)),
    }),
    server: {
      deps: {
        // Svelte runes-in-TS modules (.svelte.ts) must be inlined so the
        // Svelte plugin transforms them before vite:import-analysis runs.
        // Matches the inline rule in packages/studio/vitest.config.ts.
        inline: [/\.svelte\.ts$/],
      },
    },
    // ---------------------------------------------------------------------------
    // Vitest 4.x project-based test isolation.
    //
    // Each per-package vitest.config.ts uses `extends: true` to inherit the
    // root settings (pool, isolate, teardownTimeout, env, setupFiles, aliases).
    // Packages may override testTimeout or add package-specific aliases.
    //
    // `pnpm test` runs ALL projects (union of all test files across all configs)
    //  plus the root include above for scripts/__tests__/*.test.mjs.
    // `pnpm test:pkg @cleocode/contracts` runs only that project.
    //
    // @see T9079 Monorepo Build+Test Optimization
    // ---------------------------------------------------------------------------
    projects: [
      'packages/adapters/vitest.config.ts',
      'packages/animations/vitest.config.ts',
      'packages/brain/vitest.config.ts',
      'packages/caamp/vitest.config.ts',
      'packages/cant/vitest.config.ts',
      'packages/cleo/vitest.config.ts',
      'packages/cleo-os/vitest.config.ts',
      'packages/contracts/vitest.config.ts',
      'packages/core/vitest.config.ts',
      'packages/git-shim/vitest.config.ts',
      'packages/lafs/vitest.config.ts',
      'packages/nexus/vitest.config.ts',
      'packages/paths/vitest.config.ts',
      'packages/playbooks/vitest.config.ts',
      'packages/runtime/vitest.config.ts',
      'packages/skills/vitest.config.ts',
      'packages/studio/vitest.config.ts',
      // T11414 / E5: the pure @cleocode/utils leaf was added in #842 but its
      // vitest project was never attached here, so its unit tests (format-bytes,
      // redact) silently did not run in CI shards. Attaching it now.
      'packages/utils/vitest.config.ts',
      'packages/worktree/vitest.config.ts',
      // T10177: scripts/__tests__/*.test.mjs unit tests (bump-workspace-deps,
      // commit-msg-release-lint, lint-cli-package-boundary, etc.) re-attached
      // to the workspace as a dedicated `scripts` project. The root-level
      // `include` field is ignored once `projects:` is set, so without this
      // entry these tests silently stopped running in CI shards.
      'scripts/vitest.config.ts',
      // T13142: tests that read another package's tree without depending on
      // it (vitest.repo-guards.ts). Package-less, so PR CI's affected
      // selection always runs them; their home projects exclude them.
      {
        extends: true,
        test: {
          name: 'repo-guards',
          include: [...REPO_GUARD_TESTS],
          // `extends: true` merges the root's `include` (the scripts tests,
          // which the `scripts` project runs) into this one.
          exclude: ['scripts/**'],
        },
      },
    ],
  },
});
