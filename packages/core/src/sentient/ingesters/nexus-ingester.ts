/**
 * Nexus Ingester — Tier-2 proposal candidate source.
 *
 * Queries nexus.db for structural anomalies and returns ranked
 * ProposalCandidate[]. Two query patterns:
 *
 *   A. Orphaned callees: functions that have many callers but make no calls
 *      themselves (zero-import, high-in-degree). Suggests dead-end sinks
 *      that may be candidates for abstraction or documentation.
 *
 *   B. Over-coupled nodes: symbols with total degree (in + out edges) > 20,
 *      suggesting high coupling that should be refactored.
 *
 * Design principles:
 * - NO LLM calls. All data comes from structured SQL queries.
 * - Title is template-generated: `[T2-NEXUS] ...`. Prompt-injection defence.
 * - Failures are swallowed: returns empty array + logs warning.
 *   Nexus.db absence must never crash the propose tick.
 *
 * @task T1008
 * @see ADR-054 — Sentient Loop Tier-2
 */

import type { DatabaseSync } from 'node:sqlite';
import type { ProposalCandidate } from '@cleocode/contracts';

// ---------------------------------------------------------------------------
// Raw row types
// ---------------------------------------------------------------------------

interface OrphanCalleeRow {
  id: string;
  name: string;
  file_path: string;
  caller_count: number;
}

interface HighDegreeRow {
  id: string;
  name: string;
  file_path: string;
  degree: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Base weight for all nexus candidates (structural signals, lower priority than brain). */
export const NEXUS_BASE_WEIGHT = 0.3;

/** Minimum caller count for orphaned-callee detection. */
export const NEXUS_MIN_CALLER_COUNT = 5;

/** Minimum total degree for over-coupling detection. */
export const NEXUS_MIN_DEGREE = 20;

/** Maximum results per query. */
export const NEXUS_QUERY_LIMIT = 5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute a deduplication key that is stable across query A and query B.
 * Both queries reference the same nexus node table, so using the node id
 * directly as sourceId is sufficient.
 */
function toFingerprint(nodeId: string): string {
  return nodeId;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the Nexus ingester against the provided DatabaseSync handle.
 *
 * Returns candidates from both orphaned-callee (Query A) and high-degree
 * (Query B) detection, merged without duplication. Returns an empty array
 * if the database has no matching entries or if any error occurs.
 *
 * @param nativeDb - Open DatabaseSync handle to nexus.db. May be null if
 *   nexus.db has not been initialised; this is treated as zero candidates.
 * @returns Ranked ProposalCandidate array (may be empty).
 */
export function runNexusIngester(nativeDb: DatabaseSync | null): ProposalCandidate[] {
  if (!nativeDb) {
    return [];
  }

  const seenIds = new Set<string>();
  const candidates: ProposalCandidate[] = [];

  try {
    // Query A: orphaned callees (many callers, zero outbound calls).
    const stmtA = nativeDb.prepare(`
      SELECT n.id, n.name, n.file_path, COUNT(r.id) as caller_count
      FROM nexus_nodes n
      JOIN nexus_relations r ON r.target_id = n.id AND r.kind = 'calls'
      WHERE NOT EXISTS (
        SELECT 1 FROM nexus_relations r2
        WHERE r2.source_id = n.id AND r2.kind = 'calls'
      )
      AND n.kind = 'function'
      GROUP BY n.id
      HAVING caller_count > :minCallers
      ORDER BY caller_count DESC
      LIMIT :limit
    `);

    const rowsA = stmtA.all({
      minCallers: NEXUS_MIN_CALLER_COUNT,
      limit: NEXUS_QUERY_LIMIT,
    }) as unknown as OrphanCalleeRow[];

    for (const row of rowsA) {
      const fp = toFingerprint(row.id);
      if (seenIds.has(fp)) continue;
      seenIds.add(fp);
      candidates.push({
        source: 'nexus' as const,
        sourceId: row.id,
        title: `[T2-NEXUS] Over-coupled symbol: ${row.name} (${row.caller_count} callers)`,
        rationale: `Function ${row.name} in ${row.file_path} has ${row.caller_count} callers but makes no outbound calls — review for abstraction opportunity`,
        weight: NEXUS_BASE_WEIGHT,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[sentient/nexus-ingester] WARNING query A: ${message}\n`);
  }

  try {
    // Query B: high-degree nodes (over-coupling).
    const stmtB = nativeDb.prepare(`
      SELECT n.id, n.name, n.file_path, COUNT(r.id) as degree
      FROM nexus_nodes n
      JOIN nexus_relations r ON r.source_id = n.id OR r.target_id = n.id
      GROUP BY n.id
      HAVING degree > :minDegree
      ORDER BY degree DESC
      LIMIT :limit
    `);

    const rowsB = stmtB.all({
      minDegree: NEXUS_MIN_DEGREE,
      limit: NEXUS_QUERY_LIMIT,
    }) as unknown as HighDegreeRow[];

    for (const row of rowsB) {
      const fp = toFingerprint(row.id);
      if (seenIds.has(fp)) continue;
      seenIds.add(fp);
      candidates.push({
        source: 'nexus' as const,
        sourceId: row.id,
        title: `[T2-NEXUS] Over-coupled symbol: ${row.name} (${row.degree} edges)`,
        rationale: `Symbol ${row.name} in ${row.file_path} has ${row.degree} total edges — review for over-coupling`,
        weight: NEXUS_BASE_WEIGHT,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[sentient/nexus-ingester] WARNING query B: ${message}\n`);
  }

  return candidates;
}
