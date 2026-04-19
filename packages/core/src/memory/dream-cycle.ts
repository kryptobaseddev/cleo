/**
 * Auto-Dream Cycle — autonomous BRAIN consolidation with STDP plasticity.
 *
 * Implements three trigger tiers for autonomous `runConsolidation` dispatch:
 *
 *   Tier 1 — Volume threshold (primary):
 *     When `brain_observations` delta since last consolidation exceeds
 *     VOLUME_THRESHOLD_DEFAULT (10), trigger immediately.
 *
 *   Tier 2 — Idle detection (secondary):
 *     When `brain_retrieval_log` shows no activity for IDLE_MINUTES_DEFAULT (30)
 *     minutes, trigger consolidation in the background.
 *
 *   Tier 3 — Nightly cron (tertiary):
 *     A setInterval-based scheduler fires once per day at off-peak hours.
 *     Activated explicitly via `startDreamScheduler`. Disabled by default.
 *
 * Each trigger calls `runConsolidation(projectRoot, sessionId, 'scheduled')`
 * which includes Steps 9a (R-STDP reward backfill) + 9b (STDP plasticity) +
 * 9c (homeostatic decay) per docs/specs/stdp-wire-up-spec.md §4.
 *
 * Idempotency: `checkAndDream` tracks `lastDreamAt` in-process so that
 * repeated calls within the same process cannot double-trigger consolidation.
 * The `brain_consolidation_events` table provides cross-process idempotency
 * via the cooldown window check.
 *
 * @task T628
 * @epic T627
 * @see docs/specs/stdp-wire-up-spec.md §4.5
 */

import { getBrainDb, getBrainNativeDb } from '../store/memory-sqlite.js';

// ============================================================================
// Constants (Phase 5 hardcoded defaults; config-based tuning is Phase 6+)
// ============================================================================

/** Minimum new `brain_observations` since last consolidation to trigger volume tier. */
const VOLUME_THRESHOLD_DEFAULT = 10;

/** Minutes of no `brain_retrieval_log` activity to trigger idle tier. */
const IDLE_MINUTES_DEFAULT = 30;

/** Minimum ms between two autonomous dream cycles (cooldown guard). */
const DREAM_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

/** Nightly cron fire hour (0–23, local time). */
const NIGHTLY_HOUR_DEFAULT = 4;

// ============================================================================
// Module-level state (in-process idempotency)
// ============================================================================

/** Timestamp of the last dream cycle triggered in this process. */
let lastDreamAt: number = 0;

/** Whether a dream cycle is currently in flight (prevents overlapping runs). */
let dreamInFlight: boolean = false;

/** Reference to the nightly cron timer (if started). */
let nightlyTimer: ReturnType<typeof setInterval> | null = null;

// ============================================================================
// Result types
// ============================================================================

/** Result of a `checkAndDream` evaluation. */
export interface DreamCheckResult {
  /** Whether consolidation was triggered. */
  triggered: boolean;
  /** Which tier fired (or null if no trigger). */
  tier: 'volume' | 'idle' | 'cron' | 'manual' | null;
  /** Reason consolidation was skipped (if not triggered). */
  skippedReason?: string;
  /** New observations since last consolidation (volume trigger input). */
  newObservationCount?: number;
  /** Minutes since last retrieval activity (idle trigger input). */
  idleMinutes?: number;
}

/** Options accepted by `checkAndDream`. */
export interface DreamCycleOptions {
  /** Minimum new observations to trigger volume tier. Default: 10. */
  volumeThreshold?: number;
  /** Minutes of retrieval inactivity to trigger idle tier. Default: 30. */
  idleThresholdMinutes?: number;
  /** Session ID forwarded to runConsolidation (for Step 9a). */
  sessionId?: string | null;
  /**
   * Whether to run inline (await) vs fire-and-forget (setImmediate).
   * Default: false (fire-and-forget).
   */
  inline?: boolean;
}

// ============================================================================
// Core helpers
// ============================================================================

/**
 * Count `brain_observations` created after `afterTimestamp`.
 * Returns 0 when the table does not exist or the DB is unavailable.
 *
 * @param afterTimestamp - ISO 8601 timestamp string (SQLite datetime format)
 */
function countNewObservations(afterTimestamp: string): number {
  const db = getBrainNativeDb();
  if (!db) return 0;
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM brain_observations
         WHERE created_at > ? AND invalid_at IS NULL`,
      )
      .get(afterTimestamp) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Return the ISO timestamp of the most recent `brain_consolidation_events` row,
 * or null when no consolidation has ever run.
 */
function getLastConsolidationTimestamp(): string | null {
  const db = getBrainNativeDb();
  if (!db) return null;
  try {
    const row = db
      .prepare(
        `SELECT started_at FROM brain_consolidation_events
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get() as { started_at: string } | undefined;
    return row?.started_at ?? null;
  } catch {
    return null;
  }
}

/**
 * Return the ISO timestamp of the most recent `brain_retrieval_log` row,
 * or null when no retrievals have ever been recorded.
 */
function getLastRetrievalTimestamp(): string | null {
  const db = getBrainNativeDb();
  if (!db) return null;
  try {
    const row = db
      .prepare(`SELECT created_at FROM brain_retrieval_log ORDER BY created_at DESC LIMIT 1`)
      .get() as { created_at: string } | undefined;
    return row?.created_at ?? null;
  } catch {
    return null;
  }
}

/**
 * Compute minutes elapsed since `isoTimestamp`.
 * Returns Infinity when the timestamp is null.
 *
 * SQLite `datetime('now')` returns UTC in `"YYYY-MM-DD HH:MM:SS"` format
 * without a timezone suffix. To prevent JavaScript from misinterpreting
 * the string as local time, we normalise it to ISO 8601 UTC by replacing
 * the space separator with `T` and appending `Z`.
 *
 * @param isoTimestamp - ISO 8601 or SQLite datetime string (UTC), or null
 */
function minutesSince(isoTimestamp: string | null): number {
  if (!isoTimestamp) return Infinity;
  // Normalise SQLite "YYYY-MM-DD HH:MM:SS" → "YYYY-MM-DDTHH:MM:SSZ"
  const normalised = isoTimestamp.includes('T')
    ? isoTimestamp
    : isoTimestamp.replace(' ', 'T') + 'Z';
  const ms = Date.now() - new Date(normalised).getTime();
  return ms / 60_000;
}

// ============================================================================
// Trigger tier checks (exported for testing)
// ============================================================================

/**
 * Volume trigger: return true when new observation count since last
 * consolidation exceeds `threshold`.
 *
 * @param threshold - Minimum new observations required to trigger.
 * @returns Object with the decision and the raw observation count.
 */
export function checkVolumeTrigger(threshold: number): {
  shouldTrigger: boolean;
  newObservationCount: number;
} {
  const lastConsolidated = getLastConsolidationTimestamp();
  // If no consolidation ever ran, use epoch so all observations count.
  const after = lastConsolidated ?? '1970-01-01 00:00:00';
  const newObservationCount = countNewObservations(after);
  return {
    shouldTrigger: newObservationCount >= threshold,
    newObservationCount,
  };
}

/**
 * Idle trigger: return true when retrieval activity HAS occurred before
 * and no new activity has been seen for at least `idleThresholdMinutes`.
 *
 * When no retrievals have ever been recorded (null timestamp), the idle
 * trigger does NOT fire — the system is newly initialised, not idle.
 *
 * @param idleThresholdMinutes - Required idle window in minutes.
 * @returns Object with the decision and elapsed idle minutes.
 */
export function checkIdleTrigger(idleThresholdMinutes: number): {
  shouldTrigger: boolean;
  idleMinutes: number;
} {
  const lastRetrievalTs = getLastRetrievalTimestamp();
  // If no retrievals ever recorded, system is new — not idle.
  if (lastRetrievalTs === null) {
    return { shouldTrigger: false, idleMinutes: 0 };
  }
  const idleMinutes = minutesSince(lastRetrievalTs);
  return {
    shouldTrigger: idleMinutes >= idleThresholdMinutes,
    idleMinutes,
  };
}

// ============================================================================
// Dream dispatch
// ============================================================================

/**
 * Dispatch a dream cycle — calls `runConsolidation` with `trigger='scheduled'`.
 *
 * Private helper. External callers use `checkAndDream` or `triggerManualDream`.
 *
 * @param projectRoot - Project root for brain.db resolution.
 * @param sessionId - Active session ID (for Step 9a reward backfill).
 * @param inline - If true, await inline; else fire via setImmediate.
 */
async function dispatchDream(
  projectRoot: string,
  sessionId?: string | null,
  inline = false,
): Promise<void> {
  if (dreamInFlight) return;
  dreamInFlight = true;
  lastDreamAt = Date.now();

  const run = async (): Promise<void> => {
    try {
      const { runConsolidation } = await import('./brain-lifecycle.js');
      await runConsolidation(projectRoot, sessionId ?? null, 'scheduled');
    } catch (err) {
      console.warn('[dream-cycle] Consolidation failed:', err);
    } finally {
      dreamInFlight = false;
    }
  };

  if (inline) {
    await run();
  } else {
    setImmediate(run);
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Evaluate all three trigger tiers and fire the dream cycle when any triggers.
 *
 * Tier evaluation order: volume → idle → (cron is timer-based, not checked here).
 *
 * Idempotency guards:
 * - `dreamInFlight` prevents overlapping concurrent runs.
 * - `DREAM_COOLDOWN_MS` (5 min) prevents repeated triggers in a tight loop.
 *
 * @param projectRoot - Project root for brain.db resolution.
 * @param opts - Optional tuning parameters.
 * @returns Check result indicating whether and why consolidation was triggered.
 *
 * @task T628
 */
export async function checkAndDream(
  projectRoot: string,
  opts: DreamCycleOptions = {},
): Promise<DreamCheckResult> {
  const volumeThreshold = opts.volumeThreshold ?? VOLUME_THRESHOLD_DEFAULT;
  const idleThresholdMinutes = opts.idleThresholdMinutes ?? IDLE_MINUTES_DEFAULT;

  // Ensure brain.db is open before calling synchronous trigger helpers.
  // getBrainDb is idempotent — safe to call when DB is already open.
  try {
    await getBrainDb(projectRoot);
  } catch {
    // If we can't open the DB, triggers can't fire — return skipped
    return {
      triggered: false,
      tier: null,
      skippedReason: 'brain.db unavailable',
    };
  }

  // Cooldown guard — prevent repeated triggers within DREAM_COOLDOWN_MS
  const msSinceLastDream = Date.now() - lastDreamAt;
  if (msSinceLastDream < DREAM_COOLDOWN_MS) {
    return {
      triggered: false,
      tier: null,
      skippedReason: `dream cooldown active (${Math.round(msSinceLastDream / 1000)}s since last dream)`,
    };
  }

  // Concurrent-run guard
  if (dreamInFlight) {
    return {
      triggered: false,
      tier: null,
      skippedReason: 'dream already in flight',
    };
  }

  // Tier 1: Volume threshold
  const volumeCheck = checkVolumeTrigger(volumeThreshold);
  if (volumeCheck.shouldTrigger) {
    await dispatchDream(projectRoot, opts.sessionId, opts.inline);
    return {
      triggered: true,
      tier: 'volume',
      newObservationCount: volumeCheck.newObservationCount,
    };
  }

  // Tier 2: Idle detection
  const idleCheck = checkIdleTrigger(idleThresholdMinutes);
  if (idleCheck.shouldTrigger) {
    await dispatchDream(projectRoot, opts.sessionId, opts.inline);
    return {
      triggered: true,
      tier: 'idle',
      idleMinutes: idleCheck.idleMinutes,
    };
  }

  // No trigger fired
  return {
    triggered: false,
    tier: null,
    skippedReason: `volume below threshold (${volumeCheck.newObservationCount}/${volumeThreshold}); idle below threshold (${Math.round(idleCheck.idleMinutes)}/${idleThresholdMinutes} min)`,
    newObservationCount: volumeCheck.newObservationCount,
    idleMinutes: idleCheck.idleMinutes,
  };
}

/**
 * Manually trigger the full dream cycle immediately.
 *
 * Bypasses all trigger thresholds and cooldown guards. Intended for
 * `cleo memory dream` CLI invocation and test scaffolding.
 *
 * @param projectRoot - Project root for brain.db resolution.
 * @param sessionId - Active session ID (for Step 9a reward backfill).
 * @returns The RunConsolidationResult from the full pipeline.
 *
 * @task T628
 */
export async function triggerManualDream(
  projectRoot: string,
  sessionId?: string | null,
): Promise<import('./brain-lifecycle.js').RunConsolidationResult> {
  const { runConsolidation } = await import('./brain-lifecycle.js');
  const result = await runConsolidation(projectRoot, sessionId ?? null, 'manual');
  lastDreamAt = Date.now();
  return result;
}

/**
 * Start the nightly cron scheduler (Tier 3).
 *
 * Fires `checkAndDream` daily at `hourUTC` (default: 4 AM UTC).
 * The timer is a best-effort setInterval — it will not survive process restart.
 *
 * Only one nightly scheduler can be active. Calling this when already active
 * is a no-op.
 *
 * @param projectRoot - Project root for brain.db resolution.
 * @param hourUTC - Hour of day (0–23 UTC) to fire nightly consolidation.
 * @returns true if the scheduler was started, false if already running.
 *
 * @task T628
 */
export function startDreamScheduler(
  projectRoot: string,
  hourUTC: number = NIGHTLY_HOUR_DEFAULT,
): boolean {
  if (nightlyTimer !== null) return false;

  const msUntilNextFire = (): number => {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(hourUTC, 0, 0, 0);
    if (next.getTime() <= now.getTime()) {
      next.setUTCDate(next.getUTCDate() + 1);
    }
    return next.getTime() - now.getTime();
  };

  const scheduleNext = (): void => {
    nightlyTimer = setTimeout(() => {
      nightlyTimer = null;
      checkAndDream(projectRoot, { inline: false }).catch((err: unknown) => {
        console.warn('[dream-cycle] Nightly cron failed:', err);
      });
      // Schedule the next fire after firing.
      scheduleNext();
    }, msUntilNextFire());
  };

  scheduleNext();
  return true;
}

/**
 * Stop the nightly cron scheduler.
 *
 * @returns true if a running scheduler was stopped, false if none was active.
 *
 * @task T628
 */
export function stopDreamScheduler(): boolean {
  if (nightlyTimer === null) return false;
  clearTimeout(nightlyTimer);
  nightlyTimer = null;
  return true;
}

/**
 * Reset in-process dream cycle state.
 *
 * Intended for test teardown only. Clears `lastDreamAt`, `dreamInFlight`,
 * and stops the nightly scheduler if running.
 *
 * @internal
 */
export function _resetDreamState(): void {
  lastDreamAt = 0;
  dreamInFlight = false;
  stopDreamScheduler();
}
