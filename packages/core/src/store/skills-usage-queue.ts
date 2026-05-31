/**
 * Skills-usage write batching queue — keeps skill-load latency near zero.
 *
 * The {@link recordSkillUsage} recorder (T9689) is on the hot path of every
 * skill discovery. Even though its DB write is detached via `void`, a burst
 * of 100+ skill loads (e.g. orchestrator startup walking ~/.cleo/skills/)
 * would still trigger 100+ independent SQLite transactions. This queue
 * coalesces them into a single batched INSERT.
 *
 * ## Design
 *
 * - Bounded ring buffer (default 256 entries).
 * - Auto-flush triggers:
 *   1. 250 ms idle (debounce: every enqueue resets the timer).
 *   2. Queue full — flush immediately when entry 257 would overflow.
 *   3. `process.beforeExit` — installed exactly once at first enqueue.
 * - `flushSkillsUsage()` exposed for explicit shutdown / tests.
 * - `drainSkillsUsageQueue()` test-only seam — synchronously empties
 *   without writing.
 *
 * The queue does NOT replace {@link insertUsage}. Direct callers (Hermes
 * import, tests, the future auto-improve patch path) keep using the
 * synchronous insert API. ONLY the loader hook (T9689) routes through
 * the queue, because that's the hot path where batching pays off.
 *
 * @task T9694
 * @epic T9561
 * @saga T9560
 * @architecture docs/architecture/SG-CLEO-SKILLS-architecture-v3.md §5
 */

import {
  type NewSkillUsageRow,
  type SkillUsageRow,
  skillUsage as skillUsageTable,
} from './schema/skills-schema.js';
import { openSkillsDb } from './skills-db.js';

// ---------------------------------------------------------------------------
// Configuration constants
// ---------------------------------------------------------------------------

/** Default ring-buffer capacity. Overridable via {@link SkillsUsageQueue} ctor. */
export const SKILLS_USAGE_QUEUE_DEFAULT_CAPACITY = 256;

/** Default idle-flush window in milliseconds. */
export const SKILLS_USAGE_QUEUE_DEFAULT_IDLE_MS = 250;

// ---------------------------------------------------------------------------
// Queue class
// ---------------------------------------------------------------------------

/**
 * Options accepted by the {@link SkillsUsageQueue} constructor.
 */
export interface SkillsUsageQueueOptions {
  /** Ring-buffer capacity — when reached, the queue flushes immediately. */
  readonly capacity?: number;
  /** Idle-flush window in milliseconds — `0` disables debounced flush. */
  readonly idleMs?: number;
  /** Disable the `process.beforeExit` auto-flush hook (test-only). */
  readonly disableBeforeExitHook?: boolean;
}

/**
 * In-memory batched writer in front of `skill_usage`.
 *
 * Use the module-level singleton via {@link enqueueSkillUsage} /
 * {@link flushSkillsUsage} in production code. The class is exported so
 * tests can construct isolated instances pointing at tmp DBs.
 *
 * @task T9694
 */
export class SkillsUsageQueue {
  private readonly capacity: number;
  private readonly idleMs: number;
  private readonly disableBeforeExitHook: boolean;
  private buffer: NewSkillUsageRow[] = [];
  private timer: NodeJS.Timeout | null = null;
  private beforeExitInstalled = false;
  private flushing: Promise<void> | null = null;

  constructor(options?: SkillsUsageQueueOptions) {
    this.capacity = options?.capacity ?? SKILLS_USAGE_QUEUE_DEFAULT_CAPACITY;
    this.idleMs = options?.idleMs ?? SKILLS_USAGE_QUEUE_DEFAULT_IDLE_MS;
    this.disableBeforeExitHook = options?.disableBeforeExitHook ?? false;
  }

  /**
   * Append a row. Triggers an immediate flush if capacity is reached,
   * otherwise (re-)arms the idle-flush timer.
   *
   * @param row - Telemetry payload to persist.
   */
  enqueue(row: NewSkillUsageRow): void {
    this.installBeforeExitHookOnce();
    this.buffer.push(row);

    if (this.buffer.length >= this.capacity) {
      // Synchronous capacity-trigger — fire-and-forget the flush.
      void this.flush().catch(() => {
        /* swallowed — best-effort, matches recorder contract */
      });
      return;
    }

    // (Re-)arm the idle-flush debounce.
    if (this.idleMs > 0) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush().catch(() => {
          /* swallowed */
        });
      }, this.idleMs);
      // Don't keep the event loop alive purely for telemetry.
      if (typeof this.timer.unref === 'function') this.timer.unref();
    }
  }

  /**
   * Flush all buffered rows in a single batched INSERT.
   *
   * Safe to call concurrently — overlapping callers share the same in-flight
   * promise so the batch is written exactly once.
   *
   * @returns Resolves when the buffered rows are persisted (or swallowed if
   *   the DB is unreachable).
   */
  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.buffer.length === 0) return;

    // Snapshot + clear so concurrent enqueues land in the next batch.
    const batch = this.buffer;
    this.buffer = [];
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    this.flushing = (async () => {
      try {
        const db = await openSkillsDb();
        // Drizzle accepts an array of rows for batched insert.
        db.insert(skillUsageTable).values(batch).run();
      } catch {
        // Swallow — best-effort. We INTENTIONALLY do not requeue the batch
        // because skill-load telemetry is sampling-grade, not auditing-grade.
      }
    })();

    try {
      await this.flushing;
    } finally {
      this.flushing = null;
    }
  }

  /**
   * Synchronously discard buffered rows without writing — test-only seam.
   *
   * Production code MUST NOT call this. Used by tests that want to assert
   * "no DB row until flush" without polluting the next test's state.
   */
  drain(): NewSkillUsageRow[] {
    const snapshot = this.buffer;
    this.buffer = [];
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return snapshot;
  }

  /** Returns the current buffer length — visible for assertions. */
  get size(): number {
    return this.buffer.length;
  }

  // -------------------------------------------------------------------------
  // process.beforeExit installer (idempotent)
  // -------------------------------------------------------------------------

  private installBeforeExitHookOnce(): void {
    if (this.beforeExitInstalled) return;
    if (this.disableBeforeExitHook) return;
    this.beforeExitInstalled = true;
    process.once('beforeExit', () => {
      // Best-effort — the event loop is winding down so we await directly.
      void this.flush().catch(() => {
        /* swallowed */
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

let _singleton: SkillsUsageQueue | null = null;

/**
 * Return the process-wide singleton queue, creating it on first use.
 *
 * Tests that need isolated state should construct their own {@link SkillsUsageQueue}
 * with `disableBeforeExitHook: true` to avoid leaking listeners across cases.
 */
export function getSkillsUsageQueue(): SkillsUsageQueue {
  if (!_singleton) {
    _singleton = new SkillsUsageQueue();
  }
  return _singleton;
}

/**
 * Replace the module-level singleton — used by tests to inject an isolated
 * queue (pointed at a tmp DB) WITHOUT touching the user-global one.
 *
 * Pass `null` to reset back to lazy default-construction on next call.
 *
 * @internal
 */
export function __setSkillsUsageQueueSingleton(q: SkillsUsageQueue | null): void {
  _singleton = q;
}

/**
 * Enqueue a single usage row via the singleton queue.
 *
 * @param row - Telemetry payload.
 *
 * @task T9694
 */
export function enqueueSkillUsage(row: NewSkillUsageRow): void {
  getSkillsUsageQueue().enqueue(row);
}

/**
 * Flush the singleton queue. Returns when the in-flight batch is persisted.
 *
 * @task T9694
 */
export async function flushSkillsUsage(): Promise<void> {
  await getSkillsUsageQueue().flush();
}

// ---------------------------------------------------------------------------
// Re-exports for downstream typing
// ---------------------------------------------------------------------------

export type { NewSkillUsageRow, SkillUsageRow };
