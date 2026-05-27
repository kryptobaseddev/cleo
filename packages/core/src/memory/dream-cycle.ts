/**
 * Auto-Dream Cycle — autonomous BRAIN consolidation with STDP plasticity.
 *
 * Implements two trigger tiers for autonomous `runConsolidation` dispatch:
 *
 *   Tier 1 — Volume threshold (primary):
 *     When `brain_observations` delta since last consolidation exceeds
 *     VOLUME_THRESHOLD_DEFAULT (10), trigger immediately.
 *
 *   Tier 2 — Idle detection (secondary):
 *     When `brain_retrieval_log` shows no activity for IDLE_MINUTES_DEFAULT (30)
 *     minutes, trigger consolidation in the background.
 *
 * Tier 3 (nightly setTimeout chaining) has been removed — the sentient daemon
 * tick loop (`sentient/tick.ts`) is now the canonical trigger host. Each tick
 * evaluates both Tier 1 and Tier 2 via `checkAndDream`. This eliminates
 * setTimeout drift across long-running processes.
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

// ============================================================================
// Module-level state (in-process idempotency)
// ============================================================================

/** Timestamp of the last dream cycle triggered in this process. */
let lastDreamAt: number = 0;

/** Whether a dream cycle is currently in flight (prevents overlapping runs). */
let dreamInFlight: boolean = false;

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
   *
   * **Process lifetime (T9948):** in the fire-and-forget path the timer
   * handle is `unref()`-ed so that the host process is NOT kept alive by
   * a pending dream cycle. Long-lived hosts (e.g. the sentient daemon)
   * have other unrelated work that keeps the event loop running, so
   * unref-ing here only changes the short-lived case (`cleo briefing`,
   * `cleo show`, …) — those invocations now exit promptly instead of
   * hanging the SQLite writer lock for as long as `runConsolidation`
   * takes to finish.
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
 * **T9948 — process-lifetime contract**
 *
 * When `inline=false`, the run is scheduled via `setImmediate(...).unref()`
 * so the host process is NOT held alive by a pending dream cycle. This
 * matters because `runConsolidation` performs BEGIN-locked writes against
 * brain.db (deduplication, tier promotion, sweepers, …) which can run
 * for many minutes on a busy graph. Prior to this contract, a single
 * `cleo briefing` invocation could keep its PID alive — and therefore
 * the SQLite writer lock contended — for as long as consolidation took.
 *
 * Long-lived hosts (the sentient daemon, integration test harnesses) keep
 * the event loop alive through their tick interval / explicit awaits;
 * unref-ing this single timer changes nothing for them. Short-lived hosts
 * (`cleo briefing`, `cleo show`, `cleo find`) now exit as soon as the
 * caller's await chain resolves.
 *
 * @param projectRoot - Project root for brain.db resolution.
 * @param sessionId - Active session ID (for Step 9a reward backfill).
 * @param inline - If true, await inline; else fire-and-forget via
 *   `setImmediate(...).unref()` (non-keepalive).
 *
 * @task T9948 — briefing DB-lock contention root-cause fix
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
    // T9948: unref() the handle so a fire-and-forget dream does not hold
    // open a short-lived process (e.g. `cleo briefing`). The dream still
    // runs to completion in long-lived hosts (sentient daemon, tests)
    // because they keep the event loop alive through unrelated work.
    const handle = setImmediate(run);
    handle.unref();
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
 * Reset in-process dream cycle state.
 *
 * Intended for test teardown only. Clears `lastDreamAt` and `dreamInFlight`.
 * The nightly setTimeout scheduler has been removed — the sentient tick loop
 * is now the canonical trigger host (T996).
 *
 * @internal
 */
export function _resetDreamState(): void {
  lastDreamAt = 0;
  dreamInFlight = false;
}

// ============================================================================
// Dream Status (T1895 — engine liveness probe)
// ============================================================================

/**
 * Structured status response from `cleo memory dream --status`.
 *
 * All fields are present in every response. Fields sourced from the in-process
 * module state (`dreamInFlight`, `lastDreamAt`) reflect the state of the current
 * process only; across process restarts the values reset to their defaults.
 * Fields sourced from brain.db (`lastConsolidatedAt`, `observationsSinceLastConsolidation`,
 * `idleMinutesSinceLastRetrieval`) reflect the persistent on-disk state.
 */
export interface DreamStatus {
  /** ISO 8601 timestamp of the last completed consolidation event, or null if none. */
  lastConsolidatedAt: string | null;
  /** Count of brain_observations created after the last consolidation event. */
  observationsSinceLastConsolidation: number;
  /** Minutes since the last brain_retrieval_log entry. Infinity-like value when no retrieval ever. */
  idleMinutesSinceLastRetrieval: number;
  /** Whether the sentient tick loop has run within the last 90 minutes (cross-process check via state file). */
  tickLoopAlive: boolean;
  /** ISO 8601 timestamp of the last sentient tick, or null if never run / unavailable. */
  lastTickAt: string | null;
  /** Whether a dream cycle is currently running in this process. */
  dreamInFlight: boolean;
  /** Last error message encountered by the dream cycle, if any. */
  lastError: string | null;
  /**
   * `true` when the dream cycle is considered overdue:
   *   - More than `volumeThreshold * 5` new observations since last consolidation, OR
   *   - `lastConsolidatedAt` is older than 24h AND there are any new observations.
   */
  isOverdue: boolean;
}

/**
 * Return the current dream-cycle engine liveness status.
 *
 * Used by `cleo memory dream --status` to check whether the consolidation
 * pipeline is running at a healthy cadence. Exits with code 1 when `isOverdue=true`.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @returns DreamStatus with all 8 named fields populated.
 *
 * @task T1895
 */
export async function getDreamStatus(projectRoot: string): Promise<DreamStatus> {
  const OVERDUE_VOLUME_MULTIPLIER = 5;
  const OVERDUE_AGE_HOURS = 24;
  const TICK_ALIVE_WINDOW_MINUTES = 90;

  // Ensure brain.db is open so synchronous helpers can access it.
  try {
    await getBrainDb(projectRoot);
  } catch {
    // DB unavailable — return degraded status
    return {
      lastConsolidatedAt: null,
      observationsSinceLastConsolidation: 0,
      idleMinutesSinceLastRetrieval: 0,
      tickLoopAlive: false,
      lastTickAt: null,
      dreamInFlight,
      lastError: 'brain.db unavailable',
      isOverdue: false,
    };
  }

  const lastConsolidatedAt = getLastConsolidationTimestamp();
  const { newObservationCount } = checkVolumeTrigger(1);
  const { idleMinutes } = checkIdleTrigger(IDLE_MINUTES_DEFAULT);

  // Tick loop alive check — read sentient state file (best-effort)
  let tickLoopAlive = false;
  let lastTickAt: string | null = null;
  try {
    const { readSentientState } = await import('../sentient/state.js');
    const { resolveCanonicalCleoDir, resolveProjectByCwd } = await import('../paths.js');
    const { join } = await import('node:path');
    const stateDir = resolveCanonicalCleoDir(resolveProjectByCwd(projectRoot));
    const statePath = join(stateDir, 'sentient-state.json');
    const state = await readSentientState(statePath);
    lastTickAt = state.lastTickAt ?? null;
    if (lastTickAt) {
      const tickAgeMs = Date.now() - new Date(lastTickAt).getTime();
      tickLoopAlive = tickAgeMs < TICK_ALIVE_WINDOW_MINUTES * 60 * 1000;
    }
  } catch {
    // sentient state file may not exist (daemon not running) — not an error
  }

  // isOverdue heuristic:
  //   A. observations > VOLUME_THRESHOLD_DEFAULT * OVERDUE_VOLUME_MULTIPLIER
  //   B. lastConsolidated > 24h ago AND observations > 0
  const overdueByVolume =
    newObservationCount > VOLUME_THRESHOLD_DEFAULT * OVERDUE_VOLUME_MULTIPLIER;
  let overdueByAge = false;
  if (lastConsolidatedAt && newObservationCount > 0) {
    const normalised = lastConsolidatedAt.includes('T')
      ? lastConsolidatedAt
      : lastConsolidatedAt.replace(' ', 'T') + 'Z';
    const ageHours = (Date.now() - new Date(normalised).getTime()) / (1000 * 60 * 60);
    overdueByAge = ageHours > OVERDUE_AGE_HOURS;
  } else if (!lastConsolidatedAt && newObservationCount > 0) {
    // Never consolidated but has observations — overdue
    overdueByAge = true;
  }

  return {
    lastConsolidatedAt,
    observationsSinceLastConsolidation: newObservationCount,
    idleMinutesSinceLastRetrieval: idleMinutes,
    tickLoopAlive,
    lastTickAt,
    dreamInFlight,
    lastError: null,
    isOverdue: overdueByVolume || overdueByAge,
  };
}
