/**
 * STDP (Spike-Timing-Dependent Plasticity) for CLEO BRAIN.
 *
 * Implements a biologically-inspired Hebbian learning rule that modulates edge
 * weights based on the *temporal order* of memory retrievals within a session
 * window, not just co-occurrence frequency.
 *
 * ## Neuroscience basis
 *
 * Classical STDP: if neuron A fires before neuron B by Δt milliseconds, the
 * synapse A→B is potentiated (LTP); if A fires after B, it is depressed (LTD).
 * The magnitude of the change decays exponentially with |Δt|.
 *
 * ## Mapping to CLEO memory
 *
 * - Each entry retrieved from brain.db is a "spike".
 * - Retrievals within the same session and within `sessionWindowMs` of each
 *   other are treated as temporally related spikes.
 * - If entry A was retrieved BEFORE entry B by Δt ms:
 *     Δw = A_pre  × exp(−Δt / τ_pre)   → potentiation (LTP, positive Δw)
 * - If entry A was retrieved AFTER entry B by Δt ms:
 *     Δw = −A_post × exp(−Δt / τ_post)  → depression  (LTD, negative Δw)
 * - Weights are clamped to [0.0, 1.0].
 * - All events are logged to `brain_plasticity_events` for observability.
 *
 * ## Parameters (biologically reasonable defaults)
 *
 * | Symbol  | Value  | Meaning                                          |
 * |---------|--------|--------------------------------------------------|
 * | τ_pre   | 20 s   | Time constant for pre→post potentiation          |
 * | τ_post  | 20 s   | Time constant for post→pre depression            |
 * | A_pre   | 0.05   | Peak potentiation amplitude                      |
 * | A_post  | 0.06   | Peak depression amplitude (asymmetric, per STDP) |
 *
 * The asymmetry A_post > A_pre models the biological fact that LTD is slightly
 * stronger than LTP, preventing runaway weight growth.
 *
 * ## Relation to Hebbian co-retrieval
 *
 * Hebbian (`strengthenCoRetrievedEdges` in brain-lifecycle.ts) uses the
 * `co_retrieved` edge type and does NOT track order; it fires on pairs that
 * co-occur ≥ 3× regardless of timing. STDP is a *second plasticity pass* that
 * runs after Hebbian and refines existing `co_retrieved` edges using order data.
 *
 * If no `co_retrieved` edge exists yet between a pair, STDP inserts one with the
 * initial STDP-derived weight (potentiation pairs only — LTD does not create
 * new edges, only weakens existing ones).
 *
 * @task T626
 * @epic T626
 * @see packages/core/src/memory/brain-lifecycle.ts#strengthenCoRetrievedEdges
 */

import { typedAll } from '../store/typed-query.js';
import { computeStabilityScore, upgradePlasticityClass } from './brain-plasticity-class.js';

// ============================================================================
// Reward backfill types
// ============================================================================

/**
 * Result returned by `backfillRewardSignals`.
 *
 * @task T681
 * @epic T673
 */
export interface RewardBackfillResult {
  /** Number of brain_retrieval_log rows updated with a reward_signal. */
  rowsLabeled: number;
  /** Number of rows skipped (already labeled, backfill session, or no task match). */
  rowsSkipped: number;
}

// ============================================================================
// STDP constants
// ============================================================================

/** Time constant (ms) for pre→post potentiation window. */
const TAU_PRE_MS = 20_000; // 20 s

/** Time constant (ms) for post→pre depression window. */
const TAU_POST_MS = 20_000; // 20 s

/** Peak potentiation amplitude (dimensionless weight delta). */
const A_PRE = 0.05;

/** Peak depression amplitude (slightly larger than A_pre — asymmetric STDP). */
const A_POST = 0.06;

/** Minimum edge weight (floor). */
const WEIGHT_MIN = 0.0;

/** Maximum edge weight (ceiling). */
const WEIGHT_MAX = 1.0;

// ============================================================================
// Public types
// ============================================================================

/** Result returned by `applyStdpPlasticity`. */
export interface StdpPlasticityResult {
  /** Number of LTP (potentiation) events applied. */
  ltpEvents: number;
  /** Number of LTD (depression) events applied. */
  ltdEvents: number;
  /** Number of new edges inserted (LTP on pairs without an existing edge). */
  edgesCreated: number;
  /** Number of retrieval pairs examined. */
  pairsExamined: number;
}

/** Summary row from `getPlasticityStats`. */
export interface PlasticityStatsSummary {
  /** Total number of plasticity events ever recorded. */
  totalEvents: number;
  /** Count of LTP events. */
  ltpCount: number;
  /** Count of LTD events. */
  ltdCount: number;
  /** Net weight delta summed across all events (positive = net strengthening). */
  netDeltaW: number;
  /** Most recent event timestamp (ISO 8601), or null if no events. */
  lastEventAt: string | null;
  /** Recent events (up to `limit`, newest first). */
  recentEvents: RecentPlasticityEvent[];
}

/** A single recent plasticity event for display. */
export interface RecentPlasticityEvent {
  /** Auto-increment event ID. */
  id: number;
  /** Source node identifier. */
  sourceNode: string;
  /** Target node identifier. */
  targetNode: string;
  /** Signed weight delta. */
  deltaW: number;
  /** 'ltp' or 'ltd'. */
  kind: 'ltp' | 'ltd';
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Session ID, if available. */
  sessionId: string | null;
}

// ============================================================================
// Internal types
// ============================================================================

/** A single row from brain_retrieval_log with STDP columns. */
interface RetrievalLogRow {
  id: number;
  entry_ids: string;
  created_at: string;
  retrieval_order: number | null;
  delta_ms: number | null;
  session_id?: string | null;
}

/** A spike: one entry ID retrieved at one timestamp, with ordering metadata. */
interface Spike {
  entryId: string;
  rowId: number;
  retrievedAt: number; // epoch ms
  order: number;
}

// ============================================================================
// Core STDP function
// ============================================================================

/**
 * Apply Spike-Timing-Dependent Plasticity to brain_page_edges.
 *
 * Reads `brain_retrieval_log` for rows within the past `sessionWindowMs`
 * milliseconds, reconstructs the temporal spike sequence per session, and
 * applies the STDP rule to every ordered pair within the window.
 *
 * All weight changes are logged to `brain_plasticity_events` for
 * observability and `cleo brain plasticity stats` reporting.
 *
 * @param projectRoot - Project root directory for brain.db resolution
 * @param sessionWindowMs - Time window (ms) to consider retrievals as
 *   temporally related. Defaults to 5 minutes.
 * @returns Counts of LTP/LTD events applied and edges created/updated.
 */
export async function applyStdpPlasticity(
  projectRoot: string,
  sessionWindowMs = 5 * 60 * 1000,
): Promise<StdpPlasticityResult> {
  const { getBrainDb, getBrainNativeDb } = await import('../store/brain-sqlite.js');
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();

  const result: StdpPlasticityResult = {
    ltpEvents: 0,
    ltdEvents: 0,
    edgesCreated: 0,
    pairsExamined: 0,
  };

  if (!nativeDb) return result;

  // Guard: retrieval log must exist
  try {
    nativeDb.prepare('SELECT 1 FROM brain_retrieval_log LIMIT 1').get();
  } catch {
    return result;
  }

  // Guard: plasticity events table must exist
  try {
    nativeDb.prepare('SELECT 1 FROM brain_plasticity_events LIMIT 1').get();
  } catch {
    return result;
  }

  const now = Date.now();
  const cutoffMs = now - sessionWindowMs;
  const cutoffIso = new Date(cutoffMs).toISOString().replace('T', ' ').slice(0, 19);
  const nowIso = new Date(now).toISOString().replace('T', ' ').slice(0, 19);

  // Fetch recent retrieval log rows including the STDP columns.
  // We use all rows in the window regardless of whether retrieval_order is set —
  // if it is null (legacy rows), we fall back to ordering by created_at.
  let logRows: RetrievalLogRow[] = [];
  try {
    logRows = typedAll<RetrievalLogRow>(
      nativeDb.prepare(
        `SELECT id, entry_ids, created_at, retrieval_order, delta_ms
         FROM brain_retrieval_log
         WHERE created_at >= ?
         ORDER BY created_at ASC, id ASC
         LIMIT 2000`,
      ),
      cutoffIso,
    );
  } catch {
    return result;
  }

  if (logRows.length === 0) return result;

  // Build an ordered spike sequence from the log rows.
  // Each retrieval log row may contain multiple entry_ids (a batch retrieval).
  // We expand them into individual spikes, preserving the retrieval timestamp.
  const spikes: Spike[] = [];
  let globalOrder = 0;

  for (const row of logRows) {
    let ids: string[];
    try {
      ids = JSON.parse(row.entry_ids) as string[];
    } catch {
      continue;
    }

    const rowTime = new Date(row.created_at.replace(' ', 'T') + 'Z').getTime();

    for (const rawId of ids) {
      const entryId = rawId.includes(':') ? rawId : `observation:${rawId}`;
      spikes.push({
        entryId,
        rowId: row.id,
        retrievedAt: rowTime,
        order: row.retrieval_order ?? globalOrder,
      });
      globalOrder++;
    }
  }

  // Sort spikes by (retrievedAt, order) to establish canonical temporal sequence.
  spikes.sort((a, b) => a.retrievedAt - b.retrievedAt || a.order - b.order);

  // For each ordered pair (i, j) where i < j (spike i before spike j),
  // apply the STDP rule if Δt <= sessionWindowMs.
  const prepareGetEdge = nativeDb.prepare(
    `SELECT weight, reinforcement_count, last_reinforced_at, plasticity_class, depression_count, last_depressed_at
     FROM brain_page_edges
     WHERE from_id = ? AND to_id = ? AND edge_type = 'co_retrieved'`,
  );

  // LTP UPDATE: increment reinforcement_count, set plasticity_class='stdp' (T693)
  const prepareUpdateEdgeLtp = nativeDb.prepare(
    `UPDATE brain_page_edges
     SET weight = MAX(?, MIN(?, weight + ?)),
         reinforcement_count = reinforcement_count + 1,
         last_reinforced_at = ?,
         plasticity_class = ?,
         stability_score = ?
     WHERE from_id = ? AND to_id = ? AND edge_type = 'co_retrieved'`,
  );

  // LTD UPDATE: increment depression_count, set plasticity_class='stdp' (T693)
  const prepareUpdateEdgeLtd = nativeDb.prepare(
    `UPDATE brain_page_edges
     SET weight = MAX(?, MIN(?, weight + ?)),
         depression_count = depression_count + 1,
         last_depressed_at = ?,
         plasticity_class = ?,
         stability_score = ?
     WHERE from_id = ? AND to_id = ? AND edge_type = 'co_retrieved'`,
  );

  const prepareInsertEdge = nativeDb.prepare(
    `INSERT OR IGNORE INTO brain_page_edges
       (from_id, to_id, edge_type, weight, provenance, reinforcement_count, last_reinforced_at, plasticity_class, stability_score, created_at)
     VALUES (?, ?, 'co_retrieved', ?, 'plasticity:stdp-ltp', 1, ?, 'stdp', ?, ?)`,
  );

  const prepareLogEvent = nativeDb.prepare(
    `INSERT INTO brain_plasticity_events
       (source_node, target_node, delta_w, kind, timestamp)
     VALUES (?, ?, ?, ?, ?)`,
  );

  for (let i = 0; i < spikes.length; i++) {
    const spikeA = spikes[i]!;

    for (let j = i + 1; j < spikes.length; j++) {
      const spikeB = spikes[j]!;
      const deltaT = spikeB.retrievedAt - spikeA.retrievedAt; // ms, always >= 0

      if (deltaT > sessionWindowMs) break; // spikes are sorted; further pairs exceed window

      if (spikeA.entryId === spikeB.entryId) continue; // skip self-pairs

      result.pairsExamined++;

      // A fired before B → LTP on edge A→B
      const deltaW = A_PRE * Math.exp(-deltaT / TAU_PRE_MS);

      if (deltaW < 1e-6) continue; // negligible change — skip

      // Check whether an existing co_retrieved edge A→B exists
      const existingEdge = prepareGetEdge.get(spikeA.entryId, spikeB.entryId) as
        | {
            weight: number;
            reinforcement_count: number;
            last_reinforced_at: string | null;
            plasticity_class: string | null;
            depression_count: number;
            last_depressed_at: string | null;
          }
        | undefined;

      try {
        if (existingEdge !== undefined) {
          // LTP UPDATE: Set plasticity_class='stdp' (upgrades from 'hebbian'), compute stability (T693)
          const upgradedClass = upgradePlasticityClass(existingEdge.plasticity_class, 'stdp');
          const newRcCount = (existingEdge.reinforcement_count ?? 0) + 1;
          const stability = computeStabilityScore(newRcCount, nowIso, now);

          prepareUpdateEdgeLtp.run(
            WEIGHT_MIN,
            WEIGHT_MAX,
            deltaW,
            nowIso, // last_reinforced_at
            upgradedClass,
            stability,
            spikeA.entryId,
            spikeB.entryId,
          );
        } else {
          // INSERT: Set plasticity_class='stdp', reinforcement_count=1, compute stability (T693)
          const stability = computeStabilityScore(1, nowIso, now);
          const initialWeight = Math.min(WEIGHT_MAX, deltaW);
          prepareInsertEdge.run(
            spikeA.entryId,
            spikeB.entryId,
            initialWeight,
            nowIso, // last_reinforced_at
            stability,
            nowIso,
          );
          result.edgesCreated++;
        }

        prepareLogEvent.run(spikeA.entryId, spikeB.entryId, deltaW, 'ltp', nowIso);
        result.ltpEvents++;
      } catch {
        /* best-effort */
      }

      // B fired after A → LTD on reverse edge B→A (depression)
      // LTD only weakens existing edges; it does not create new ones.
      const deltaWNeg = -(A_POST * Math.exp(-deltaT / TAU_POST_MS));

      const existingReverseEdge = prepareGetEdge.get(spikeB.entryId, spikeA.entryId) as
        | {
            weight: number;
            reinforcement_count: number;
            last_reinforced_at: string | null;
            plasticity_class: string | null;
            depression_count: number;
            last_depressed_at: string | null;
          }
        | undefined;

      if (existingReverseEdge !== undefined && Math.abs(deltaWNeg) >= 1e-6) {
        try {
          // LTD UPDATE: Set plasticity_class='stdp' (upgrades), compute stability (T693)
          const upgradedClass = upgradePlasticityClass(
            existingReverseEdge.plasticity_class,
            'stdp',
          );
          // Stability is based on LTP count, not depression (per spec §3.10)
          const stability = computeStabilityScore(
            existingReverseEdge.reinforcement_count,
            existingReverseEdge.last_reinforced_at,
            now,
          );

          prepareUpdateEdgeLtd.run(
            WEIGHT_MIN,
            WEIGHT_MAX,
            deltaWNeg,
            nowIso, // last_depressed_at
            upgradedClass,
            stability,
            spikeB.entryId,
            spikeA.entryId,
          );
          prepareLogEvent.run(spikeB.entryId, spikeA.entryId, deltaWNeg, 'ltd', nowIso);
          result.ltdEvents++;
        } catch {
          /* best-effort */
        }
      }
    }
  }

  return result;
}

// ============================================================================
// Plasticity stats query
// ============================================================================

/**
 * Retrieve a summary of recent STDP plasticity events from `brain_plasticity_events`.
 *
 * Used by `cleo brain plasticity stats`.
 *
 * @param projectRoot - Project root directory for brain.db resolution
 * @param limit - Maximum number of recent events to include. Defaults to 20.
 * @returns Aggregated plasticity statistics and the most recent events.
 */
export async function getPlasticityStats(
  projectRoot: string,
  limit = 20,
): Promise<PlasticityStatsSummary> {
  const { getBrainDb, getBrainNativeDb } = await import('../store/brain-sqlite.js');
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();

  const empty: PlasticityStatsSummary = {
    totalEvents: 0,
    ltpCount: 0,
    ltdCount: 0,
    netDeltaW: 0,
    lastEventAt: null,
    recentEvents: [],
  };

  if (!nativeDb) return empty;

  try {
    nativeDb.prepare('SELECT 1 FROM brain_plasticity_events LIMIT 1').get();
  } catch {
    return empty;
  }

  interface AggRow {
    total: number;
    ltp_count: number;
    ltd_count: number;
    net_delta_w: number;
    last_event_at: string | null;
  }

  let agg: AggRow | undefined;
  try {
    agg = nativeDb
      .prepare(
        `SELECT
           COUNT(*)                         AS total,
           SUM(CASE WHEN kind = 'ltp' THEN 1 ELSE 0 END) AS ltp_count,
           SUM(CASE WHEN kind = 'ltd' THEN 1 ELSE 0 END) AS ltd_count,
           SUM(delta_w)                    AS net_delta_w,
           MAX(timestamp)                  AS last_event_at
         FROM brain_plasticity_events`,
      )
      .get() as AggRow | undefined;
  } catch {
    return empty;
  }

  interface EventRow {
    id: number;
    source_node: string;
    target_node: string;
    delta_w: number;
    kind: string;
    timestamp: string;
    session_id: string | null;
  }

  let recentRows: EventRow[] = [];
  try {
    recentRows = typedAll<EventRow>(
      nativeDb.prepare(
        `SELECT id, source_node, target_node, delta_w, kind, timestamp, session_id
         FROM brain_plasticity_events
         ORDER BY timestamp DESC, id DESC
         LIMIT ?`,
      ),
      limit,
    );
  } catch {
    // non-fatal
  }

  return {
    totalEvents: agg?.total ?? 0,
    ltpCount: agg?.ltp_count ?? 0,
    ltdCount: agg?.ltd_count ?? 0,
    netDeltaW: agg?.net_delta_w ?? 0,
    lastEventAt: agg?.last_event_at ?? null,
    recentEvents: recentRows.map((r) => ({
      id: r.id,
      sourceNode: r.source_node,
      targetNode: r.target_node,
      deltaW: r.delta_w,
      kind: r.kind as 'ltp' | 'ltd',
      timestamp: r.timestamp,
      sessionId: r.session_id,
    })),
  };
}

// ============================================================================
// R-STDP reward backfill (Step 9a of runConsolidation)
// ============================================================================

/**
 * Backfill reward_signal values on brain_retrieval_log rows for a session.
 *
 * Step 9a of the `runConsolidation` pipeline — runs BEFORE `applyStdpPlasticity`
 * (Step 9b) so reward signals are present when STDP reads them.
 *
 * ## Signal derivation
 *
 * Queries tasks.db for tasks attributed to `sessionId` within `lookbackDays`.
 * Maps task outcomes to reward scalars:
 *
 * | Task state | Reward |
 * |-----------|--------|
 * | `status='done'`, `verification.passed=true` | +1.0 (verified correct) |
 * | `status='done'`, verification not passed | +0.5 (completed, unverified) |
 * | `status='cancelled'` | -0.5 (cancelled) |
 *
 * All brain_retrieval_log rows for the session receive the derived scalar as
 * a session-level reward (the entire session's retrieval pattern is rated by
 * the session's overall task outcome). If multiple tasks exist in the session,
 * the MAXIMUM reward takes precedence (positive outcome wins).
 *
 * ## Skipped sessions
 *
 * Sessions with `session_id LIKE 'ses_backfill_%'` are synthetic (date-bucketed
 * historical rows per M1). These have no real task correlation and MUST be skipped.
 *
 * ## Idempotency
 *
 * Already-labeled rows (reward_signal IS NOT NULL) are not overwritten.
 * Running twice on the same session is safe.
 *
 * ## Transaction pattern
 *
 * Two separate SQLite connections (no ATTACH): reads tasks.db → computes reward
 * map → writes brain.db in separate transactions. Matches `cross-db-cleanup.ts`.
 *
 * @param projectRoot - Project root directory for database resolution
 * @param sessionId - The session ID to backfill. Pass null/undefined for no-op.
 * @param lookbackDays - Days of tasks.db history to scan (default 30)
 * @returns Counts of rows labeled and skipped
 *
 * @task T681
 * @epic T673
 */
export async function backfillRewardSignals(
  projectRoot: string,
  sessionId: string | null | undefined,
  lookbackDays = 30,
): Promise<RewardBackfillResult> {
  const result: RewardBackfillResult = { rowsLabeled: 0, rowsSkipped: 0 };

  // No-op: null/undefined sessionId has no task correlation
  if (!sessionId) {
    return result;
  }

  // No-op: synthetic backfill sessions have no task correlation (spec §2.4 / §4.3)
  if (sessionId.startsWith('ses_backfill_')) {
    return result;
  }

  // ── Step 1: Read tasks.db for tasks in this session ────────────────────────
  //
  // Two-connection pattern: read tasks.db first, then write brain.db separately.
  // No ATTACH. Matches cross-db-cleanup.ts pattern.

  interface TaskOutcomeRow {
    id: string;
    status: string;
    verificationJson: string | null;
    completedAt: string | null;
    cancelledAt: string | null;
  }

  let taskRows: TaskOutcomeRow[] = [];

  try {
    const { getDb } = await import('../store/sqlite.js');
    const tasksDb = await getDb(projectRoot);
    const { tasks } = await import('../store/tasks-schema.js');
    const { and, eq, inArray, gte, or, isNotNull } = await import('drizzle-orm');

    const cutoffTs = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);

    const rawRows = await tasksDb
      .select({
        id: tasks.id,
        status: tasks.status,
        verificationJson: tasks.verificationJson,
        completedAt: tasks.completedAt,
        cancelledAt: tasks.cancelledAt,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.sessionId, sessionId),
          inArray(tasks.status, ['done', 'cancelled'] as const),
          or(
            and(isNotNull(tasks.completedAt), gte(tasks.completedAt, cutoffTs)),
            and(isNotNull(tasks.cancelledAt), gte(tasks.cancelledAt, cutoffTs)),
          ),
        ),
      )
      .all();

    taskRows = rawRows.map((r) => ({
      id: r.id,
      status: r.status,
      verificationJson: r.verificationJson ?? null,
      completedAt: r.completedAt ?? null,
      cancelledAt: r.cancelledAt ?? null,
    }));
  } catch {
    // tasks.db may not be accessible (fresh project, test environment without tasks.db)
    // Return early — no task data means no reward signal can be derived
    return result;
  }

  // ── Step 2: Derive session-level reward from task outcomes ──────────────────
  //
  // Reward assignment per spec §3.6 / §4.3:
  //   +1.0 — done + verification.passed = true (verified correct)
  //   +0.5 — done, verification not passed (completed, unverified)
  //   -0.5 — cancelled
  //
  // If multiple tasks in session, take the MAXIMUM reward (positive outcome wins).
  // If no matching tasks, return early — reward stays null (unlabeled).

  if (taskRows.length === 0) {
    return result;
  }

  let sessionReward: number | null = null;

  /** Derive the scalar reward for one task row. */
  function deriveTaskReward(task: TaskOutcomeRow): number {
    if (task.status === 'cancelled') {
      return -0.5;
    }
    // status === 'done'
    let verificationPassed = false;
    if (task.verificationJson) {
      try {
        const v = JSON.parse(task.verificationJson) as { passed?: boolean };
        verificationPassed = v.passed === true;
      } catch {
        // malformed JSON — treat as unverified
      }
    }
    return verificationPassed ? 1.0 : 0.5;
  }

  for (const task of taskRows) {
    const taskReward = deriveTaskReward(task);
    if (sessionReward === null || taskReward > sessionReward) {
      sessionReward = taskReward;
    }
  }

  if (sessionReward === null) {
    return result;
  }

  // ── Step 3: Write reward_signal to brain.db ─────────────────────────────────
  //
  // Separate connection from tasks.db — no ATTACH, per spec §4.3.

  try {
    const { getBrainDb, getBrainNativeDb } = await import('../store/brain-sqlite.js');
    await getBrainDb(projectRoot);
    const nativeDb = getBrainNativeDb();

    if (!nativeDb) return result;

    // Guard: retrieval log must exist
    try {
      nativeDb.prepare('SELECT 1 FROM brain_retrieval_log LIMIT 1').get();
    } catch {
      return result;
    }

    // UPDATE retrieval log rows for this session that are still unlabeled.
    // Idempotent: WHERE reward_signal IS NULL means already-labeled rows are untouched.
    const updateResult = nativeDb
      .prepare(
        `UPDATE brain_retrieval_log
         SET reward_signal = ?
         WHERE session_id = ?
           AND reward_signal IS NULL`,
      )
      .run(sessionReward, sessionId);

    const updatedCount = typeof updateResult.changes === 'number' ? updateResult.changes : 0;
    result.rowsLabeled = updatedCount;

    // Count rows that were already labeled (skipped this run)
    const skipRow = nativeDb
      .prepare(
        `SELECT COUNT(*) AS cnt FROM brain_retrieval_log
         WHERE session_id = ? AND reward_signal IS NOT NULL`,
      )
      .get(sessionId) as { cnt: number } | undefined;
    result.rowsSkipped = skipRow?.cnt ?? 0;

    // ── Step 4: INSERT brain_modulators rows for each task outcome ──────────
    //
    // Guard: modulators table must exist (M4 migration may not have run yet)
    let modulatorsExist = false;
    try {
      nativeDb.prepare('SELECT 1 FROM brain_modulators LIMIT 1').get();
      modulatorsExist = true;
    } catch {
      // table not created yet — skip, best-effort
    }

    if (modulatorsExist && updatedCount > 0) {
      const insertModulator = nativeDb.prepare(
        `INSERT INTO brain_modulators
           (modulator_type, valence, magnitude, source_event_id, session_id, description)
         VALUES (?, ?, 1.0, ?, ?, ?)`,
      );

      for (const task of taskRows) {
        const taskReward = deriveTaskReward(task);

        let modulatorType: string;
        let description: string;

        if (task.status === 'cancelled') {
          modulatorType = 'task_cancelled';
          description = `Task ${task.id} cancelled`;
        } else if (taskReward >= 1.0) {
          modulatorType = 'task_verified';
          description = `Task ${task.id} completed and verified`;
        } else {
          modulatorType = 'task_completed';
          description = `Task ${task.id} completed (unverified)`;
        }

        try {
          insertModulator.run(modulatorType, taskReward, task.id, sessionId, description);
        } catch {
          // best-effort: modulator INSERT failure does not block backfill
        }
      }
    }
  } catch {
    // brain.db write failure — non-fatal, best-effort
  }

  return result;
}
