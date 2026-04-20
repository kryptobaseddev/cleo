/**
 * NEXUS plasticity — Hebbian co-access strengthening for nexus_relations edges.
 *
 * Implements "fire together, wire together": each time two nodes are
 * co-accessed during BRAIN retrieval, the directed edge(s) between them in
 * nexus_relations gain plasticity weight.  Weight is capped at 1.0 to prevent
 * runaway strengthening.
 *
 * Designed as Step 6b in runConsolidation (brain-lifecycle.ts) so every
 * nexus-backed read passively strengthens the code-graph edges that
 * participated in that retrieval.
 *
 * @task T998
 * @epic T991
 */

import { typedAll } from '../store/typed-query.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A directed edge pair to strengthen. */
export interface NexusEdgePair {
  /** Source node ID as stored in nexus_relations.source_id. */
  sourceId: string;
  /** Target node ID as stored in nexus_relations.target_id. */
  targetId: string;
}

/** Result from a strengthenNexusCoAccess call. */
export interface StrengthNexusResult {
  /** Number of rows updated (edges that existed and were strengthened). */
  strengthened: number;
  /** Number of pairs that had no matching row in nexus_relations (skipped). */
  skipped: number;
}

// ---------------------------------------------------------------------------
// Weight increment constant and decay configuration
// ---------------------------------------------------------------------------

/** Increment applied to `weight` per co-access event. */
const WEIGHT_INCREMENT = 0.05;

/** Default plasticity half-life in days (configurable via CLEO_PLASTICITY_HALFLIFE_DAYS env var). */
const DEFAULT_PLASTICITY_HALFLIFE_DAYS = 14;

/** Result from applying plasticity decay. */
export interface PlasticityDecayResult {
  /** Number of rows updated in nexus_relations. */
  updated: number;
  /** Half-life used for decay calculation (days). */
  halfLifeDays: number;
  /** Decay factor applied per day (0–1). */
  decayPerDay: number;
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * Strengthen nexus_relations edges for co-accessed node pairs.
 *
 * For each `{sourceId, targetId}` pair, performs:
 * ```sql
 * UPDATE nexus_relations
 * SET weight          = MIN(1.0, weight + 0.05),
 *     co_accessed_count = co_accessed_count + 1,
 *     last_accessed_at  = datetime('now')
 * WHERE source_id = ? AND target_id = ?
 * ```
 *
 * Only updates rows that already exist — never inserts.  This keeps the
 * plasticity pass additive and non-destructive: if a pair does not yet have
 * a code-graph edge, it is silently skipped (recorded in `result.skipped`).
 *
 * This function is safe to call from any consolidation context.  It
 * gracefully no-ops when nexus.db has not been initialised (returns zeros).
 *
 * @param pairs - Array of source/target ID pairs to strengthen.
 * @returns Counts of strengthened and skipped pairs.
 *
 * @example
 * ```typescript
 * const result = await strengthenNexusCoAccess([
 *   { sourceId: 'src/foo.ts::bar', targetId: 'src/baz.ts::qux' },
 * ]);
 * // result.strengthened → 1 (if edge existed)
 * // result.skipped      → 0
 * ```
 */
export async function strengthenNexusCoAccess(
  pairs: NexusEdgePair[],
): Promise<StrengthNexusResult> {
  if (pairs.length === 0) return { strengthened: 0, skipped: 0 };

  const { getNexusNativeDb } = await import('../store/nexus-sqlite.js');
  const nativeDb = getNexusNativeDb();
  if (!nativeDb) return { strengthened: 0, skipped: 0 };

  // Verify the plasticity columns exist before attempting updates (safety net
  // for databases that haven't run the T998 migration yet).
  try {
    nativeDb.prepare('SELECT weight FROM nexus_relations LIMIT 1').get();
  } catch {
    // Column not present — migration hasn't run yet.  No-op gracefully.
    return { strengthened: 0, skipped: 0 };
  }

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  let strengthened = 0;
  let skipped = 0;

  const stmt = nativeDb.prepare(`
    UPDATE nexus_relations
    SET weight            = MIN(1.0, COALESCE(weight, 0.0) + ${WEIGHT_INCREMENT}),
        co_accessed_count = COALESCE(co_accessed_count, 0) + 1,
        last_accessed_at  = ?
    WHERE source_id = ? AND target_id = ?
  `);

  for (const pair of pairs) {
    try {
      const result = stmt.run(now, pair.sourceId, pair.targetId);
      const changes = typeof result.changes === 'number' ? result.changes : 0;
      if (changes > 0) {
        strengthened++;
      } else {
        skipped++;
      }
    } catch {
      // Best-effort per pair — do not abort the whole batch.
      skipped++;
    }
  }

  return { strengthened, skipped };
}

// ---------------------------------------------------------------------------
// Plasticity decay (time-based weight reduction)
// ---------------------------------------------------------------------------

/**
 * Apply temporal decay to nexus_relations plasticity weights.
 *
 * Weights decay exponentially based on days since last access using a
 * configurable half-life. Formula:
 * ```
 * new_weight = weight * (0.5 ^ (daysSinceLastAccess / halfLifeDays))
 * ```
 *
 * The half-life can be configured via the `CLEO_PLASTICITY_HALFLIFE_DAYS`
 * environment variable (default 14 days). This matches the development
 * cadence of typical projects: edges unused for 14 days halve their weight,
 * unused for 28 days drop to 0.25, and so on.
 *
 * Only updates rows where `last_accessed_at` is not NULL — new edges
 * with no access record are left unchanged.
 *
 * @param projectRoot - Project root directory for nexus.db resolution
 * @returns Decay result including row count and parameters used
 *
 * @example
 * ```typescript
 * const result = await applyPlasticityDecay(projectRoot);
 * console.log(`Decayed ${result.updated} edges with ${result.halfLifeDays}-day half-life`);
 * ```
 */
export async function applyPlasticityDecay(_projectRoot: string): Promise<PlasticityDecayResult> {
  const { getNexusNativeDb } = await import('../store/nexus-sqlite.js');
  const nativeDb = getNexusNativeDb();
  if (!nativeDb) {
    return {
      updated: 0,
      halfLifeDays: DEFAULT_PLASTICITY_HALFLIFE_DAYS,
      decayPerDay: 1 - 0.5 ** (1 / DEFAULT_PLASTICITY_HALFLIFE_DAYS),
    };
  }

  // Read half-life from environment variable or use default (14 days).
  const halfLifeDays = Number.parseFloat(
    process.env.CLEO_PLASTICITY_HALFLIFE_DAYS ?? String(DEFAULT_PLASTICITY_HALFLIFE_DAYS),
  );
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) {
    return {
      updated: 0,
      halfLifeDays: DEFAULT_PLASTICITY_HALFLIFE_DAYS,
      decayPerDay: 1 - 0.5 ** (1 / DEFAULT_PLASTICITY_HALFLIFE_DAYS),
    };
  }

  // Calculate per-day decay factor: λ = 1 - 0.5^(1/halfLifeDays)
  // This ensures weight = weight * 0.5 after halfLifeDays of decay.
  const decayPerDay = 1 - 0.5 ** (1 / halfLifeDays);

  // Verify the plasticity columns exist before attempting updates.
  try {
    nativeDb.prepare('SELECT weight, last_accessed_at FROM nexus_relations LIMIT 1').get();
  } catch {
    // Columns not present — migration hasn't run yet. No-op gracefully.
    return {
      updated: 0,
      halfLifeDays,
      decayPerDay,
    };
  }

  // Apply decay to all edges with a non-NULL last_accessed_at.
  // SQLite's julianday('now') - julianday(last_accessed_at) gives days since access.
  // decay_factor = 0.5 ^ (days / halfLifeDays) = 2 ^ (-days / halfLifeDays)
  // This is implemented as: weight * EXP(LN(0.5) * julianday(...) / halfLifeDays)
  const stmt = nativeDb.prepare(`
    UPDATE nexus_relations
    SET weight = MAX(0.0, weight * EXP(LN(0.5) * (julianday('now') - julianday(last_accessed_at)) / ?))
    WHERE last_accessed_at IS NOT NULL AND weight > 0.001
  `);

  try {
    const result = stmt.run(halfLifeDays);
    const updated = typeof result.changes === 'number' ? result.changes : 0;
    return { updated, halfLifeDays, decayPerDay };
  } catch {
    // Best-effort: if the query fails, return zeros
    return { updated: 0, halfLifeDays, decayPerDay };
  }
}

// ---------------------------------------------------------------------------
// Co-access pair extraction from brain retrieval log
// ---------------------------------------------------------------------------

interface RetrievalLogRow {
  entry_ids: string;
}

/**
 * Parse entry_ids which may be either JSON array or comma-separated string (BUG-2 fix).
 *
 * @param raw - Raw entry_ids value from brain_retrieval_log
 * @returns Parsed array of entry IDs, or empty array if parse fails
 */
function parseEntryIds(raw: string): string[] {
  const trimmed = raw.trim();
  // Try JSON array first
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as string[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  // Fall back to comma-separated (legacy format from pre-migration data)
  return trimmed
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Extract nexus node ID pairs from the brain_retrieval_log that were
 * co-retrieved in the same search session.
 *
 * Used by Step 6b in runConsolidation to derive which nexus edges to
 * strengthen from recent BRAIN retrieval activity.
 *
 * The entry_ids column stores a JSON array of brain entry IDs (e.g.,
 * `["D-abc", "L-def", "O-ghi"]`).  These are mapped to nexus node IDs
 * via the brain-nexus bridge (brain_page_edges of type `documents` /
 * `applies_to`).  When no bridge data is available, the raw brain IDs
 * are returned as-is — callers should filter non-node-format IDs before
 * passing to nexus_relations.
 *
 * BUG-1 fix: The lookback window is separate from insertion timestamp.
 * Consolidation scans retrieval events within `lookbackDays` of now.
 *
 * @param projectRoot - Project root for brain.db resolution.
 * @param lookbackDays - How far back in time to scan retrieval events (default 30 days).
 * @returns Deduplicated source/target pairs ready for strengthenNexusCoAccess.
 */
export async function extractNexusPairsFromRetrievalLog(
  projectRoot: string,
  lookbackDays = 30,
): Promise<NexusEdgePair[]> {
  const { getBrainDb, getBrainNativeDb } = await import('../store/memory-sqlite.js');
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();
  if (!nativeDb) return [];

  // Check if retrieval log table exists.
  try {
    nativeDb.prepare('SELECT 1 FROM brain_retrieval_log LIMIT 1').get();
  } catch {
    return [];
  }

  // BUG-1 fix: Use lookbackDays to determine the time window, separate from insertion timestamp.
  // This allows for configurable lookback without conflating with log insertion timing.
  const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);

  let rows: RetrievalLogRow[] = [];
  try {
    rows = typedAll<RetrievalLogRow>(
      nativeDb.prepare(
        `SELECT entry_ids FROM brain_retrieval_log WHERE created_at >= ? LIMIT 1000`,
      ),
      cutoff,
    );
  } catch {
    return [];
  }

  // Build deduplicated pair set: canonical order (a < b) to avoid duplicates.
  const seen = new Set<string>();
  const pairs: NexusEdgePair[] = [];

  for (const row of rows) {
    // BUG-2 fix: handle both JSON array and comma-separated formats
    const ids = parseEntryIds(row.entry_ids);
    if (ids.length < 2) continue;

    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i];
        const b = ids[j];
        if (!a || !b) continue;
        // Emit both directions so both directed edges get strengthened.
        const fwd = `${a}|${b}`;
        const rev = `${b}|${a}`;
        if (!seen.has(fwd)) {
          seen.add(fwd);
          pairs.push({ sourceId: a, targetId: b });
        }
        if (!seen.has(rev)) {
          seen.add(rev);
          pairs.push({ sourceId: b, targetId: a });
        }
      }
    }
  }

  return pairs;
}
