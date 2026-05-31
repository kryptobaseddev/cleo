/**
 * Build-order dependency declarations for the monorepo build orchestrator
 * (`build.mjs`).
 *
 * This file makes inter-package build dependencies EXPLICIT in code, replacing
 * the implicit ordering that previously lived only in `build.mjs`'s wave
 * comments. The shape is consumed by:
 *
 *   1. `build.mjs` — `assertDepsReady(<pkgKey>)` is called immediately before
 *      each `buildPkg(...)` invocation. It hard-fails the build with
 *      `E_BUILD_DEP_MISSING` if any declared dep's `dist/` directory is absent.
 *   2. `scripts/__tests__/build-deps.test.mjs` — regression-locks the critical
 *      `cant -> caamp` edge (the original bug class from T9939) plus a wave-
 *      ordering invariant check.
 *
 * ## Rationale (T9939)
 *
 * `caamp`'s tsup DTS step imports `@cleocode/cant` directly:
 *
 * ```ts
 * // packages/caamp/src/manifest/validate.ts
 * import { validateDocument } from '@cleocode/cant';
 * ```
 *
 * tsup runs rollup-plugin-dts during the DTS phase, which requires `cant`'s
 * `.d.ts` declarations to exist on disk BEFORE caamp builds. Without an
 * explicit hard prereq, a future refactor of the wave structure could
 * accidentally place caamp ahead of cant — the build would then fail with a
 * confusing `TS2307: Cannot find module '@cleocode/cant'` deep inside the
 * rollup-plugin-dts output, instead of an actionable error at the wave gate.
 *
 * Caught during T9853 hotfix prep, where contributors had to manually
 * `pnpm --filter @cleocode/cant run build` BEFORE `pnpm run build` to unstick
 * the caamp tsup DTS step.
 *
 * ## Adding a new package
 *
 * Add an entry whose key is the dist-path key used as the second arg of
 * `buildPkg(...)` (e.g. `packages/caamp/dist/`) and whose value is the list of
 * dist paths that MUST exist before that build starts. Internal deps only —
 * external (npm) deps are out of scope. Test asserts every declared dep is a
 * known dist key.
 *
 * @task T9939
 * @epic T9864
 * @saga T9862
 */

/**
 * Canonical inter-package build dependency map.
 *
 * Keys and values are the same `packages/<pkg>/dist/` strings passed as the
 * second arg to `buildPkg(...)` in `build.mjs`. Keeping a single canonical
 * spelling means the assertion + the test can string-compare without a
 * normalization step.
 *
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const PACKAGE_DEPS = Object.freeze({
  // Wave 1: zero internal deps (true roots of the graph).
  'packages/lafs/dist/': Object.freeze([]),
  'packages/paths/dist/': Object.freeze([]),

  // Wave 2: contracts depends on lafs (re-exports lafs envelope types).
  'packages/contracts/dist/': Object.freeze(['packages/lafs/dist/']),

  // Wave 3: worktree + git-shim + nexus + cant — all depend on
  // contracts + paths (both ready after wave 2).
  'packages/worktree/dist/': Object.freeze(['packages/contracts/dist/', 'packages/paths/dist/']),
  'packages/git-shim/dist/': Object.freeze(['packages/contracts/dist/', 'packages/paths/dist/']),
  'packages/nexus/dist/': Object.freeze(['packages/contracts/dist/', 'packages/paths/dist/']),
  // ┌─ The critical edge this entire module exists to lock in. ─────────────┐
  // │ cant declares contracts + lafs deps; the cant→caamp prereq lives on  │
  // │ caamp's entry below.                                                  │
  // └───────────────────────────────────────────────────────────────────────┘
  'packages/cant/dist/': Object.freeze(['packages/contracts/dist/', 'packages/lafs/dist/']),

  // Wave 4: caamp imports from @cleocode/cant in its tsup DTS step (T9939).
  // This is the regression-locked edge — DO NOT remove cant from this list
  // without also moving caamp to a wave that runs after wave 3.
  'packages/caamp/dist/': Object.freeze([
    'packages/cant/dist/',
    'packages/contracts/dist/',
    'packages/lafs/dist/',
    'packages/paths/dist/',
  ]),

  // Wave 5: core depends on caamp, nexus, worktree, paths, contracts.
  'packages/core/dist/': Object.freeze([
    'packages/caamp/dist/',
    'packages/contracts/dist/',
    'packages/nexus/dist/',
    'packages/paths/dist/',
    'packages/worktree/dist/',
  ]),

  // Wave 6: runtime + adapters — both depend only on core (+ contracts).
  'packages/runtime/dist/': Object.freeze(['packages/contracts/dist/', 'packages/core/dist/']),
  'packages/adapters/dist/': Object.freeze(['packages/contracts/dist/', 'packages/core/dist/']),

  // Wave 7: playbooks — depends on core only.
  // packages/mcp-adapter was deleted (R8 · T11259); MCP transport lives in @cleocode/runtime/gateway/mcp.
  'packages/playbooks/dist/': Object.freeze(['packages/contracts/dist/', 'packages/core/dist/']),

  // Wave 8: cleo (esbuild) depends on adapters, playbooks, runtime, core.
  'packages/cleo/dist/': Object.freeze([
    'packages/adapters/dist/',
    'packages/contracts/dist/',
    'packages/core/dist/',
    'packages/playbooks/dist/',
    'packages/runtime/dist/',
  ]),

  // Wave 9: cleo-os depends on cleo + cant.
  'packages/cleo-os/dist/': Object.freeze(['packages/cant/dist/', 'packages/cleo/dist/']),
});

/**
 * Look up the declared deps for a given build target. Returns an empty array
 * when the target has no declared deps (true roots) or is unknown.
 *
 * @param {string} distLabel - The `packages/<pkg>/dist/` label.
 * @returns {readonly string[]}
 */
export function depsFor(distLabel) {
  const found = PACKAGE_DEPS[distLabel];
  return found ?? Object.freeze([]);
}
