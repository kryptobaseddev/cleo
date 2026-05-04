/**
 * NEXUS Symbol Context Augmentation
 *
 * LIKE-based search against nexus_nodes for PreToolUse hook injection.
 * Returns top 5 symbols with callers/callees/community metadata.
 *
 * Used by: packages/cleo-os/src/hooks/nexus-augment.sh (PreToolUse handler)
 *
 * @task T1061
 * @task T1765 — fix wrong column names + operator precedence bug + community_id type
 * @epic T1042
 */

import { existsSync } from 'node:fs';
import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { getNexusDbPath, getNexusNativeDb } from '../store/nexus-sqlite.js';
import { openNativeDatabase } from '../store/sqlite.js';

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
  /** Community identifier string (e.g. "comm_3"). Text in nexus_nodes.community_id. */
  communityId?: string;
  communitySize?: number;
}

/** Raw row returned from the main search query. */
interface RawNodeRow {
  id: string;
  label: string;
  kind: string;
  file_path: string | null;
  start_line: number | null;
  end_line: number | null;
  community_id: string | null;
  callers_count: number;
  callees_count: number;
}

/**
 * Search nexus_nodes for symbols matching pattern.
 *
 * Uses LIKE search against label and file_path columns.
 * Restricts to callable symbols (function, method, constructor, class,
 * interface, type_alias) to maximise relevance for code intelligence contexts.
 * Exported symbols are ranked above unexported ones within the same kind tier.
 *
 * Community sizes are resolved in a single batched query rather than N+1
 * individual look-ups.
 *
 * Fixes (T1765):
 *   - Wrong column names in callers/callees subqueries:
 *       `target_node_id`/`source_node_id`/`relation_type`
 *       → `target_id`/`source_id`/`type`
 *   - Operator precedence bug: `WHERE label LIKE ? OR file_path LIKE ? AND kind IN (...)`
 *       parsed as `label LIKE ? OR (file_path LIKE ? AND kind IN (...))` because AND
 *       binds tighter than OR. Fixed with explicit parentheses.
 *   - `community_id` typed as `number | null` but the schema stores text (e.g. "comm_3").
 *       Corrected to `string | null`.
 *
 * @param pattern - Search pattern (function name, filename fragment, etc.)
 * @param limit - Max results (default 5)
 * @returns Array of augmented symbol results, or empty if nexus.db absent
 */
export function augmentSymbol(pattern: string, limit: number = 5): AugmentResult[] {
  // Empty pattern is meaningless — return early before touching the DB.
  if (!pattern) {
    return [];
  }

  const dbPath = getNexusDbPath();

  // Gracefully no-op if nexus.db is absent
  if (!existsSync(dbPath)) {
    return [];
  }

  // Track whether we opened a private read-only connection that needs closing.
  let ownedDb: ReturnType<typeof openNativeDatabase> | null = null;

  try {
    // Prefer the shared initialized singleton (avoids double-open).
    // If the singleton has not been initialized yet (e.g. called from the CLI
    // augment path which never calls getNexusDb()), open a private read-only
    // connection directly.  This is the common path for PreToolUse hooks.
    let db = getNexusNativeDb();
    if (db === null) {
      ownedDb = openNativeDatabase(dbPath, { readonly: true });
      db = ownedDb;
    }

    // Parentheses around the OR clause are required: AND has higher precedence
    // than OR in SQL, so without them `file_path LIKE ? AND kind IN (...)` would
    // be evaluated first, leaving the label branch completely unfiltered.
    //
    // Column name corrections (T1765):
    //   nexus_relations uses `source_id`/`target_id`/`type`, NOT
    //   `source_node_id`/`target_node_id`/`relation_type`.
    const searchQuery = `
      SELECT
        n.id,
        n.label,
        n.kind,
        n.file_path,
        n.start_line,
        n.end_line,
        n.community_id,
        (SELECT COUNT(*) FROM nexus_relations WHERE target_id = n.id AND type = 'calls') AS callers_count,
        (SELECT COUNT(*) FROM nexus_relations WHERE source_id = n.id AND type = 'calls') AS callees_count
      FROM nexus_nodes n
      WHERE (n.label LIKE ? OR n.file_path LIKE ?)
        AND n.kind IN ('function', 'method', 'constructor', 'class', 'interface', 'type_alias')
      ORDER BY
        CASE n.kind
          WHEN 'function'    THEN 0
          WHEN 'method'      THEN 1
          WHEN 'constructor' THEN 2
          WHEN 'class'       THEN 3
          WHEN 'interface'   THEN 4
          ELSE 5
        END ASC,
        n.is_exported DESC,
        LENGTH(n.label) ASC,
        n.label ASC
      LIMIT ?
    `;

    const patternLike = `%${pattern}%`;
    const rows = db
      .prepare(searchQuery)
      .all(patternLike, patternLike, limit) as unknown as RawNodeRow[];

    if (rows.length === 0) {
      return [];
    }

    // Batch-resolve community sizes in a single query to avoid N+1 look-ups.
    const communityIds = [...new Set(rows.map((r) => r.community_id).filter((c) => c != null))];
    const communitySizeMap = new Map<string, number>();

    if (communityIds.length > 0) {
      const placeholders = communityIds.map(() => '?').join(', ');
      const sizeRows = db
        .prepare(
          `SELECT community_id, COUNT(*) AS count FROM nexus_nodes WHERE community_id IN (${placeholders}) GROUP BY community_id`,
        )
        .all(...communityIds) as Array<{ community_id: string; count: number }>;

      for (const sr of sizeRows) {
        communitySizeMap.set(sr.community_id, sr.count);
      }
    }

    const results = rows.map((row) => ({
      id: row.id,
      label: row.label,
      kind: row.kind,
      filePath: row.file_path ?? undefined,
      startLine: row.start_line ?? undefined,
      endLine: row.end_line ?? undefined,
      callersCount: row.callers_count,
      calleesCount: row.callees_count,
      communityId: row.community_id ?? undefined,
      communitySize: row.community_id != null ? communitySizeMap.get(row.community_id) : undefined,
    }));

    return results;
  } catch (_error) {
    // Database errors are non-fatal — augmentation should never break tool execution.
    return [];
  } finally {
    // Close the private read-only connection if we opened one.
    if (ownedDb !== null) {
      try {
        ownedDb.close();
      } catch {
        // Ignore close errors — non-fatal for hook path.
      }
    }
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

// ---------------------------------------------------------------------------
// EngineResult-returning wrappers (T1569 / ADR-057 / ADR-058)
// ---------------------------------------------------------------------------

// SSoT-EXEMPT:engine-migration-T1569
export async function nexusAugment(
  pattern: string,
  limit?: number,
): Promise<
  EngineResult<{
    pattern: string;
    results: AugmentResult[];
    text: string;
  }>
> {
  try {
    const results = augmentSymbol(pattern, limit ?? 5);
    const text = formatAugmentResults(results);
    return engineSuccess({ pattern, results, text });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

// SSoT-EXEMPT:engine-migration-T1569
export async function nexusSearchCode(
  pattern: string,
  limit: number,
): Promise<EngineResult<unknown>> {
  return nexusAugment(pattern, limit);
}
