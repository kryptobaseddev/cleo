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
 *   | Tool           | Default                          | Binding constraint        |
 *   |----------------|----------------------------------|---------------------------|
 *   | test, build    | min(RAM/24GiB, cpus/4), min 1    | MEMORY (each run forks)   |
 *   | lint, typecheck| max(2, cpus/2)                   | CPU (single-process)      |
 *   | audit          | max(2, cpus/2)                   | network-bound, small RAM  |
 *   | security-scan  | max(2, cpus/2)                   | network-bound, small RAM  |
 *
 * T12091: `test`/`build` were `max(1, cpus/4)` — 6 slots on a 24-core box. Since
 * each `pnpm run test` is itself allowed 6 vitest forks × 4 GiB, the two bounds
 * composed to 144 GiB of permitted heap on 62 GiB of RAM. Neither layer was
 * individually violated, which is exactly why the machine froze without any
 * guard firing. Heavy tools are now bounded by the dimension that actually
 * limits them — see {@link defaultMaxConcurrent}.
 *
 * Override via `CLEO_TOOL_CONCURRENCY_<CANONICAL>` (e.g.
 * `CLEO_TOOL_CONCURRENCY_TEST=2`). Set to `0` or a negative number to
 * disable the limit for that tool — which also disables the RAM bound, so it is
 * the one setting that can still oversubscribe the machine.
 *
 * @task T1534
 * @task T12091
 * @adr ADR-061
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, hostname, totalmem } from 'node:os';
import { join } from 'node:path';

import lockfile from 'proper-lockfile';

import { getCleoHome } from '../paths.js';
import type { ResourceSample } from '../resources/backend.js';
import { ResourceMonitor } from '../resources/monitor.js';
import { isHeavyTool } from './heavy-tool-env.js';
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
   * Override `os.totalmem()` (in GiB) for tests.
   *
   * T12091 made the heavy-tool budget RAM-derived, which would otherwise make
   * the slot count depend on whatever host the suite runs on — a 16 GiB CI
   * runner and a 62 GiB workstation resolve different budgets for identical
   * inputs. Injecting it keeps semaphore behaviour deterministic.
   *
   * @internal
   */
  totalRamGib?: number;
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
 * Worst-case resident footprint of ONE `tool:test` / `tool:build` invocation,
 * in GiB.
 *
 * This is not a guess. `vitest.memory-safe.ts` permits
 * `MEMORY_SAFE_MAX_WORKERS` forks (up to 6) each capped at `FORK_HEAP_MB`
 * (4096), so a single `pnpm run test` may legitimately hold ~24 GiB before any
 * guard fires. Keep this in step with that file if either bound changes.
 *
 * @task T12091
 */
export const HEAVY_TOOL_FOOTPRINT_GIB = 24;

/**
 * Compute the default max-concurrency for a canonical tool.
 *
 * ## Why this is RAM-derived, not core-derived (T12091)
 *
 * This returned `floor(cpus / 4)` for `test`/`build`, which on a 24-core box is
 * **6 concurrent full test suites**. Each of those is itself allowed 6 vitest
 * forks × a 4 GiB heap cap, so the composed permission was
 *
 *     6 runs × 6 forks × 4 GiB = 144 GiB
 *
 * on a 62 GiB machine. Both layers were individually "bounded" and their
 * composition was 2.3× the hardware — which is precisely how this box froze
 * repeatedly: no single guard was violated. The per-invocation cap (T12087) and
 * this cross-invocation cap were written independently and never multiplied out.
 *
 * The dimensional error is the root of it: what limits a test run is MEMORY, and
 * core count says nothing about memory. A 24-core/16 GiB VM got the same 6 slots
 * as a 24-core/256 GiB server. So heavy tools now divide TOTAL RAM by
 * {@link HEAVY_TOOL_FOOTPRINT_GIB} and are additionally capped by cores, never
 * exceeding what the machine can actually hold.
 *
 * Reactive pressure scaling ({@link pressureScaleSlots}) is not a substitute:
 * PSI `some avg10` is a ten-second average, and a fork fleet can exhaust RAM
 * faster than that window can report it. Admission has to be right up front.
 *
 * Light tools (lint, typecheck, audit, security-scan) are single-process and
 * short, and keep the core-derived half-of-cores budget.
 *
 * @param canonical - the canonical tool class.
 * @param cpuCount  - logical cores available.
 * @param totalRamGib - total machine RAM in GiB; defaults to a live reading.
 * @returns the machine-wide slot count, always ≥ 1.
 *
 * @example
 * ```ts
 * // 24 cores, 62 GiB → floor(62/24) = 2 (was 6, permitting 144 GiB of heap)
 * defaultMaxConcurrent('test', 24, 62); // → 2
 * // 24 cores, 16 GiB → 1: one suite is already more than this box can hold
 * defaultMaxConcurrent('test', 24, 16); // → 1
 * ```
 *
 * @task T1534
 * @task T12091
 */
export function defaultMaxConcurrent(
  canonical: CanonicalTool,
  cpuCount: number,
  totalRamGib: number = totalmem() / 1024 ** 3,
): number {
  const cpus = Math.max(1, cpuCount);
  switch (canonical) {
    case 'test':
    case 'build': {
      const byRam = Math.floor(totalRamGib / HEAVY_TOOL_FOOTPRINT_GIB);
      const byCpu = Math.floor(cpus / 4);
      return Math.max(1, Math.min(byRam, byCpu));
    }
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
export function resolveMaxConcurrent(
  canonical: CanonicalTool,
  cpuCount?: number,
  totalRamGib?: number,
): number {
  const envKey = `CLEO_TOOL_CONCURRENCY_${canonical.toUpperCase().replace(/-/g, '_')}`;
  const raw = process.env[envKey];
  if (raw !== undefined && raw !== '') {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) {
      if (parsed <= 0) return Number.POSITIVE_INFINITY;
      return parsed;
    }
  }
  return defaultMaxConcurrent(
    canonical,
    cpuCount ?? availableParallelism(),
    totalRamGib ?? totalmem() / 1024 ** 3,
  );
}

/**
 * Whether a canonical tool's slot budget shrinks under memory pressure.
 * Only the heavy `test`/`build` classes scale; lint/typecheck/audit are light
 * and single-threaded, so they keep their static budget.
 */
function isPressureSensitive(canonical: CanonicalTool): boolean {
  // Delegates rather than repeating the literal. This was the third
  // independent definition of "heavy"; all three agreed by coincidence, and a
  // fifth heavy tool would have needed three coordinated edits — with a missed
  // one producing a SILENT asymmetry (a tool granted the long deadline and the
  // worker caps but not a semaphore slot, or the reverse).
  return isHeavyTool(canonical);
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

/**
 * Identity of the process currently holding a semaphore slot.
 *
 * `proper-lockfile` decides staleness from the lock's **mtime**, which it
 * refreshes on a timer while the holder lives. That makes a slot held by a
 * process which died without releasing indistinguishable from one held by a
 * legitimately long-running suite: both simply wait out `staleMs` (10 min by
 * default). On a box where evidence runs are frequent, one orphan therefore
 * blocks every later verify for ten minutes with `E_EVIDENCE_TOOL_BUSY` and
 * no indication of who is holding it (gh#1222).
 *
 * Recording the holder turns that into a decidable question: a slot whose
 * owner is a dead pid on this host is orphaned NOW, not in ten minutes, and
 * the operator can be told which process to look at.
 *
 * @task T12113 (gh#1222)
 */
export interface SlotHolder {
  /** OS process id of the holder. */
  pid: number;
  /** Host that pid is meaningful on. Liveness is only decided on a match. */
  host: string;
  /** ISO 8601 timestamp of acquisition — lets the operator judge "stuck vs slow". */
  acquiredAt: string;
  /** Canonical tool the slot belongs to. */
  canonical: string;
  /** Slot file this holder record describes. */
  slot: string;
}

/**
 * Path of the sidecar holder record for a slot.
 *
 * Deliberately a SIBLING of the lock rather than a file inside it:
 * `proper-lockfile` removes its lock directory with `rmdir`, which fails if we
 * have put anything inside it.
 *
 * @internal
 * @task T12113 (gh#1222)
 */
function holderPath(slotPath: string): string {
  return `${slotPath}.holder.json`;
}

/**
 * Record who holds a slot. Best-effort: a failure here must never fail an
 * acquire that has already succeeded, because the slot IS held at that point
 * and throwing would leak it.
 *
 * @internal
 * @task T12113 (gh#1222)
 */
function writeHolder(slotPath: string, canonical: string): void {
  const holder: SlotHolder = {
    pid: process.pid,
    host: hostname(),
    acquiredAt: new Date().toISOString(),
    canonical,
    slot: slotPath,
  };
  try {
    writeFileSync(holderPath(slotPath), JSON.stringify(holder), 'utf-8');
  } catch {
    /* best-effort — never fail an acquire that succeeded */
  }
}

/**
 * Read a slot's holder record. Returns `null` when absent or unparseable —
 * both mean "we cannot say who holds this", which is treated as alive.
 *
 * @internal
 * @task T12113 (gh#1222)
 */
export function readHolder(slotPath: string): SlotHolder | null {
  try {
    const parsed = JSON.parse(readFileSync(holderPath(slotPath), 'utf-8')) as Partial<SlotHolder>;
    if (typeof parsed.pid !== 'number' || typeof parsed.host !== 'string') return null;
    return parsed as SlotHolder;
  } catch {
    return null;
  }
}

/**
 * Is a slot's recorded holder still running?
 *
 * Fails SAFE: an unknown holder, a holder on another host, or any error is
 * reported as ALIVE. Reaping a live holder's slot would let two heavy suites
 * run against one bound — the exact oversubscription the semaphore exists to
 * prevent — so uncertainty must never authorise a reap.
 *
 * @param holder - Holder record, or `null` when none could be read.
 * @returns `true` when the slot must be treated as legitimately held.
 *
 * @task T12113 (gh#1222)
 */
export function isHolderAlive(holder: SlotHolder | null): boolean {
  if (!holder) return true; // unknown — assume alive
  if (holder.host !== hostname()) return true; // pid is not ours to judge
  try {
    process.kill(holder.pid, 0); // signal 0 = existence check, sends nothing
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Release a slot whose recorded holder is gone.
 *
 * Removes `proper-lockfile`'s lock directory directly — the same thing its own
 * stale recovery does, but decided by process liveness instead of by a 10
 * minute mtime timeout.
 *
 * @param slotPath - Slot lock file path.
 * @returns `true` when an orphaned slot was actually reaped.
 *
 * @task T12113 (gh#1222)
 */
export function reapSlotIfOrphaned(slotPath: string): boolean {
  const holder = readHolder(slotPath);
  if (isHolderAlive(holder)) return false;
  try {
    rmSync(`${slotPath}.lock`, { recursive: true, force: true });
    rmSync(holderPath(slotPath), { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Enumerate every slot of a canonical tool with its holder and liveness.
 *
 * Backs the operator-facing lock inspection surface requested in gh#1222 —
 * "who is holding this, and is it even alive?" — which previously required
 * reading `~/.local/share/cleo/locks/` by hand.
 *
 * @param canonical - Canonical tool name.
 * @returns One row per existing slot file.
 *
 * @task T12113 (gh#1222)
 */
export function listSlotHolders(
  canonical: CanonicalTool,
): Array<{ slot: string; held: boolean; holder: SlotHolder | null; alive: boolean }> {
  const dir = semaphoreDir(canonical);
  if (!existsSync(dir)) return [];
  const rows: Array<{
    slot: string;
    held: boolean;
    holder: SlotHolder | null;
    alive: boolean;
  }> = [];
  for (let i = 0; ; i++) {
    const slotPath = join(dir, `slot-${i}.lock`);
    if (!existsSync(slotPath)) break;
    const holder = readHolder(slotPath);
    rows.push({
      slot: slotPath,
      held: existsSync(`${slotPath}.lock`),
      holder,
      alive: isHolderAlive(holder),
    });
  }
  return rows;
}

/**
 * Reap every orphaned slot of a canonical tool.
 *
 * @param canonical - Canonical tool name.
 * @returns Paths of the slots actually reaped.
 *
 * @task T12113 (gh#1222)
 */
export function reapOrphanedSlots(canonical: CanonicalTool): string[] {
  const reaped: string[] = [];
  for (const row of listSlotHolders(canonical)) {
    if (row.held && !row.alive && reapSlotIfOrphaned(row.slot)) reaped.push(row.slot);
  }
  return reaped;
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
  const max = resolveMaxConcurrent(canonical, opts.cpuCount, opts.totalRamGib);
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
      let acquired: (() => Promise<void>) | null = null;
      try {
        acquired = await lockfile.lock(path, { retries: 0, stale: staleMs, realpath: false });
      } catch {
        // gh#1222: the slot is held — but by whom? proper-lockfile decides
        // staleness from mtime, so a process that died without releasing
        // holds the slot for the full staleMs (10 min) and is
        // indistinguishable from a legitimately slow suite. Ask the holder
        // record instead: a dead pid on this host is orphaned NOW. Fails
        // safe — an unknown or remote holder is treated as alive.
        if (reapSlotIfOrphaned(path)) {
          try {
            acquired = await lockfile.lock(path, { retries: 0, stale: staleMs, realpath: false });
          } catch {
            acquired = null; // someone else won the race for the reaped slot
          }
        }
      }
      if (acquired) {
        const release = acquired;
        writeHolder(path, canonical);
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
          try {
            rmSync(`${path}.holder.json`, { force: true });
          } catch {
            /* best-effort — a stale holder record is only ever advisory */
          }
        };
      }
    }
    // All slots busy — sleep and retry.
    await sleep(pollMs);
  }

  // gh#1222: name the holders. "Everything is busy" with no way to see WHO is
  // what made an orphaned slot look like a broken semaphore.
  const holders = listSlotHolders(canonical)
    .filter((r) => r.held)
    .map((r) => {
      const h = r.holder;
      if (!h) return `${r.slot}: holder unknown`;
      return `${r.slot}: pid ${h.pid} on ${h.host} since ${h.acquiredAt}${r.alive ? '' : ' (DEAD)'}`;
    });
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for a free '${canonical}' tool slot ` +
      `(max ${max} concurrent).` +
      (holders.length > 0 ? ` Current holders — ${holders.join('; ')}.` : '') +
      ` Override with CLEO_TOOL_CONCURRENCY_${canonical.toUpperCase().replace(/-/g, '_')}=<n>.`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
