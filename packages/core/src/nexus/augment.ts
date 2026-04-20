/**
 * NEXUS Symbol Context Augmentation
 *
 * BM25-only search against nexus_nodes for PreToolUse hook injection.
 * Returns top 5 symbols with callers/callees/community metadata.
 *
 * Used by: packages/cleo-os/src/hooks/nexus-augment.sh (PreToolUse handler)
 *
 * @task T1061
 * @epic T1042
 */

import { existsSync } from 'node:fs';
import { getNexusDbPath, getNexusNativeDb } from '../store/nexus-sqlite.js';

/**
 * Result of augmenting a symbol with context
 */
export interface AugmentResult {
  id: string;
  label: string;
  kind: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  callersCount: number;
  calleesCount: number;
  communityId?: number;
  communitySize?: number;
}

/**
 * Search nexus_nodes for symbols matching pattern.
 *
 * Uses LIKE search against label column (simple text match, no FTS5 yet).
 * Restricts to callable symbols (function, method, constructor, class) to maximize
 * relevance for code intelligence contexts.
 *
 * @param pattern - Search pattern (filename, function name, etc)
 * @param limit - Max results (default 5)
 * @returns Array of augmented symbol results, or empty if nexus.db absent
 */
export function augmentSymbol(pattern: string, limit: number = 5): AugmentResult[] {
  const dbPath = getNexusDbPath();

  // Gracefully no-op if nexus.db is absent or stale
  if (!existsSync(dbPath)) {
    return [];
  }

  try {
    const db = getNexusNativeDb();

    if (db === null) {
      return [];
    }

    // Search nodes by label using LIKE (case-insensitive)
    // Prioritize callable symbols: function, method, constructor, class
    const searchQuery = `
      SELECT
        n.id,
        n.label,
        n.kind,
        n.file_path,
        n.start_line,
        n.end_line,
        n.community_id,
        (SELECT COUNT(*) FROM nexus_relations WHERE target_node_id = n.id AND relation_type = 'calls') as callers_count,
        (SELECT COUNT(*) FROM nexus_relations WHERE source_node_id = n.id AND relation_type = 'calls') as callees_count
      FROM nexus_nodes n
      WHERE n.label LIKE ? OR n.file_path LIKE ?
      AND n.kind IN ('function', 'method', 'constructor', 'class', 'interface', 'type_alias')
      ORDER BY
        CASE n.kind
          WHEN 'function' THEN 0
          WHEN 'method' THEN 1
          WHEN 'constructor' THEN 2
          WHEN 'class' THEN 3
          WHEN 'interface' THEN 4
          ELSE 5
        END,
        LENGTH(n.label) ASC,
        n.label ASC
      LIMIT ?
    `;

    const pattern_like = `%${pattern}%`;
    const rows = db.prepare(searchQuery).all(pattern_like, pattern_like, limit) as Array<{
      id: string;
      label: string;
      kind: string;
      file_path: string | null;
      start_line: number | null;
      end_line: number | null;
      community_id: number | null;
      callers_count: number;
      callees_count: number;
    }>;

    // Fetch community sizes
    const results: AugmentResult[] = [];
    for (const row of rows) {
      let communitySize: number | undefined;
      if (row.community_id != null) {
        try {
          const sizeResult = db
            .prepare('SELECT COUNT(*) as count FROM nexus_nodes WHERE community_id = ?')
            .get(row.community_id) as { count: number } | undefined;
          communitySize = sizeResult?.count;
        } catch {
          // Ignore errors fetching community size
        }
      }

      results.push({
        id: row.id,
        label: row.label,
        kind: row.kind,
        filePath: row.file_path ?? undefined,
        startLine: row.start_line ?? undefined,
        endLine: row.end_line ?? undefined,
        callersCount: row.callers_count,
        calleesCount: row.callees_count,
        communityId: row.community_id ?? undefined,
        communitySize,
      });
    }

    return results;
  } catch (_error) {
    // Database errors are non-fatal — log and return empty
    // Hook should never break tool execution
    return [];
  }
}

/**
 * Format augmented results as plain text for hook injection.
 *
 * Output sent to stderr in PreToolUse hook handler so it doesn't
 * interfere with tool output parsing.
 *
 * @param results - Array of augment results
 * @returns Plain text formatted for stderr injection
 */
export function formatAugmentResults(results: AugmentResult[]): string {
  if (results.length === 0) {
    return '';
  }

  const lines: string[] = ['[nexus] Symbol context:'];
  for (const r of results) {
    const loc = r.filePath ? ` (${r.filePath}:${r.startLine ?? '?'})` : '';
    const community =
      r.communityId != null
        ? ` [community ${r.communityId}, ${r.communitySize ?? '?'} members]`
        : '';
    lines.push(
      `  ${r.label} (${r.kind})${loc} | callers: ${r.callersCount}, callees: ${r.calleesCount}${community}`,
    );
  }

  return lines.join('\n');
}
