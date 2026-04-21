/**
 * NEXUS plasticity queries (T1013 · fills wiring gap from T998 + T1006).
 *
 * Read-only queries over the plasticity columns that T998 added to
 * `nexus_relations` (`weight`, `last_accessed_at`, `co_accessed_count`).
 *
 * - `getHotPaths`   — top-N relations by weight (strongest paths).
 * - `getHotNodes`   — top-N source symbols aggregated by weight (busiest hubs).
 * - `getColdSymbols`— symbols whose last_accessed_at is older than a threshold
 *                    (or never accessed) — prune / archive candidates.
 *
 * Empty-state semantics: all three return `{ count, note? }` envelopes with
 * the payload array under `paths` / `nodes` / `symbols`. They never throw on
 * missing DB — callers in the CLI layer return a LAFS envelope either way.
 *
 * The CLI in `packages/cleo/src/cli/commands/nexus.ts` depends on the exact
 * field names below: `paths[]`, `nodes[]`, `symbols[]`, `count`, `note`.
 */

import { sql } from 'drizzle-orm';
import { getNexusDb } from '../store/nexus-sqlite.js';

/** One row in the hot-paths result. */
export interface NexusHotPath {
  sourceId: string;
  targetId: string;
  type: string;
  weight: number;
  lastAccessedAt: string | null;
  coAccessedCount: number;
}

/** One row in the hot-nodes result. */
export interface NexusHotNode {
  /** Canonical node id (matches `nexus_nodes.id`). T1108 field. */
  nodeId: string;
  /** Backward-compatible alias of {@link nodeId}. Retained for pre-T1108 callers. */
  sourceId: string;
  label: string;
  filePath: string | null;
  kind: string;
  totalWeight: number;
  pathCount: number;
}

/** One row in the cold-symbols result. */
export interface NexusColdSymbol {
  /** Canonical node id (matches `nexus_nodes.id`). T1108 field. */
  nodeId: string;
  /** Backward-compatible alias of {@link nodeId}. */
  sourceId: string;
  label: string;
  filePath: string | null;
  kind: string;
  lastAccessedAt: string | null;
  /** Alias of {@link lastAccessedAt} — CLI renderer convenience. */
  lastAccessed: string | null;
  ageDays: number | null;
  pathCount: number;
  /** Maximum relation weight on any outgoing edge — ranks cold-but-still-valuable symbols. */
  maxWeight: number;
}

/** Generic plasticity result envelope. Property name varies by query. */
export interface NexusHotPathsResult {
  paths: NexusHotPath[];
  count: number;
  note?: string;
}

export interface NexusHotNodesResult {
  nodes: NexusHotNode[];
  count: number;
  note?: string;
}

export interface NexusColdSymbolsResult {
  symbols: NexusColdSymbol[];
  count: number;
  /** The `thresholdDays` input echoed back for caller convenience. T1108 field. */
  thresholdDays: number;
  note?: string;
}

/**
 * Generic plasticity result (backward-compatible alias).
 * Kept for consumers that prefer a generic wrapper over the three concrete types.
 */
export type NexusPlasticityResult<T> =
  | { paths: T[]; count: number; note?: string }
  | { nodes: T[]; count: number; note?: string }
  | { symbols: T[]; count: number; note?: string };

type RawPathRow = {
  sourceId: string;
  targetId: string;
  type: string;
  weight: number | null;
  lastAccessedAt: string | null;
  coAccessedCount: number | null;
};

type RawNodeRow = {
  sourceId: string;
  label: string | null;
  filePath: string | null;
  kind: string | null;
  totalWeight: number | null;
  pathCount: number;
};

type RawColdRow = {
  sourceId: string;
  label: string | null;
  filePath: string | null;
  kind: string | null;
  lastAccessedAt: string | null;
  pathCount: number;
  maxWeight: number | null;
};

function emptyResult<K extends 'paths' | 'nodes' | 'symbols'>(
  key: K,
  note: string,
): { [P in K]: [] } & { count: 0; note: string } {
  return { [key]: [], count: 0, note } as { [P in K]: [] } & { count: 0; note: string };
}

/**
 * Return the top-N strongest relations by `weight` DESC.
 * Uses the plasticity columns added in T998.
 */
export async function getHotPaths(_projectRoot: string, limit = 20): Promise<NexusHotPathsResult> {
  const db = await getNexusDb();
  if (!db) {
    return emptyResult('paths', 'nexus database not initialised');
  }
  const stmt = sql`
    SELECT source_id AS sourceId,
           target_id AS targetId,
           type AS type,
           COALESCE(weight, 0.0) AS weight,
           last_accessed_at AS lastAccessedAt,
           COALESCE(co_accessed_count, 0) AS coAccessedCount
      FROM nexus_relations
     WHERE COALESCE(weight, 0.0) > 0.0
  ORDER BY weight DESC
     LIMIT ${limit}
  `;
  const rows = (await db.all(stmt)) as RawPathRow[];
  if (rows.length === 0) {
    return emptyResult('paths', 'no relations with weight > 0 — plasticity has not fired yet');
  }
  const paths: NexusHotPath[] = rows.map((r) => ({
    sourceId: r.sourceId,
    targetId: r.targetId,
    type: r.type,
    weight: r.weight ?? 0,
    lastAccessedAt: r.lastAccessedAt,
    coAccessedCount: r.coAccessedCount ?? 0,
  }));
  return { paths, count: paths.length };
}

/**
 * Return the top-N source symbols by aggregated `weight`.
 * Joins nexus_nodes for label / filePath / kind so the CLI can render a
 * human-readable table without a second query.
 */
export async function getHotNodes(_projectRoot: string, limit = 20): Promise<NexusHotNodesResult> {
  const db = await getNexusDb();
  if (!db) {
    return emptyResult('nodes', 'nexus database not initialised');
  }
  const stmt = sql`
    SELECT r.source_id AS sourceId,
           COALESCE(n.label, r.source_id) AS label,
           n.file_path AS filePath,
           COALESCE(n.kind, 'unknown') AS kind,
           SUM(COALESCE(r.weight, 0.0)) AS totalWeight,
           COUNT(*) AS pathCount
      FROM nexus_relations r
 LEFT JOIN nexus_nodes n ON n.id = r.source_id
     WHERE COALESCE(r.weight, 0.0) > 0.0
  GROUP BY r.source_id, n.label, n.file_path, n.kind
  ORDER BY totalWeight DESC
     LIMIT ${limit}
  `;
  const rows = (await db.all(stmt)) as RawNodeRow[];
  if (rows.length === 0) {
    return emptyResult('nodes', 'no relations with weight > 0 — plasticity has not fired yet');
  }
  const nodes: NexusHotNode[] = rows.map((r) => ({
    nodeId: r.sourceId,
    sourceId: r.sourceId,
    label: r.label ?? r.sourceId,
    filePath: r.filePath,
    kind: r.kind ?? 'unknown',
    totalWeight: r.totalWeight ?? 0,
    pathCount: r.pathCount,
  }));
  return { nodes, count: nodes.length };
}

/**
 * Return symbols that haven't been accessed in `thresholdDays` (or never).
 * Joins nexus_nodes for label / filePath / kind. Capped at 500 rows so large
 * neglected graphs don't flood stdout.
 */
export async function getColdSymbols(
  _projectRoot: string,
  thresholdDays = 30,
): Promise<NexusColdSymbolsResult> {
  const db = await getNexusDb();
  if (!db) {
    return { symbols: [], count: 0, thresholdDays, note: 'nexus database not initialised' };
  }
  const cutoff = new Date(Date.now() - thresholdDays * 86_400_000).toISOString();
  // Cold = weak (maxWeight < 0.1) AND (never accessed OR older than cutoff).
  // thresholdDays=0 special-cases "any unaccessed symbol" — the cutoff is now
  // and we keep the NULL-allowed branch.
  const stmt = sql`
    SELECT r.source_id AS sourceId,
           COALESCE(n.label, r.source_id) AS label,
           n.file_path AS filePath,
           COALESCE(n.kind, 'unknown') AS kind,
           MAX(r.last_accessed_at) AS lastAccessedAt,
           COUNT(*) AS pathCount,
           MAX(COALESCE(r.weight, 0.0)) AS maxWeight
      FROM nexus_relations r
 LEFT JOIN nexus_nodes n ON n.id = r.source_id
  GROUP BY r.source_id, n.label, n.file_path, n.kind
    HAVING maxWeight < 0.1
       AND (lastAccessedAt IS NULL OR lastAccessedAt < ${cutoff})
  ORDER BY CASE WHEN lastAccessedAt IS NULL THEN 0 ELSE 1 END, lastAccessedAt ASC
     LIMIT 500
  `;
  const rows = (await db.all(stmt)) as RawColdRow[];
  const now = Date.now();
  const symbols: NexusColdSymbol[] = rows.map((r) => ({
    nodeId: r.sourceId,
    sourceId: r.sourceId,
    label: r.label ?? r.sourceId,
    filePath: r.filePath,
    kind: r.kind ?? 'unknown',
    lastAccessedAt: r.lastAccessedAt,
    lastAccessed: r.lastAccessedAt,
    ageDays:
      r.lastAccessedAt === null
        ? null
        : Math.floor((now - new Date(r.lastAccessedAt).getTime()) / 86_400_000),
    pathCount: r.pathCount,
    maxWeight: r.maxWeight ?? 0,
  }));
  if (symbols.length === 0) {
    return {
      symbols: [],
      count: 0,
      thresholdDays,
      note: `no cold (weight<0.1) symbols older than ${thresholdDays} days`,
    };
  }
  const neverAccessed = symbols.filter((s) => s.lastAccessedAt === null).length;
  const note =
    neverAccessed > 0
      ? `${neverAccessed}/${symbols.length} symbols have never been accessed (last_accessed_at IS NULL)`
      : `all ${symbols.length} symbols last-accessed before the ${thresholdDays}-day cutoff`;
  return { symbols, count: symbols.length, thresholdDays, note };
}
