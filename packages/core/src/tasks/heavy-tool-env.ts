/**
 * Hard memory ceiling injected into every heavy tool CLEO spawns (T12096).
 *
 * ## Why a cap at the spawn point, and not just a semaphore
 *
 * T12091 bounded how many `tool:test` INVOCATIONS run at once. It counts an
 * entire process tree as one slot — and in a workspace, one invocation is not
 * one test run. Measured 2026-08-09 in `/mnt/projects/PepsVida`:
 *
 *     cleo verify T1046 --gate testsPassed --evidence tool:test
 *       └─ npm test
 *           └─ pnpm -r --if-present run test     ← fans out
 *               └─ concurrent vitest in {apps,lib}/*   (15 packages have tests)
 *
 * CLEO's semaphore saw ONE slot in use. The project has 15 packages with a
 * `test` script and **none of its three vitest configs cap `maxWorkers` or
 * heap** — the memory-safe SSoT and its lint gate live in cleocode and protect
 * only cleocode. So a single evidence atom could expand to 15 concurrent
 * unbounded fork pools on a 62 GiB machine.
 *
 * A consuming project cannot be relied on to configure this. CLEO is the one
 * spawning the process, so CLEO sets the ceiling — and the child inherits it
 * whether or not the project has ever heard of `vitest.memory-safe.ts`.
 *
 * ## The three levers (each verified against the installed tool, not assumed)
 *
 * | Variable | Effect | Verified by |
 * |---|---|---|
 * | `NODE_OPTIONS=--max-old-space-size=N` | Heap ceiling for EVERY node process in the tree, inherited | node docs; appended, never clobbered |
 * | `VITEST_MAX_WORKERS=N` | `if (process.env.VITEST_MAX_WORKERS) resolved.maxWorkers = parseInt(...)` — overrides the resolved config, so it binds projects that set their own | read out of vitest 4.1.4 `dist/chunks/coverage.*.js` |
 * | `npm_config_workspace_concurrency=N` / `pnpm_config_workspace_concurrency=N` | Bounds `pnpm -r` fan-out across workspace packages (pnpm 10 reads the first, pnpm 11+ the second) | `npm_config_workspace_concurrency=1 pnpm config get workspace-concurrency` → `1` on pnpm 10.30; `pnpm_config_…` → `1` on pnpm 12.6 (T13122) |
 *
 * Together these bound the product the semaphore could not see:
 * `packages in flight × workers per run × heap per worker`.
 *
 * The worker levers apply ONLY to `test` / `build`, the tools that fork.
 * `typecheck` and `lint` are single processes, but not cheap ones: one
 * TypeScript program on a large monorepo holds 2–5 GB (a live `tsc --noEmit`
 * held 4.7 GB on 2026-10-03), so since T13123 they get the heap ceiling and the
 * workspace-concurrency bound too ({@link isMemoryBoundTool}), and no worker
 * variables, which nothing they run reads.
 *
 * ## An inherited value can tighten the plan, never loosen it (T13122)
 *
 * The overlay is merged over the CALLER's environment: whatever the shell
 * profile, the agent harness or a parent process exported. Until T13122 an
 * inherited value always won, on the theory that "a deliberate setting beats our
 * default". A shell profile is not a per-project decision: on 2026-10-03 a
 * `~/.zprofile` export of `NODE_OPTIONS=--max-old-space-size=8192` reached a
 * `cleo verify --evidence tool:test`, and the run got 6 workers × 8 GiB = all of
 * a 48 GiB Mac, because the worker count was sized for a 4 GiB heap it was not
 * getting.
 *
 * So the run has a heap budget — the default worker count times the default heap
 * ({@link heavyRunBudgetMb}) — and the overlay is planned against it
 * ({@link planHeavyToolEnv}):
 *
 *   - an inherited `NODE_OPTIONS` heap that fits the budget is kept, and the
 *     worker count shrinks so `workers × heap` still fits; one above the budget
 *     is clamped to it;
 *   - an inherited worker count or workspace concurrency at or below the plan
 *     is kept; one above it is clamped;
 *   - only an explicit CLEO override asks for more: `CLEO_HEAVY_HEAP_MB`,
 *     `CLEO_HEAVY_WORKERS`, `CLEO_HEAVY_WORKSPACE_CONCURRENCY`.
 *
 * A project that wants more for its own suite still sets it in its own script
 * (`"test": "NODE_OPTIONS=… vitest run"`) or config: that runs below the
 * overlay and is untouched by it. The plan, and every value it clamped, is
 * reported by `cleo verify` and `cleo run`.
 *
 * @task T12096
 * @task T13122
 * @task T13123
 */

import { totalmem } from 'node:os';
import type { HeavyLeverChange, HeavyToolResourcePlan } from '@cleocode/contracts';
import type { CanonicalTool } from './tool-resolver.js';

/**
 * Heap ceiling per node process, in MiB.
 *
 * Matches `FORK_HEAP_MB` in `vitest.memory-safe.ts`. A worker that needs more
 * than 4 GiB of JS heap for a unit test has a leak, and the whole point is to
 * make that fail loudly in one worker rather than take the machine down.
 */
export const HEAVY_TOOL_HEAP_MB = 4096;

/** RAM assumed consumable per concurrent worker, in GiB, when sizing the pool. */
export const GIB_PER_WORKER = 6;

/** Never grant more than this many workers, however large the machine. */
export const MAX_HEAVY_WORKERS = 6;

/** Never grant fewer than this many — one worker must always be able to run. */
export const MIN_HEAVY_WORKERS = 1;

/**
 * Workspace packages allowed to run their test/build script concurrently.
 *
 * Deliberately 1. The fan-out is the multiplier the semaphore was blind to, and
 * a serialised workspace sweep is slower but finishes; a parallel one on a
 * memory-bound box does not finish at all.
 */
export const WORKSPACE_CONCURRENCY = 1;

/**
 * The default heap never drops below this, in MiB, however small the machine —
 * one worker must be able to run a real suite.
 *
 * @task T13122
 */
export const MIN_HEAVY_HEAP_MB = 1024;

/**
 * Fraction of total RAM the DEFAULT heap may reach. {@link HEAVY_TOOL_HEAP_MB}
 * on an 8 GiB laptop is half the machine; on a 4 GiB box it would be all of it,
 * which is no ceiling at all. Machines of 8 GiB and up are unaffected.
 *
 * @task T13122
 */
export const HEAVY_HEAP_RAM_FRACTION = 0.5;

/**
 * Explicit heap ceiling for heavy tools, in MiB. The only way to ask for a heap
 * above the run's budget: unlike an inherited `NODE_OPTIONS`, it is never
 * clamped.
 *
 * @task T13122
 */
export const HEAVY_HEAP_ENV = 'CLEO_HEAVY_HEAP_MB';

/**
 * Explicit worker count for heavy tools. Replaces the planned count for every
 * runner variable, even when that puts the run over its budget.
 *
 * @task T13122
 */
export const HEAVY_WORKERS_ENV = 'CLEO_HEAVY_WORKERS';

/**
 * Explicit workspace concurrency for heavy tools (`pnpm -r` packages in flight).
 *
 * @task T13122
 */
export const HEAVY_WORKSPACE_CONCURRENCY_ENV = 'CLEO_HEAVY_WORKSPACE_CONCURRENCY';

/**
 * The two spellings of pnpm's `workspace-concurrency` in the environment. pnpm
 * 10 reads only `npm_config_workspace_concurrency`; pnpm 11+ reads only
 * `pnpm_config_workspace_concurrency` (measured: pnpm 10.30.0 and 12.6.0 each
 * report `undefined` for the other spelling). Setting one bounded `pnpm -r`
 * fan-out on one pnpm major and silently nothing on the other, so the overlay
 * sets both.
 *
 * @task T13122
 */
export const WORKSPACE_CONCURRENCY_VARS = [
  'npm_config_workspace_concurrency',
  'pnpm_config_workspace_concurrency',
] as const;

/** Environment overlay to merge into a heavy tool's spawn env. */
export type HeavyToolEnv = Readonly<Record<string, string>>;

/**
 * The overlay for one heavy or memory-bound tool spawn, with the plan behind it
 * (T13122).
 *
 * `resources` is `null` for a tool that is not memory-bound, whose overlay is
 * empty.
 */
export interface HeavyToolSpawnPlan {
  /** Variables to merge over the caller's environment. */
  readonly overlay: HeavyToolEnv;
  /** What was chosen and why; `null` when the tool is not heavy. */
  readonly resources: HeavyToolResourcePlan | null;
}

/**
 * Canonical tools treated as HEAVY — the ones that fork.
 *
 * The single definition. Before this there were four independent literals
 * across `heavy-tool-env.ts`, `tool-semaphore.ts`, `tool-cache.ts` and
 * `heavy-tool-limit.ts`, all agreeing by coincidence. Adding a fifth heavy tool
 * took four coordinated edits, and missing one produced a **silent asymmetry** —
 * a tool inheriting the long deadline but no memory bound, say, which is the
 * ordering hazard we sequence PRs to avoid, reappearing inside one process.
 */
const HEAVY_TOOLS = new Set<CanonicalTool>(['test', 'build']);

/**
 * Whether a canonical tool is heavy enough to need bounding.
 *
 * Heavy means "forks, and its memory is a product rather than a constant":
 * a test or build spawns workers, which is what makes the ceiling necessary.
 * `lint`, `typecheck`, `audit` and `security-scan` are single cheap processes —
 * bounding them costs a subprocess to guard nothing.
 *
 * @param canonical - the tool in question.
 * @returns `true` when the tool needs a worker cap, a memory ceiling and the
 *          longer spawn deadline. All three must agree, which is why they read
 *          this instead of each keeping a literal.
 *
 * @example
 * ```ts
 * isHeavyTool('test');      // true
 * isHeavyTool('typecheck'); // false
 * ```
 */
export function isHeavyTool(canonical: CanonicalTool): boolean {
  return HEAVY_TOOLS.has(canonical);
}

/**
 * Canonical tools whose memory must be bounded: the heavy ones, plus the
 * single-process tools that build a whole TypeScript program (T13123).
 */
const MEMORY_BOUND_TOOLS = new Set<CanonicalTool>(['test', 'build', 'typecheck', 'lint']);

/**
 * Whether a canonical tool's memory is bounded: a heap ceiling and workspace
 * concurrency in its spawn env, a RAM-derived machine-wide slot count that
 * shrinks under pressure, and a {@link ResourceGovernor} class.
 *
 * A superset of {@link isHeavyTool}. `typecheck` and `lint` were treated as
 * cheap (`max(2, cpus/2)` slots, no ceiling) until T13123: nine concurrent
 * `tsc` runs of 2–5 GB each on an 18-core box is most of 48 GB. `audit` and
 * `security-scan` stay unbounded — they are network-bound and small.
 *
 * @param canonical - the tool in question.
 * @returns `true` for `test`, `build`, `typecheck` and `lint`.
 *
 * @example
 * ```ts
 * isMemoryBoundTool('typecheck'); // true
 * isMemoryBoundTool('audit');     // false
 * ```
 *
 * @task T13123
 */
export function isMemoryBoundTool(canonical: CanonicalTool): boolean {
  return MEMORY_BOUND_TOOLS.has(canonical);
}

/**
 * Per-runner worker-count variables, keyed by the env var each runner reads.
 *
 * T12116: the original overlay set `VITEST_MAX_WORKERS` and nothing else, so a
 * consumer running `cargo test`, `pytest`, `go test` or `make` got no bound at
 * all — and CLEO is a general task runner whose projects are not all Node.
 * Each entry below is the documented knob for one ecosystem's test/build
 * parallelism; setting a variable a project does not use is inert, so the whole
 * table can be applied unconditionally.
 *
 * This is still advisory — a runner may ignore its own variable. The hard bound
 * is the cgroup in `heavy-tool-limit.ts`; these merely stop a cooperative
 * runner from sizing its pool off `nproc` and immediately breaching it.
 */
const WORKER_COUNT_VARS = [
  /** vitest — overrides the resolved config, so it binds projects with their own. */
  'VITEST_MAX_WORKERS',
  /** jest — honoured by jest >= 29 when no CLI flag is given. */
  'JEST_MAX_WORKERS',
  /** cargo test / libtest harness. */
  'RUST_TEST_THREADS',
  /** cargo build + `cargo test`'s compile step. */
  'CARGO_BUILD_JOBS',
  /** Go toolchain — bounds both `go test -p` scheduling and runtime threads. */
  'GOMAXPROCS',
  /** pytest-xdist, when `-n auto` is in use. */
  'PYTEST_XDIST_AUTO_NUM_WORKERS',
] as const;

/**
 * Default worker count this machine can hold, given {@link GIB_PER_WORKER}.
 *
 * The planned count ({@link planHeavyToolEnv}) never exceeds this: a small
 * inherited heap does not buy extra workers, because each worker also costs
 * memory outside its heap.
 *
 * @param totalRamGib - total RAM in GiB; defaults to a live reading.
 * @returns a value in `[MIN_HEAVY_WORKERS, MAX_HEAVY_WORKERS]`.
 */
export function heavyToolWorkers(totalRamGib: number = totalmem() / 1024 ** 3): number {
  const byRam = Math.floor(totalRamGib / GIB_PER_WORKER);
  return Math.min(MAX_HEAVY_WORKERS, Math.max(MIN_HEAVY_WORKERS, byRam));
}

/**
 * Default heap ceiling per Node process, in MiB: {@link HEAVY_TOOL_HEAP_MB},
 * lowered to {@link HEAVY_HEAP_RAM_FRACTION} of RAM on a machine under 8 GiB
 * (never below {@link MIN_HEAVY_HEAP_MB}).
 *
 * @param totalRamGib - total RAM in GiB; defaults to a live reading.
 * @returns the default heap in MiB.
 *
 * @example
 * ```ts
 * defaultHeavyHeapMb(64); // → 4096
 * defaultHeavyHeapMb(4);  // → 2048
 * ```
 *
 * @task T13122
 */
export function defaultHeavyHeapMb(totalRamGib: number = totalmem() / 1024 ** 3): number {
  const byRam = Math.floor(totalRamGib * 1024 * HEAVY_HEAP_RAM_FRACTION);
  return Math.min(HEAVY_TOOL_HEAP_MB, Math.max(MIN_HEAVY_HEAP_MB, byRam));
}

/**
 * Heap budget for one heavy run, in MiB: the default worker count times the
 * default heap. `workspace concurrency × workers × heap` must fit in it.
 *
 * Unchanged by T13122 for the default case (6 × 4096 = 24 GiB on 36 GiB and
 * up, 1 × 4096 on 8 GiB); what changed is that an inherited heap is now planned
 * against it instead of multiplying it.
 *
 * @param totalRamGib - total RAM in GiB; defaults to a live reading.
 * @returns the budget in MiB.
 *
 * @example
 * ```ts
 * heavyRunBudgetMb(64); // → 24576 (6 workers × 4096)
 * heavyRunBudgetMb(16); // → 8192  (2 workers × 4096)
 * heavyRunBudgetMb(8);  // → 4096  (1 worker  × 4096)
 * ```
 *
 * @task T13122
 */
export function heavyRunBudgetMb(totalRamGib: number = totalmem() / 1024 ** 3): number {
  return heavyToolWorkers(totalRamGib) * defaultHeavyHeapMb(totalRamGib);
}

/**
 * `NODE_OPTIONS` flags that set a V8 heap limit. `max-old-space-size` and its
 * percentage form decide the old-space ceiling; `max-semi-space-size` sizes the
 * young generation and is only ever read, never rewritten.
 *
 * @task T12989
 * @task T13122
 */
export const HEAP_FLAG_NAMES: ReadonlySet<string> = new Set([
  'max-old-space-size',
  'max-old-space-size-percentage',
  'max-semi-space-size',
]);

/** The two flags that set the old-space ceiling, which a plan replaces. */
const OLD_SPACE_FLAGS: ReadonlySet<string> = new Set([
  'max-old-space-size',
  'max-old-space-size-percentage',
]);

/** A `NODE_OPTIONS` token split into a heap flag, or `null` when it is not one. */
interface HeapToken {
  /** Flag name with underscores read as dashes. */
  readonly name: string;
  /** The value, `''` when absent. */
  readonly value: string;
  /** Tokens consumed: 2 for the space-separated spelling. */
  readonly width: 1 | 2;
}

function heapTokenAt(tokens: readonly string[], i: number): HeapToken | null {
  const token = tokens[i] ?? '';
  if (!token.startsWith('--')) return null;
  const eq = token.indexOf('=');
  const name = (eq === -1 ? token.slice(2) : token.slice(2, eq)).replace(/_/g, '-');
  if (!HEAP_FLAG_NAMES.has(name)) return null;
  const next = tokens[i + 1];
  if (eq === -1 && next !== undefined && /^\d+(\.\d+)?$/.test(next)) {
    return { name, value: next, width: 2 };
  }
  return { name, value: eq === -1 ? '' : token.slice(eq + 1), width: 1 };
}

/**
 * The V8 heap flags a `NODE_OPTIONS` value sets, by name, with the value in
 * effect.
 *
 * V8 reads flags left to right and a later value replaces an earlier one, so
 * the LAST occurrence of each flag is the effective one. Underscores in a flag
 * name read as dashes, as they do to V8, and the space-separated spelling
 * (`--max-old-space-size 4096`) is read too.
 *
 * @param nodeOptions - A `NODE_OPTIONS` value, if any.
 * @returns flag name → effective value, in first-seen order.
 *
 * @task T12989
 * @task T13122
 */
export function parseHeapFlags(nodeOptions: string | undefined): ReadonlyMap<string, string> {
  const tokens = (nodeOptions ?? '').trim().split(/\s+/).filter(Boolean);
  const values = new Map<string, string>();
  for (let i = 0; i < tokens.length; i++) {
    const flag = heapTokenAt(tokens, i);
    if (flag === null) continue;
    values.set(flag.name, flag.value);
    i += flag.width - 1;
  }
  return values;
}

/**
 * The old-space heap ceiling a `NODE_OPTIONS` value asks for, in MiB, or
 * `null` when it sets none (or sets one Node could not use).
 *
 * `--max-old-space-size-percentage` wins over `--max-old-space-size` whatever
 * their order (measured on Node 24.21: `=10` beside `=2048` gave a 6745 MiB
 * limit on a 64 GiB machine either way round), and resolves against total RAM.
 *
 * @param nodeOptions - A `NODE_OPTIONS` value, if any.
 * @param totalRamMb - Total RAM in MiB, for the percentage form.
 * @returns the requested heap in MiB, or `null`.
 *
 * @example
 * ```ts
 * inheritedHeapMb('--max-old-space-size=8192', 65536);          // → 8192
 * inheritedHeapMb('--max-old-space-size-percentage=25', 65536); // → 16384
 * inheritedHeapMb('--enable-source-maps', 65536);               // → null
 * ```
 *
 * @task T13122
 */
export function inheritedHeapMb(
  nodeOptions: string | undefined,
  totalRamMb: number,
): number | null {
  const flags = parseHeapFlags(nodeOptions);
  const pct = Number(flags.get('max-old-space-size-percentage') ?? Number.NaN);
  if (Number.isFinite(pct) && pct > 0 && pct <= 100) {
    return Math.floor((totalRamMb * pct) / 100);
  }
  const mb = Number(flags.get('max-old-space-size') ?? Number.NaN);
  return Number.isFinite(mb) && mb >= 1 ? Math.floor(mb) : null;
}

/**
 * Set the old-space heap ceiling in a `NODE_OPTIONS` value: every existing
 * `--max-old-space-size` and `--max-old-space-size-percentage` is removed and one
 * `--max-old-space-size=<heapMb>` appended. Every other flag survives in order —
 * a project may rely on `--experimental-*` or `--require` there.
 *
 * Removing the percentage form is required, not tidiness: it outranks the size
 * form whatever the order, so leaving it would silently undo the ceiling.
 *
 * @param existing - current `NODE_OPTIONS`, if any.
 * @param heapMb - ceiling to apply.
 * @returns the rewritten value.
 *
 * @example
 * ```ts
 * withHeapCeiling('--enable-source-maps --max-old-space-size=8192', 4096);
 * // → '--enable-source-maps --max-old-space-size=4096'
 * ```
 *
 * @task T13122
 */
export function withHeapCeiling(existing: string | undefined, heapMb: number): string {
  const tokens = (existing ?? '').trim().split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const flag = heapTokenAt(tokens, i);
    if (flag !== null && OLD_SPACE_FLAGS.has(flag.name)) {
      i += flag.width - 1;
      continue;
    }
    kept.push(tokens[i] ?? '');
  }
  kept.push(`--max-old-space-size=${heapMb}`);
  return kept.join(' ');
}

/**
 * Append `--max-old-space-size` to an existing `NODE_OPTIONS`, or create it,
 * leaving an existing `--max-old-space-size` alone.
 *
 * @deprecated Since T13122 the heavy-tool overlay plans the heap against the
 *   run's budget instead of letting any inherited value win; use
 *   {@link planHeavyToolEnv} (or {@link withHeapCeiling} to set a ceiling).
 *   Kept for SDK consumers.
 *
 * @param existing - current `NODE_OPTIONS`, if any.
 * @param heapMb - ceiling to apply.
 * @returns the merged value.
 */
export function mergeNodeOptions(existing: string | undefined, heapMb: number): string {
  const current = (existing ?? '').trim();
  if (/--max-old-space-size[= ]/.test(current)) return current;
  const flag = `--max-old-space-size=${heapMb}`;
  return current.length > 0 ? `${current} ${flag}` : flag;
}

/** A strictly positive base-10 integer, or `null` (`'50%'`, `'0'`, `'-1'`, `'4x'` are all `null`). */
function positiveInt(raw: string | undefined): number | null {
  const text = (raw ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number.parseInt(text, 10);
  return n > 0 ? n : null;
}

/** An explicit `CLEO_HEAVY_*` override, or `null`; an unusable value is noted and ignored. */
function readOverride(env: NodeJS.ProcessEnv, name: string, ignored: string[]): number | null {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return null;
  const n = positiveInt(raw);
  if (n === null) ignored.push(`${name}=${JSON.stringify(raw)} (not a positive integer)`);
  return n;
}

/** The heap flags of a `NODE_OPTIONS` value as one readable string, e.g. `--max-old-space-size=8192`. */
function heapFlagsText(nodeOptions: string | undefined): string {
  return [...parseHeapFlags(nodeOptions)]
    .filter(([name]) => OLD_SPACE_FLAGS.has(name))
    .map(([name, value]) => `--${name}=${value}`)
    .join(' ');
}

/** The heap a plan gives each Node process, and why. */
interface HeapChoice {
  readonly heapMb: number;
  readonly source: HeavyToolResourcePlan['heapSource'];
  readonly inherited: number | null;
}

function chooseHeap(
  env: NodeJS.ProcessEnv,
  override: number | null,
  maxHeapMb: number,
  totalRamMb: number,
  defaultHeapMb: number,
): HeapChoice {
  const inherited = inheritedHeapMb(env.NODE_OPTIONS, totalRamMb);
  if (override !== null) return { heapMb: override, source: 'override', inherited };
  // The default heap never shrinks to fit an explicit workspace concurrency: a
  // run asked for that way is reported over budget instead (`overBudget`).
  if (inherited === null) return { heapMb: defaultHeapMb, source: 'default', inherited };
  if (inherited <= maxHeapMb) return { heapMb: inherited, source: 'inherited', inherited };
  return { heapMb: maxHeapMb, source: 'clamped', inherited };
}

/** One worker-count variable: keep an inherited value within the plan, else overlay the plan. */
function planCount(
  name: string,
  raw: string | undefined,
  planned: number,
  forced: boolean,
  overlay: Record<string, string>,
  clamped: HeavyLeverChange[],
  kept: string[],
): void {
  const inherited = positiveInt(raw);
  if (!forced && inherited !== null && inherited <= planned) {
    kept.push(`${name}=${inherited}`);
    return;
  }
  overlay[name] = String(planned);
  if (!forced && raw !== undefined && raw !== '') {
    clamped.push({ name, from: raw, to: String(planned) });
  }
}

/** The worker pool a plan gives a tool, and why. */
interface WorkerChoice {
  readonly workers: number;
  readonly source: HeavyToolResourcePlan['workersSource'];
  readonly reason: string;
}

/** A tool that runs as one process: nothing to size. */
const SINGLE_PROCESS: WorkerChoice = {
  workers: 1,
  source: 'plan',
  reason: 'one process, no worker pool',
};

/** Where a plan records what it overlaid, clamped, kept and ignored. */
interface PlanLedger {
  readonly overlay: Record<string, string>;
  readonly clamped: HeavyLeverChange[];
  readonly kept: string[];
  readonly ignored: string[];
}

/**
 * The worker count of a forking tool — `CLEO_HEAVY_WORKERS`, else as many as
 * fit (`fit`, the budget over packages × heap), never above the default — written
 * to every runner variable and to `MAKEFLAGS`.
 */
function planWorkers(
  env: NodeJS.ProcessEnv,
  fit: number,
  defaultWorkers: number,
  ledger: PlanLedger,
): WorkerChoice {
  const override = readOverride(env, HEAVY_WORKERS_ENV, ledger.ignored);
  const workers =
    override ?? Math.max(MIN_HEAVY_WORKERS, Math.min(defaultWorkers, Math.floor(fit)));
  for (const key of WORKER_COUNT_VARS) {
    planCount(
      key,
      env[key],
      workers,
      override !== null,
      ledger.overlay,
      ledger.clamped,
      ledger.kept,
    );
  }
  // GNU make sizes `-j` off nproc when told `-j` with no argument; an explicit
  // job count here bounds a Makefile-driven test/build target too. An inherited
  // MAKEFLAGS is left alone: inside a `make` recipe it carries the parent's
  // jobserver, which already bounds the jobs this run may take.
  if (!env.MAKEFLAGS) ledger.overlay.MAKEFLAGS = `-j${workers}`;
  if (override !== null) return { workers, source: 'override', reason: HEAVY_WORKERS_ENV };
  return {
    workers,
    source: 'plan',
    reason:
      workers < defaultWorkers
        ? `fewer than the default ${defaultWorkers} so the run fits its budget`
        : 'default for this RAM',
  };
}

function heapReason(choice: HeapChoice): string {
  switch (choice.source) {
    case 'override':
      return HEAVY_HEAP_ENV;
    case 'inherited':
      return 'inherited NODE_OPTIONS';
    case 'clamped':
      return `inherited NODE_OPTIONS asked for ${choice.inherited} MiB, more than the budget allows`;
    default:
      return 'CLEO default';
  }
}

/**
 * Plan a heavy or memory-bound tool spawn: the environment overlay, and the
 * resource plan behind it (T13122, T13123).
 *
 * The heap is chosen first — `CLEO_HEAVY_HEAP_MB`, else the inherited
 * `NODE_OPTIONS` heap when it fits the budget (clamped to it otherwise), else
 * {@link defaultHeavyHeapMb}. The worker count then derives from the heap
 * actually in effect, `⌊budget / (packages × heap)⌋`, never above
 * {@link heavyToolWorkers}, so `packages × workers × heap` stays within
 * {@link heavyRunBudgetMb}. Inherited worker counts and workspace concurrency
 * are kept at or below the plan and clamped above it; `CLEO_HEAVY_WORKERS` and
 * `CLEO_HEAVY_WORKSPACE_CONCURRENCY` override.
 *
 * A single-process memory-bound tool (`typecheck`, `lint`) gets the same heap
 * ceiling and workspace concurrency, and no worker variables: its plan is one
 * process (T13123).
 *
 * @param canonical - the canonical tool about to be spawned.
 * @param env - the environment the child would otherwise inherit.
 * @param totalRamGib - total RAM in GiB; injectable for deterministic tests.
 * @returns the overlay and plan; an empty overlay and `null` plan for a tool
 *          that is not memory-bound (`audit`, `security-scan`).
 *
 * @example
 * ```ts
 * // A shell profile exported an 8 GiB heap on a 64 GiB machine:
 * const { overlay, resources } = planHeavyToolEnv(
 *   'test', { NODE_OPTIONS: '--max-old-space-size=8192' }, 64);
 * overlay.VITEST_MAX_WORKERS; // → '3' (3 × 8192 = the 24576 MiB budget)
 * resources?.heapSource;      // → 'inherited'
 * ```
 *
 * @task T12096
 * @task T13122
 * @task T13123
 */
export function planHeavyToolEnv(
  canonical: CanonicalTool,
  env: NodeJS.ProcessEnv = process.env,
  totalRamGib: number = totalmem() / 1024 ** 3,
): HeavyToolSpawnPlan {
  if (!isMemoryBoundTool(canonical)) return { overlay: {}, resources: null };

  const totalRamMb = Math.floor(totalRamGib * 1024);
  const defaultWorkers = heavyToolWorkers(totalRamGib);
  const defaultHeapMb = defaultHeavyHeapMb(totalRamGib);
  const budgetMb = defaultWorkers * defaultHeapMb;
  const overlay: Record<string, string> = {};
  const clamped: HeavyLeverChange[] = [];
  const kept: string[] = [];
  const ignored: string[] = [];

  // Packages in flight first: the heap ceiling an inherited value may keep is
  // the budget shared between them.
  const packagesOverride = readOverride(env, HEAVY_WORKSPACE_CONCURRENCY_ENV, ignored);
  const packages = packagesOverride ?? WORKSPACE_CONCURRENCY;
  for (const name of WORKSPACE_CONCURRENCY_VARS) {
    planCount(name, env[name], packages, packagesOverride !== null, overlay, clamped, kept);
  }
  // What the child gets: the overlay's value, or the inherited one it kept —
  // the larger of the two spellings, since which one pnpm reads depends on its
  // version.
  const packagesInFlight = Math.max(
    ...WORKSPACE_CONCURRENCY_VARS.map(
      (name) => positiveInt(overlay[name] ?? env[name]) ?? packages,
    ),
  );

  const heap = chooseHeap(
    env,
    readOverride(env, HEAVY_HEAP_ENV, ignored),
    Math.max(1, Math.floor(budgetMb / packagesInFlight)),
    totalRamMb,
    defaultHeapMb,
  );
  overlay.NODE_OPTIONS = withHeapCeiling(env.NODE_OPTIONS, heap.heapMb);
  if (heap.source === 'clamped') {
    clamped.push({
      name: 'NODE_OPTIONS',
      from: heapFlagsText(env.NODE_OPTIONS),
      to: `--max-old-space-size=${heap.heapMb}`,
    });
  }

  // A single-process tool (typecheck, lint) has no worker pool to size.
  const pool = isHeavyTool(canonical)
    ? planWorkers(env, budgetMb / (packagesInFlight * heap.heapMb), defaultWorkers, {
        overlay,
        clamped,
        kept,
        ignored,
      })
    : SINGLE_PROCESS;
  const { workers } = pool;

  const product = packagesInFlight * workers * heap.heapMb;
  const overBudget = product > budgetMb;
  const parts = [
    `heap ${heap.heapMb} MiB (${heapReason(heap)}) × ${workers} worker(s) (${pool.reason}) × ` +
      `${packagesInFlight} workspace package(s) at once = ${product} MiB of a ${budgetMb} MiB budget ` +
      `(${Math.round(totalRamMb / 1024)} GiB RAM)`,
  ];
  if (clamped.length > 0) {
    parts.push(
      `clamped ${clamped.map((c) => `${c.name} ${c.from} → ${c.to}`).join(', ')}; ` +
        `set ${HEAVY_HEAP_ENV}, ${HEAVY_WORKERS_ENV} or ${HEAVY_WORKSPACE_CONCURRENCY_ENV} to ask for more`,
    );
  }
  if (overBudget) parts.push('OVER budget by an explicit CLEO_HEAVY_* override');
  if (ignored.length > 0) parts.push(`ignored ${ignored.join(', ')}`);

  return {
    overlay,
    resources: {
      heapMb: heap.heapMb,
      heapSource: heap.source,
      inheritedHeapMb: heap.inherited,
      workers,
      workersSource: pool.source,
      workspaceConcurrency: packagesInFlight,
      budgetMb,
      totalRamMb,
      clamped,
      kept,
      overBudget,
      summary: parts.join('; '),
    },
  };
}

/** Launchers that are npm itself: they warn about every unknown `npm_config_*` and read none of the pnpm ones. */
const NPM_LAUNCHERS = new Set(['npm', 'npx']);

/**
 * The overlay a given launcher should actually receive (T13122).
 *
 * npm prints `npm warn Unknown env config "workspace-concurrency"` on every run
 * when `npm_config_workspace_concurrency` is set, and that line lands in the
 * output tail CLEO quotes when a tool fails, pushing the real error out of it.
 * npm never reads the variable (it runs workspace scripts one at a time), so
 * for an `npm`/`npx` launcher it is dropped. Every other launcher gets the
 * overlay unchanged.
 *
 * @param overlay - the planned overlay.
 * @param cmd - the executable about to be spawned (a path or a bare name).
 * @returns the overlay for that launcher.
 *
 * @example
 * ```ts
 * overlayForLauncher({ npm_config_workspace_concurrency: '1' }, 'npx'); // → {}
 * overlayForLauncher({ npm_config_workspace_concurrency: '1' }, 'pnpm'); // unchanged
 * ```
 *
 * @task T13122
 */
export function overlayForLauncher(overlay: HeavyToolEnv, cmd: string): HeavyToolEnv {
  const launcher = (cmd.split('/').pop() ?? cmd).replace(/\.(cmd|exe)$/i, '');
  if (!NPM_LAUNCHERS.has(launcher) || overlay.npm_config_workspace_concurrency === undefined) {
    return overlay;
  }
  return Object.fromEntries(
    Object.entries(overlay).filter(([name]) => name !== 'npm_config_workspace_concurrency'),
  );
}

/**
 * Build the environment overlay for a heavy or memory-bound tool spawn: the
 * `overlay` of {@link planHeavyToolEnv}.
 *
 * Returns an empty object for a tool that is not memory-bound, so the caller
 * can merge unconditionally.
 *
 * @param canonical - the canonical tool about to be spawned.
 * @param env - the environment the child would otherwise inherit.
 * @param totalRamGib - total RAM in GiB; injectable for deterministic tests.
 * @returns variables to overlay; inherited values within the plan are kept.
 *
 * @example
 * ```ts
 * const overlay = heavyToolEnv('test', {}, 62);
 * // { NODE_OPTIONS: '--max-old-space-size=4096',
 * //   VITEST_MAX_WORKERS: '6',
 * //   npm_config_workspace_concurrency: '1', … }
 * heavyToolEnv('typecheck', {}, 62);
 * // { NODE_OPTIONS: '--max-old-space-size=4096',
 * //   npm_config_workspace_concurrency: '1', pnpm_config_workspace_concurrency: '1' }
 * heavyToolEnv('audit', process.env, 62); // → {}
 * ```
 *
 * @task T12096
 * @task T13122
 * @task T13123
 */
export function heavyToolEnv(
  canonical: CanonicalTool,
  env: NodeJS.ProcessEnv = process.env,
  totalRamGib: number = totalmem() / 1024 ** 3,
): HeavyToolEnv {
  return planHeavyToolEnv(canonical, env, totalRamGib).overlay;
}
