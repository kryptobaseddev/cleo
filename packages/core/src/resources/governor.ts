/**
 * ResourceGovernor — Never-OOM class-based admission (T11999, Epic T11992).
 *
 * Admits resource-intensive work through priority classes whose slot budgets
 * are computed at acquire time from host memory + memory-pressure (PSI). A
 * denial returns a structured, retryable {@link ResourceDeferral} — never a
 * silent drop, never a crash. Existing grants are NEVER revoked.
 *
 * Three modes (verbatim writer-lease shape, `writer-lease.ts` `resolveLeaseMode`):
 * - `supervisor` — defer to the Rust `cleo-supervisor` `resource_admit` verb.
 *   Demotes to `local` (log-once) until the IPC client is wired — a
 *   dead/absent arbiter must never deadlock work.
 * - `local` — DEFAULT, daemon-off. Per-class slot directories under
 *   `getCleoHome()/locks/resource-<class>/` arbitrated by `proper-lockfile`
 *   (crash-stale auto-release ⇒ genuinely cross-process without a daemon),
 *   plus a point-sample of the {@link ResourceMonitor} taken INSIDE acquire.
 *   Generalizes the tool-semaphore engine (`tool-semaphore.ts`).
 * - `off` — pure pass-through.
 *
 * `interactive-cli` is NEVER gated; `full-build` is pinned to one machine-wide
 * slot regardless of pressure.
 *
 * @task T11999
 * @epic T11992
 * @adr resource-governor-never-oom-architecture §3.4
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { availableParallelism, totalmem } from 'node:os';
import { join } from 'node:path';
import {
  type AdmissionResult,
  DEFAULT_RESOURCE_RETRY_AFTER_MS,
  type GovernorMode,
  type ResourceClass,
  type ResourceDeferral,
  type ResourceGrant,
} from '@cleocode/contracts';
import lockfile from 'proper-lockfile';
import { getLogger } from '../logger.js';
import { getCleoHome } from '../paths.js';
import type { ResourceSample } from './backend.js';
import { ResourceMonitor } from './monitor.js';

let _log: ReturnType<typeof getLogger> | null = null;
function log(): ReturnType<typeof getLogger> {
  if (_log === null) _log = getLogger('resource-governor');
  return _log;
}

// ---------------------------------------------------------------------------
// Mode resolution (mirrors writer-lease.ts:192)
// ---------------------------------------------------------------------------

let _cachedMode: GovernorMode | null = null;
let _supervisorDemotionLogged = false;

/**
 * Resolve the governor mode from `CLEO_RESOURCES_MODE`, once per process.
 * Unknown / unset values resolve to `'local'` — the production-safe default
 * while the supervisor daemon is disabled.
 *
 * @task T11999
 */
export function resolveGovernorMode(): GovernorMode {
  if (_cachedMode !== null) return _cachedMode;
  const raw = process.env.CLEO_RESOURCES_MODE;
  _cachedMode = raw === 'supervisor' || raw === 'local' || raw === 'off' ? raw : 'local';
  return _cachedMode;
}

/**
 * The mode actually used for arbitration. `supervisor` demotes to `local`
 * because the IPC client is not wired yet — a dead/absent arbiter must never
 * deadlock work. Logged once. Mirrors writer-lease `effectiveMode`.
 */
function effectiveMode(): Exclude<GovernorMode, 'supervisor'> {
  const mode = resolveGovernorMode();
  if (mode === 'supervisor') {
    if (!_supervisorDemotionLogged) {
      _supervisorDemotionLogged = true;
      log().info(
        'CLEO_RESOURCES_MODE=supervisor but no IPC client is wired; ' +
          'demoting to local-mode admission for the process lifetime.',
      );
    }
    return 'local';
  }
  return mode;
}

/**
 * Reset cached process-global state (mode + demotion flag). Tests only.
 * @internal
 */
export function _resetGovernorStateForTest(): void {
  _cachedMode = null;
  _supervisorDemotionLogged = false;
}

// ---------------------------------------------------------------------------
// Budget computation — f(totalRAM, MemAvailable, PSI)
// ---------------------------------------------------------------------------

/** Tunables for budget computation. All optional; sane defaults applied. */
export interface BudgetOptions {
  /** RAM reserved for the OS + interactive use, in MiB. Default 2048. */
  readonly headroomMb?: number;
  /** Estimated RAM per agent session (incl. ~300 MB MCP suite), MiB. Default 4096. */
  readonly agentEstRamMb?: number;
  /** `some avg10` (pp) at/above which test/build budgets halve. Default 10. */
  readonly holdSomeAvg10?: number;
  /** `some avg10` (pp) at/above which test/build budgets floor to 1. Default 25. */
  readonly floorSomeAvg10?: number;
  /** Override CPU count (tests). Default {@link availableParallelism}. */
  readonly cpuCount?: number;
  /** Override total RAM bytes (tests). Default {@link totalmem}. */
  readonly totalMemBytes?: number;
}

const MB = 1024 * 1024;

/** Extract `some avg10` (0–100) from a sample; 0 when unavailable. */
function someAvg10(sample: ResourceSample): number {
  const some = sample.globalPressure?.some ?? sample.slicePressure?.some;
  return some?.avg10 ?? 0;
}

/**
 * Compute the slot budget for a class given a point-sample.
 *
 * - `interactive-cli` → `Infinity` (never gated).
 * - `full-build` → `1` machine-wide, pressure-independent.
 * - `agent-session` → `clamp(1, ⌊(MemAvailable − headroom)/estRamMb⌋, cpus−2)`.
 * - `test-run` / `scoped-build` → `max(1, ⌊cpus/4⌋)`, ×0.5 when `some>hold`,
 *   floored to 1 when `some>floor`.
 * - `llm-call` → `max(1, cpus−2)` (primarily gated by the llm-queue elsewhere).
 * - `db-heavy` → `1`, deferred (→0) under `backoff`-level pressure.
 * - `background-autonomous` → `1` only when pressure is `ok`, else `0`.
 *
 * @adr resource-governor-never-oom-architecture §3.4 (budgets)
 */
export function computeClassBudget(
  cls: ResourceClass,
  sample: ResourceSample,
  opts: BudgetOptions = {},
): number {
  if (cls === 'interactive-cli') return Number.POSITIVE_INFINITY;

  const cpus = Math.max(1, opts.cpuCount ?? availableParallelism());
  const totalBytes = opts.totalMemBytes ?? totalmem();
  const headroomBytes = (opts.headroomMb ?? 2048) * MB;
  const hold = opts.holdSomeAvg10 ?? 10;
  const floor = opts.floorSomeAvg10 ?? 25;
  const some = someAvg10(sample);
  // MemAvailable can be null on non-Linux / read error — fall back to total.
  const availBytes = sample.memAvailableBytes ?? totalBytes;
  const fullStall = sample.globalPressure?.full?.avg10 ?? sample.slicePressure?.full?.avg10 ?? 0;
  const backoff = some > floor || fullStall > 10;

  switch (cls) {
    case 'full-build':
      return 1;
    case 'agent-session': {
      const estRamBytes = (opts.agentEstRamMb ?? 4096) * MB;
      const byMem = Math.floor((availBytes - headroomBytes) / estRamBytes);
      return clamp(1, byMem, Math.max(1, cpus - 2));
    }
    case 'llm-call':
      return Math.max(1, cpus - 2);
    case 'test-run':
    case 'scoped-build': {
      const base = Math.max(1, Math.floor(cpus / 4));
      if (some > floor) return 1;
      if (some > hold) return Math.max(1, Math.floor(base / 2));
      return base;
    }
    case 'db-heavy':
      return backoff ? 0 : 1;
    case 'background-autonomous':
      return some > hold || fullStall > 5 ? 0 : 1;
    default:
      return 1;
  }
}

function clamp(lo: number, v: number, hi: number): number {
  return Math.max(lo, Math.min(v, hi));
}

// ---------------------------------------------------------------------------
// Local-mode slot engine (generalizes tool-semaphore.ts)
// ---------------------------------------------------------------------------

/**
 * Machine-wide slot directory for a class, under
 * `getCleoHome()/locks/resource-<class>/`. Shared across projects, worktrees,
 * and PIDs — exactly like the tool semaphore.
 */
export function governorSlotDir(cls: ResourceClass): string {
  return join(getCleoHome(), 'locks', `resource-${cls}`);
}

function ensureSlotFiles(dir: string, count: number): string[] {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const paths: string[] = [];
  for (let i = 0; i < count; i++) {
    const p = join(dir, `slot-${i}.lock`);
    if (!existsSync(p)) writeFileSync(p, '', { flag: 'a' });
    paths.push(p);
  }
  return paths;
}

const STALE_MS = 600_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function passThroughGrant(cls: ResourceClass): ResourceGrant {
  return {
    deferred: false,
    class: cls,
    slot: -1,
    acquiredAtMs: Date.now(),
    release: async () => {},
  };
}

function deferral(cls: ResourceClass, reason: string, retryAfterMs: number): ResourceDeferral {
  return { deferred: true, class: cls, retryAfterMs, reason };
}

/** Options for {@link ResourceGovernor.acquire}. */
export interface AcquireOptions extends BudgetOptions {
  /**
   * When `false`, a single non-blocking pass — returns a {@link ResourceDeferral}
   * immediately if no slot is free (admission semantics; spawn/wave clamp).
   * When `true` (default), polls until a slot frees or `timeoutMs` elapses
   * (queue semantics; heavy ops). On timeout, returns a deferral.
   */
  readonly blocking?: boolean;
  /** Max wall-clock to wait in blocking mode (ms). Default 3_600_000. */
  readonly timeoutMs?: number;
  /** Poll interval in blocking mode (ms). Default 200. */
  readonly pollMs?: number;
  /**
   * Inject a pre-taken sample (tests, or to avoid re-sampling). When omitted,
   * a fresh point-sample is taken inside acquire.
   */
  readonly sample?: ResourceSample;
  /** Inject a monitor (tests). Default a fresh {@link ResourceMonitor}. */
  readonly monitor?: ResourceMonitor;
}

/**
 * The Never-OOM admission gate. Stateless wrapper over the mode-resolved
 * backend (local slot dirs today; supervisor IPC when wired). Construct once
 * and share, or use the module-level {@link governor} singleton.
 */
export class ResourceGovernor {
  /**
   * Acquire one slot of `cls`. Returns a {@link ResourceGrant} on success or a
   * {@link ResourceDeferral} on denial. Never throws for admission control;
   * only genuinely unexpected I/O errors propagate.
   */
  async acquire(cls: ResourceClass, opts: AcquireOptions = {}): Promise<AdmissionResult> {
    // Ungated fast paths: off mode + interactive-cli are pure pass-through.
    if (effectiveMode() === 'off' || cls === 'interactive-cli') {
      return passThroughGrant(cls);
    }

    const sample = opts.sample ?? (await (opts.monitor ?? new ResourceMonitor()).sample());
    const budget = computeClassBudget(cls, sample, opts);

    if (!Number.isFinite(budget)) return passThroughGrant(cls);
    if (budget <= 0) {
      return deferral(
        cls,
        `class '${cls}' budget is 0 under current pressure (some avg10=${someAvg10(sample).toFixed(1)})`,
        DEFAULT_RESOURCE_RETRY_AFTER_MS,
      );
    }

    const dir = governorSlotDir(cls);
    const slots = ensureSlotFiles(dir, budget);
    const blocking = opts.blocking ?? true;
    const timeoutMs = opts.timeoutMs ?? 3_600_000;
    const pollMs = opts.pollMs ?? 200;
    const startedAt = Date.now();

    do {
      // Re-shuffle each pass so concurrent acquirers don't collide on slot 0.
      const order = shuffledIndices(slots.length);
      for (const idx of order) {
        const path = slots[idx];
        if (!path) continue;
        try {
          const release = await lockfile.lock(path, {
            retries: 0,
            stale: STALE_MS,
            realpath: false,
          });
          let released = false;
          return {
            deferred: false,
            class: cls,
            slot: idx,
            acquiredAtMs: Date.now(),
            release: async () => {
              if (released) return;
              released = true;
              try {
                await release();
              } catch {
                // Already released (e.g. stale recovery) — post-condition holds.
              }
            },
          };
        } catch {
          // slot busy — try next
        }
      }
      if (!blocking) break;
      await sleep(pollMs);
    } while (Date.now() - startedAt < timeoutMs);

    return deferral(
      cls,
      `class '${cls}' is at capacity (${budget} slot(s)); ` +
        (blocking ? `timed out after ${timeoutMs}ms` : 'no slot free'),
      Math.min(pollMs * 4, DEFAULT_RESOURCE_RETRY_AFTER_MS),
    );
  }

  /** Non-blocking single-pass acquire (admission semantics). */
  async tryAcquire(cls: ResourceClass, opts: AcquireOptions = {}): Promise<AdmissionResult> {
    return this.acquire(cls, { ...opts, blocking: false });
  }

  /**
   * Currently-grantable slot count for `cls` = budget − held. Held is the count
   * of slot files currently locked. `Infinity` for ungated classes.
   */
  async available(cls: ResourceClass, opts: AcquireOptions = {}): Promise<number> {
    if (effectiveMode() === 'off' || cls === 'interactive-cli') return Number.POSITIVE_INFINITY;
    const sample = opts.sample ?? (await (opts.monitor ?? new ResourceMonitor()).sample());
    const budget = computeClassBudget(cls, sample, opts);
    if (!Number.isFinite(budget)) return Number.POSITIVE_INFINITY;
    if (budget <= 0) return 0;
    const held = await countHeldSlots(cls, budget);
    return Math.max(0, budget - held);
  }
}

function shuffledIndices(n: number): number[] {
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = order[i];
    const b = order[j];
    if (a !== undefined && b !== undefined) {
      order[i] = b;
      order[j] = a;
    }
  }
  return order;
}

/**
 * Count how many of `budget` slots are currently held, by probing each with a
 * non-blocking lock. A successful probe-lock is released immediately — it never
 * holds the slot, so it cannot starve a real acquirer.
 */
async function countHeldSlots(cls: ResourceClass, budget: number): Promise<number> {
  const dir = governorSlotDir(cls);
  if (!existsSync(dir)) return 0;
  const slots = ensureSlotFiles(dir, budget);
  let held = 0;
  for (const path of slots) {
    try {
      const release = await lockfile.lock(path, { retries: 0, stale: STALE_MS, realpath: false });
      await release();
    } catch {
      held++;
    }
  }
  return held;
}

/** Count of slot files for a class (debug/introspection). */
export function slotFileCount(cls: ResourceClass): number {
  const dir = governorSlotDir(cls);
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => f.startsWith('slot-') && f.endsWith('.lock')).length;
}

/** Process-wide governor singleton. */
export const governor = new ResourceGovernor();
