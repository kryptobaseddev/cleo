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
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { ParserExecutionPort } from '@cleocode/contracts';
import type {
  ProcessCaptureOptions,
  ProcessCaptureResourceObservation,
  ProcessCaptureResult,
  ProcessCaptureStop,
  ProcessLaunchExecution,
  SystemdControlContext,
} from '@cleocode/contracts/resource-governor';
import { z } from 'zod';
import { registerTeardownAbort } from '../teardown-signal.js';

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

  /** Optional hard kernel task limit (processes and threads); omitted preserves manager defaults. */
  tasksMax?: number;
}

/**
 * Options for {@link buildSpawnArgs}.
 */
export interface BuildSpawnArgsOptions {
  /** Original caller deadline/cancellation, shared through probes and launch.
   * @defaultValue No additional execution deadline; legacy probe ceilings still apply.
   */
  execution?: ProcessLaunchExecution;
  /**
   * Explicit local manager connection, separate from the child's isolated environment.
   * Only the launcher receives these path/address overrides; original child values
   * are restored before executing the requested command. No global environment changes.
   * @defaultValue Ambient manager discovery.
   */
  systemdControl?: SystemdControlContext;
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
   * When `true` (default), suppress coredumps by wrapping the inner command
   * as `sh -c 'ulimit -c 0; exec "$@"' sh <cmd> <args...>`.
   *
   * This achieves process-level core suppression without relying on
   * `LimitCORE=0`, which is a service-unit EXEC property and is rejected by
   * `systemd-run --scope` ("Unknown assignment: LimitCORE").  The `ulimit -c 0`
   * approach works identically in the systemd path and the pgid-fallback path,
   * preventing V8-heap-abort and cgroup-kill coredumps from producing
   * abrt-applet toasts on Fedora and Ubuntu.
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
export const DEFAULT_SCOPE_RESOURCES: Required<Omit<SliceResourceConfig, 'tasksMax'>> = {
  memoryHigh: 'infinity', // P1: disabled — no throttle (safe until P2 stall-escalator)
  memoryMax: '32G', // P1: hard cap (benign cgroup kill; coredumps suppressed via ulimit -c 0)
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
 * Is `systemd-run` available for this manager context? Probed and cached per connection.
 * Mirrors the probe in `packages/core/src/check/pr-gate.ts`.
 */
let _forcedSystemdRunAvailable: boolean | undefined;
const systemdProbeCache = new Map<string, boolean>();

/** Construct a manager environment without mutating the caller or global state. */
function managerEnvironment(
  context: SystemdControlContext | undefined,
  original: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (!context) return original;
  if (!isAbsolute(context.runtimeDirectory))
    throw new TypeError('Systemd manager runtime directory must be absolute');
  const address = context.busAddress ?? `unix:path=${join(context.runtimeDirectory, 'bus')}`;
  if (!address.startsWith('unix:'))
    throw new TypeError('Systemd manager bus must use a local Unix address');
  return {
    ...original,
    XDG_RUNTIME_DIR: context.runtimeDirectory,
    DBUS_SESSION_BUS_ADDRESS: address,
  };
}

/** Check the original launch boundary without claiming preemption of synchronous calls. */
function launchRemaining(execution?: ProcessLaunchExecution): number {
  execution?.signal?.throwIfAborted();
  if (!execution) return 1000;
  if (!Number.isSafeInteger(execution.deadlineAt))
    throw new RangeError('Process deadline must be an absolute integer timestamp');
  const remaining = execution.deadlineAt - Date.now();
  if (remaining <= 0)
    throw new Error('E_PROCESS_DEADLINE: original process launch deadline expired');
  return remaining;
}

/**
 * Check whether the selected local user manager can launch transient scopes.
 * @param context - Explicit manager context; omitted callers retain ambient discovery.
 * @param execution - Original deadline/cancellation; each synchronous probe uses its remaining budget.
 * @returns Whether systemd binaries and the selected user bus answered the bounded probes.
 * @remarks Availability does not prove that a later scope or resource bound was established.
 * Probe results are keyed by platform, executable search path and manager connection,
 * so an unavailable ambient context cannot poison a later explicit context.
 * @example
 * ```typescript
 * const available = hasSystemdRun({ runtimeDirectory: '/run/user/1000' });
 * ```
 */
export function hasSystemdRun(
  context?: SystemdControlContext,
  execution?: ProcessLaunchExecution,
): boolean {
  launchRemaining(execution);
  const env = managerEnvironment(context, process.env);
  if (_forcedSystemdRunAvailable !== undefined) return _forcedSystemdRunAvailable;
  const key = JSON.stringify([
    process.platform,
    env['PATH'],
    env['DBUS_SESSION_BUS_ADDRESS'],
    env['XDG_RUNTIME_DIR'],
  ]);
  const cached = systemdProbeCache.get(key);
  if (cached !== undefined) return cached;
  let available = false;
  if (process.platform === 'linux' && (env['DBUS_SESSION_BUS_ADDRESS'] || env['XDG_RUNTIME_DIR'])) {
    const probe = spawnSync('systemd-run', ['--version'], {
      env,
      stdio: 'ignore',
      timeout: Math.min(1000, launchRemaining(execution)),
    });
    launchRemaining(execution);
    const bus =
      probe.status === 0
        ? spawnSync('systemctl', ['--user', 'show-environment'], {
            env,
            stdio: 'ignore',
            timeout: Math.min(1000, launchRemaining(execution)),
          })
        : null;
    launchRemaining(execution);
    available = probe.status === 0 && bus?.status === 0;
  }
  // Bound contexts retained by long-lived callers with many synthetic workspaces.
  if (systemdProbeCache.size >= 64) systemdProbeCache.clear();
  systemdProbeCache.set(key, available);
  return available;
}

/**
 * Override availability for deterministic tests, or clear the override and cached probes.
 * @param available - Forced availability; undefined restores real context-specific probing.
 * @remarks Test overrides do not establish actual manager availability or containment.
 * @example
 * ```typescript
 * _forceSystemdRunAvailable(undefined);
 * ```
 */
export function _forceSystemdRunAvailable(available: boolean | undefined): void {
  _forcedSystemdRunAvailable = available;
  systemdProbeCache.clear();
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
 *   '-p', 'MemorySwapMax=0',
 *   ['-p', 'ManagedOOMPreference=avoid'],  // daemon/db only
 *   '--',
 *   // when noCoreFile=true (default):
 *   'sh', '-c', 'ulimit -c 0; exec "$@"', 'sh', command, ...args
 *   // when noCoreFile=false:
 *   command, ...args]
 * ```
 *
 * `LimitCORE` is intentionally NOT used — it is a service-unit EXEC property
 * and is rejected by `systemd-run --scope` with "Unknown assignment: LimitCORE".
 * Core-dump suppression is applied at the process level instead via
 * `ulimit -c 0` (POSIX sh, works in both systemd and pgid-fallback paths).
 *
 * When `systemd-run` is NOT available, the result is `[command, ...args]`
 * (or the sh/ulimit-wrapped form when noCoreFile=true) and `mode` is `'pgid'`.
 *
 * @param command - The executable to run (e.g. `'node'`).
 * @param args - Arguments to pass to the executable.
 * @param opts - Wrapper options (scope class, resources, etc.).
 * @returns Build result with final command, args, mode, and unit name.
 * @remarks This only constructs launch arguments; it does not establish or inspect a scope.
 * @example
 * ```typescript
 * const launch = buildSpawnArgs('node', ['--version']);
 * ```
 */
export function buildSpawnArgs(
  command: string,
  args: readonly string[],
  opts: BuildSpawnArgsOptions = {},
): SpawnArgsBuildResult {
  const { scopeClass = 'agent', scopeId, resources = {}, noCoreFile = true } = opts;

  if (!hasSystemdRun(opts.systemdControl, opts.execution)) {
    if (!_pgidDemotionLogged) {
      _pgidDemotionLogged = true;
      process.stderr.write(
        '[cleo:spawn-wrapper] systemd-run unavailable — falling back to plain pgid spawn ' +
          '(no cgroup containment; set NODE_OPTIONS=--max-old-space-size=<mb> externally)\n',
      );
    }
    if (noCoreFile) {
      // Apply ulimit -c 0 in the pgid path as well so core suppression is
      // consistent regardless of whether systemd is available.
      return {
        command: 'sh',
        args: ['-c', 'ulimit -c 0; exec "$@"', 'sh', command, ...args],
        mode: 'pgid',
      };
    }
    return { command, args: [...args], mode: 'pgid' };
  }

  const totalBytes = readMemTotalBytes();
  const merged: Required<Omit<SliceResourceConfig, 'tasksMax'>> = {
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

  if (resources.tasksMax !== undefined) {
    if (!Number.isSafeInteger(resources.tasksMax) || resources.tasksMax < 1)
      throw new RangeError('Scope task limit must be a positive safe integer');
    wrapArgs.push('-p', `TasksMax=${resources.tasksMax}`);
  }

  // MemoryHigh: only emit the directive when it is a real limit (not infinity).
  if (highStr !== 'infinity') {
    wrapArgs.push('-p', `MemoryHigh=${highStr}`);
  }

  // Selective oomd-avoid: only for write-txn holder classes.
  if (OOM_AVOID_CLASSES.has(scopeClass)) {
    wrapArgs.push('-p', 'ManagedOOMPreference=avoid');
  }

  if (noCoreFile) {
    // LimitCORE is a service-unit EXEC property — it is NOT valid on scope
    // units and causes systemd-run to reject the argv with:
    //   "Unknown assignment: LimitCORE=0"
    // Suppress coredumps at the process level instead: wrap the inner command
    // in a tiny sh fragment that sets `ulimit -c 0` then execs the real binary.
    // This is equivalent to LimitCORE for our purposes and works on both
    // Fedora and Ubuntu CI runners.
    wrapArgs.push('--', 'sh', '-c', 'ulimit -c 0; exec "$@"', 'sh', command, ...args);
  } else {
    wrapArgs.push('--', command, ...args);
  }

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
 * @remarks An explicit manager context applies only to the launcher. Child manager variables
 * are restored before execution, while all other child environment values remain in env.
 * Scope membership, limits and cleanup require independent observation.
 * @example
 * ```typescript
 * const launched = spawnWrapped('node', ['--version'], { env: process.env });
 * ```
 */
export function spawnWrapped(
  command: string,
  args: readonly string[],
  spawnOpts: Parameters<typeof spawn>[2] = {},
  wrapOpts: BuildSpawnArgsOptions = {},
): SpawnWrappedResult {
  const execution = wrapOpts.execution ? { ...wrapOpts.execution } : undefined;
  const options = {
    ...wrapOpts,
    execution,
    systemdControl: wrapOpts.systemdControl ? { ...wrapOpts.systemdControl } : undefined,
  };
  launchRemaining(execution);
  const control = options.systemdControl;
  const childEnvironment = spawnOpts?.env ?? process.env;
  const controlled = control !== undefined && hasSystemdRun(control, execution);
  // Only non-secret manager path/address values enter the env shim's argv.
  // Arbitrary child environment (including credentials) stays in the environment.
  const restored: string[] = [];
  if (controlled) {
    for (const key of ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) {
      restored.push(`--unset=${key}`);
    }
    for (const key of ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) {
      const value = childEnvironment[key];
      if (value !== undefined) restored.push(`${key}=${value}`);
    }
  }
  const built = buildSpawnArgs(
    controlled ? 'env' : command,
    controlled ? [...restored, command, ...args] : args,
    options,
  );
  launchRemaining(execution);
  const child = spawn(
    built.command,
    built.args,
    controlled ? { ...spawnOpts, env: managerEnvironment(control, childEnvironment) } : spawnOpts,
  );
  return {
    child,
    pid: child.pid,
    mode: built.mode,
    unitName: built.unitName,
  };
}

/** Transport reports target events separately from the enclosing scope wrapper. */
const CAPTURE_TRANSPORT = String.raw`
(() => {
const { spawn } = require('node:child_process');
const send = (event) => process.stdout.write(JSON.stringify(event) + '\n');
const [limitsJson, command, ...args] = process.argv.slice(1);
const limits = JSON.parse(limitsJson);
if (limits.memoryMaxBytes !== undefined || limits.tasksMax !== undefined) {
  try {
    const { readFileSync } = require('node:fs');
    const { join } = require('node:path');
    const entries = readFileSync('/proc/self/cgroup', 'utf8').trim().split('\n');
    const unified = entries.find((entry) => entry.startsWith('0::'));
    if (!unified) throw new Error('Unified cgroup membership unavailable');
    const cgroup = unified.slice(3);
    if (!cgroup.startsWith('/') || cgroup.split('/').includes('..') || !cgroup.split('/').includes(limits.unitName))
      throw new Error('Transport is not inside the requested owned scope');
    const readLimit = (name) => {
      const value = readFileSync(join('/sys/fs/cgroup', cgroup, name), 'utf8').trim();
      if (value === 'max') return null;
      const limit = Number(value);
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid kernel limit: ' + name);
      return limit;
    };
    const memoryMaxBytes = readLimit('memory.max');
    const tasksMax = readLimit('pids.max');
    if (limits.memoryMaxBytes !== undefined && (memoryMaxBytes === null || memoryMaxBytes > limits.memoryMaxBytes))
      throw new Error('Requested memory ceiling was not observed');
    if (limits.tasksMax !== undefined && (tasksMax === null || tasksMax > limits.tasksMax))
      throw new Error('Requested task ceiling was not observed');
    send({ type: 'resources', cgroup, memoryMaxBytes, tasksMax });
  } catch (error) {
    send({ type: 'resource-error', message: String(error.message) });
    process.exitCode = 125;
    return;
  }
}
const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
child.once('spawn', () => send({ type: 'started', pid: child.pid }));
child.once('error', (error) => send({ type: 'error', message: String(error.code || '') + ': ' + error.message }));
for (const stream of ['stdout', 'stderr']) {
  child[stream].on('data', (chunk) => {
    for (let offset = 0; offset < chunk.length; offset += 16384)
      send({ type: 'data', stream, bytes: chunk.subarray(offset, offset + 16384).toString('base64') });
  });
}
child.once('close', (code, signal) => send({ type: 'closed', code, signal }));
})();
`;

/** Internal framing is validated before it can supply a target verdict. */
const captureFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('resource-error'), message: z.string() }).strict(),
  z
    .object({
      type: z.literal('resources'),
      cgroup: z.string(),
      memoryMaxBytes: z.number().int().positive().safe().nullable(),
      tasksMax: z.number().int().positive().safe().nullable(),
    })
    .strict(),
  z.object({ type: z.literal('started'), pid: z.number().int().positive() }).strict(),
  z.object({ type: z.literal('error'), message: z.string() }).strict(),
  z
    .object({ type: z.literal('data'), stream: z.enum(['stdout', 'stderr']), bytes: z.string() })
    .strict(),
  z
    .object({
      type: z.literal('closed'),
      code: z.number().int().nullable(),
      signal: z.string().nullable(),
    })
    .strict(),
]);

/**
 * Capture an owned process with a shared deadline, cancellation and bounded output.
 * @param command - Exact executable; never interpreted as a shell expression.
 * @param args - Exact target arguments; no environment values are added to argv.
 * @param options - Explicit captured routing, environment and original execution budget.
 * @returns Target events and independent transport, stop and cleanup diagnostics.
 * @throws When admission inputs are invalid, the original context has ended, or the platform cannot provide process-group cleanup.
 * @remarks A fixed Node transport distinguishes the requested process from systemd/sh
 * launchers. Cleanup has a bounded additional manager timeout and can exceed the
 * execution deadline. POSIX process groups cannot contain deliberately escaped
 * descendants; Windows capture is refused. Requested hard memory/task limits require
 * observation inside the exact owned cgroup before the target is launched. Calls without
 * requests retain unverified memory limits. This is a transport, not a job scheduler.
 * @example
 * ```typescript
 * const result = await captureWrapped('node', ['check.mjs'], {
 *   cwd: projectRoot, env: {}, execution: { deadlineAt: Date.now() + 2000 },
 * });
 * if (result.started && !result.stopped && result.exitCode === 0) inspect(result);
 * ```
 */
export async function captureWrapped(
  command: string,
  args: readonly string[],
  options: ProcessCaptureOptions,
): Promise<ProcessCaptureResult> {
  if (process.platform === 'win32')
    throw new Error(
      'E_PROCESS_CONTAINMENT: bounded process-group capture is unavailable on Windows',
    );
  if (!isAbsolute(options.cwd)) throw new TypeError('Captured process cwd must be absolute');
  const maxOutputBytes = options.maxOutputBytes ?? 1_048_576;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1)
    throw new RangeError('Capture byte limit must be a positive safe integer');
  const memoryMaxMb = options.memoryMaxMb;
  const tasksMax = options.tasksMax;
  for (const [name, value] of [
    ['memoryMaxMb', memoryMaxMb],
    ['tasksMax', tasksMax],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
      throw new RangeError(`${name} must be a positive safe integer`);
  }
  const memoryMaxBytes = memoryMaxMb === undefined ? undefined : memoryMaxMb * 1024 * 1024;
  if (memoryMaxBytes !== undefined && !Number.isSafeInteger(memoryMaxBytes))
    throw new RangeError('Requested memory ceiling exceeds exact byte representation');
  const scopeId = `${process.pid}-${randomUUID()}`;
  const requestedLimits = { memoryMaxBytes, tasksMax, unitName: `cleo-tool-${scopeId}.scope` };
  const requiresLimits = memoryMaxMb !== undefined || tasksMax !== undefined;
  const execution = { ...options.execution };
  const env = { ...options.env };
  const systemdControl = options.systemdControl ? { ...options.systemdControl } : undefined;
  const startedAt = Date.now();
  launchRemaining(execution);
  const controller = new AbortController();
  const deregister = registerTeardownAbort(controller);
  let owned: SpawnWrappedResult;
  try {
    controller.signal.throwIfAborted();
    owned = spawnWrapped(
      process.execPath,
      ['-e', CAPTURE_TRANSPORT, JSON.stringify(requestedLimits), command, ...args],
      {
        cwd: options.cwd,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
      {
        scopeClass: 'tool',
        scopeId,
        resources: {
          ...(memoryMaxMb === undefined ? {} : { memoryMax: `${memoryMaxMb}M` }),
          tasksMax,
        },
        execution,
        systemdControl,
        noCoreFile: false,
      },
    );
  } catch (error) {
    deregister();
    throw error;
  }
  return new Promise<ProcessCaptureResult>((resolve) => {
    const { child } = owned;
    let resourceLimits: ProcessCaptureResourceObservation | undefined;
    let started = false;
    let targetPid: number | null = null;
    let exitCode: number | null = null;
    let signal: string | null = null;
    let error: string | null = null;
    let stopped: ProcessCaptureStop | null = null;
    let closedFrame = false;
    let pending = '';
    let outputBytes = 0;
    let outputTruncated = false;
    let wrapperError = '';
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const cleanupErrors: string[] = [];
    let cleanupObservation: ProcessCaptureResult['cleanupObservation'] = 'unverified';
    let terminated = false;
    const terminate = () => {
      if (terminated) return;
      terminated = true;
      if (child.pid) {
        try {
          if (process.platform === 'win32') child.kill('SIGKILL');
          else {
            process.kill(-child.pid, 'SIGKILL');
            cleanupObservation = 'process-group-signalled';
          }
        } catch (cause) {
          if (cause instanceof Error && 'code' in cause && cause.code === 'ESRCH')
            cleanupObservation = 'process-group-absent';
          else cleanupErrors.push(String(cause));
        }
      }
      if (owned.unitName) {
        const cleanup = spawnSync(
          'systemctl',
          ['--user', 'kill', '--kill-whom=all', '--signal=SIGKILL', owned.unitName],
          {
            env: managerEnvironment(systemdControl, env),
            timeout: 1000,
            maxBuffer: 4096,
            encoding: 'utf8',
          },
        );
        const observation = spawnSync(
          'systemctl',
          ['--user', 'show', owned.unitName, '--property=LoadState', '--property=ActiveState'],
          {
            env: managerEnvironment(systemdControl, env),
            timeout: 1000,
            maxBuffer: 4096,
            encoding: 'utf8',
          },
        );
        const inactive = observation.stdout
          ?.split('\n')
          .some(
            (line) =>
              line === 'LoadState=not-found' ||
              line === 'ActiveState=inactive' ||
              line === 'ActiveState=failed',
          );
        if (!observation.error && inactive) cleanupObservation = 'scope-terminal';
        if (observation.error || !inactive)
          cleanupErrors.push(
            `Scope cleanup unverified: ${
              observation.error?.message ??
              observation.stderr?.trim() ??
              cleanup.error?.message ??
              cleanup.stderr?.trim() ??
              'scope remains active'
            }`,
          );
      }
    };
    const stop = (reason: ProcessCaptureStop, diagnostic?: string) => {
      stopped ??= reason;
      if (diagnostic) error ??= diagnostic;
      terminate();
    };
    const cancelled = () => stop('cancelled');
    const teardown = () => stop('teardown');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = () => {
      const remaining = execution.deadlineAt - Date.now();
      if (remaining <= 0) stop('deadline');
      else timer = setTimeout(deadline, Math.min(2_147_483_647, remaining));
    };
    deadline();
    execution.signal?.addEventListener('abort', cancelled, { once: true });
    controller.signal.addEventListener('abort', teardown, { once: true });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      pending += chunk;
      for (;;) {
        const end = pending.indexOf('\n');
        if (end < 0) break;
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (line.length > 32768) {
          stop('transport-error', 'Capture frame exceeds byte bound');
          break;
        }
        try {
          const frame = captureFrameSchema.parse(JSON.parse(line));
          if (closedFrame) throw new Error('Capture frame received after target close');
          switch (frame.type) {
            case 'resource-error':
              stop('resource-limit', `E_PROCESS_RESOURCE_LIMIT: ${frame.message}`);
              break;
            case 'resources':
              if (
                !requiresLimits ||
                resourceLimits ||
                started ||
                owned.mode !== 'systemd' ||
                !frame.cgroup.split('/').includes(requestedLimits.unitName) ||
                (memoryMaxBytes !== undefined &&
                  (frame.memoryMaxBytes === null || frame.memoryMaxBytes > memoryMaxBytes)) ||
                (tasksMax !== undefined && (frame.tasksMax === null || frame.tasksMax > tasksMax))
              )
                throw new Error('Invalid or insufficient resource observation');
              resourceLimits = {
                cgroup: frame.cgroup,
                memoryMaxBytes: frame.memoryMaxBytes,
                tasksMax: frame.tasksMax,
              };
              break;
            case 'started':
              if (requiresLimits && !resourceLimits)
                throw new Error('Target started without required resource observation');
              if (started || error) throw new Error('Duplicate or contradictory target start');
              started = true;
              targetPid = frame.pid;
              break;
            case 'error':
              error = frame.message;
              break;
            case 'closed':
              closedFrame = true;
              if (started) {
                exitCode = frame.code;
                signal = frame.signal;
              }
              break;
            case 'data': {
              if (!started) throw new Error('Output before target spawn');
              const bytes = Buffer.from(frame.bytes, 'base64');
              if (bytes.toString('base64') !== frame.bytes)
                throw new Error('Malformed output encoding');
              const allowed = Math.max(0, maxOutputBytes - outputBytes);
              (frame.stream === 'stdout' ? stdout : stderr).push(bytes.subarray(0, allowed));
              outputBytes += bytes.length;
              if (outputBytes > maxOutputBytes) {
                outputTruncated = true;
                stop('output-limit');
              }
              break;
            }
          }
        } catch (cause) {
          stop('transport-error', `Invalid capture transport: ${String(cause)}`);
        }
      }
      if (pending.length > 32768)
        stop('transport-error', 'Unterminated capture frame exceeds bound');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      wrapperError = Buffer.concat([Buffer.from(wrapperError), chunk])
        .subarray(0, 4096)
        .toString('utf8');
    });
    child.once('error', (cause) => {
      error = `Capture launcher failed: ${cause.message}`;
    });
    child.once('close', (wrapperCode, wrapperSignal) => {
      clearTimeout(timer);
      execution.signal?.removeEventListener('abort', cancelled);
      controller.signal.removeEventListener('abort', teardown);
      deregister();
      if (
        !stopped &&
        (!closedFrame ||
          (!started && !error) ||
          pending.length ||
          wrapperCode !== 0 ||
          wrapperSignal)
      ) {
        stopped = 'transport-error';
        error ??= `Capture transport incomplete (wrapper code ${wrapperCode}, signal ${wrapperSignal}): ${wrapperError}`;
      }
      terminate();
      if (
        Buffer.byteLength(Buffer.concat(stdout).toString('utf8')) +
          Buffer.byteLength(Buffer.concat(stderr).toString('utf8')) >
        maxOutputBytes
      ) {
        outputTruncated = true;
        stopped ??= 'output-limit';
      }
      const decodedStdout = new StringDecoder('utf8').write(
        Buffer.from(Buffer.concat(stdout).toString('utf8')).subarray(0, maxOutputBytes),
      );
      const decodedStderr = new StringDecoder('utf8').write(
        Buffer.from(Buffer.concat(stderr).toString('utf8')).subarray(
          0,
          maxOutputBytes - Buffer.byteLength(decodedStdout),
        ),
      );
      resolve({
        started,
        targetPid,
        exitCode,
        signal,
        error,
        stopped,
        stdout: decodedStdout,
        stderr: decodedStderr,
        outputTruncated,
        durationMs: Date.now() - startedAt,
        mode: owned.mode,
        ...(owned.unitName ? { unitName: owned.unitName } : {}),
        nativeMemory: resourceLimits?.memoryMaxBytes ? 'observed-cgroup' : 'unverified',
        ...(resourceLimits ? { resourceLimits } : {}),
        cleanupScope: 'process-group',
        transportClosed: true,
        targetCloseObserved: closedFrame,
        cleanupObservation,
        cleanupErrors,
      });
    });
    if (execution.signal?.aborted) cancelled();
    if (controller.signal.aborted) teardown();
  });
}

/**
 * Create the parser's process-execution port using the canonical spawn service.
 * @returns A launcher with per-process V8 limits and teardown cancellation.
 * @remarks Explicit Node argv overrides inherited NODE_OPTIONS heap flags while
 * preserving loader guards. Configured cgroup memory is not claimed as observed
 * native-memory containment. The parser verifies its actual V8 limit at startup.
 * @example
 * ```ts
 * const parserExecution = createParserExecutionPort();
 * ```
 */
export function createParserExecutionPort(): ParserExecutionPort {
  return {
    spawn(scriptPath, limits) {
      const heapMb = limits.workerHeapMb ?? 128;
      if (!Number.isSafeInteger(heapMb) || heapMb < 8 || heapMb > 512) {
        throw new RangeError('Parser worker heap must be an integer from 8 to 512 MiB');
      }
      limits.signal?.throwIfAborted();
      const controller = new AbortController();
      const deregister = registerTeardownAbort(controller);
      if (controller.signal.aborted) {
        deregister();
        controller.signal.throwIfAborted();
      }
      let owned: SpawnWrappedResult;
      try {
        owned = spawnWrapped(
          process.execPath,
          [`--max-old-space-size=${heapMb}`, '--max-semi-space-size=8', scriptPath],
          {
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
            detached: process.platform !== 'win32',
            env: process.env,
          },
          { scopeClass: 'tool', resources: { memoryMax: `${Math.max(256, heapMb * 2)}M` } },
        );
      } catch (error) {
        deregister();
        throw error;
      }
      const { child } = owned;
      // Drain diagnostics to avoid blocking a child on a full stderr pipe.
      child.stderr?.on('data', () => undefined);
      let exited = false;
      const closed = new Promise<void>((resolve) => {
        child.once('close', () => {
          exited = true;
          resolve();
        });
      });
      const stop = async (): Promise<void> => {
        if (!exited && child.pid) {
          try {
            if (process.platform === 'win32') child.kill('SIGKILL');
            else process.kill(-child.pid, 'SIGKILL');
          } catch (error) {
            if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH')
              throw error;
          }
        }
        await closed;
      };
      const abort = () => {
        void stop().catch(() => undefined);
      };
      limits.signal?.addEventListener('abort', abort, { once: true });
      controller.signal.addEventListener('abort', abort, { once: true });
      child.once('close', () => {
        limits.signal?.removeEventListener('abort', abort);
        controller.signal.removeEventListener('abort', abort);
        deregister();
      });
      if (limits.signal?.aborted || controller.signal.aborted) abort();
      return { child, heapMb, nativeMemory: 'unverified', stop };
    },
  };
}
