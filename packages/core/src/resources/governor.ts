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
 * A local slot whose holder process is provably gone is reaped at once instead
 * of waiting out the 10 min stale timeout (T12963), as the tool semaphore does
 * for its slots (gh#1222).
 *
 * @task T11999
 * @task T12963
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
import { getLogger } from '../logger.js';
import { getCleoHome } from '../paths.js';
import type { ResourceSample } from './backend.js';
import { pressureScore, ResourceMonitor } from './monitor.js';
import { parentRunJob } from './run-admission.js';
import { _resetSlotHolderStateForTest, describeSlotHolders, lockSlot } from './slot-holder.js';
import {
  resolveSupervisorSocketPath,
  sendResourceAdmit,
  sendResourceRelease,
} from './supervisor-admit.js';

let _log: ReturnType<typeof getLogger> | null = null;
function log(): ReturnType<typeof getLogger> {
  if (_log === null) _log = getLogger('resource-governor');
  return _log;
}

// ---------------------------------------------------------------------------
// Mode resolution (mirrors writer-lease.ts:192)
// ---------------------------------------------------------------------------

let _cachedMode: GovernorMode | null = null;
let _supervisorDegradeLogged = false;

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
 * Log (once) that `supervisor` mode degraded to the local slot engine because
 * the arbiter was unreachable — a dead/absent supervisor must never deadlock
 * work (T12001). Mirrors the writer-lease degrade-once behaviour.
 */
function logSupervisorDegradeOnce(reason: string): void {
  if (_supervisorDegradeLogged) return;
  _supervisorDegradeLogged = true;
  log().info(
    `CLEO_RESOURCES_MODE=supervisor but the arbiter is unreachable (${reason}); ` +
      'degrading to local-mode admission for the process lifetime.',
  );
}

/**
 * Reset cached process-global state (mode + degrade flag). Tests only.
 * @internal
 */
export function _resetGovernorStateForTest(): void {
  _cachedMode = null;
  _supervisorDegradeLogged = false;
  _resetSlotHolderStateForTest();
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
  /**
   * Estimated worst-case RAM for ONE `test-run` / `scoped-build`, in MiB.
   * Default 24576 (24 GiB) — a full `pnpm run test` is permitted 6 vitest forks
   * × a 4 GiB heap cap by `vitest.memory-safe.ts`, and the governor has to
   * admit against what a run may actually hold, not what it usually holds.
   *
   * @task T12091
   */
  readonly testRunEstRamMb?: number;
  /** `some avg10` (pp) at/above which test/build budgets halve. Default 10. */
  readonly holdSomeAvg10?: number;
  /** `some avg10` (pp) at/above which test/build budgets floor to 1. Default 25. */
  readonly floorSomeAvg10?: number;
  /** Override CPU count (tests). Default {@link availableParallelism}. */
  readonly cpuCount?: number;
  /** Override total RAM bytes (tests). Default {@link totalmem}. */
  readonly totalMemBytes?: number;
  /**
   * Budget on MEMORY pressure alone, ignoring the CPU signal (T13119, T13150).
   *
   * For work that must not be deferred merely because the machine is busy: a
   * required migration of the store being opened, whose deferral leaves the
   * command reading an empty store. CPU saturation slows such work; it cannot
   * exhaust memory, which is what the governor exists to prevent. On macOS
   * the CPU signal is derived from the load average (T12981), so any machine
   * whose load exceeds twice its effective cores (a CI runner under vitest, a
   * Mac running agents) read as `backoff` and deferred it.
   */
  readonly ignoreCpuPressure?: boolean;
}

const MB = 1024 * 1024;

/** Extract `some avg10` (0–100) from a sample; 0 when unavailable. */
function someAvg10(sample: ResourceSample): number {
  // T12981: memory or CPU, whichever is worse (CPU rescaled to this scale).
  return pressureScore(sample);
}

/** Memory `some avg10` (0–100) alone; 0 when unavailable. */
function memorySomeAvg10(sample: ResourceSample): number {
  return (sample.globalPressure?.some ?? sample.slicePressure?.some)?.avg10 ?? 0;
}

/**
 * Compute the slot budget for a class given a point-sample.
 *
 * - `interactive-cli` → `Infinity` (never gated).
 * - `full-build` → `1` machine-wide, pressure-independent.
 * - `agent-session` → `clamp(1, ⌊(MemAvailable − headroom)/estRamMb⌋, cpus−2)`.
 * - `test-run` / `scoped-build` → `clamp(1, ⌊(MemAvailable − headroom)/estRamMb⌋,
 *   ⌊cpus/4⌋)`, ×0.5 when `some>hold`, floored to 1 when `some>floor` (T12091:
 *   was core-only, which authorised 144 GiB of heap on a 62 GiB box).
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
  const some = opts.ignoreCpuPressure === true ? memorySomeAvg10(sample) : someAvg10(sample);
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
      // T12091: this was core-only — `max(1, ⌊cpus/4⌋)` — which on a 24-core
      // box admitted 6 concurrent runs. Each run is itself allowed 6 vitest
      // forks × 4 GiB, so the governor was authorising 144 GiB of heap on a
      // 62 GiB machine and the box froze without any single bound being
      // violated. What limits a test run is MEMORY; cores say nothing about it.
      // Mirrors the `agent-session` shape, which had this right all along.
      const estRamBytes = (opts.testRunEstRamMb ?? 24576) * MB;
      const byMem = Math.floor((availBytes - headroomBytes) / estRamBytes);
      const base = clamp(1, byMem, Math.max(1, Math.floor(cpus / 4)));
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

// The slot timing constants live with the slot locks (T12963); re-exported
// for existing importers.
export { SLOT_LOCK_STALE_MS, SLOT_LOCK_UPDATE_MS } from './slot-holder.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** An ungated grant (no slot held, `slot: -1`): `off` mode, `interactive-cli`, a nested run, fail-open. */
export function passThroughGrant(cls: ResourceClass): ResourceGrant {
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

/** Filesystem errors meaning the governor's state can't be written here. */
const GOVERNOR_IO_CODES = new Set([
  'EACCES',
  'EPERM',
  'EROFS',
  'ENOSPC',
  'EDQUOT',
  'ENOTDIR',
  'ELOOP',
]);

/** Why the governor could not keep its state: the errno code and the path, when known. */
export interface GovernorIoError {
  readonly code: string;
  readonly path: string | null;
}

/**
 * The code and path of an error that means "the governor cannot keep state here" (a sandbox that
 * blocks writes to the CLEO home, a read-only or full disk, a broken CLEO home), or null for any
 * other error, which is a bug and must not be hidden.
 */
export function governorIoError(err: unknown): GovernorIoError | null {
  const e = err as NodeJS.ErrnoException | null;
  if (!e || typeof e !== 'object' || typeof e.code !== 'string') return null;
  if (!GOVERNOR_IO_CODES.has(e.code)) return null;
  return { code: e.code, path: typeof e.path === 'string' ? e.path : null };
}

/**
 * Run an admission, failing OPEN when the governor cannot write its state
 * ({@link governorIoError}): the work proceeds ungated with a
 * {@link passThroughGrant}, and `ungoverned` says why. A sandboxed or
 * read-only CLEO home must never turn into a deferral that never clears.
 * Any other error is a bug and propagates.
 *
 * @example
 * ```ts
 * const { admission, ungoverned } = await admitFailOpen('agent-session', () =>
 *   governor.tryAcquire('agent-session'),
 * );
 * ```
 */
export async function admitFailOpen(
  cls: ResourceClass,
  acquire: () => Promise<AdmissionResult>,
): Promise<{ readonly admission: AdmissionResult; readonly ungoverned: GovernorIoError | null }> {
  try {
    return { admission: await acquire(), ungoverned: null };
  } catch (err) {
    const io = governorIoError(err);
    if (io === null) throw err;
    return { admission: passThroughGrant(cls), ungoverned: io };
  }
}

let _supervisorHolderSeq = 0;

/**
 * A process-unique holder id for a supervisor `resource_admit`, so each acquire
 * is a distinct slot (matched 1:1 by its `release`). `pid` scopes the holder to
 * this process; the sequence distinguishes concurrent holds of the same class.
 */
function supervisorHolderId(cls: ResourceClass): string {
  _supervisorHolderSeq += 1;
  return `${process.pid}:${cls}:${_supervisorHolderSeq}`;
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
   *
   * Only a held lock (`ELOCKED`) counts as a busy slot. Any other lock error
   * (EACCES from a sandbox that can't write the slot dir, EROFS, ENOSPC…) is
   * thrown once a pass found no free slot, never read as "busy": a slot that
   * can never be taken would otherwise defer every caller until it times out
   * (#1777 round 8, R8-1). Callers fail open with {@link admitFailOpen}.
   */
  async acquire(cls: ResourceClass, opts: AcquireOptions = {}): Promise<AdmissionResult> {
    // Ungated fast paths: off mode + interactive-cli are pure pass-through.
    const mode = resolveGovernorMode();
    if (mode === 'off' || cls === 'interactive-cli') {
      return passThroughGrant(cls);
    }
    // Inside a running `cleo run` job (e.g. `cleo run -- cleo verify`), the
    // job's slot already covers this process tree: waiting for another slot
    // of a budget-1 class would wait on ourselves (#1777 round 3, M-2). The
    // env var only says "look"; parentRunJob's group + start-time check is
    // what decides, so setting it by hand grants nothing.
    // Only a parent holding THIS class covers it (#1777 round 4, MED-1).
    if (process.env.CLEO_RUN_CLASS !== undefined && parentRunJob({ pid: process.pid, cls })) {
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

    // Supervisor mode (T12001): route the count enforcement through the central
    // Rust arbiter so heavy ops are bounded machine-wide. The client computes the
    // budget (above) from its local pressure sample; the supervisor enforces the
    // in-flight COUNT. An unreachable supervisor degrades to the local slot
    // engine below — never a deadlock.
    if (mode === 'supervisor') {
      const viaSupervisor = await this.acquireViaSupervisor(cls, Math.floor(budget));
      if (viaSupervisor !== null) return viaSupervisor;
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
      let lockError: { readonly err: unknown } | null = null;
      for (const idx of order) {
        const path = slots[idx];
        if (!path) continue;
        try {
          // T12963: a busy slot whose holder is provably dead is reaped here.
          const release = await lockSlot(path, cls);
          if (release) {
            return { deferred: false, class: cls, slot: idx, acquiredAtMs: Date.now(), release };
          }
        } catch (err) {
          // Anything but a held lock is not "busy" (#1777 round 8, R8-1).
          lockError ??= { err };
        }
      }
      if (lockError !== null) throw lockError.err;
      if (!blocking) break;
      await sleep(pollMs);
    } while (Date.now() - startedAt < timeoutMs);

    return deferral(
      cls,
      `class '${cls}' is at capacity (${budget} slot(s)); ` +
        (blocking ? `timed out after ${timeoutMs}ms` : 'no slot free') +
        describeSlotHolders(slots),
      Math.min(pollMs * 4, DEFAULT_RESOURCE_RETRY_AFTER_MS),
    );
  }

  /**
   * Route an admission through the supervisor's central `resource_admit` verb.
   * Returns a grant (whose `release` calls `resource_release`) or a deferral, or
   * `null` when the supervisor is unreachable so the caller degrades to the
   * local slot engine. Never throws — a dead arbiter never deadlocks work.
   *
   * @task T12001
   */
  private async acquireViaSupervisor(
    cls: ResourceClass,
    budget: number,
  ): Promise<AdmissionResult | null> {
    const socketPath = resolveSupervisorSocketPath();
    const holderId = supervisorHolderId(cls);
    const reply = await sendResourceAdmit(socketPath, cls, holderId, budget);
    if ('unavailable' in reply) {
      logSupervisorDegradeOnce(reply.reason);
      return null;
    }
    if (reply.disposition === 'deferred') {
      return deferral(
        cls,
        `class '${cls}' deferred by supervisor (budget ${budget})`,
        reply.retry_after_ms || DEFAULT_RESOURCE_RETRY_AFTER_MS,
      );
    }
    let released = false;
    return {
      deferred: false,
      class: cls,
      slot: 0,
      acquiredAtMs: Date.now(),
      release: async () => {
        if (released) return;
        released = true;
        await sendResourceRelease(socketPath, cls, holderId).catch(() => {
          // Best-effort: the arbiter reclaims the slot on process death anyway.
        });
      },
    };
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
    if (resolveGovernorMode() === 'off' || cls === 'interactive-cli') {
      return Number.POSITIVE_INFINITY;
    }
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
 * holds the slot, so it cannot starve a real acquirer. A slot held by a dead
 * process is reaped, not counted (T12963).
 */
async function countHeldSlots(cls: ResourceClass, budget: number): Promise<number> {
  const dir = governorSlotDir(cls);
  if (!existsSync(dir)) return 0;
  const slots = ensureSlotFiles(dir, budget);
  let held = 0;
  for (const path of slots) {
    try {
      const release = await lockSlot(path, cls);
      if (release) await release();
      else held++;
    } catch {
      // Only a held lock is a holder; an unwritable slot dir is not (R8-1).
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
