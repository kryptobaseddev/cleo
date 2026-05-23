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
    extends: true,
    name: '@cleocode/cleo',
    globals: true,
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
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
      // T9955: explicit subpath aliases for provenance/jobs/enums modules.
      // These MUST appear BEFORE the bare `@cleocode/contracts` alias so
      // vitest matches the longer prefix first; otherwise the broader alias
      // rewrites the path to `index.ts/<subpath>` and Node errors with ENOTDIR.
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
      '@cleocode/contracts': new URL('../../packages/contracts/src/index.ts', import.meta.url)
        .pathname,
      '@cleocode/core/internal': new URL('../../packages/core/src/internal.ts', import.meta.url)
        .pathname,
      // @cleocode/paths — workspace-local canonical path utilities (env-paths wrapper).
      // Must be aliased so vitest resolves packages/core/src/paths.ts without a build step.
      '@cleocode/paths': new URL('../../packages/paths/src/index.ts', import.meta.url).pathname,
      // caamp and cant — required to resolve @cleocode/core/internal transitive deps
      '@cleocode/caamp': new URL('../../packages/caamp/src/index.ts', import.meta.url).pathname,
      '@cleocode/cant': new URL('../../packages/cant/src/index.ts', import.meta.url).pathname,
      // T1187-followup / v2026.4.113: CLI imports buildManifestEntryFromShorthand
      // from the core SDK (package-boundary fix — CLI must delegate to core for
      // defaulting logic). Matches existing brain-backfill.js / precompact-flush.js pattern.
      '@cleocode/core/memory/manifest-builder.js': new URL(
        '../../packages/core/src/memory/manifest-builder.ts',
        import.meta.url,
      ).pathname,
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
      // T10124 / Saga T10113 — sagas core module hosts the pure-business
      // saga ops (create/add/list/members/rollup) used by the dispatch layer.
      '@cleocode/core/sagas': new URL(
        '../../packages/core/src/sagas/index.ts',
        import.meta.url,
      ).pathname,
      // T997/T1004: precompact-flush subpath export used by memory dispatch domain
      '@cleocode/core/memory/precompact-flush.js': new URL(
        '../../packages/core/src/memory/precompact-flush.ts',
        import.meta.url,
      ).pathname,
      // T1003: brain-backfill subpath export used by memory dispatch domain
      '@cleocode/core/memory/brain-backfill.js': new URL(
        '../../packages/core/src/memory/brain-backfill.ts',
        import.meta.url,
      ).pathname,
      // T1015: sentient + gc daemons relocated from cleo → core
      '@cleocode/core/sentient/daemon.js': new URL(
        '../../packages/core/src/sentient/daemon.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/core/sentient/state.js': new URL(
        '../../packages/core/src/sentient/state.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/core/sentient/tick.js': new URL(
        '../../packages/core/src/sentient/tick.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/core/sentient/propose-tick.js': new URL(
        '../../packages/core/src/sentient/propose-tick.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/core/sentient/proposal-rate-limiter.js': new URL(
        '../../packages/core/src/sentient/proposal-rate-limiter.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/core/sentient': new URL(
        '../../packages/core/src/sentient/index.ts',
        import.meta.url,
      ).pathname,
      // T9421: setup subpath export used by `cleo setup` CLI command + tests.
      '@cleocode/core/setup': new URL(
        '../../packages/core/src/setup/index.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/core/gc/daemon.js': new URL(
        '../../packages/core/src/gc/daemon.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/core/gc/runner.js': new URL(
        '../../packages/core/src/gc/runner.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/core/gc/state.js': new URL(
        '../../packages/core/src/gc/state.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/core/gc/transcript.js': new URL(
        '../../packages/core/src/gc/transcript.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/core/gc': new URL('../../packages/core/src/gc/index.ts', import.meta.url)
        .pathname,
      // T1203: core formatters subpath — pure tree/wave rendering utilities
      '@cleocode/core/formatters': new URL(
        '../../packages/core/src/formatters/index.ts',
        import.meta.url,
      ).pathname,
      // T1453: conduit subpath export used by conduit dispatch domain
      '@cleocode/core/conduit': new URL(
        '../../packages/core/src/conduit/index.ts',
        import.meta.url,
      ).pathname,
      // T1473: nexus subpath export used by nexus CLI thin wrapper
      '@cleocode/core/nexus': new URL(
        '../../packages/core/src/nexus/index.ts',
        import.meta.url,
      ).pathname,
      // T9620: agents public API subpath — CLI agent commands use @cleocode/core/agents
      '@cleocode/core/agents': new URL(
        '../../packages/core/src/agents/index.ts',
        import.meta.url,
      ).pathname,
      // T9769 (T9763 W0): caamp/src/core/advanced/orchestration.ts imports the
      // subpath at runtime — vitest's alias rewrites for `@cleocode/core` only
      // cover the root entry point, leaving this subpath to fall through to
      // node resolution, which fails because root node_modules does not
      // symlink `@cleocode/core`. Map directly to source so transitive caamp
      // imports load under vitest. Resolves the import error that surfaced
      // after T9747's skill-root refactor for every renderer test that pulls
      // in `@cleocode/core` through `formatSuccess`.
      '@cleocode/core/skills/skill-root.js': new URL(
        '../../packages/core/src/skills/skill-root.ts',
        import.meta.url,
      ).pathname,
      // T9424: status subpath export used by `cleo status` CLI thin wrapper
      '@cleocode/core/status': new URL(
        '../../packages/core/src/status/index.ts',
        import.meta.url,
      ).pathname,
      // T9274: llm/usage-pricing subpath — cost tracking helpers (not in package exports map)
      '@cleocode/core/llm/usage-pricing': new URL(
        '../../packages/core/src/llm/usage-pricing.ts',
        import.meta.url,
      ).pathname,
      // T9314: llm/catalog-cache subpath — models.dev live catalog cache
      '@cleocode/core/llm/catalog-cache': new URL(
        '../../packages/core/src/llm/catalog-cache.ts',
        import.meta.url,
      ).pathname,
      // T9323: llm subpath imports used by llm-login.ts and its tests
      '@cleocode/core/llm/credentials-store.js': new URL(
        '../../packages/core/src/llm/credentials-store.ts',
        import.meta.url,
      ).pathname,
      // T9598: config subpath import used by `cleo auth consent`
      '@cleocode/core/config.js': new URL(
        '../../packages/core/src/config.ts',
        import.meta.url,
      ).pathname,
      // T9416: llm subpath imports used by `cleo auth list` / `cleo auth remove`
      '@cleocode/core/llm/credential-pool.js': new URL(
        '../../packages/core/src/llm/credential-pool.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/core/llm/credential-removal.js': new URL(
        '../../packages/core/src/llm/credential-removal.ts',
        import.meta.url,
      ).pathname,
      // T9419: credential-seeders/index subpath used by E2b integration tests
      // to construct SeederRegistry + CredentialSeeder fixtures without going
      // through the BUILTIN_SEEDERS singleton.
      '@cleocode/core/llm/credential-seeders/index.js': new URL(
        '../../packages/core/src/llm/credential-seeders/index.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/core/llm/oauth/device-code.js': new URL(
        '../../packages/core/src/llm/oauth/device-code.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/core/llm/provider-registry/builtin/kimi-code.js': new URL(
        '../../packages/core/src/llm/provider-registry/builtin/kimi-code.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/core/llm/provider-registry/index.js': new URL(
        '../../packages/core/src/llm/provider-registry/index.ts',
        import.meta.url,
      ).pathname,
      // T9315: dynamic imports used by resolveDefaultModel + buildSession
      '@cleocode/core/llm/role-resolver.js': new URL(
        '../../packages/core/src/llm/role-resolver.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/core/llm/concrete-session.js': new URL(
        '../../packages/core/src/llm/concrete-session.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/core/llm/credentials.js': new URL(
        '../../packages/core/src/llm/credentials.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/core/llm/transports/anthropic.js': new URL(
        '../../packages/core/src/llm/transports/anthropic.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/core/llm/transports/chat-completions.js': new URL(
        '../../packages/core/src/llm/transports/chat-completions.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/core/llm/transports/gemini.js': new URL(
        '../../packages/core/src/llm/transports/gemini.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/core/llm/oauth/pkce.js': new URL(
        '../../packages/core/src/llm/oauth/pkce.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/contracts/llm/oauth.js': new URL(
        '../../packages/contracts/src/llm/oauth.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/contracts/operations/llm.js': new URL(
        '../../packages/contracts/src/operations/llm.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/core': new URL('../../packages/core/src/index.ts', import.meta.url).pathname,
      '@cleocode/lafs': new URL('../../packages/lafs/src/index.ts', import.meta.url).pathname,
      // T9965: @a2a-js/sdk is a dep of @cleocode/lafs; in worktrees it resolves
      // through lafs/node_modules rather than root node_modules.
      '@a2a-js/sdk': new URL(
        '../../packages/lafs/node_modules/@a2a-js/sdk/dist/index.js',
        import.meta.url,
      ).pathname,
      // T9965: js-yaml + @iarna/toml are deps of @cleocode/caamp; in worktrees
      // they resolve through caamp/node_modules rather than root node_modules.
      '@iarna/toml': new URL(
        '../../packages/caamp/node_modules/@iarna/toml/toml.js',
        import.meta.url,
      ).pathname,
      'js-yaml': new URL(
        '../../packages/caamp/node_modules/js-yaml/index.js',
        import.meta.url,
      ).pathname,
      // T1113: nexus code sub-path exports — legacy dist-path imports used in nexus.ts
      '@cleocode/nexus/dist/src/code/unfold.js': new URL(
        '../../packages/nexus/src/code/unfold.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/nexus/dist/src/code/search.js': new URL(
        '../../packages/nexus/src/code/search.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/nexus/code/unfold': new URL(
        '../../packages/nexus/src/code/unfold.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/nexus/code/search': new URL(
        '../../packages/nexus/src/code/search.ts',
        import.meta.url,
      ).pathname,
      '@cleocode/nexus': new URL('../../packages/nexus/src/index.ts', import.meta.url).pathname,
      // T9522: @cleocode/worktree — worktree provisioning helpers, transitively
      // imported by @cleocode/core/internal via orchestrate/spawn-ops.ts.
      // Required for integration tests that instantiate TasksHandler.
      '@cleocode/worktree': new URL(
        '../../packages/worktree/src/index.ts',
        import.meta.url,
      ).pathname,
      // T9315: citty is not symlinked into root node_modules in sparse worktrees;
      // alias it to the pnpm store copy so tests that import CLI command files
      // (which use defineCommand) resolve without node_modules setup.
      'citty': new URL(
        '../../node_modules/.pnpm/citty@0.2.1/node_modules/citty/dist/index.mjs',
        import.meta.url,
      ).pathname,
    },
  },
});
