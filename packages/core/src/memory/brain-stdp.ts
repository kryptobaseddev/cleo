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
    `SELECT weight FROM brain_page_edges
     WHERE from_id = ? AND to_id = ? AND edge_type = 'co_retrieved'`,
  );

  const prepareUpdateEdge = nativeDb.prepare(
    `UPDATE brain_page_edges
     SET weight = MAX(?, MIN(?, weight + ?))
     WHERE from_id = ? AND to_id = ? AND edge_type = 'co_retrieved'`,
  );

  const prepareInsertEdge = nativeDb.prepare(
    `INSERT OR IGNORE INTO brain_page_edges
       (from_id, to_id, edge_type, weight, provenance, created_at)
     VALUES (?, ?, 'co_retrieved', ?, 'plasticity:stdp-ltp', ?)`,
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
        | { weight: number }
        | undefined;

      try {
        if (existingEdge !== undefined) {
          prepareUpdateEdge.run(WEIGHT_MIN, WEIGHT_MAX, deltaW, spikeA.entryId, spikeB.entryId);
        } else {
          // Insert new edge with initial LTP weight (capped at WEIGHT_MAX)
          const initialWeight = Math.min(WEIGHT_MAX, deltaW);
          prepareInsertEdge.run(spikeA.entryId, spikeB.entryId, initialWeight, nowIso);
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
        | { weight: number }
        | undefined;

      if (existingReverseEdge !== undefined && Math.abs(deltaWNeg) >= 1e-6) {
        try {
          prepareUpdateEdge.run(WEIGHT_MIN, WEIGHT_MAX, deltaWNeg, spikeB.entryId, spikeA.entryId);
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
