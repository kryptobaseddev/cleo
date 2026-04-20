/**
 * Nexus Ingester — Tier-2 proposal candidate source.
 *
 * Queries nexus.db for structural anomalies and returns ranked
 * ProposalCandidate[]. Five query patterns:
 *
 *   A. Orphaned callees: functions that have many callers but make no calls
 *      themselves (zero-import, high-in-degree). Suggests dead-end sinks
 *      that may be candidates for abstraction or documentation.
 *
 *   B. Over-coupled nodes: symbols with total degree (in + out edges) > 20,
 *      suggesting high coupling that should be refactored.
 *
 *   C. Community fragmentation: community's symbol count dropped >20% since
 *      last snapshot → potential broken module boundary.
 *
 *   D. Entry-point erosion: process node where `entry_point_of` source is
 *      now unexported → potential dead process definition.
 *
 *   E. Cross-community coupling spike: symbol with degree > 30 and
 *      cross_community_edge_count > 15 → extract-module candidate.
 *
 * Design principles:
 * - NO LLM calls. All data comes from structured SQL queries.
 * - Title is template-generated: `[T2-NEXUS] ...`. Prompt-injection defence.
 * - Failures are swallowed: returns empty array + logs warning.
 *   Nexus.db absence must never crash the propose tick.
 * - Community snapshots stored in nexus_schema_meta (k/v) with key
 *   `community_snapshot_json`. First analyze run has no baseline.
 *
 * @task T1008
 * @task T1070
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

interface CommunityFragmentationRow {
  community_id: string;
  community_label: string;
  current_count: number;
}

interface EntryPointErosionRow {
  process_id: string;
  process_label: string;
  entry_function_id: string;
  entry_function_name: string;
  is_exported: number;
}

interface CrossCommunityRow {
  id: string;
  name: string;
  file_path: string;
  degree: number;
  cross_community_edge_count: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Base weight for all nexus candidates (structural signals, lower priority than brain). */
export const NEXUS_BASE_WEIGHT = 0.3;

/** Weight for community fragmentation detection (Query C). */
export const NEXUS_COMMUNITY_FRAGMENTATION_WEIGHT = 0.4;

/** Weight for entry-point erosion detection (Query D). */
export const NEXUS_ENTRY_EROSION_WEIGHT = 0.5;

/** Weight for cross-community coupling spike detection (Query E). */
export const NEXUS_CROSS_COUPLING_WEIGHT = 0.35;

/** Minimum caller count for orphaned-callee detection (Query A). */
export const NEXUS_MIN_CALLER_COUNT = 5;

/** Minimum total degree for over-coupling detection (Query B). */
export const NEXUS_MIN_DEGREE = 20;

/** Minimum degree for cross-community coupling detection (Query E). */
export const NEXUS_MIN_CROSS_COUPLING_DEGREE = 30;

/** Minimum cross-community edge count for coupling spike detection (Query E). */
export const NEXUS_MIN_CROSS_COMMUNITY_EDGES = 15;

/** Threshold for community symbol count drop (Query C). */
export const NEXUS_COMMUNITY_SHRINK_THRESHOLD = 0.2; // 20%

/** Maximum results per query. */
export const NEXUS_QUERY_LIMIT = 5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute a deduplication key that is stable across all queries.
 * Both queries reference the same nexus node table, so using the node id
 * directly as sourceId is sufficient.
 */
function toFingerprint(nodeId: string): string {
  return nodeId;
}

/**
 * Log an audit event to nexus_audit_log for proposal detection.
 *
 * @param nativeDb - Open DatabaseSync handle.
 * @param action - Action name, e.g. 'sentient.nexus.proposal.community_fragmentation'.
 * @param detailsJson - JSON object with detection details.
 */
function logAuditEvent(
  nativeDb: DatabaseSync,
  action: string,
  detailsJson: Record<string, unknown>,
): void {
  try {
    const stmtInsert = nativeDb.prepare(`
      INSERT INTO nexus_audit_log (id, timestamp, action, details_json)
      VALUES (:id, datetime('now'), :action, :details_json)
    `);
    stmtInsert.run({
      id: `audit_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      action,
      details_json: JSON.stringify(detailsJson),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[sentient/nexus-ingester] WARNING audit log: ${message}\n`);
  }
}

/**
 * Load the current community snapshot from nexus_schema_meta.
 *
 * @param nativeDb - Open DatabaseSync handle.
 * @returns Snapshot as Record<communityId, symbolCount> or empty object if not found.
 */
function loadCommunitySnapshot(nativeDb: DatabaseSync): Record<string, number> {
  try {
    const stmt = nativeDb.prepare(`
      SELECT value FROM nexus_schema_meta WHERE key = 'community_snapshot_json'
    `);
    const row = stmt.get() as { value: string } | undefined;
    if (!row) {
      return {};
    }
    return JSON.parse(row.value) as Record<string, number>;
  } catch (_err) {
    return {};
  }
}

/**
 * Save a new community snapshot to nexus_schema_meta.
 *
 * @param nativeDb - Open DatabaseSync handle.
 * @param snapshot - Record<communityId, symbolCount>.
 */
function saveCommunitySnapshot(nativeDb: DatabaseSync, snapshot: Record<string, number>): void {
  try {
    const stmtDelete = nativeDb.prepare(`
      DELETE FROM nexus_schema_meta WHERE key = 'community_snapshot_json'
    `);
    stmtDelete.run();

    const stmtInsert = nativeDb.prepare(`
      INSERT INTO nexus_schema_meta (key, value) VALUES (:key, :value)
    `);
    stmtInsert.run({
      key: 'community_snapshot_json',
      value: JSON.stringify(snapshot),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[sentient/nexus-ingester] WARNING snapshot save: ${message}\n`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the Nexus ingester against the provided DatabaseSync handle.
 *
 * Returns candidates from five detection patterns:
 * - Query A: orphaned callees (many callers, zero outbound calls)
 * - Query B: over-coupled nodes (high-degree symbols)
 * - Query C: community fragmentation (symbol count drop >20%)
 * - Query D: entry-point erosion (unexported process entry points)
 * - Query E: cross-community coupling spike (degree > 30 with >15 cross-edges)
 *
 * Merged without duplication. Returns an empty array if the database has no
 * matching entries or if any error occurs.
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

  try {
    // Query C: community fragmentation (symbol count dropped >20% since last snapshot).
    const oldSnapshot = loadCommunitySnapshot(nativeDb);
    const stmtC = nativeDb.prepare(`
      SELECT n.community_id, n.label as community_label, COUNT(n.id) as current_count
      FROM nexus_nodes n
      WHERE n.community_id IS NOT NULL
      GROUP BY n.community_id
    `);

    const rowsC = stmtC.all() as unknown as CommunityFragmentationRow[];
    const newSnapshot: Record<string, number> = {};

    for (const row of rowsC) {
      const communityId = row.community_id;
      newSnapshot[communityId] = row.current_count;

      // Only emit proposal if we have a previous snapshot to compare against.
      if (oldSnapshot[communityId] !== undefined) {
        const oldCount = oldSnapshot[communityId];
        const shrinkPercent = (oldCount - row.current_count) / oldCount;

        if (shrinkPercent > NEXUS_COMMUNITY_SHRINK_THRESHOLD) {
          const fp = toFingerprint(communityId);
          if (seenIds.has(fp)) continue;
          seenIds.add(fp);

          const percentStr = Math.round(shrinkPercent * 100);
          candidates.push({
            source: 'nexus' as const,
            sourceId: communityId,
            title: `[T2-NEXUS] Community fragmentation: ${row.community_label} shrunk ${percentStr}%`,
            rationale: `Community ${row.community_label} (${communityId}) has ${row.current_count} symbols (was ${oldCount}) — possible broken module boundary or dead code.`,
            weight: NEXUS_COMMUNITY_FRAGMENTATION_WEIGHT,
          });

          logAuditEvent(nativeDb, 'sentient.nexus.proposal.community_fragmentation', {
            community_id: communityId,
            community_label: row.community_label,
            old_count: oldCount,
            current_count: row.current_count,
            shrink_percent: shrinkPercent,
          });
        }
      }
    }

    // Save new snapshot for next run.
    saveCommunitySnapshot(nativeDb, newSnapshot);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[sentient/nexus-ingester] WARNING query C: ${message}\n`);
  }

  try {
    // Query D: entry-point erosion (process where entry_point_of source is now unexported).
    const stmtD = nativeDb.prepare(`
      SELECT
        p.id as process_id,
        p.label as process_label,
        ep.source_id as entry_function_id,
        n.name as entry_function_name,
        n.is_exported
      FROM nexus_nodes p
      JOIN nexus_relations ep ON p.id = ep.target_id AND ep.type = 'entry_point_of'
      JOIN nexus_nodes n ON ep.source_id = n.id
      WHERE p.kind = 'process' AND n.is_exported = 0
      LIMIT :limit
    `);

    const rowsD = stmtD.all({
      limit: NEXUS_QUERY_LIMIT,
    }) as unknown as EntryPointErosionRow[];

    for (const row of rowsD) {
      const fp = toFingerprint(row.process_id);
      if (seenIds.has(fp)) continue;
      seenIds.add(fp);

      candidates.push({
        source: 'nexus' as const,
        sourceId: row.process_id,
        title: `[T2-NEXUS] Entry-point erosion: process ${row.process_label} entry is unexported`,
        rationale: `Process ${row.process_label} (${row.process_id}) points to unexported function ${row.entry_function_name} — verify process is still active.`,
        weight: NEXUS_ENTRY_EROSION_WEIGHT,
      });

      logAuditEvent(nativeDb, 'sentient.nexus.proposal.entry_point_erosion', {
        process_id: row.process_id,
        process_label: row.process_label,
        entry_function_id: row.entry_function_id,
        entry_function_name: row.entry_function_name,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[sentient/nexus-ingester] WARNING query D: ${message}\n`);
  }

  try {
    // Query E: cross-community coupling spike (post-processed in memory).
    // Symbol with degree > 30 AND cross_community_edge_count > 15.

    // First, get all nodes in communities with their degrees
    const stmtNodeDegrees = nativeDb.prepare(`
      SELECT
        n.id,
        n.name,
        n.file_path,
        n.community_id,
        COUNT(r.id) as degree
      FROM nexus_nodes n
      LEFT JOIN nexus_relations r ON r.source_id = n.id OR r.target_id = n.id
      WHERE n.community_id IS NOT NULL
      GROUP BY n.id
      HAVING degree > :minDegree
      ORDER BY degree DESC
      LIMIT :limit
    `);

    const highDegreeNodes = stmtNodeDegrees.all({
      minDegree: NEXUS_MIN_CROSS_COUPLING_DEGREE,
      limit: NEXUS_QUERY_LIMIT * 2, // Get more to filter post-process
    }) as unknown as Array<{
      id: string;
      name: string;
      file_path: string;
      community_id: string;
      degree: number;
    }>;

    // For each high-degree node, count cross-community edges
    for (const node of highDegreeNodes) {
      // Count edges to nodes in different communities
      const stmtCrossCommunity = nativeDb.prepare(`
        SELECT COUNT(*) as cross_count
        FROM nexus_relations r
        JOIN nexus_nodes target ON (
          (r.source_id = :nodeId AND r.target_id = target.id)
          OR
          (r.target_id = :nodeId AND r.source_id = target.id)
        )
        WHERE target.community_id IS NOT NULL
        AND target.community_id != :communityId
      `);

      const crossResult = stmtCrossCommunity.get({
        nodeId: node.id,
        communityId: node.community_id,
      }) as { cross_count: number } | undefined;

      const crossCount = crossResult?.cross_count ?? 0;

      if (crossCount > NEXUS_MIN_CROSS_COMMUNITY_EDGES) {
        const fp = toFingerprint(node.id);
        if (seenIds.has(fp)) continue;
        seenIds.add(fp);

        candidates.push({
          source: 'nexus' as const,
          sourceId: node.id,
          title: `[T2-NEXUS] Cross-community coupling: ${node.name} (${crossCount} inter-community edges)`,
          rationale: `Symbol ${node.name} in ${node.file_path} couples heavily across community boundaries (${crossCount} cross edges, ${node.degree} total) — extract-module candidate.`,
          weight: NEXUS_CROSS_COUPLING_WEIGHT,
        });

        logAuditEvent(nativeDb, 'sentient.nexus.proposal.cross_community_coupling', {
          node_id: node.id,
          node_name: node.name,
          degree: node.degree,
          cross_community_edge_count: crossCount,
        });

        // Only emit up to NEXUS_QUERY_LIMIT results
        if (
          candidates.filter((c) => c.title.includes('Cross-community')).length >= NEXUS_QUERY_LIMIT
        ) {
          break;
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[sentient/nexus-ingester] WARNING query E: ${message}\n`);
  }

  return candidates;
}
