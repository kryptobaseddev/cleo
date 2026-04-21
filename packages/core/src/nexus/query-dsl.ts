/**
 * Nexus SQLite Recursive CTE Query DSL
 *
 * Provides a safe, parameterized interface for executing recursive CTEs
 * against nexus.db. Supports raw CTE syntax and 6 template aliases for
 * common code intelligence queries.
 *
 * Template aliases:
 * - callers-of <symbol>: All functions that call a symbol
 * - callees-of <symbol>: All functions called by a symbol
 * - co-changed <symbol>: Symbols in same file_path history
 * - co-cited <symbol>: Symbols referenced together in code
 * - path-between <a> <b>: Shortest call path between two symbols
 * - community-members <id>: All symbols in a community
 *
 * @task T1057
 * @epic T1042
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  NexusCteAlias,
  NexusCteParams,
  NexusCtePlaceholder,
  NexusCteResult,
} from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts';
import { CleoError } from '../errors.js';
import { getNexusDb, getNexusNativeDb } from '../store/nexus-sqlite.js';

// T1013/T1108: plasticity queries over nexus_relations plasticity columns.
// Canonical implementation lives in plasticity-queries.ts so the CLI and test
// fixtures (expected in query-dsl.ts per the T1108 spec) both converge here.
export {
  getColdSymbols,
  getHotNodes,
  getHotPaths,
  type NexusColdSymbol,
  type NexusColdSymbolsResult,
  type NexusHotNode,
  type NexusHotNodesResult,
  type NexusHotPath,
  type NexusHotPathsResult,
  type NexusPlasticityResult,
} from './plasticity-queries.js';

// ── Template CTE Definitions ─────────────────────────────────────────

/**
 * Callers-of: All functions that directly or indirectly call a target symbol.
 * Uses recursive CTE to walk the call graph upward from target.
 */
const CALLERS_OF_CTE = `
WITH RECURSIVE callers AS (
  -- Base: direct callers
  SELECT DISTINCT r.source_id as node_id, r.target_id as target
    FROM nexus_relations r
   WHERE r.type = 'calls'
     AND r.target_id = ?
  UNION ALL
  -- Recursive: callers of callers
  SELECT DISTINCT r.source_id, c.target
    FROM nexus_relations r
    JOIN callers c ON r.target_id = c.node_id
   WHERE r.type = 'calls'
)
SELECT DISTINCT n.id, n.label, n.kind, n.file_path, n.start_line, n.end_line,
       (SELECT COUNT(*) FROM nexus_relations WHERE source_id = n.id AND type = 'calls') as outgoing_calls
  FROM callers c
  JOIN nexus_nodes n ON c.node_id = n.id
 ORDER BY n.kind, n.label
`;

/**
 * Callees-of: All functions called by a target symbol.
 * Uses recursive CTE to walk the call graph downward from target.
 */
const CALLEES_OF_CTE = `
WITH RECURSIVE callees AS (
  -- Base: direct callees
  SELECT DISTINCT r.target_id as node_id, r.source_id as source
    FROM nexus_relations r
   WHERE r.type = 'calls'
     AND r.source_id = ?
  UNION ALL
  -- Recursive: callees of callees
  SELECT DISTINCT r.target_id, c.source
    FROM nexus_relations r
    JOIN callees c ON r.source_id = c.node_id
   WHERE r.type = 'calls'
)
SELECT DISTINCT n.id, n.label, n.kind, n.file_path, n.start_line, n.end_line,
       (SELECT COUNT(*) FROM nexus_relations WHERE target_id = n.id AND type = 'calls') as incoming_calls
  FROM callees c
  JOIN nexus_nodes n ON c.node_id = n.id
 ORDER BY n.kind, n.label
`;

/**
 * Co-changed: Symbols that appear in the same file_path (code locality).
 * Useful for identifying cohesive modules.
 */
const CO_CHANGED_CTE = `
SELECT DISTINCT n.id, n.label, n.kind, n.file_path, n.start_line, n.end_line
  FROM nexus_nodes target
  JOIN nexus_nodes n ON target.file_path = n.file_path
 WHERE target.id = ?
   AND n.id != target.id
 ORDER BY n.kind, n.label
`;

/**
 * Co-cited: Symbols that share a relation type (e.g., both implement the same interface).
 * Models semantic coupling via shared dependencies.
 */
const CO_CITED_CTE = `
WITH target_relations AS (
  SELECT type, target_id
    FROM nexus_relations
   WHERE source_id = ?
  UNION
  SELECT type, source_id
    FROM nexus_relations
   WHERE target_id = ?
)
SELECT DISTINCT n.id, n.label, n.kind, n.file_path, n.start_line, n.end_line
  FROM nexus_nodes n
  JOIN nexus_relations r ON (r.source_id = n.id OR r.target_id = n.id)
 WHERE (r.type, CASE
          WHEN r.source_id = n.id THEN r.target_id
          ELSE r.source_id
        END) IN (SELECT * FROM target_relations)
   AND n.id != ?
 ORDER BY n.kind, n.label
`;

/**
 * Path-between: Shortest call path from source to destination symbol.
 * Uses BFS via recursive CTE to find connected nodes.
 */
const PATH_BETWEEN_CTE = `
WITH RECURSIVE path AS (
  -- Base: start from source
  SELECT source_id as node_id, target_id as target, 1 as depth,
         source_id || ' -> ' || target_id as path_str
    FROM nexus_relations
   WHERE type = 'calls'
     AND source_id = ?
  UNION ALL
  -- Recursive: extend path
  SELECT r.source_id, p.target, p.depth + 1,
         p.path_str || ' -> ' || r.target_id
    FROM nexus_relations r
    JOIN path p ON r.source_id = p.node_id
   WHERE r.type = 'calls'
     AND p.depth < 10  -- Limit recursion depth
     AND p.path_str NOT LIKE '%' || r.target_id || '%'  -- Avoid cycles
)
SELECT DISTINCT n.id, n.label, n.kind, n.file_path, n.start_line, p.depth
  FROM path p
  JOIN nexus_nodes n ON p.node_id = n.id
 WHERE p.target = ?
 ORDER BY p.depth
 LIMIT 1
`;

/**
 * Community-members: All symbols in a specified community.
 * Returns members of a code intelligence community cluster.
 */
const COMMUNITY_MEMBERS_CTE = `
SELECT n.id, n.label, n.kind, n.file_path, n.start_line, n.end_line, n.community_id
  FROM nexus_nodes n
 WHERE n.community_id = ?
 ORDER BY n.kind, n.label
`;

// ── Template Compilation ─────────────────────────────────────────────

/**
 * Compile a named alias into a parameterized CTE placeholder.
 * Returns the CTE string and parameter information.
 *
 * @param alias - Template alias name
 * @returns Compiled CTE placeholder
 * @throws CleoError if alias is unknown
 */
export function compileCteAlias(alias: NexusCteAlias): NexusCtePlaceholder {
  switch (alias) {
    case 'callers-of':
      return {
        cte: CALLERS_OF_CTE,
        description: 'All functions that call a target symbol (recursive)',
        paramCount: 1,
        paramNames: ['symbol_id'],
      };
    case 'callees-of':
      return {
        cte: CALLEES_OF_CTE,
        description: 'All functions called by a target symbol (recursive)',
        paramCount: 1,
        paramNames: ['symbol_id'],
      };
    case 'co-changed':
      return {
        cte: CO_CHANGED_CTE,
        description: 'Symbols in the same file (co-locality)',
        paramCount: 1,
        paramNames: ['symbol_id'],
      };
    case 'co-cited':
      return {
        cte: CO_CITED_CTE,
        description: 'Symbols sharing the same relation (semantic coupling)',
        paramCount: 3,
        paramNames: ['symbol_id', 'symbol_id', 'symbol_id'],
      };
    case 'path-between':
      return {
        cte: PATH_BETWEEN_CTE,
        description: 'Shortest call path between two symbols',
        paramCount: 2,
        paramNames: ['source_id', 'target_id'],
      };
    case 'community-members':
      return {
        cte: COMMUNITY_MEMBERS_CTE,
        description: 'All symbols in a community cluster',
        paramCount: 1,
        paramNames: ['community_id'],
      };
    default:
      throw new CleoError(
        ExitCode.NEXUS_QUERY_FAILED,
        `Unknown CTE alias: ${alias}. Valid: callers-of, callees-of, co-changed, co-cited, path-between, community-members`,
      );
  }
}

// ── Query Execution ──────────────────────────────────────────────────

/**
 * Execute a raw CTE query against nexus.db with parameter binding.
 *
 * Validates the CTE syntax before execution. Handles both raw CTEs and
 * parameterized queries. Returns structured result with rows and metadata.
 *
 * @param cte - SQL CTE string, may contain ? or :param placeholders
 * @param params - Positional parameter values (for ? placeholders)
 * @param db - Optional DatabaseSync instance (uses global nexus.db if omitted)
 * @returns NexusCteResult with rows and execution metadata
 *
 * @task T1057
 * @throws Errors are caught and returned in result.error (not thrown)
 */
export async function runNexusCte(
  cte: string,
  params: NexusCteParams,
  db?: DatabaseSync,
): Promise<NexusCteResult> {
  const startTime = performance.now();
  // Lazy-initialize nexus.db if not already open (idempotent singleton)
  if (!db && !getNexusNativeDb()) {
    await getNexusDb();
  }
  const nativeDb = db ?? getNexusNativeDb();

  // Guard: database could not be initialized
  if (!nativeDb) {
    return {
      success: false,
      rows: [],
      row_count: 0,
      execution_time_ms: performance.now() - startTime,
      error: 'nexus.db not initialized. Run "cleo nexus init" first.',
    };
  }

  try {
    // Validate: CTE must not be empty
    const trimmed = cte.trim();
    if (!trimmed.length) {
      return {
        success: false,
        rows: [],
        row_count: 0,
        execution_time_ms: performance.now() - startTime,
        error: 'CTE cannot be empty',
      };
    }

    // Execute query with parameters
    const stmt = nativeDb.prepare(trimmed);
    const rows = stmt.all(...params) as Array<Record<string, unknown>>;

    return {
      success: true,
      rows: rows || [],
      row_count: rows?.length ?? 0,
      execution_time_ms: performance.now() - startTime,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      rows: [],
      row_count: 0,
      execution_time_ms: performance.now() - startTime,
      error: `CTE execution failed: ${msg}`,
    };
  }
}

/**
 * Convert query result rows to markdown table format.
 * Used by CLI to format output for human consumption.
 *
 * @param result - NexusCteResult from runNexusCte()
 * @returns Markdown table string
 */
export function formatCteResultAsMarkdown(result: NexusCteResult): string {
  if (!result.success) {
    return `**Error**: ${result.error}`;
  }

  if (result.rows.length === 0) {
    return 'No results.';
  }

  // Determine columns from first row
  const firstRow = result.rows[0];
  if (!firstRow || typeof firstRow !== 'object') {
    return 'Invalid result format.';
  }

  const columns = Object.keys(firstRow);
  const header = '| ' + columns.join(' | ') + ' |';
  const separator = '| ' + columns.map(() => '---').join(' | ') + ' |';

  const rows = result.rows.map((row) => {
    const cells = columns.map((col) => {
      const val = row[col];
      if (val === null) return 'null';
      if (typeof val === 'string') return val;
      if (typeof val === 'number') return String(val);
      return JSON.stringify(val);
    });
    return '| ' + cells.join(' | ') + ' |';
  });

  return [header, separator, ...rows].join('\n');
}
