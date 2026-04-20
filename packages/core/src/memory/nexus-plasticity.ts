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
// Weight increment constant
// ---------------------------------------------------------------------------

/** Increment applied to `weight` per co-access event. */
const WEIGHT_INCREMENT = 0.05;

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
// Co-access pair extraction from brain retrieval log
// ---------------------------------------------------------------------------

interface RetrievalLogRow {
  entry_ids: string;
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
 * @param projectRoot - Project root for brain.db resolution.
 * @param lookbackDays - How far back in time to scan retrieval events.
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
    let ids: string[];
    try {
      ids = JSON.parse(row.entry_ids) as string[];
    } catch {
      continue;
    }
    if (!Array.isArray(ids) || ids.length < 2) continue;

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
