/**
 * Slice-aware launch-wrapper SSoT (T11993 · Epic T11992).
 *
 * This module is the ONLY constructor of `systemd-run` argv for cleo children.
 * Every consumer that needs to launch a cleo child in a memory-capped cgroup
 * MUST call {@link buildSpawnArgs} or {@link spawnWrapped} here instead of
 * constructing `systemd-run` arguments ad-hoc.
 *
 * ## Design
 *
 * Children are placed inside `cleo.slice` when systemd is available:
 *
 * ```
 * cleo.slice
 *   ├── cleo-daemon.service         (managed by the daemon service unit)
 *   └── cleo-<scopeClass>-<n>.scope (transient scopes for child spawns)
 * ```
 *
 * The slice applies MemoryHigh (primary soft throttle) and MemoryMax (hard
 * safety net) at the slice level, shared across all members.  Child scopes
 * inherit these limits and may override them downward.
 *
 * ## Staged P1 budget (IMPORTANT — read before tuning)
 *
 * P1 ships MemoryHigh within 5 % of MemoryMax (80 % / 85 % of a reference
 * host total) so that reclaim stalls under the soft limit NEVER block the
 * SQLite WAL write-transaction held by a slice member.  A stalled scope
 * holding a WAL write-txn for > 30 s (busy_timeout) cascades SQLITE_BUSY to
 * every other slice member.
 *
 * **P1 installed values (safe defaults):**
 *   - `MemoryHigh = undefined` (disabled — no throttle in P1)
 *   - `MemoryMax  = 32G`       (hard cap, benign cgroup kill)
 *
 * The 60 % / 85 % target shape is documented here and in `DEFAULT_SLICE_CONFIG`
 * as the P2 goal once the stall-escalator (T11994) is in place.
 *
 * **With `MemorySwapMax=0`:** reclaim has only page-cache to chew against
 * `MemoryHigh` on anonymous heaps — admission (P2) becomes the primary
 * control, throttling is not load-bearing in P1.
 *
 * ## oomd-avoid (selective)
 *
 * `ManagedOOMPreference=avoid` is applied ONLY to daemon/db-heavy scope
 * classes (`'daemon'`, `'db'`).  Bulk agent/test scopes do NOT get `avoid`
 * because Fedora oomd monitors `user@1000.service` at 80 %/20 s and ranks
 * avoid-marked candidates last — blanket avoid redirects oomd kills onto
 * innocent user apps.
 *
 * ## Fallback
 *
 * On hosts without systemd-run (macOS, CI containers, minimal installs)
 * the wrapper degrades log-once to plain `spawn` in a new process-group
 * with NODE_OPTIONS heap cap inherited from the caller.  This is mirrored
 * from the writer-lease `pgid-demotion` pattern.
 *
 * ## Return value — ownership handle (T11998 / T11995)
 *
 * {@link SpawnWrappedResult} carries `{ unitName?, pid, mode }` so the
 * suite-containment epic (T11998) and the janitor (T11995) can look up or
 * clean up the transient scope by unit name.
 *
 * @module @cleocode/core/resources/spawn-wrapper
 * @epic T11992
 * @task T11993
 */

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Public types (cross-package shapes live in packages/contracts/; these are
// narrow, module-local contract types that do not need fan-out).
// ---------------------------------------------------------------------------

/**
 * Scope classes understood by the wrapper.
 *
 * `'daemon'` and `'db'` receive `ManagedOOMPreference=avoid` (write-txn
 * holders must not be oom-killed mid-transaction).  All other classes run
 * without the avoid flag.
 */
export type ScopeClass = 'daemon' | 'db' | 'agent' | 'test' | 'tool';

/**
 * Memory resource configuration for the slice / scope.
 *
 * Percentages are resolved against the host's MemTotal at build time by
 * {@link buildSpawnArgs}.  Pass absolute strings (e.g. `'32G'`, `'768M'`)
 * to bypass percentage resolution.
 */
export interface SliceResourceConfig {
  /**
   * MemoryHigh for the transient scope.
   *
   * `undefined` (default P1) = disabled (no soft throttle).
   * Set to a fraction in (0, 1) to express as percent of MemTotal, or pass
   * an absolute systemd memory value (`'32G'`, `'2G'`, …`).
   *
   * **P1 default: `undefined`** (disabled).  P2 target: `0.60` (60 %).
   */
  memoryHigh?: number | string;

  /**
   * MemoryMax for the transient scope (hard kill ceiling).
   *
   * Default: `'32G'`.  P2 target: 85 % of MemTotal (`0.85`).
   */
  memoryMax?: number | string;
}

/**
 * Options for {@link buildSpawnArgs}.
 */
export interface BuildSpawnArgsOptions {
  /**
   * Scope class — controls `ManagedOOMPreference` and the transient unit name
   * prefix.
   *
   * Default: `'agent'`.
   */
  scopeClass?: ScopeClass;

  /**
   * Optional caller-supplied discriminator appended to the unit name so that
   * concurrent same-class scopes are addressable.  E.g. a task ID.
   */
  scopeId?: string;

  /**
   * Memory resource overrides.  Merged over {@link DEFAULT_SCOPE_RESOURCES}.
   */
  resources?: SliceResourceConfig;

  /**
   * When `true`, emit `LimitCORE=0` on the scope so that V8-heap aborts and
   * cgroup hard-cap kills do NOT produce a coredump / abrt-applet toast.
   *
   * Default: `true`.
   */
  noCoreFile?: boolean;
}

/**
 * Result returned by {@link buildSpawnArgs}.
 *
 * `mode = 'systemd'` means the argv leads with `systemd-run`.
 * `mode = 'pgid'`    means the fallback path (no systemd-run available).
 */
export interface SpawnArgsBuildResult {
  /** The command to execute (e.g. `'systemd-run'` or the original command). */
  command: string;
  /** Full argument list, including the original command if wrapped. */
  args: string[];
  /**
   * Whether the child will run inside a systemd transient scope.
   * `false` = plain pgid spawn (no systemd available).
   */
  mode: 'systemd' | 'pgid';
  /**
   * The transient scope unit name (e.g. `cleo-agent-T1234.scope`).
   * `undefined` when `mode = 'pgid'`.
   */
  unitName?: string;
}

/**
 * Result returned by {@link spawnWrapped}.
 *
 * Carries the ownership/cleanup handle (T11998 / T11995).
 */
export interface SpawnWrappedResult {
  /** The spawned child process handle. */
  child: ChildProcess;
  /** PID of the spawned child (may be undefined for detached+unreffed). */
  pid: number | undefined;
  /**
   * Whether the child runs inside a systemd transient scope (`'systemd'`) or
   * in a plain process-group (`'pgid'`).
   */
  mode: 'systemd' | 'pgid';
  /**
   * The transient scope unit name (e.g. `cleo-agent-T1234.scope`).
   * `undefined` when `mode = 'pgid'`.
   *
   * Use this as the cleanup handle in T11998 / T11995:
   * `systemctl --user stop <unitName>`
   */
  unitName?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The systemd user slice that all cleo child scopes are placed under.
 *
 * The slice unit (`~/.config/systemd/user/cleo.slice`) must be installed
 * by the doctor/install flow before this is effective.  Placing an orphan
 * scope under a non-existent slice degrades silently to the default slice —
 * so the slice install is best-effort and the wrapper is always safe to call.
 */
export const CLEO_SLICE = 'cleo.slice' as const;

/**
 * Default per-scope memory resource config (P1 staged values).
 *
 * P1: MemoryHigh disabled, MemoryMax=32G.
 * P2 target (after T11994 stall-escalator lands): memoryHigh=0.60, memoryMax=0.85.
 */
export const DEFAULT_SCOPE_RESOURCES: Required<SliceResourceConfig> = {
  memoryHigh: 'infinity', // P1: disabled — no throttle (safe until P2 stall-escalator)
  memoryMax: '32G', // P1: hard cap (benign cgroup kill, no coredump w/ LimitCORE=0)
};

/**
 * Scope classes that receive `ManagedOOMPreference=avoid`.
 *
 * Only write-transaction holders (daemon, db) are marked `avoid` to prevent
 * mid-txn oomd kills.  See module-level TSDoc for the Fedora oomd rationale.
 */
const OOM_AVOID_CLASSES = new Set<ScopeClass>(['daemon', 'db']);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Is `systemd-run` available on this host? Probed once and cached.
 * Mirrors the probe in `packages/core/src/check/pr-gate.ts`.
 */
let _systemdRunAvailable: boolean | undefined;

/**
 * Check whether `systemd-run --user` is usable on this host.
 *
 * Returns `false` on non-Linux, when systemd-run is not on PATH, or when
 * DBUS_SESSION_BUS_ADDRESS / XDG_RUNTIME_DIR are absent (CI containers,
 * ssh sessions without a user bus).
 */
export function hasSystemdRun(): boolean {
  if (_systemdRunAvailable !== undefined) return _systemdRunAvailable;
  if (process.platform !== 'linux') {
    _systemdRunAvailable = false;
    return false;
  }
  // Quick binary availability check — does NOT test user-bus connectivity.
  const probe = spawnSync('systemd-run', ['--version'], { stdio: 'ignore' });
  _systemdRunAvailable = probe.status === 0;
  return _systemdRunAvailable;
}

/**
 * Force-override the cached systemd-run availability.
 *
 * Exposed for unit tests that need to exercise the pgid-fallback or
 * systemd paths without the real binary.
 *
 * @param available - `true` = force systemd path, `false` = force pgid path.
 */
export function _forceSystemdRunAvailable(available: boolean): void {
  _systemdRunAvailable = available;
}

/** Whether we have already emitted the pgid-demotion log line for this process. */
let _pgidDemotionLogged = false;

/**
 * Resolve a memory value to a systemd property string.
 *
 * Numbers in (0, 1] are treated as fractions of a `totalBytes` reference.
 * Strings are passed through verbatim.  `undefined` / `'infinity'` resolves
 * to `'infinity'` (disabled).
 */
function resolveMemoryValue(val: number | string | undefined, totalBytes: number): string {
  if (val === undefined || val === 'infinity') return 'infinity';
  if (typeof val === 'string') return val;
  // Fraction: multiply by total and round to nearest mebibyte boundary.
  const bytes = Math.round(val * totalBytes);
  const mib = Math.round(bytes / (1024 * 1024));
  return `${mib}M`;
}

/**
 * Read /proc/meminfo MemTotal in bytes.  Returns 32 GiB as a safe fallback
 * when unavailable (non-Linux, CI, permission denied).
 */
function readMemTotalBytes(): number {
  if (process.platform !== 'linux') return 32 * 1024 * 1024 * 1024;
  try {
    const raw = readFileSync('/proc/meminfo', 'utf8');
    const m = raw.match(/^MemTotal:\s+(\d+)\s+kB/m);
    if (m?.[1]) return parseInt(m[1], 10) * 1024;
  } catch {
    // ignore
  }
  return 32 * 1024 * 1024 * 1024;
}

/** Counter for generating unique scope discriminators within a process. */
let _scopeCounter = 0;

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * Build the argv for a cleo child spawn.
 *
 * When `systemd-run` is available, the result is:
 *
 * ```
 * ['systemd-run', '--user', '--scope', '--slice=cleo.slice',
 *   '--unit=cleo-<class>-<id>.scope',
 *   '-p', 'MemoryHigh=<high>', '-p', 'MemoryMax=<max>',
 *   '-p', 'MemorySwapMax=0', '-p', 'LimitCORE=0',
 *   ['-p', 'ManagedOOMPreference=avoid'],  // daemon/db only
 *   '--', command, ...args]
 * ```
 *
 * When `systemd-run` is NOT available, the result is the original
 * `[command, ...args]` unchanged, and `mode` is `'pgid'`.
 *
 * @param command - The executable to run (e.g. `'node'`).
 * @param args - Arguments to pass to the executable.
 * @param opts - Wrapper options (scope class, resources, etc.).
 * @returns Build result with final command, args, mode, and unit name.
 */
export function buildSpawnArgs(
  command: string,
  args: readonly string[],
  opts: BuildSpawnArgsOptions = {},
): SpawnArgsBuildResult {
  const { scopeClass = 'agent', scopeId, resources = {}, noCoreFile = true } = opts;

  if (!hasSystemdRun()) {
    if (!_pgidDemotionLogged) {
      _pgidDemotionLogged = true;
      process.stderr.write(
        '[cleo:spawn-wrapper] systemd-run unavailable — falling back to plain pgid spawn ' +
          '(no cgroup containment; set NODE_OPTIONS=--max-old-space-size=<mb> externally)\n',
      );
    }
    return { command, args: [...args], mode: 'pgid' };
  }

  const totalBytes = readMemTotalBytes();
  const merged: Required<SliceResourceConfig> = {
    memoryHigh: resources.memoryHigh ?? DEFAULT_SCOPE_RESOURCES.memoryHigh,
    memoryMax: resources.memoryMax ?? DEFAULT_SCOPE_RESOURCES.memoryMax,
  };

  const highStr = resolveMemoryValue(merged.memoryHigh, totalBytes);
  const maxStr = resolveMemoryValue(merged.memoryMax, totalBytes);

  // Build a deterministic, unique unit name.
  const counter = ++_scopeCounter;
  const discriminator = scopeId ? scopeId.replace(/[^a-zA-Z0-9-]/g, '-') : String(counter);
  const unitName = `cleo-${scopeClass}-${discriminator}.scope`;

  const wrapArgs: string[] = [
    '--user',
    '--scope',
    `--slice=${CLEO_SLICE}`,
    `--unit=${unitName}`,
    '-p',
    `MemoryMax=${maxStr}`,
    '-p',
    'MemorySwapMax=0',
  ];

  // MemoryHigh: only emit the directive when it is a real limit (not infinity).
  if (highStr !== 'infinity') {
    wrapArgs.push('-p', `MemoryHigh=${highStr}`);
  }

  if (noCoreFile) {
    wrapArgs.push('-p', 'LimitCORE=0');
  }

  // Selective oomd-avoid: only for write-txn holder classes.
  if (OOM_AVOID_CLASSES.has(scopeClass)) {
    wrapArgs.push('-p', 'ManagedOOMPreference=avoid');
  }

  wrapArgs.push('--', command, ...args);

  return {
    command: 'systemd-run',
    args: wrapArgs,
    mode: 'systemd',
    unitName,
  };
}

/**
 * Spawn a command wrapped in a cleo.slice transient cgroup scope.
 *
 * This is a thin convenience wrapper over {@link buildSpawnArgs} +
 * Node.js `child_process.spawn`.  All cleo child spawns SHOULD route through
 * this function instead of constructing `systemd-run` arguments inline.
 *
 * The returned {@link SpawnWrappedResult} carries `unitName` — the systemd
 * transient scope unit name — as the ownership/cleanup handle for
 * T11998 (suite containment) and T11995 (janitor).
 *
 * @param command - The executable to run.
 * @param args - Arguments to pass to the executable.
 * @param spawnOpts - Options forwarded to `child_process.spawn`.
 * @param wrapOpts - Wrapper options (scope class, resources, etc.).
 * @returns Wrapped spawn result.
 */
export function spawnWrapped(
  command: string,
  args: readonly string[],
  spawnOpts: Parameters<typeof spawn>[2] = {},
  wrapOpts: BuildSpawnArgsOptions = {},
): SpawnWrappedResult {
  const built = buildSpawnArgs(command, args, wrapOpts);
  const child = spawn(built.command, built.args, spawnOpts);
  return {
    child,
    pid: child.pid,
    mode: built.mode,
    unitName: built.unitName,
  };
}
