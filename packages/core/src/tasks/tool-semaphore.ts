/**
 * Cross-process global concurrency limit for evidence-tool runs (T1534 / ADR-061).
 *
 * The cache layer ({@link runToolCached}) coalesces *identical* parallel runs
 * via a per-key file lock — when 10 sibling tasks against the same git HEAD
 * call `tool:test`, only one spawns. But orchestrator-spawned worktree
 * agents each operate on a *different* HEAD (one branch per worktree per
 * ADR-055), so their cache keys differ and the per-key lock does NOT
 * coalesce them. Without an additional bound, N worktree agents would each
 * spawn the full toolchain, multiplying CPU and resident memory by N.
 *
 * This module bounds *total* concurrent runs of a canonical tool across
 * the whole machine — independent of which project, worktree, or PID
 * issues the call. It uses a slot directory under
 * `~/.local/share/cleo/locks/tool-<canonical>/` with `slot-0.lock` …
 * `slot-(N-1).lock` files; each slot is held by `proper-lockfile` so a
 * crashed process auto-releases via the standard stale-lock recovery.
 *
 * Defaults (configurable via env):
 *
 *   | Tool           | Default        | CPU profile                         |
 *   |----------------|----------------|-------------------------------------|
 *   | test, build    | max(1, cpus/4) | runs its own worker pool already    |
 *   | lint, typecheck| max(2, cpus/2) | usually single-threaded, lighter    |
 *   | audit          | max(2, cpus/2) | network-bound, small RAM            |
 *   | security-scan  | max(2, cpus/2) | network-bound, small RAM            |
 *
 * Override via `CLEO_TOOL_CONCURRENCY_<CANONICAL>` (e.g.
 * `CLEO_TOOL_CONCURRENCY_TEST=2`). Set to `0` or a negative number to
 * disable the limit for that tool.
 *
 * @task T1534
 * @adr ADR-061
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';

import lockfile from 'proper-lockfile';

import { getCleoHome } from '../paths.js';
import type { ResourceSample } from '../resources/backend.js';
import { ResourceMonitor } from '../resources/monitor.js';
import type { CanonicalTool } from './tool-resolver.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Function returned by {@link acquireGlobalSlot} that must be called to
 * release the held slot. Always-callable; idempotent against re-entry.
 *
 * @task T1534
 */
export type ReleaseSlotFn = () => Promise<void>;

/**
 * Options for {@link acquireGlobalSlot}.
 *
 * @task T1534
 */
export interface AcquireSlotOptions {
  /**
   * Maximum wall-clock time to wait for a free slot before throwing. The
   * default — 60 minutes — covers a long-running monorepo test suite that
   * can leave the semaphore held for a while.
   *
   * @defaultValue `3_600_000` (60 min)
   */
  timeoutMs?: number;
  /**
   * Sleep between acquire attempts when all slots are busy. Smaller values
   * burn more CPU on the polling loop; larger values delay the next worker.
   *
   * @defaultValue `100`
   */
  pollMs?: number;
  /**
   * Stale-lock window passed to `proper-lockfile`. A slot held by a
   * process that exited without releasing is reaped after this many
   * milliseconds.
   *
   * @defaultValue `600_000` (10 min)
   */
  staleMs?: number;
  /**
   * Override `os.availableParallelism()` for tests.
   *
   * @internal
   */
  cpuCount?: number;
  /**
   * Memory-pressure sample used to scale the effective slot count for the
   * pressure-sensitive `test`/`build` tools (T12001, Epic T11992). When
   * omitted, a best-effort live sample is taken (fail-open to the static slot
   * count on any error). Pass `null` to disable pressure scaling explicitly.
   * Tests inject a synthetic sample for determinism.
   *
   * @internal
   */
  pressureSample?: ResourceSample | null;
}

// ---------------------------------------------------------------------------
// Concurrency-limit defaults + override resolution
// ---------------------------------------------------------------------------

/**
 * Compute the default max-concurrency for a canonical tool given the CPU
 * count. CPU-heavy runners (test, build) get a quarter of cores; lighter
 * tools (lint, typecheck, audit, security-scan) get half. Always at least 1.
 *
 * @task T1534
 */
export function defaultMaxConcurrent(canonical: CanonicalTool, cpuCount: number): number {
  const cpus = Math.max(1, cpuCount);
  switch (canonical) {
    case 'test':
    case 'build':
      return Math.max(1, Math.floor(cpus / 4));
    case 'lint':
    case 'typecheck':
    case 'audit':
    case 'security-scan':
      return Math.max(2, Math.floor(cpus / 2));
    default:
      return 1;
  }
}

/**
 * Resolve the active per-tool concurrency limit, honouring the
 * `CLEO_TOOL_CONCURRENCY_<CANONICAL>` env override when set. A value of
 * `0` (or any non-positive number) disables the bound and returns
 * `Number.POSITIVE_INFINITY`, in which case {@link acquireGlobalSlot}
 * returns a no-op release.
 *
 * @task T1534
 */
export function resolveMaxConcurrent(canonical: CanonicalTool, cpuCount?: number): number {
  const envKey = `CLEO_TOOL_CONCURRENCY_${canonical.toUpperCase().replace(/-/g, '_')}`;
  const raw = process.env[envKey];
  if (raw !== undefined && raw !== '') {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) {
      if (parsed <= 0) return Number.POSITIVE_INFINITY;
      return parsed;
    }
  }
  return defaultMaxConcurrent(canonical, cpuCount ?? availableParallelism());
}

/**
 * Whether a canonical tool's slot budget shrinks under memory pressure.
 * Only the heavy `test`/`build` classes scale; lint/typecheck/audit are light
 * and single-threaded, so they keep their static budget.
 */
function isPressureSensitive(canonical: CanonicalTool): boolean {
  return canonical === 'test' || canonical === 'build';
}

/**
 * Scale a static slot budget down under memory pressure (T12001 · choke-point
 * #6). Mirrors the governor's `test-run` budget: halve when `some avg10` exceeds
 * the hold threshold, floor to 1 when it exceeds the backoff/floor threshold.
 * Recovers automatically as pressure clears. `full-build` is not represented as
 * a canonical tool here; the dedicated `full-build` governor class (T11999)
 * pins that to one machine-wide slot.
 *
 * @task T12001
 */
export function pressureScaleSlots(
  canonical: CanonicalTool,
  staticMax: number,
  sample: ResourceSample,
  thresholds: { holdSomeAvg10?: number; floorSomeAvg10?: number } = {},
): number {
  if (!Number.isFinite(staticMax) || !isPressureSensitive(canonical)) return staticMax;
  const hold = thresholds.holdSomeAvg10 ?? 10;
  const floor = thresholds.floorSomeAvg10 ?? 25;
  const some = sample.globalPressure?.some?.avg10 ?? sample.slicePressure?.some?.avg10 ?? 0;
  if (some > floor) return 1;
  if (some > hold) return Math.max(1, Math.floor(staticMax / 2));
  return staticMax;
}

/**
 * Best-effort point-sample for slot scaling. NEVER throws — on any error (no
 * `/proc`, non-Linux, read failure) returns `null` so the caller fails open to
 * the static slot count. The PSI + meminfo reads are sub-5ms.
 */
async function samplePressureSafe(): Promise<ResourceSample | null> {
  try {
    return await new ResourceMonitor().sample();
  } catch {
    return null;
  }
}

/**
 * Whether an explicit `CLEO_TOOL_CONCURRENCY_<TOOL>` override is set — when so,
 * the operator's intent is authoritative and pressure scaling is bypassed.
 */
function hasConcurrencyOverride(canonical: CanonicalTool): boolean {
  const raw = process.env[`CLEO_TOOL_CONCURRENCY_${canonical.toUpperCase().replace(/-/g, '_')}`];
  return raw !== undefined && raw !== '';
}

// ---------------------------------------------------------------------------
// Slot-directory layout
// ---------------------------------------------------------------------------

/**
 * Path to the global slot directory for a canonical tool. Sits under
 * `getCleoHome()/locks/tool-<canonical>/` so all CLEO-driven processes
 * on a machine share the same semaphore — across projects, worktrees,
 * and PIDs.
 *
 * @task T1534
 */
export function semaphoreDir(canonical: CanonicalTool): string {
  return join(getCleoHome(), 'locks', `tool-${canonical}`);
}

function ensureSlotFiles(dir: string, count: number): string[] {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const paths: string[] = [];
  for (let i = 0; i < count; i++) {
    const p = join(dir, `slot-${i}.lock`);
    if (!existsSync(p)) {
      writeFileSync(p, '', 'utf-8');
    }
    paths.push(p);
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Acquire / release
// ---------------------------------------------------------------------------

const NOOP_RELEASE: ReleaseSlotFn = async () => {
  /* no-op when concurrency is disabled */
};

/**
 * Acquire one slot from the global semaphore for a canonical tool. Blocks
 * until a slot becomes free or `timeoutMs` elapses.
 *
 * Implementation detail: tries each slot file in turn with `retries: 0`
 * (proper-lockfile non-blocking acquire). When all are busy, sleeps for
 * `pollMs` and retries. This avoids the thundering-herd cost of having
 * many retriers wake at the exact same moment.
 *
 * @param canonical - Canonical tool name from the resolver.
 * @param opts - Acquisition options.
 * @returns A release function. Idempotent.
 * @throws When `timeoutMs` elapses without acquiring a slot.
 *
 * @example
 * ```ts
 * const release = await acquireGlobalSlot('test');
 * try {
 *   await runTheTool();
 * } finally {
 *   await release();
 * }
 * ```
 *
 * @task T1534
 */
export async function acquireGlobalSlot(
  canonical: CanonicalTool,
  opts: AcquireSlotOptions = {},
): Promise<ReleaseSlotFn> {
  const max = resolveMaxConcurrent(canonical, opts.cpuCount);
  if (!Number.isFinite(max) || max <= 0) {
    return NOOP_RELEASE;
  }

  // T12001 / choke-point #6: shrink the EFFECTIVE slot count for the heavy
  // test/build classes under memory pressure so builds/tests can't co-schedule
  // into an OOM. The static slot FILES are still created (stable dir across
  // pressure swings) — only the acquirable window shrinks, and it recovers as
  // pressure clears. An explicit CLEO_TOOL_CONCURRENCY_* override is honored
  // verbatim, and any sampling failure fails OPEN to the static count.
  let effectiveMax = max;
  if (isPressureSensitive(canonical) && !hasConcurrencyOverride(canonical)) {
    const sample =
      opts.pressureSample !== undefined ? opts.pressureSample : await samplePressureSafe();
    if (sample) effectiveMax = pressureScaleSlots(canonical, max, sample);
  }

  const dir = semaphoreDir(canonical);
  // Create the full static slot set so the directory is stable; only the first
  // `effectiveMax` are eligible this acquire.
  const slots = ensureSlotFiles(dir, max);
  const usableSlots = slots.slice(0, Math.max(1, effectiveMax));

  const timeoutMs = opts.timeoutMs ?? 3_600_000;
  const pollMs = opts.pollMs ?? 100;
  const staleMs = opts.staleMs ?? 600_000;
  const startedAt = Date.now();

  // Randomise slot order so concurrent acquirers don't collide on slot 0.
  // The Fisher–Yates shuffle is fine for small N.
  const order = [...usableSlots.keys()];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = order[i];
    const b = order[j];
    if (a !== undefined && b !== undefined) {
      order[i] = b;
      order[j] = a;
    }
  }

  while (Date.now() - startedAt < timeoutMs) {
    for (const idx of order) {
      const path = slots[idx];
      if (!path) continue;
      try {
        const release = await lockfile.lock(path, {
          retries: 0,
          stale: staleMs,
          realpath: false,
        });
        let released = false;
        return async () => {
          if (released) return;
          released = true;
          try {
            await release();
          } catch {
            // proper-lockfile throws if the lock was already released
            // (e.g. via stale recovery). Swallow — the post-condition
            // is "slot is free", which is true either way.
          }
        };
      } catch {
        // slot busy; try next
      }
    }
    // All slots busy — sleep and retry.
    await sleep(pollMs);
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for a free '${canonical}' tool slot ` +
      `(max ${max} concurrent). Override with CLEO_TOOL_CONCURRENCY_${canonical
        .toUpperCase()
        .replace(/-/g, '_')}=<n>.`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
