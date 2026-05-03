import { svelte, vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

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
    pool: 'forks',
    isolate: true,
    // T753: Force-kill worker forks that fail to exit after teardown.
    // Without this, workers with open SQLite handles or process.once('SIGTERM')
    // handlers that call async code can block the runner indefinitely.
    teardownTimeout: 10_000,
    // Note: VITEST env var is auto-set by vitest. Enforcement code checks
    // process.env.VITEST to disable enforcement during test runs.
    // Tests that validate enforcement directly must clear VITEST in beforeAll.
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/src/**/__tests__/*.test.ts',
      'packages/*/tests/**/*.test.ts',
      // skills package uses skills/ instead of src/
      'packages/skills/skills/**/__tests__/*.test.ts',
      // scripts unit tests (new-migration post-processing, lint-migrations logic)
      'scripts/__tests__/*.test.mjs',
    ],
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
    alias: {
      // SvelteKit $lib alias for studio package tests (run from root with --shard).
      // The Svelte plugin (above) handles .svelte/.svelte.ts compilation; this
      // alias is still required so vitest resolves $lib/server/* imports correctly.
      '$lib': new URL('./packages/studio/src/lib', import.meta.url).pathname,
      '@cleocode/caamp': new URL('./packages/caamp/src/index.ts', import.meta.url).pathname,
      '@cleocode/contracts': new URL('./packages/contracts/src/index.ts', import.meta.url).pathname,
      '@cleocode/core/internal': new URL('./packages/core/src/internal.ts', import.meta.url).pathname,
      // T1187-followup / v2026.4.113: specific subpath alias for
      // buildManifestEntryFromShorthand (CLI → core SDK delegation).
      '@cleocode/core/memory/manifest-builder.js': new URL(
        './packages/core/src/memory/manifest-builder.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/core/store/nexus-sqlite': new URL(
        './packages/core/src/store/nexus-sqlite.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/core/store/nexus-schema': new URL(
        './packages/core/src/store/nexus-schema.ts',
        import.meta.url,
      ).pathname,
      // T946 sentient daemon consumes these core subpath exports at runtime.
      '@cleocode/core/sdk': new URL('./packages/core/src/cleo.ts', import.meta.url).pathname,
      // T948 Studio refactor: deep subpaths like /lifecycle/rollup, /tasks/add, /tasks/list.
      // Order matters — most specific first, then the directory-index aliases, then root.
      '@cleocode/core/lifecycle/rollup': new URL(
        './packages/core/src/lifecycle/rollup.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/core/tasks/add': new URL(
        './packages/core/src/tasks/add.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/core/tasks/list': new URL(
        './packages/core/src/tasks/list.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/core/store/data-accessor': new URL(
        './packages/core/src/store/data-accessor.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/core/tasks': new URL(
        './packages/core/src/tasks/index.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/core/lifecycle': new URL(
        './packages/core/src/lifecycle/index.ts',
        import.meta.url,
      ).pathname,
      // T997/T1004: precompact-flush subpath export used by memory dispatch domain
      '@cleocode/core/memory/precompact-flush.js': new URL(
        './packages/core/src/memory/precompact-flush.ts',
        import.meta.url,
      ).pathname,
      // T1003: brain-backfill subpath export used by memory dispatch domain
      '@cleocode/core/memory/brain-backfill.js': new URL(
        './packages/core/src/memory/brain-backfill.ts',
        import.meta.url,
      ).pathname,
      // T1015: sentient + gc daemons relocated from cleo → core
      '@cleocode/core/sentient/daemon.js': new URL(
        './packages/core/src/sentient/daemon.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/core/sentient/state.js': new URL(
        './packages/core/src/sentient/state.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/core/sentient/tick.js': new URL(
        './packages/core/src/sentient/tick.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/core/sentient/propose-tick.js': new URL(
        './packages/core/src/sentient/propose-tick.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/core/sentient/proposal-rate-limiter.js': new URL(
        './packages/core/src/sentient/proposal-rate-limiter.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/core/sentient': new URL(
        './packages/core/src/sentient/index.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/core/gc/daemon.js': new URL(
        './packages/core/src/gc/daemon.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/core/gc/runner.js': new URL(
        './packages/core/src/gc/runner.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/core/gc/state.js': new URL(
        './packages/core/src/gc/state.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/core/gc/transcript.js': new URL(
        './packages/core/src/gc/transcript.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/core/gc': new URL('./packages/core/src/gc/index.ts', import.meta.url).pathname,
      // T1203: core formatters subpath — pure tree/wave rendering utilities
      '@cleocode/core/formatters': new URL(
        './packages/core/src/formatters/index.ts',
        import.meta.url,
      ).pathname,
      // T1453: conduit subpath export used by conduit dispatch domain
      '@cleocode/core/conduit': new URL(
        './packages/core/src/conduit/index.ts',
        import.meta.url,
      ).pathname,
      // T1473: nexus subpath export used by nexus CLI thin wrapper
      '@cleocode/core/nexus': new URL(
        './packages/core/src/nexus/index.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/core': new URL('./packages/core/src/index.ts', import.meta.url).pathname,
      '@cleocode/adapters': new URL('./packages/adapters/src/index.ts', import.meta.url).pathname,
      '@cleocode/lafs': new URL('./packages/lafs/src/index.ts', import.meta.url).pathname,
      // T929: @cleocode/nexus was missing from vitest aliases — core imports it
      // from src/code/index.ts and src/internal.ts, which caused orchestrate-engine
      // tests to fail with "Failed to resolve entry for package @cleocode/nexus".
      '@cleocode/nexus': new URL('./packages/nexus/src/index.ts', import.meta.url).pathname,
    },
    server: {
      deps: {
        // Svelte runes-in-TS modules (.svelte.ts) must be inlined so the
        // Svelte plugin transforms them before vite:import-analysis runs.
        // Matches the inline rule in packages/studio/vitest.config.ts.
        inline: [/\.svelte\.ts$/],
      },
    },
  },
});
