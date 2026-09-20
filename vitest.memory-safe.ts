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

import { readFileSync } from 'node:fs';
import { cpus, freemem } from 'node:os';

/** Bytes per GiB. */
const GB = 1024 ** 3;

/**
 * RAM budget assumed per fork.
 *
 * Deliberately LARGER than {@link FORK_HEAP_MB}. `--max-old-space-size` bounds
 * the V8 old space and nothing else, while these tests open SQLite with the
 * native `vec0` extension — those allocations are native and are never counted
 * against the heap cap. The gap between 4 GB of heap and this 6 GB budget is
 * that uncounted native footprint plus headroom.
 */
export const RAM_BUDGET_PER_FORK_GB = 6;

/**
 * Memory held back from the fork budget for everything that is NOT this test
 * run: the desktop session, browsers, language servers, and any OTHER agent
 * session sharing the machine.
 *
 * Without this the budget silently assumes a dedicated box.
 */
export const RESERVED_HEADROOM_GB = 12;

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
 * Bytes of memory actually available to start new work — not bytes installed.
 *
 * Takes the MINIMUM of two independent readings, because either can be the
 * binding constraint:
 *
 *   1. **The enclosing cgroup v2 budget.** Resolved by reading this process's
 *      own cgroup path from `/proc/self/cgroup` and walking every ancestor up
 *      to the root, taking the tightest `min(memory.high, memory.max) -
 *      memory.current`. Walking matters: on a systemd desktop the limit is set
 *      on `app.slice`, several levels above the scope the process lands in, and
 *      the ROOT cgroup's `memory.*` files are not even readable. A previous
 *      revision read `/sys/fs/cgroup/memory.current` directly, which is the
 *      root, so this whole branch silently never fired on the machine it was
 *      written to protect.
 *   2. **`MemAvailable` from `/proc/meminfo`** — what Linux believes can be
 *      handed out without swapping. This counts reclaimable page cache, which
 *      `os.freemem()` (MemFree) wrongly excludes, so `freemem()` alone badly
 *      understates availability on a warm box.
 *
 * Every read is best-effort: an unreadable or malformed source is skipped
 * rather than thrown, because this runs at vitest config load and a config that
 * throws takes the whole suite with it.
 *
 * @returns Available bytes, falling back to `os.freemem()` when neither source
 *   can be read (non-Linux, or a restricted sandbox).
 */
function availableMemoryBytes(): number {
  const readNum = (path: string): number | null => {
    try {
      const raw = readFileSync(path, 'utf8').trim();
      if (raw === 'max') return Number.POSITIVE_INFINITY;
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 ? n : null;
    } catch {
      return null;
    }
  };

  const candidates: number[] = [];

  // 1. cgroup v2 — the ceiling that actually SIGKILLs us, wherever it is set.
  try {
    // "0::/user.slice/…/app.slice/foo.scope" → the path after the second colon.
    const own = /^0::(.*)$/m.exec(readFileSync('/proc/self/cgroup', 'utf8'))?.[1];
    if (own !== undefined) {
      const segments = own.split('/').filter(Boolean);
      // Walk deepest → root, inspecting every ancestor for a limit.
      for (let depth = segments.length; depth >= 0; depth--) {
        const dir = `/sys/fs/cgroup${segments.slice(0, depth).map((seg) => `/${seg}`).join('')}`;
        const current = readNum(`${dir}/memory.current`);
        if (current === null || !Number.isFinite(current)) continue;
        const limit = Math.min(
          readNum(`${dir}/memory.high`) ?? Number.POSITIVE_INFINITY,
          readNum(`${dir}/memory.max`) ?? Number.POSITIVE_INFINITY,
        );
        if (Number.isFinite(limit)) candidates.push(Math.max(0, limit - current));
      }
    }
  } catch {
    // fall through to the meminfo reading
  }

  // 2. Linux MemAvailable.
  try {
    const match = /^MemAvailable:\s+(\d+) kB$/m.exec(readFileSync('/proc/meminfo', 'utf8'));
    if (match?.[1]) candidates.push(Number(match[1]) * 1024);
  } catch {
    // fall through to the portable path
  }

  // 3. Portable fallback.
  return candidates.length > 0 ? Math.min(...candidates) : freemem();
}

/**
 * Fork count bounded by CPU, by memory ACTUALLY AVAILABLE, and by a hard ceiling.
 *
 * The previous revision divided `totalmem()` by the per-fork budget. That is the
 * wrong denominator — installed RAM says nothing about what is free — so on a
 * box already running a desktop and other agent sessions the same memory was
 * budgeted twice and the run was OOM-killed. Measured 2026-09-20 on a 24-core /
 * 62.5 GB machine with ~16 GB already in use: `totalmem` yielded 6 forks (24 GB
 * nominal) which, on top of that 16 GB, brushed the 45 GiB `MemoryHigh` on
 * `app.slice` and was killed. Reading availability instead yields 1-4 forks on
 * the same box depending on what else is running, and the full 6 on an idle one.
 *
 * This is the third revision of this guard. T11839 put the bounds in the ROOT
 * config, where a direct `--root packages/<pkg>` run never inherited them;
 * T12087 moved them into this module so every config spreads them directly but
 * kept the `totalmem` denominator. Both were correct about the mechanism they
 * fixed and wrong about the one that was still firing.
 *
 * Override with `CLEO_TEST_MAX_WORKERS` when you know better than the heuristic
 * (CI pinning, a deliberately serial debug run). Values below 1 are ignored.
 */
export const MEMORY_SAFE_MAX_WORKERS = ((): number => {
  const override = Number(process.env['CLEO_TEST_MAX_WORKERS']);
  if (Number.isFinite(override) && override >= 1) return Math.floor(override);

  const budgetBytes = Math.max(0, availableMemoryBytes() - RESERVED_HEADROOM_GB * GB);
  const byMemory = Math.max(1, Math.floor(budgetBytes / (RAM_BUDGET_PER_FORK_GB * GB)));

  return Math.max(1, Math.min(Math.max(1, cpus().length - 1), byMemory, MAX_FORKS_CEILING));
})();

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
