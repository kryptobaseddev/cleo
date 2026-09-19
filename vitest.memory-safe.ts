/**
 * Memory-safe vitest fork settings — the SSoT every config must spread (T12087).
 *
 * ## The freeze this prevents
 *
 * `pool: 'forks'` with vitest's default `maxWorkers` (CPU-1) spawns ~23 forks on
 * a 24-core box. Each loads the heavy `@cleocode/core` graph (sqlite/vec0 native
 * + the full SDK) at roughly 2.7 GB, and without an explicit V8 ceiling a single
 * leaky test grows unbounded. 23 × 2.7 GB ≈ 62 GB → kernel OOM → the whole
 * machine freezes and the session dies.
 *
 * ## Why this file exists instead of living in the root config
 *
 * T11839 fixed this in the ROOT `vitest.config.ts` and relied on
 * `test.extends: true` in each package config to inherit it. That covers
 * `pnpm run test` (which resolves the workspace root) but NOT a direct
 * per-package invocation:
 *
 * ```bash
 * vitest run --root packages/core        # packages/core IS the root — nothing to extend
 * pnpm run test:pkg <name>               # same
 * ```
 *
 * A guard that applies on one invocation path and silently not on another is
 * indistinguishable from no guard, because the unsafe path is the convenient
 * one. It froze this machine twice on 2026-08-06, both times from a scoped
 * `--root packages/core` run.
 *
 * So the settings live in a plain module that every config imports and spreads
 * **directly**. No inheritance, no invocation-path dependency, and a lint gate
 * (`scripts/lint-vitest-memory-safe.mjs`) fails any package config that omits
 * it.
 *
 * @task T12087
 * @task T11839
 */

import { cpus, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';

/** Bytes per GiB. */
const GB = 1024 ** 3;

/**
 * RAM budget assumed per fork. Sized from the measured ~2.7 GB peak of a
 * core-graph test fork plus headroom, so `totalmem / this` is a safe fork count.
 */
export const RAM_BUDGET_PER_FORK_GB = 6;

/**
 * Hard ceiling on parallel forks regardless of machine size.
 *
 * Beyond this the suite is I/O- and SQLite-lock-bound rather than CPU-bound, so
 * more forks buy nothing and cost memory.
 */
export const MAX_FORKS_CEILING = 6;

/** Per-fork V8 old-space cap (MB) — bounds ONE runaway test to its own fork. */
export const FORK_HEAP_MB = 4096;

/**
 * Fork count bounded by CPU **and** physical RAM **and** a hard ceiling.
 *
 * On a 24-core / 62 GB box: `min(23, 10, 6)` = 6 forks × 4 GB = a 24 GB
 * ceiling. On a 2-core CI runner: `min(1, …)` = 1.
 */
export const MEMORY_SAFE_MAX_WORKERS = Math.max(
  1,
  Math.min(
    Math.max(1, cpus().length - 1),
    Math.floor(totalmem() / (RAM_BUDGET_PER_FORK_GB * GB)),
    MAX_FORKS_CEILING,
  ),
);

/**
 * Spread this into EVERY `defineConfig({ test: … })` in the repo.
 *
 * `pool: 'forks'` + `isolate: true` are included because the memory ceiling is
 * only meaningful for the fork pool — a config that overrides the pool back to
 * threads would silently escape `execArgv`, since worker_threads do not take
 * per-worker V8 flags this way.
 *
 * @example
 * ```ts
 * import { MEMORY_SAFE_TEST_DEFAULTS } from '../../vitest.memory-safe.js';
 *
 * export default defineConfig({
 *   test: { ...MEMORY_SAFE_TEST_DEFAULTS, name: '@cleocode/core', … },
 * });
 * ```
 *
 * @task T12087
 */
export const MEMORY_SAFE_TEST_DEFAULTS = {
  // Every project spreads these defaults. An absolute setup path also works
  // for direct package runs and does not depend on workspace inheritance.
  setupFiles: [fileURLToPath(new URL('./vitest.setup.ts', import.meta.url))],
  pool: 'forks',
  isolate: true,
  maxWorkers: MEMORY_SAFE_MAX_WORKERS,
  minWorkers: 1,
  // TOP-LEVEL `execArgv`, not `poolOptions.forks.execArgv`.
  //
  // Vitest 4 REMOVED `test.poolOptions` ("All previous poolOptions are now
  // top-level options") and ignores the old shape with only a deprecation
  // warning on stderr. T11839 wrote the nested form, so from the Vitest 4
  // upgrade onward the fork count was still bounded (`maxWorkers` is top-level)
  // while the per-fork heap ceiling silently evaporated — which is why the
  // machine kept freezing despite a fix that looked present in the config.
  //
  // A config option that is silently ignored is worse than one that errors: the
  // guard reads as active in review and is absent at runtime.
  execArgv: [`--max-old-space-size=${FORK_HEAP_MB}`],
} as const;
