/**
 * Kernel-enforced memory ceiling for heavy tools CLEO spawns (T12116).
 *
 * ## Why the environment variables were never enough
 *
 * {@link ./heavy-tool-env.ts | heavyToolEnv} bounds a heavy tool by exporting
 * `NODE_OPTIONS`, `VITEST_MAX_WORKERS` and `npm_config_workspace_concurrency`.
 * Every one of those is **advisory and runner-specific**:
 *
 *   - `VITEST_MAX_WORKERS` binds vitest. It does nothing for jest, mocha,
 *     `cargo test`, `pytest`, `go test`, or a hand-rolled `make test` — and
 *     CLEO is a general task runner whose consumers are not all Node projects.
 *   - `--max-old-space-size` caps the V8 **old space**, not RSS. Buffers, typed
 *     arrays, native allocations and every non-Node child are outside it.
 *   - A tool is free to ignore all of them.
 *
 * So the ceiling only ever bound the case we happened to think of. The failure
 * this is written against was not an OOM kill at all: `app.slice` reached its
 * `MemoryHigh`, the kernel throttled and thrashed swap, and the desktop locked
 * up **without logging anything** — which is why repeated OOM hunts found
 * nothing. A throttle-and-thrash freeze is silent.
 *
 * ## What this does instead
 *
 * Spawn the tool inside its own transient systemd scope with a hard
 * `MemoryMax` and, critically, `MemorySwapMax=0`. Two properties follow, and
 * neither depends on the tool's language or cooperation:
 *
 *   1. **The bound is the kernel's**, applied to the whole process tree. A
 *      `pnpm -r` fan-out into fifteen packages is still one cgroup.
 *   2. **Breaching it kills the tool, not the host.** With swap denied, the
 *      cgroup cannot thrash its way into freezing the desktop; it OOMs inside
 *      its own boundary and CLEO reports a failed run. A failed test run is a
 *      result. A frozen workstation is not.
 *
 * Verified on Fedora 44 / systemd 258 before this module was written: a scope
 * created with `MemoryMax=512M` reports `memory.max=536870912` and
 * `memory.swap.max=0` from inside, and a Node process touching 2 GiB is killed
 * at ~450 MiB RSS rather than allocating.
 *
 * Where systemd is unavailable (macOS, Windows, a container without a user
 * manager) this degrades to a no-op and the env-var overlay remains the only
 * bound — the same protection as before, never less.
 *
 * @module
 * @task T12116
 */

import { spawnSync } from 'node:child_process';
import { totalmem } from 'node:os';
import type { CanonicalTool } from './tool-resolver.js';

/** Fraction of host RAM one heavy tool invocation may occupy. */
export const HEAVY_TOOL_RAM_FRACTION = 0.25;

/** Never grant a single invocation more than this, however large the host. */
export const HEAVY_TOOL_MEMORY_CEILING_MB = 8_192;

/** Never grant less than this — a real test suite must be able to run. */
export const HEAVY_TOOL_MEMORY_FLOOR_MB = 2_048;

/** Env var an operator can set to override the derived ceiling. */
export const MEMORY_MAX_ENV = 'CLEO_TOOL_MEMORY_MAX_MB';

/** Env var to disable cgroup confinement entirely. */
export const DISABLE_ENV = 'CLEO_NO_TOOL_CGROUP';

/** A command ready to spawn, plus whether a kernel bound was applied. */
export interface LimitedCommand {
  /** Executable to spawn. */
  readonly cmd: string;
  /** Arguments for {@link cmd}. */
  readonly args: readonly string[];
  /** `true` when the command runs inside a memory-bounded cgroup. */
  readonly confined: boolean;
  /** Ceiling applied, in MiB; `null` when unconfined. */
  readonly memoryMaxMb: number | null;
}

/**
 * Memory ceiling for one heavy-tool invocation, in MiB.
 *
 * Derived from host RAM so a 16 GiB laptop is not handed a 45 GiB allowance,
 * then clamped. The result is per-invocation; total exposure is this times the
 * tool semaphore's concurrency, which is itself RAM-derived (T12091).
 *
 * @param totalRamGib - host RAM in GiB; injectable for deterministic tests.
 * @param env - environment to read the operator override from.
 * @returns the ceiling in MiB.
 *
 * @example
 * ```ts
 * resolveMemoryMaxMb(62);  // → 8192 (clamped from 15872)
 * resolveMemoryMaxMb(8);   // → 2048 (floor)
 * ```
 */
export function resolveMemoryMaxMb(
  totalRamGib: number = totalmem() / 1024 ** 3,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const override = Number.parseInt(env[MEMORY_MAX_ENV] ?? '', 10);
  if (Number.isFinite(override) && override > 0) return override;

  const derived = Math.floor(totalRamGib * 1024 * HEAVY_TOOL_RAM_FRACTION);
  return Math.min(HEAVY_TOOL_MEMORY_CEILING_MB, Math.max(HEAVY_TOOL_MEMORY_FLOOR_MB, derived));
}

/** Cached result of {@link cgroupConfinementAvailable}. */
let _available: boolean | null = null;

/**
 * Whether transient memory-bounded scopes can be created on this host.
 *
 * Probes once per process, because the answer cannot change mid-run and the
 * probe costs a subprocess. Requires both `systemd-run` and a **running user
 * manager** — the binary alone is not enough inside a container.
 *
 * @param env - environment to read {@link DISABLE_ENV} from.
 * @returns `true` when {@link withMemoryLimit} can confine a spawn.
 */
export function cgroupConfinementAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env[DISABLE_ENV] === '1') return false;
  if (process.platform !== 'linux') return false;
  if (_available !== null) return _available;

  // `spawnSync`, not `execFileSync`: `systemctl is-system-running` prints the
  // state on stdout but exits NON-ZERO for every state except `running` — a
  // `degraded` manager (one failed unit anywhere in the session, which is
  // extremely common) exits 1. `execFileSync` throws on a non-zero exit, so it
  // would discard the very string we need to read and silently disable
  // confinement on most real desktops. Measured on this host: `degraded`,
  // exit 1, with transient scopes working perfectly.
  const probe = spawnSync('systemd-run', ['--user', '--version'], {
    stdio: 'ignore',
    timeout: 5_000,
  });
  if (probe.error || probe.status !== 0) {
    _available = false;
    return _available;
  }

  const state = spawnSync('systemctl', ['--user', 'is-system-running'], {
    encoding: 'utf-8',
    timeout: 5_000,
  });
  const reported = (state.stdout ?? '').trim();

  // A manager that answers at all can host a transient scope. `running` and
  // `degraded` both do; `offline`/`unknown` (or no answer) do not.
  _available = reported === 'running' || reported === 'degraded';

  return _available;
}

/** Reset the cached probe. Test-only. @internal */
export function _resetConfinementCache(): void {
  _available = null;
}

/**
 * Wrap a heavy tool command so the kernel bounds its whole process tree.
 *
 * Applied only to `test` and `build` — the canonicals that fork. Confining
 * `lint` or `typecheck` would add a subprocess to bound a single cheap process.
 *
 * `--scope` (not `--unit`) keeps the tool a child of this process, so CLEO's
 * existing stdio piping, timeout and exit-code handling are unchanged;
 * `--collect` reaps the transient unit so repeated verifies do not accumulate
 * scope units.
 *
 * @param canonical - the tool about to run.
 * @param cmd - executable.
 * @param args - arguments.
 * @param opts - overrides for deterministic tests.
 * @returns the command to spawn, confined where possible.
 *
 * @example
 * ```ts
 * const c = withMemoryLimit('test', 'pnpm', ['run', 'test']);
 * // c.cmd === 'systemd-run'
 * // c.args === ['--user','--scope','--quiet','--collect',
 * //             '-p','MemoryMax=8192M','-p','MemorySwapMax=0',
 * //             '--','pnpm','run','test']
 * ```
 *
 * @task T12116
 */
export function withMemoryLimit(
  canonical: CanonicalTool,
  cmd: string,
  args: readonly string[],
  opts: {
    totalRamGib?: number;
    env?: NodeJS.ProcessEnv;
    available?: boolean;
  } = {},
): LimitedCommand {
  const env = opts.env ?? process.env;

  if (canonical !== 'test' && canonical !== 'build') {
    return { cmd, args, confined: false, memoryMaxMb: null };
  }

  const available = opts.available ?? cgroupConfinementAvailable(env);
  if (!available) {
    return { cmd, args, confined: false, memoryMaxMb: null };
  }

  const memoryMaxMb = resolveMemoryMaxMb(opts.totalRamGib ?? totalmem() / 1024 ** 3, env);

  return {
    cmd: 'systemd-run',
    args: [
      '--user',
      '--scope',
      '--quiet',
      '--collect',
      '-p',
      `MemoryMax=${memoryMaxMb}M`,
      // Denying swap is the point. The failure this guards against was a
      // throttle-and-thrash freeze, not an OOM kill: with swap available the
      // cgroup degrades the whole host instead of failing itself.
      '-p',
      'MemorySwapMax=0',
      '--',
      cmd,
      ...args,
    ],
    confined: true,
    memoryMaxMb,
  };
}
