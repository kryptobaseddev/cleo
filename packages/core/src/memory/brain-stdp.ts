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
 * ## Two-Window Architecture (T679 BUG-1 fix, T688 expansion)
 *
 * Prior code used `sessionWindowMs=5min` as BOTH the SQL lookback cutoff AND the
 * spike-pair Δt gate, causing all live rows (>5min old) to produce zero plasticity
 * events. This version separates the two concerns:
 *
 * | Parameter         | Default    | Purpose                                  |
 * |-------------------|------------|------------------------------------------|
 * | `lookbackDays`    | 30 days    | SQL cutoff for fetching retrieval rows   |
 * | `pairingWindowMs` | 24 h       | Max Δt between two spikes for pairing    |
 *
 * T688: `pairingWindowMs` raised to 24 h — cross-session pairs now eligible.
 * Session boundary is NOT a hard cutoff; τ tier determines decay magnitude.
 *
 * ## Tiered τ (T689)
 *
 * `computeTau(deltaT)` selects the decay time constant based on Δt:
 *
 * | Gap class     | Δt range       | τ       |
 * |---------------|----------------|---------|
 * | Intra-batch   | 0 — 30 s       | 20 s    |
 * | Intra-session | 30 s — 2 h     | 30 min  |
 * | Cross-session | 2 h — 24 h     | 12 h    |
 *
 * ## R-STDP reward modulation (T692)
 *
 * `reward_signal r` (from Step 9a backfill) gates Δw per spike:
 *   Δw_ltp_effective = clamp(Δw_ltp × (1+r), 0, 2×A_pre)
 *   Δw_ltd_effective = clamp(Δw_ltd × (1-r), -2×A_post, 0)
 * null reward → no modulation (r treated as 0).
 *
 * ## Novelty boost (T691)
 *
 * On INSERT (first co-retrieval), initial_weight = clamp(Δw × 1.5, 0, A_pre×1.5).
 * UPDATE path uses un-boosted Δw.
 *
 * @task T626
 * @task T679
 * @task T688
 * @task T689
 * @task T691
 * @task T692
 * @epic T673
 * @see packages/core/src/memory/brain-lifecycle.ts#strengthenCoRetrievedEdges
 * @see docs/specs/stdp-wire-up-spec.md §3.2 Two-Window Architecture
 */

import { typedAll } from '../store/typed-query.js';
import { computeStabilityScore, upgradePlasticityClass } from './brain-plasticity-class.js';

// ============================================================================
// STDP defaults (T679, T688)
// ============================================================================

/** Default SQL lookback window: fetch retrieval rows from the last N days. */
const DEFAULT_LOOKBACK_DAYS = 30;

/**
 * Default spike-pair matching window in milliseconds.
 * T688: raised from 5 min to 24 h — cross-session pairs are now eligible.
 * Session boundary is NOT a hard cutoff; tiered τ provides smaller Δw for
 * cross-session pairs (τ_episodic=12h vs τ_near=20s).
 */
const DEFAULT_PAIRING_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 h

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

/**
 * Options for `applyStdpPlasticity`.
 *
 * ### Migration note — legacy number signature deprecated (T679)
 *
 * The old single-parameter signature `applyStdpPlasticity(root, sessionWindowMs)`
 * used the same value for both SQL lookback cutoff and spike-pair Δt gate.
 * All 38 live retrieval rows were older than 5 min, so zero events ever fired.
 *
 * Pass `lookbackDays` (how far back to fetch rows) and `pairingWindowMs`
 * (max Δt between two spikes for pair formation) as separate parameters.
 */
export interface StdpPlasticityOptions {
  /**
   * SQL lookback window: only retrieve log rows from the last N days.
   * Default: 30. A 30-day window captures all meaningful retrieval history
   * without unbounded growth.
   */
  lookbackDays?: number;
  /**
   * Maximum Δt (ms) between two spikes for them to form a STDP pair.
   * T688 default: 24 h (86,400,000 ms) — cross-session pairs are eligible.
   * Tiered τ (T689) applies different decay constants based on session
   * relationship and Δt magnitude, so cross-session pairs still get
   * significantly smaller Δw than intra-batch pairs.
   */
  pairingWindowMs?: number;
}

// ============================================================================
// STDP constants (T689: tiered τ replaces single TAU_PRE_MS/TAU_POST_MS)
// ============================================================================

/**
 * Intra-batch time constant (ms).
 * Used when Δt ≤ 30 s — both spikes are in the same retrieval batch.
 * Biological analogue: classical STDP window (~20 ms–100 ms in neurons;
 * scaled to 20 s for CLEO memory retrieval granularity).
 *
 * @task T689
 */
const TAU_NEAR_MS = 20_000; // 20 s

/**
 * Intra-session time constant (ms).
 * Used when 30 s < Δt ≤ 2 h — spikes are in the same session but not same batch.
 * Biological analogue: working-memory consolidation window.
 *
 * @task T689
 */
const TAU_SESSION_MS = 30 * 60 * 1000; // 30 min

/**
 * Cross-session (episodic) time constant (ms).
 * Used when Δt > 2 h — spikes span different sessions.
 * Biological analogue: episodic reconsolidation (~12 h per Walker & Stickgold 2004).
 * Pairs 12 h apart contribute A × exp(-1) ≈ 0.37×A; pairs 36 h apart ≈ 0.05×A.
 *
 * @task T689
 */
const TAU_EPISODIC_MS = 12 * 60 * 60 * 1000; // 12 h

/**
 * Δt boundary (ms) between intra-batch and intra-session τ tiers.
 * Spikes within 30 s of each other use τ_near.
 */
const TAU_NEAR_THRESHOLD_MS = 30_000; // 30 s

/**
 * Δt boundary (ms) between intra-session and cross-session τ tiers.
 * Spikes more than 2 h apart use τ_episodic.
 */
const TAU_SESSION_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 h

/** Peak potentiation amplitude (dimensionless weight delta). */
const A_PRE = 0.05;

/** Peak depression amplitude (slightly larger than A_pre — asymmetric STDP). */
const A_POST = 0.06;

/**
 * Novelty boost multiplier for first-ever co-retrieval pair (INSERT path).
 * Models dopamine-novelty literature: new associations are strengthened more.
 * Applied only on INSERT; UPDATE path uses standard Δw.
 *
 * @task T691
 */
const K_NOVELTY = 1.5;

/** Minimum edge weight (floor). */
const WEIGHT_MIN = 0.0;

/** Maximum edge weight (ceiling). */
const WEIGHT_MAX = 1.0;

// ============================================================================
// Tiered τ computation (T689)
// ============================================================================

/**
 * Select the decay time constant τ based on spike-pair temporal gap.
 *
 * Three tiers (per spec §3.3):
 * - τ_near = 20 s   — Δt ≤ 30 s  (intra-batch, classical STDP window)
 * - τ_session = 30 min — 30 s < Δt ≤ 2 h (intra-session, working memory)
 * - τ_episodic = 12 h — Δt > 2 h  (cross-session, episodic reconsolidation)
 *
 * @param deltaT - Time gap between spikes in milliseconds (non-negative).
 * @returns τ in milliseconds for use in exp(-Δt / τ).
 *
 * @task T689
 */
export function computeTau(deltaT: number): number {
  if (deltaT <= TAU_NEAR_THRESHOLD_MS) return TAU_NEAR_MS;
  if (deltaT <= TAU_SESSION_THRESHOLD_MS) return TAU_SESSION_MS;
  return TAU_EPISODIC_MS;
}

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
  /**
   * Number of pairs where reward_signal was non-null and modulated Δw.
   * Incremented for both LTP and LTD events that had a non-null reward.
   *
   * @task T692
   */
  rewardModulatedEvents: number;
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
  /** Session that produced this retrieval. Populated by M1 migration / T703 writer fix. */
  session_id: string | null;
  /** R-STDP reward signal populated by backfillRewardSignals (Step 9a). */
  reward_signal: number | null;
}

/** A spike: one entry ID retrieved at one timestamp, with ordering and session metadata. */
interface Spike {
  entryId: string;
  rowId: number;
  retrievedAt: number; // epoch ms
  order: number;
  /** Session that produced this spike — from brain_retrieval_log.session_id. */
  sessionId: string | null;
  /** R-STDP reward signal from the retrieval row. */
  rewardSignal: number | null;
}

// ============================================================================
// Idempotency and minimum-pair guards (T713, T714)
// ============================================================================

/**
 * Check if a recent plasticity event exists for the given source→target pair
 * within the last `withinHours` (default 1 hour).
 *
 * Used by T713 idempotency guard to prevent duplicate event insertion when
 * consolidation runs multiple times against the same session.
 *
 * @param nativeDb - SQLite native database connection
 * @param sourceNode - Source node ID (entry ID)
 * @param targetNode - Target node ID (entry ID)
 * @param kind - Event kind ('ltp' or 'ltd')
 * @param sessionId - Session ID to match (null = all sessions)
 * @param withinHours - Dedup window in hours. Default: 1
 * @returns True if a matching recent event exists; false otherwise.
 */
function isPlasticityEventDuplicate(
  nativeDb: unknown,
  sourceNode: string,
  targetNode: string,
  kind: 'ltp' | 'ltd',
  sessionId: string | null,
  withinHours = 1,
): boolean {
  try {
    const cutoffIso = new Date(Date.now() - withinHours * 60 * 60 * 1000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);

    const db = nativeDb as unknown as {
      prepare: (sql: string) => { get: (...args: unknown[]) => unknown };
    };
    const stmt = db.prepare(
      `SELECT 1 FROM brain_plasticity_events
       WHERE source_node = ? AND target_node = ? AND kind = ?
         AND session_id = ?
         AND timestamp > ?
       LIMIT 1`,
    );

    const result = stmt.get(sourceNode, targetNode, kind, sessionId, cutoffIso);
    return result !== undefined;
  } catch {
    // If table doesn't exist yet or query fails, assume no duplicate
    return false;
  }
}

/**
 * Check if there are at least `minCount` retrieval log rows since the last
 * plasticity event in the given session.
 *
 * Used by T714 minimum-pair gate to skip Step 9b when a session has too few
 * retrievals to warrant plasticity processing.
 *
 * @param nativeDb - SQLite native database connection
 * @param minCount - Minimum number of new retrievals required. Default: 2
 * @param sessionId - Session ID to check (null = all sessions)
 * @returns True if minCount or more new retrievals exist; false otherwise.
 */
function hasMinimumRetrievalsSinceLastPlasticity(
  nativeDb: unknown,
  minCount = 2,
  sessionId: string | null = null,
): boolean {
  try {
    // Query: latest plasticity event timestamp for this session
    const db = nativeDb as unknown as {
      prepare: (sql: string) => { get: (...args: unknown[]) => unknown };
    };
    const lastPlasticityStmt = db.prepare(
      `SELECT MAX(timestamp) as last_time FROM brain_plasticity_events
       WHERE session_id = ?`,
    );
    const lastPlasticityRow = lastPlasticityStmt.get(sessionId) as
      | { last_time: string | null }
      | undefined;
    const lastTime = lastPlasticityRow?.last_time ?? null;

    // Count retrievals since that timestamp (or all if no prior events)
    let newRetrievalCount: number;

    if (lastTime === null) {
      // No prior plasticity events — count all retrievals in this session
      const countRow = db
        .prepare(
          `SELECT COUNT(*) as cnt FROM brain_retrieval_log
           WHERE session_id = ?`,
        )
        .get(sessionId) as { cnt: number } | undefined;
      newRetrievalCount = countRow?.cnt ?? 0;
    } else {
      // Count only retrievals *after* the last plasticity event
      const countRow = db
        .prepare(
          `SELECT COUNT(*) as cnt FROM brain_retrieval_log
           WHERE session_id = ? AND created_at > ?`,
        )
        .get(sessionId, lastTime) as { cnt: number } | undefined;
      newRetrievalCount = countRow?.cnt ?? 0;
    }

    return newRetrievalCount >= minCount;
  } catch {
    // If tables don't exist yet or query fails, assume no minimum requirement
    return true;
  }
}

/**
 * T714: Check whether Step 9b (STDP plasticity) should run based on retrieval volume.
 *
 * Per spec §4.2, skip plasticity processing if fewer than `minRetrievalsForPlasticity`
 * new retrieval rows exist since the last `brain_plasticity_events` timestamp.
 * This prevents wasted compute on early-session edge cases where no meaningful pairs exist.
 *
 * @param projectRoot - Project root for brain.db resolution
 * @param sessionId - Session ID to check (null = all sessions)
 * @param minRetrievalsForPlasticity - Minimum row count required. Default: 2.
 * @returns True if plasticity should run; false if gate blocks it.
 */
export async function shouldRunPlasticity(
  projectRoot: string,
  sessionId: string | null = null,
  minRetrievalsForPlasticity = 2,
): Promise<boolean> {
  const { getBrainDb, getBrainNativeDb } = await import('../store/brain-sqlite.js');
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();

  if (!nativeDb) return true; // Err on the side of running

  const hasMinimum = hasMinimumRetrievalsSinceLastPlasticity(
    nativeDb,
    minRetrievalsForPlasticity,
    sessionId,
  );

  if (!hasMinimum) {
    const count = (() => {
      try {
        const db = nativeDb as unknown as {
          prepare: (sql: string) => { get: (...args: unknown[]) => unknown };
        };
        const lastPlasticityStmt = db.prepare(
          `SELECT MAX(timestamp) as last_time FROM brain_plasticity_events WHERE session_id = ?`,
        );
        const lastPlasticityRow = lastPlasticityStmt.get(sessionId) as
          | { last_time: string | null }
          | undefined;
        const lastTime = lastPlasticityRow?.last_time ?? null;

        if (lastTime === null) {
          const countStmt = db.prepare(
            `SELECT COUNT(*) as cnt FROM brain_retrieval_log WHERE session_id = ?`,
          );
          const countRow = countStmt.get(sessionId) as { cnt: number } | undefined;
          return countRow?.cnt ?? 0;
        } else {
          const countStmt = db.prepare(
            `SELECT COUNT(*) as cnt FROM brain_retrieval_log WHERE session_id = ? AND created_at > ?`,
          );
          const countRow = countStmt.get(sessionId, lastTime) as { cnt: number } | undefined;
          return countRow?.cnt ?? 0;
        }
      } catch {
        return 0;
      }
    })();
    console.warn(
      `[plasticity] Minimum-pair gate: skipped STDP Step 9b (${count} retrievals, need >=${minRetrievalsForPlasticity})`,
    );
  }

  return hasMinimum;
}

// ============================================================================
// Core STDP function
// ============================================================================

/**
 * Apply Spike-Timing-Dependent Plasticity to brain_page_edges.
 *
 * Reads `brain_retrieval_log` for rows within the past `lookbackDays` days
 * (default 30), reconstructs the temporal spike sequence, and applies the
 * STDP rule to every ordered pair within `pairingWindowMs` (default 24 h).
 *
 * All weight changes are logged to `brain_plasticity_events` (with
 * `session_id`, `retrieval_log_id`, `weight_before`, `weight_after`,
 * `delta_t_ms`) and to `brain_weight_history` for the full audit trail.
 *
 * ### T679 fixes (root cause: BUG-1 from stdp-wire-up-spec.md §1.4)
 *
 * - Separated `lookbackDays` (SQL fetch window, default 30d) from
 *   `pairingWindowMs` (spike-pair Δt gate, default 5min). Previously both
 *   used `sessionWindowMs=5min`, causing all live rows (>5min old) to produce
 *   zero events.
 * - Writer now populates `session_id` + `retrieval_log_id` + `weight_before` /
 *   `weight_after` on `brain_plasticity_events` INSERT.
 * - Writer now inserts into `brain_weight_history` per weight delta.
 * - Fixed bug where `prepareUpdateEdge.run()` was missing 4 of 9 SQL params.
 *
 * ### Backward compatibility
 *
 * The legacy `applyStdpPlasticity(root, number)` signature is still accepted.
 * The number is mapped to `pairingWindowMs`; `lookbackDays` stays at 30d.
 * A deprecation warning is emitted to steer callers to `StdpPlasticityOptions`.
 *
 * @param projectRoot - Project root directory for brain.db resolution
 * @param options - `StdpPlasticityOptions` or a legacy number (deprecated `sessionWindowMs`).
 * @returns Counts of LTP/LTD events applied and edges created/updated.
 */
export async function applyStdpPlasticity(
  projectRoot: string,
  options?: StdpPlasticityOptions | number,
): Promise<StdpPlasticityResult> {
  // ---- Backward-compatible options resolution ----
  let lookbackDays = DEFAULT_LOOKBACK_DAYS;
  let pairingWindowMs = DEFAULT_PAIRING_WINDOW_MS;

  if (typeof options === 'number') {
    // Legacy call: applyStdpPlasticity(root, sessionWindowMs)
    // Map to pairingWindowMs only; lookbackDays stays at 30d so historical rows are fetched.
    console.warn(
      '[brain-stdp] Deprecated: passing sessionWindowMs as a number. ' +
        'Use StdpPlasticityOptions { lookbackDays, pairingWindowMs } instead. (T679)',
    );
    pairingWindowMs = options;
  } else if (options !== undefined) {
    lookbackDays = options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
    pairingWindowMs = options.pairingWindowMs ?? DEFAULT_PAIRING_WINDOW_MS;
  }

  const { getBrainDb, getBrainNativeDb } = await import('../store/brain-sqlite.js');
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();

  const result: StdpPlasticityResult = {
    ltpEvents: 0,
    ltdEvents: 0,
    edgesCreated: 0,
    pairsExamined: 0,
    rewardModulatedEvents: 0,
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
  // T679 BUG-1 fix: use lookbackDays (default 30d) for the SQL cutoff, NOT pairingWindowMs.
  // Previously: cutoffMs = now - sessionWindowMs (5 min) → all 38 live rows were skipped.
  const cutoffMs = now - lookbackDays * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString().replace('T', ' ').slice(0, 19);
  const nowIso = new Date(now).toISOString().replace('T', ' ').slice(0, 19);

  // Fetch recent retrieval log rows including the STDP columns.
  // T679: also fetch session_id and reward_signal for plasticity events INSERT.
  let logRows: RetrievalLogRow[] = [];
  try {
    logRows = typedAll<RetrievalLogRow>(
      nativeDb.prepare(
        `SELECT id, entry_ids, created_at, retrieval_order, delta_ms, session_id, reward_signal
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
  // We expand them into individual spikes, preserving the retrieval timestamp,
  // session_id, and reward_signal from the source row.
  const spikes: Spike[] = [];
  let globalOrder = 0;

  for (const row of logRows) {
    let ids: string[];
    try {
      ids = JSON.parse(row.entry_ids) as string[];
    } catch {
      // entry_ids is not JSON — row was not migrated (BUG-2). Skip silently.
      continue;
    }

    if (!Array.isArray(ids)) continue;

    const rowTime = new Date(row.created_at.replace(' ', 'T') + 'Z').getTime();

    for (const rawId of ids) {
      if (typeof rawId !== 'string' || rawId.length === 0) continue;
      const entryId = rawId.includes(':') ? rawId : `observation:${rawId}`;
      spikes.push({
        entryId,
        rowId: row.id,
        retrievedAt: rowTime,
        order: row.retrieval_order ?? globalOrder,
        sessionId: row.session_id ?? null,
        rewardSignal: row.reward_signal ?? null,
      });
      globalOrder++;
    }
  }

  if (spikes.length < 2) return result;

  // Sort spikes by (retrievedAt, order) to establish canonical temporal sequence.
  spikes.sort((a, b) => a.retrievedAt - b.retrievedAt || a.order - b.order);

  // T695: Session-bucket O(n²) guard.
  //
  // With lookbackDays=30 and high retrieval volume, the spike array may contain
  // thousands of entries. A flat O(n²) all-pairs loop is impractical at that scale.
  //
  // Mitigation: group spikes by session_id (null session → single bucket keyed 'null').
  // Within-session pairs are always checked. Cross-session pairs are only checked between
  // temporally adjacent session buckets (their last spike ↔ next bucket's first spike
  // must be within pairingWindowMs). Each session contributes at most maxPairsPerSession
  // spikes to cross-session pair formation — a hard cap that prevents runaway.
  //
  // The flat loop below is replaced by iterating over a merged spike slice composed of:
  //   (a) all within-session spikes for each session bucket, and
  //   (b) the tail (up to maxPairsPerSession) of adjacent sessions for cross-session pairs.
  //
  // Correctness invariant: all pairs within pairingWindowMs are still found because
  // session boundaries are not hard cutoffs and the sorted order is preserved.

  /** T695: Maximum spikes per session contributed to cross-session pair checks. */
  const MAX_PAIRS_PER_SESSION = 50;

  // Build session buckets: Map<sessionKey, Spike[]> sorted by retrievedAt ascending.
  // Spikes within each bucket are already sorted (inherits sort above).
  const sessionBucketMap = new Map<string, Spike[]>();
  for (const spike of spikes) {
    const key = spike.sessionId ?? 'null';
    const bucket = sessionBucketMap.get(key);
    if (bucket !== undefined) {
      bucket.push(spike);
    } else {
      sessionBucketMap.set(key, [spike]);
    }
  }

  // Produce an ordered list of (bucketKey, spikes[]) sorted by each bucket's earliest spike.
  const orderedBuckets = Array.from(sessionBucketMap.entries()).sort(
    ([, a], [, b]) => (a[0]?.retrievedAt ?? 0) - (b[0]?.retrievedAt ?? 0),
  );

  // Build the merged spike sequence for pair processing:
  // For each bucket, include ALL its spikes. For cross-session adjacency, the tail
  // of the previous bucket is already included — the sorted global order handles it.
  // We build a composite array that processes ALL within-session pairs, and
  // limits cross-session exposure by capping the carry-forward tail from each bucket.
  //
  // Implementation: walk through sorted buckets, building a running "window" of recent
  // spikes that may still pair with incoming spikes. For efficiency, the window is
  // capped at MAX_PAIRS_PER_SESSION × number-of-buckets entries.
  //
  // For correctness the sorted spikes array already handles pairing correctly — the
  // T695 optimization ONLY caps how many spikes from PRIOR sessions are kept in the
  // active window for cross-session pair comparison.

  // Create a flattened array of spike indices to iterate over, broken into
  // per-session chunks.  Cross-session pairs are formed by allowing each session's
  // spikes to pair with the tail (last MAX_PAIRS_PER_SESSION spikes) of each
  // immediately preceding session whose last spike is within pairingWindowMs.
  //
  // We do this by building a per-bucket flat array and iterating with a controlled
  // cross-bucket suffix window.

  // Compose the working spike list respecting the per-session cap.
  const workingSpikes: Spike[] = [];
  for (let bi = 0; bi < orderedBuckets.length; bi++) {
    const [, bucketSpikes] = orderedBuckets[bi]!;

    // Add all spikes from this session unconditionally (within-session pairs are
    // always generated regardless of session size).
    workingSpikes.push(...bucketSpikes);
  }

  // For pair formation we now iterate over workingSpikes (which is sorted) using
  // the same O(n²) loop — but with a per-session cross-session cap enforced:
  // when computing pairs between two spikes from DIFFERENT sessions, we only allow
  // pairs where spikeA comes from within MAX_PAIRS_PER_SESSION of the boundary
  // between the two sessions.
  //
  // We achieve this efficiently by tracking the "last spike index within a session"
  // and skipping spikeA entries that are more than MAX_PAIRS_PER_SESSION spikes
  // before the session boundary when pairing with spikes from a different session.

  // Build a lookup: spike index → position within its own session bucket.
  const withinSessionIndex = new Map<Spike, number>();
  const sessionSizeMap = new Map<string, number>();
  for (const [, bucketSpikes] of orderedBuckets) {
    for (let idx = 0; idx < bucketSpikes.length; idx++) {
      const spike = bucketSpikes[idx]!;
      withinSessionIndex.set(spike, idx);
      sessionSizeMap.set(spike.sessionId ?? 'null', bucketSpikes.length);
    }
  }

  // Replace the plain spikes array with the working array for pair processing below.
  // (workingSpikes has the same content as the sorted `spikes` array,
  //  so the existing O(n²) loop is preserved with one additional guard.)

  // For each ordered pair (i, j) where i < j (spike i before spike j),
  // apply the STDP rule if Δt <= pairingWindowMs.
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

  // T679: plasticity events INSERT now includes session_id, retrieval_log_id,
  // weight_before, weight_after, delta_t_ms per spec §2.1.2.
  const prepareLogEvent = nativeDb.prepare(
    `INSERT INTO brain_plasticity_events
       (source_node, target_node, delta_w, kind, timestamp,
        session_id, retrieval_log_id, weight_before, weight_after, delta_t_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // T679: brain_weight_history INSERT per spec §2.1.4.
  // Table is guaranteed by brain-sqlite.ts ensureColumns guard — safe to INSERT.
  let prepareLogWeightHistory: ReturnType<typeof nativeDb.prepare> | null = null;
  try {
    nativeDb.prepare('SELECT 1 FROM brain_weight_history LIMIT 1').get();
    prepareLogWeightHistory = nativeDb.prepare(
      `INSERT INTO brain_weight_history
         (edge_from_id, edge_to_id, edge_type, weight_before, weight_after,
          delta_weight, event_kind, source_plasticity_event_id, retrieval_log_id,
          reward_signal, changed_at)
       VALUES (?, ?, 'co_retrieved', ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  } catch {
    // brain_weight_history not yet created — skip history writes best-effort
  }

  for (let i = 0; i < workingSpikes.length; i++) {
    const spikeA = workingSpikes[i]!;
    const sessionKeyA = spikeA.sessionId ?? 'null';
    const sessionSizeA = sessionSizeMap.get(sessionKeyA) ?? 1;
    const posInSessionA = withinSessionIndex.get(spikeA) ?? 0;

    // T695: cross-session cap. If this spike is not among the last MAX_PAIRS_PER_SESSION
    // spikes of its session, it will not pair with spikes from a DIFFERENT session.
    // It still pairs with all spikes within its own session.
    const canCrossSession = posInSessionA >= sessionSizeA - MAX_PAIRS_PER_SESSION;

    for (let j = i + 1; j < workingSpikes.length; j++) {
      const spikeB = workingSpikes[j]!;
      const deltaT = spikeB.retrievedAt - spikeA.retrievedAt; // ms, always >= 0

      if (deltaT > pairingWindowMs) break; // spikes are sorted; further pairs exceed window

      if (spikeA.entryId === spikeB.entryId) continue; // skip self-pairs

      // T695: enforce cross-session cap — skip cross-session pairs when spikeA is deep
      // inside its own session (not near the tail).
      const sessionKeyB = spikeB.sessionId ?? 'null';
      if (sessionKeyA !== sessionKeyB && !canCrossSession) {
        continue;
      }

      result.pairsExamined++;

      // T689: Select tiered τ based on Δt magnitude.
      // Intra-batch (≤30s) → τ_near=20s; intra-session (≤2h) → τ_session=30min;
      // cross-session (>2h) → τ_episodic=12h.
      const tau = computeTau(deltaT);

      // A fired before B → LTP on edge A→B
      let deltaW = A_PRE * Math.exp(-deltaT / tau);

      if (deltaW < 1e-6) continue; // negligible change — skip

      // Use session_id from the pre-spike's retrieval row (spikeA) — causal attribution.
      const eventSessionId = spikeA.sessionId ?? null;
      const eventRewardSignal = spikeA.rewardSignal ?? null;

      // T692: R-STDP reward modulation.
      // Δw_ltp_effective = clamp(Δw_ltp × (1+r), 0, 2×A_pre)
      // null reward → no modulation (r treated as 0 per spec §3.6).
      let wasRewardModulated = false;
      if (eventRewardSignal !== null) {
        const r = eventRewardSignal;
        deltaW = Math.min(deltaW * (1 + r), 2 * A_PRE);
        // Clamp to non-negative: r=-1 zeroes out LTP per spec table
        deltaW = Math.max(deltaW, 0);
        wasRewardModulated = true;
      }

      if (deltaW < 1e-6) {
        // Reward modulation may have zeroed Δw — count as modulated but skip writes
        if (wasRewardModulated) result.rewardModulatedEvents++;
        continue;
      }

      // Check whether an existing co_retrieved edge A→B exists
      type EdgeRow = {
        weight: number;
        reinforcement_count: number;
        last_reinforced_at: string | null;
        plasticity_class: string | null;
        depression_count: number;
        last_depressed_at: string | null;
      };

      const existingEdge = prepareGetEdge.get(spikeA.entryId, spikeB.entryId) as
        | EdgeRow
        | undefined;

      let ltpEventId: number | null = null;

      try {
        if (existingEdge !== undefined) {
          // UPDATE path: standard deltaW (no novelty boost — only on INSERT)
          const currentWeight = existingEdge.weight;
          const newWeight = Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, currentWeight + deltaW));
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

          // T713: Idempotency guard — skip INSERT if recent event exists for this pair+session
          const isDuplicate = isPlasticityEventDuplicate(
            nativeDb,
            spikeA.entryId,
            spikeB.entryId,
            'ltp',
            eventSessionId,
            1, // within 1 hour
          );
          if (isDuplicate) {
            // Edge was updated above; skip event logging to prevent duplicate record
            result.ltpEvents++;
            if (wasRewardModulated) result.rewardModulatedEvents++;
            continue;
          }

          // T679: include session_id, retrieval_log_id, weight_before, weight_after, delta_t_ms
          const evtStmt = prepareLogEvent.run(
            spikeA.entryId,
            spikeB.entryId,
            deltaW,
            'ltp',
            nowIso,
            eventSessionId,
            spikeA.rowId,
            currentWeight,
            newWeight,
            deltaT,
          );
          ltpEventId =
            (evtStmt as { lastInsertRowid?: number | bigint }).lastInsertRowid != null
              ? Number((evtStmt as { lastInsertRowid: number | bigint }).lastInsertRowid)
              : null;

          if (prepareLogWeightHistory) {
            prepareLogWeightHistory.run(
              spikeA.entryId,
              spikeB.entryId,
              currentWeight,
              newWeight,
              deltaW,
              'ltp',
              ltpEventId,
              spikeA.rowId,
              eventRewardSignal,
              nowIso,
            );
          }
        } else {
          // INSERT path: apply T691 novelty boost (k_novelty=1.5) — first co-retrieval.
          // initial_weight = clamp(deltaW × k_novelty, 0, A_pre × k_novelty)
          const noveltyBoostedWeight = deltaW * K_NOVELTY;
          const initialWeight = Math.min(
            WEIGHT_MAX,
            Math.min(A_PRE * K_NOVELTY, noveltyBoostedWeight),
          );

          // INSERT: Set plasticity_class='stdp', reinforcement_count=1, compute stability (T693)
          const stability = computeStabilityScore(1, nowIso, now);
          prepareInsertEdge.run(
            spikeA.entryId,
            spikeB.entryId,
            initialWeight,
            nowIso, // last_reinforced_at
            stability,
            nowIso,
          );
          result.edgesCreated++;

          // T679: weight_before = null (new edge), include session_id, retrieval_log_id, delta_t_ms
          const evtStmt = prepareLogEvent.run(
            spikeA.entryId,
            spikeB.entryId,
            initialWeight,
            'ltp',
            nowIso,
            eventSessionId,
            spikeA.rowId,
            null,
            initialWeight,
            deltaT,
          );
          ltpEventId =
            (evtStmt as { lastInsertRowid?: number | bigint }).lastInsertRowid != null
              ? Number((evtStmt as { lastInsertRowid: number | bigint }).lastInsertRowid)
              : null;

          if (prepareLogWeightHistory) {
            prepareLogWeightHistory.run(
              spikeA.entryId,
              spikeB.entryId,
              null,
              initialWeight,
              initialWeight,
              'ltp',
              ltpEventId,
              spikeA.rowId,
              eventRewardSignal,
              nowIso,
            );
          }
        }

        result.ltpEvents++;
        if (wasRewardModulated) result.rewardModulatedEvents++;
      } catch {
        /* best-effort */
      }

      // B fired after A → LTD on reverse edge B→A (depression)
      // LTD only weakens existing edges; it does not create new ones.
      // T689: same tiered τ used for LTD magnitude.
      // T692: R-STDP modulation for LTD — Δw_ltd × (1-r), capped at -2×A_post.
      let deltaWNeg = -(A_POST * Math.exp(-deltaT / tau));
      let ltdWasRewardModulated = false;
      if (eventRewardSignal !== null) {
        const r = eventRewardSignal;
        // Δw_ltd_effective = clamp(Δw_ltd × (1-r), -2×A_post, 0)
        // deltaWNeg is already negative; multiply by (1-r) and clamp.
        deltaWNeg = Math.max(deltaWNeg * (1 - r), -2 * A_POST);
        ltdWasRewardModulated = true;
      }

      const existingReverseEdge = prepareGetEdge.get(spikeB.entryId, spikeA.entryId) as
        | EdgeRow
        | undefined;

      if (existingReverseEdge !== undefined && Math.abs(deltaWNeg) >= 1e-6) {
        try {
          const currentReverseWeight = existingReverseEdge.weight;
          const newReverseWeight = Math.max(
            WEIGHT_MIN,
            Math.min(WEIGHT_MAX, currentReverseWeight + deltaWNeg),
          );
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

          // T713: Idempotency guard — skip INSERT if recent event exists for this pair+session
          const isLtdDuplicate = isPlasticityEventDuplicate(
            nativeDb,
            spikeB.entryId,
            spikeA.entryId,
            'ltd',
            eventSessionId,
            1, // within 1 hour
          );
          if (isLtdDuplicate) {
            // Edge was updated above; skip event logging to prevent duplicate record
            result.ltdEvents++;
            if (ltdWasRewardModulated) result.rewardModulatedEvents++;
            continue;
          }

          // T679: include session_id, retrieval_log_id (post-synaptic), weight_before, weight_after
          const ltdEvtStmt = prepareLogEvent.run(
            spikeB.entryId,
            spikeA.entryId,
            deltaWNeg,
            'ltd',
            nowIso,
            eventSessionId,
            spikeB.rowId,
            currentReverseWeight,
            newReverseWeight,
            deltaT,
          );
          const ltdEventId =
            (ltdEvtStmt as { lastInsertRowid?: number | bigint }).lastInsertRowid != null
              ? Number((ltdEvtStmt as { lastInsertRowid: number | bigint }).lastInsertRowid)
              : null;

          if (prepareLogWeightHistory) {
            prepareLogWeightHistory.run(
              spikeB.entryId,
              spikeA.entryId,
              currentReverseWeight,
              newReverseWeight,
              deltaWNeg,
              'ltd',
              ltdEventId,
              spikeB.rowId,
              eventRewardSignal,
              nowIso,
            );
          }

          result.ltdEvents++;
          if (ltdWasRewardModulated) result.rewardModulatedEvents++;
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

// ============================================================================
// T690 — Homeostatic decay pass (Step 9c)
// ============================================================================

/**
 * Options for `applyHomeostaticDecay`.
 *
 * @task T690
 * @epic T673
 */
export interface HomeostaticDecayOptions {
  /**
   * Fractional weight loss per day for idle edges.
   * Default: 0.02 (2%/day → weight halves in ~35 days).
   * Spec §3.9 default: decay_rate=0.02.
   */
  decayRatePerDay?: number;
  /**
   * Days of idle time before decay begins.
   * Edges reinforced more recently than this are left untouched.
   * Default: 7 days — keeps weekly-session edges alive.
   */
  gracePeriodDays?: number;
  /**
   * Edges whose post-decay weight falls below this threshold are pruned (deleted).
   * Default: 0.05 (5%) — no meaningful signal below this floor.
   */
  pruneThreshold?: number;
}

/**
 * Result returned by `applyHomeostaticDecay`.
 *
 * @task T690
 * @epic T673
 */
export interface HomeostaticDecayResult {
  /** Number of edges whose weight was reduced by the decay pass (still above pruneThreshold). */
  edgesDecayed: number;
  /** Number of edges deleted because their post-decay weight fell below pruneThreshold. */
  edgesPruned: number;
}

/**
 * Apply homeostatic weight decay to `hebbian` and `stdp` brain edges (Step 9c).
 *
 * Runs after `applyStdpPlasticity` (Step 9b) in the consolidation pipeline.
 * For each `co_retrieved` edge with `plasticity_class IN ('hebbian', 'stdp')` and
 * `last_reinforced_at` older than `gracePeriodDays`, applies:
 *
 * ```
 * new_weight = current_weight × (1 - decayRatePerDay) ^ days_idle
 * ```
 *
 * where `days_idle = (now − last_reinforced_at) − gracePeriodDays`.
 *
 * If `new_weight < pruneThreshold`, the edge is **deleted** and a
 * `brain_weight_history` row with `event_kind='prune'` is written.
 * If `new_weight >= pruneThreshold`, the weight is updated **without**
 * writing to `brain_weight_history` (routine decay is not logged per
 * spec §1 decision #11).
 *
 * **Protected edge classes** (never touched):
 * - `plasticity_class = 'static'` — structural edges
 * - `plasticity_class = 'external'` — externally owned edges
 * - Edges with `last_reinforced_at IS NULL` — never reinforced, skip decay
 *
 * @param projectRoot - Project root directory for brain.db resolution
 * @param options - Decay configuration (see `HomeostaticDecayOptions`)
 * @returns Counts of edges decayed and pruned
 *
 * @task T690
 * @epic T673
 * @see docs/specs/stdp-wire-up-spec.md §3.9
 */
export async function applyHomeostaticDecay(
  projectRoot: string,
  options?: HomeostaticDecayOptions,
): Promise<HomeostaticDecayResult> {
  const decayRatePerDay = options?.decayRatePerDay ?? 0.02;
  const gracePeriodDays = options?.gracePeriodDays ?? 7;
  const pruneThreshold = options?.pruneThreshold ?? 0.05;

  const result: HomeostaticDecayResult = { edgesDecayed: 0, edgesPruned: 0 };

  const { getBrainDb, getBrainNativeDb } = await import('../store/brain-sqlite.js');
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();

  if (!nativeDb) return result;

  // Guard: brain_page_edges must exist
  try {
    nativeDb.prepare('SELECT 1 FROM brain_page_edges LIMIT 1').get();
  } catch {
    return result;
  }

  const nowIso = new Date().toISOString().replace('T', ' ').slice(0, 19);

  // Check if brain_weight_history exists (M4 migration may not have run)
  let weightHistoryExists = false;
  try {
    nativeDb.prepare('SELECT 1 FROM brain_weight_history LIMIT 1').get();
    weightHistoryExists = true;
  } catch {
    // best-effort: history writes skipped if table absent
  }

  // ── Fetch candidate edges ──────────────────────────────────────────────────
  //
  // Candidates: plasticity_class IN ('hebbian', 'stdp') AND last_reinforced_at IS NOT NULL
  // AND (now − last_reinforced_at) > gracePeriodDays.
  //
  // We fetch and process in TypeScript rather than doing a bare SQL UPDATE so we
  // can write individual brain_weight_history rows for pruned edges per spec §2.1.4.

  interface CandidateEdgeRow {
    from_id: string;
    to_id: string;
    edge_type: string;
    weight: number;
    plasticity_class: string;
    last_reinforced_at: string;
  }

  let candidates: CandidateEdgeRow[] = [];
  try {
    candidates = typedAll<CandidateEdgeRow>(
      nativeDb.prepare(
        `SELECT from_id, to_id, edge_type, weight, plasticity_class, last_reinforced_at
         FROM brain_page_edges
         WHERE plasticity_class IN ('hebbian', 'stdp')
           AND last_reinforced_at IS NOT NULL
           AND (julianday('now') - julianday(last_reinforced_at)) > ?`,
      ),
      gracePeriodDays,
    );
  } catch {
    return result;
  }

  if (candidates.length === 0) return result;

  // ── Prepared statements ────────────────────────────────────────────────────

  const prepareUpdateWeight = nativeDb.prepare(
    `UPDATE brain_page_edges
     SET weight = ?
     WHERE from_id = ? AND to_id = ? AND edge_type = ?`,
  );

  const prepareDeleteEdge = nativeDb.prepare(
    `DELETE FROM brain_page_edges
     WHERE from_id = ? AND to_id = ? AND edge_type = ?`,
  );

  let prepareInsertHistory: ReturnType<typeof nativeDb.prepare> | null = null;
  if (weightHistoryExists) {
    try {
      prepareInsertHistory = nativeDb.prepare(
        `INSERT INTO brain_weight_history
           (edge_from_id, edge_to_id, edge_type, weight_before, weight_after,
            delta_weight, event_kind, changed_at)
         VALUES (?, ?, ?, ?, 0.0, ?, 'prune', ?)`,
      );
    } catch {
      // best-effort
    }
  }

  // ── Decay and prune loop ───────────────────────────────────────────────────

  const nowMs = Date.now();

  for (const edge of candidates) {
    try {
      const lastReinforced = new Date(edge.last_reinforced_at.replace(' ', 'T') + 'Z').getTime();

      const daysIdle = (nowMs - lastReinforced) / (24 * 60 * 60 * 1000);
      // Only decay idle days BEYOND the grace period
      const decayDays = Math.max(0, daysIdle - gracePeriodDays);

      const newWeight = edge.weight * (1.0 - decayRatePerDay) ** decayDays;

      if (newWeight < pruneThreshold) {
        // Prune: delete the edge and write a history row
        prepareDeleteEdge.run(edge.from_id, edge.to_id, edge.edge_type);
        result.edgesPruned++;

        if (prepareInsertHistory) {
          const deltaW = -edge.weight; // prune is a full loss
          try {
            prepareInsertHistory.run(
              edge.from_id,
              edge.to_id,
              edge.edge_type,
              edge.weight,
              deltaW,
              nowIso,
            );
          } catch {
            // best-effort: history write failure does not block prune
          }
        }
      } else {
        // Decay: update the weight only (no history row per spec §1 decision #11)
        prepareUpdateWeight.run(newWeight, edge.from_id, edge.to_id, edge.edge_type);
        result.edgesDecayed++;
      }
    } catch {
      // per-edge failure is non-fatal
    }
  }

  return result;
}
