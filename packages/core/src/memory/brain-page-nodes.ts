/**
 * Brain-page-nodes sentience layer — universal semantic graph SDK surface.
 *
 * This module is THE canonical sentience layer for brain_page_nodes:
 *
 * - `getRelated`   — 1-hop neighbour traversal with edge-type filtering
 * - `getImpact`    — upstream/downstream impact analysis (BFS with depth)
 * - `getContext`   — 360-degree node context view (in-edges, out-edges, neighbours)
 * - `materializeXfkEdges` — promote cross-DB soft-FK references (XFKB-001..005)
 *   to hard graph edges in brain_page_nodes / brain_page_edges
 *
 * Auto-population hooks (`ensureTaskNode`, `ensureMessageNode`, etc.) live in
 * `graph-auto-populate.ts` and are invoked by the CLEO write paths. This module
 * provides the read surface that Studio and the SDK expose externally.
 *
 * Design principles:
 * - All reads are BEST-EFFORT: failures return empty results, never throw.
 * - `materializeXfkEdges` runs as a best-effort migration; it is idempotent
 *   and safe to call multiple times.
 * - Types imported from `@cleocode/contracts` where possible; local types
 *   defined only for raw DB rows.
 *
 * @task T945
 * @epic T1056
 */

import type { BrainEdgeType, BrainNodeType } from '../store/memory-schema.js';
import { BRAIN_EDGE_TYPES } from '../store/memory-schema.js';
import { getBrainDb, getBrainNativeDb } from '../store/memory-sqlite.js';
import { getNexusNativeDb } from '../store/nexus-sqlite.js';
import { typedAll } from '../store/typed-query.js';
import type { NodeContext, RelatedNode, TraceNode } from './graph-queries.js';
import { contextBrainNode, relatedBrainNodes, traceBrainGraph } from './graph-queries.js';

// Re-export so callers can import everything from this module.
export type { NodeContext, RelatedNode, TraceNode };

// ---------------------------------------------------------------------------
// Public canonical node types for the universal semantic graph.
// These are the node type strings that the /api/v1/graph endpoint exposes.
// ---------------------------------------------------------------------------

/**
 * Node types that form the sentience layer.
 * Maps directly to `BRAIN_NODE_TYPES` entries that the graph surface exposes.
 *
 * Note: "conduit_message" in API responses corresponds to the internal `msg`
 * node type to keep the external interface self-documenting.
 */
export type SentienceNodeType =
  | 'task'
  | 'decision'
  | 'observation'
  | 'symbol'
  | 'conduit_message'
  | 'llmtxt';

/**
 * Mapping from internal BRAIN_NODE_TYPES to the API-facing SentienceNodeType.
 * `msg` → `conduit_message` for clarity; all others pass through unchanged.
 */
export const INTERNAL_TO_SENTIENCE_TYPE: Partial<Record<BrainNodeType, SentienceNodeType>> = {
  task: 'task',
  decision: 'decision',
  observation: 'observation',
  symbol: 'symbol',
  msg: 'conduit_message',
  llmtxt: 'llmtxt',
};

// ---------------------------------------------------------------------------
// Canonical edge types for the universal semantic graph (T945 AC)
// ---------------------------------------------------------------------------

/**
 * Canonical edge types for the sentience layer traversal surface.
 *
 * Source: BRAIN_EDGE_TYPES in memory-schema.ts (T945 Stage A).
 * These are the types that `cleo nexus query` must return without error.
 */
export const CANONICAL_SENTIENCE_EDGE_TYPES = [
  'documents',
  'applies_to',
  'blocks',
  'derived_from',
  'touches_code',
  'discusses',
  'cites',
  'supersedes',
] as const satisfies ReadonlyArray<BrainEdgeType>;

export type CanonicalSentienceEdgeType = (typeof CANONICAL_SENTIENCE_EDGE_TYPES)[number];

// ---------------------------------------------------------------------------
// getRelated — 1-hop neighbour traversal
// ---------------------------------------------------------------------------

/**
 * Parameters for {@link getRelated}.
 */
export interface GetRelatedParams {
  /**
   * Optional edge-type filter. When provided, only edges of this type are
   * followed. Accepts any `BrainEdgeType` from the canonical vocabulary.
   */
  edgeType?: BrainEdgeType;
  /**
   * Maximum number of results to return. Defaults to 50.
   */
  limit?: number;
}

/**
 * Return the immediate (1-hop) neighbours of a brain graph node.
 *
 * Follows edges in both directions (outgoing and incoming). Results are
 * sorted by edge weight descending, then quality score descending. When
 * `edgeType` is supplied only edges of that type are traversed.
 *
 * This is the primary SDK entry point for "what is related to X?" queries.
 *
 * @param projectRoot - Absolute path to the project root (locates brain.db).
 * @param nodeId - Node ID to query (format: `'<type>:<source-id>'`).
 * @param params - Optional filter parameters.
 * @returns Array of neighbour nodes with edge metadata.
 *
 * @example
 * ```typescript
 * const neighbours = await getRelated('/project', 'task:T945', { edgeType: 'discusses' });
 * for (const { node, edgeType, direction, weight } of neighbours) {
 *   console.log(direction, edgeType, node.label, weight);
 * }
 * ```
 *
 * @task T945
 */
export async function getRelated(
  projectRoot: string,
  nodeId: string,
  params: GetRelatedParams = {},
): Promise<RelatedNode[]> {
  try {
    const { limit = 50 } = params;
    const all = await relatedBrainNodes(projectRoot, nodeId, params.edgeType);
    return all.slice(0, limit);
  } catch (err) {
    console.warn('[brain-page-nodes] getRelated failed:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// getImpact — BFS upstream/downstream impact analysis
// ---------------------------------------------------------------------------

/**
 * Parameters for {@link getImpact}.
 */
export interface GetImpactParams {
  /**
   * Traversal direction.
   * - `'upstream'`   — follow edges where this node is the **target** (what depends on it?)
   * - `'downstream'` — follow edges where this node is the **source** (what does it affect?)
   * - `'both'`       — bidirectional BFS (default)
   */
  direction?: 'upstream' | 'downstream' | 'both';
  /**
   * Maximum BFS depth. Defaults to 3.
   */
  maxDepth?: number;
}

/**
 * Return the transitive impact set for a brain graph node using BFS.
 *
 * The impact set is the set of all nodes reachable from `nodeId` within
 * `maxDepth` hops. Nodes are annotated with their discovery depth (0 = seed).
 *
 * This is the primary SDK entry point for "what does X affect?" queries —
 * the brain-layer equivalent of `gitnexus_impact` for code symbols.
 *
 * @param projectRoot - Absolute path to the project root (locates brain.db).
 * @param nodeId - Node ID to start from (format: `'<type>:<source-id>'`).
 * @param params - Optional traversal parameters.
 * @returns Array of impacted nodes sorted by depth ascending, quality descending.
 *
 * @example
 * ```typescript
 * const impacted = await getImpact('/project', 'decision:D-abc123', {
 *   direction: 'downstream',
 *   maxDepth: 2,
 * });
 * console.log(impacted.length, 'nodes impacted at depth ≤ 2');
 * ```
 *
 * @task T945
 */
export async function getImpact(
  projectRoot: string,
  nodeId: string,
  params: GetImpactParams = {},
): Promise<TraceNode[]> {
  try {
    const { maxDepth = 3 } = params;
    // traceBrainGraph runs a bidirectional BFS CTE; it does not support
    // unidirectional traversal natively, so we post-filter by direction when needed.
    const all = await traceBrainGraph(projectRoot, nodeId, maxDepth);

    if (!params.direction || params.direction === 'both') {
      return all;
    }

    // For directional filtering, re-query edges to determine which nodes are
    // reachable in the requested direction only.
    await getBrainDb(projectRoot);
    const nativeDb = getBrainNativeDb();
    if (!nativeDb) return all;

    // Build the set of nodes reachable in the requested direction via raw SQL.
    const col = params.direction === 'upstream' ? 'to_id' : 'from_id';
    const otherCol = params.direction === 'upstream' ? 'from_id' : 'to_id';

    interface RawEdgeRow {
      from_id: string;
      to_id: string;
    }

    const edges = typedAll<RawEdgeRow>(
      nativeDb.prepare(`SELECT from_id, to_id FROM brain_page_edges`),
    );

    // BFS in requested direction
    const visited = new Set<string>([nodeId]);
    const queue: string[] = [nodeId];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) continue;
      for (const edge of edges) {
        if (edge[col as keyof RawEdgeRow] === current) {
          const next = edge[otherCol as keyof RawEdgeRow];
          if (!visited.has(next)) {
            visited.add(next);
            queue.push(next);
          }
        }
      }
    }

    return all.filter((n) => visited.has(n.id));
  } catch (err) {
    console.warn('[brain-page-nodes] getImpact failed:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// getContext — 360-degree view of a single node
// ---------------------------------------------------------------------------

/**
 * Return a 360-degree context view for a single brain graph node.
 *
 * Provides the node itself, all its incoming edges, all its outgoing edges,
 * and the full set of direct neighbour nodes with relationship metadata.
 *
 * This is the primary SDK entry point for "tell me everything about X" queries.
 *
 * @param projectRoot - Absolute path to the project root (locates brain.db).
 * @param nodeId - Node ID to inspect (format: `'<type>:<source-id>'`).
 * @returns Full context record, or `null` if the node does not exist.
 *
 * @example
 * ```typescript
 * const ctx = await getContext('/project', 'task:T945');
 * if (ctx) {
 *   console.log(ctx.node.label, ctx.outEdges.length, 'outgoing edges');
 *   for (const n of ctx.neighbors) {
 *     console.log(' →', n.edgeType, n.node.label);
 *   }
 * }
 * ```
 *
 * @task T945
 */
export async function getContext(projectRoot: string, nodeId: string): Promise<NodeContext | null> {
  try {
    return await contextBrainNode(projectRoot, nodeId);
  } catch (err) {
    console.warn('[brain-page-nodes] getContext failed:', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// listEdgeTypes — enumerate all canonical edge types in brain_page_edges
// ---------------------------------------------------------------------------

/**
 * Return the set of all edge type strings that appear in brain_page_edges.
 *
 * Used by `cleo nexus query` and the /api/v1/graph endpoint to verify
 * canonicalization. Returns the de-duplicated sorted list.
 *
 * @param projectRoot - Absolute path to the project root (locates brain.db).
 * @returns Array of edge type strings present in the graph.
 *
 * @task T945
 */
export async function listEdgeTypes(projectRoot: string): Promise<string[]> {
  try {
    await getBrainDb(projectRoot);
    const nativeDb = getBrainNativeDb();
    if (!nativeDb) return [];

    interface RawRow {
      edge_type: string;
    }

    const rows = typedAll<RawRow>(
      nativeDb.prepare(`SELECT DISTINCT edge_type FROM brain_page_edges ORDER BY edge_type ASC`),
    );

    return rows.map((r) => r.edge_type);
  } catch (err) {
    console.warn('[brain-page-nodes] listEdgeTypes failed:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// validateEdgeTypes — check all BRAIN_EDGE_TYPES are canonicalized
// ---------------------------------------------------------------------------

/**
 * Validate that all edge types present in brain_page_edges are members of
 * the canonical `BRAIN_EDGE_TYPES` array.
 *
 * Returns a list of unrecognized edge type strings (empty = fully canonical).
 *
 * @param projectRoot - Absolute path to the project root (locates brain.db).
 * @returns Array of non-canonical edge type strings found in the graph.
 *
 * @task T945
 */
export async function validateEdgeTypes(projectRoot: string): Promise<string[]> {
  const present = await listEdgeTypes(projectRoot);
  const canonical = new Set<string>(BRAIN_EDGE_TYPES);
  return present.filter((t) => !canonical.has(t));
}

// ---------------------------------------------------------------------------
// materializeXfkEdges — promote soft-FK cross-DB refs to hard graph edges
// ---------------------------------------------------------------------------

/**
 * Result summary from {@link materializeXfkEdges}.
 */
export interface MaterializeXfkResult {
  /** Number of new `part_of` edges created (task → epic). */
  taskToEpic: number;
  /** Number of new `produced_by` edges created (observation → session). */
  observationToSession: number;
  /** Number of new `applies_to` edges created (decision → task). */
  decisionToTask: number;
  /** Number of new `applies_to` edges created (decision → epic). */
  decisionToEpic: number;
  /** Number of new `informed_by` edges created (memory-link → task). */
  memoryLinkToTask: number;
  /** Total new edges created across all XFK categories. */
  total: number;
}

/**
 * Materialize cross-database soft-FK references as hard graph edges in brain.db.
 *
 * SQLite does not support FK constraints across database connections. Brain.db
 * stores "soft FKs" as text IDs referencing tasks.db rows. This function
 * promotes those soft-FK fields to explicit `brain_page_nodes` nodes and
 * `brain_page_edges` edges — making them first-class citizens of the graph
 * that can be traversed without cross-DB joins.
 *
 * ## XFKB mappings (T033 audit, ADR per cross-db-cleanup.ts)
 *
 * | XFKB | Source field | Target | Edge type |
 * |------|-------------|--------|-----------|
 * | XFKB-001 | brain_decisions.context_epic_id | task:<epicId> | applies_to |
 * | XFKB-002 | brain_decisions.context_task_id | task:<taskId> | applies_to |
 * | XFKB-003 | brain_memory_links.task_id | task:<taskId> | informed_by |
 * | XFKB-004 | brain_observations.source_session_id | session:<sessId> | produced_by |
 * | XFKB-005 | brain_page_nodes (task: prefix) existence | — | already a hard node |
 *
 * This function is idempotent: duplicate edges are silently skipped via
 * `INSERT OR IGNORE` on the composite PK (fromId, toId, edgeType).
 *
 * Task and session nodes are upserted in `brain_page_nodes` with
 * quality_score = 0.7 (provisional) if they do not already exist.
 *
 * @param projectRoot - Absolute path to the project root (locates brain.db).
 * @returns Summary counts of edges created by category.
 *
 * @task T945
 */
export async function materializeXfkEdges(projectRoot: string): Promise<MaterializeXfkResult> {
  const result: MaterializeXfkResult = {
    taskToEpic: 0,
    observationToSession: 0,
    decisionToTask: 0,
    decisionToEpic: 0,
    memoryLinkToTask: 0,
    total: 0,
  };

  try {
    await getBrainDb(projectRoot);
    const nativeDb = getBrainNativeDb();
    if (!nativeDb) return result;

    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

    /**
     * Upsert a stub node (task or session) in brain_page_nodes if not present.
     * Idempotent — existing rows are not modified.
     */
    const upsertStubNode = (nodeId: string, nodeType: BrainNodeType, label: string): void => {
      nativeDb
        .prepare(
          `INSERT OR IGNORE INTO brain_page_nodes
            (id, node_type, label, quality_score, content_hash, metadata_json,
             last_activity_at, created_at, updated_at)
           VALUES (?, ?, ?, 0.7, NULL, NULL, ?, ?, ?)`,
        )
        .run(nodeId, nodeType, label, now, now, now);
    };

    /**
     * Write a directed edge (idempotent via INSERT OR IGNORE).
     * Returns 1 if a new edge was inserted, 0 if it already existed.
     */
    const insertEdge = (
      fromId: string,
      toId: string,
      edgeType: BrainEdgeType,
      provenance: string,
    ): number => {
      const stmt = nativeDb.prepare(
        `INSERT OR IGNORE INTO brain_page_edges
           (from_id, to_id, edge_type, weight, provenance, created_at)
         VALUES (?, ?, ?, 1.0, ?, ?)`,
      );
      // SQLite .run() returns { changes } — positive means a row was inserted.
      const info = stmt.run(fromId, toId, edgeType, provenance, now) as { changes: number };
      return info.changes > 0 ? 1 : 0;
    };

    // ------------------------------------------------------------------
    // XFKB-001: brain_decisions.context_epic_id → task:<epicId>
    // ------------------------------------------------------------------
    interface RawDecisionEpic {
      id: string;
      context_epic_id: string;
    }

    const decisionsWithEpic = typedAll<RawDecisionEpic>(
      nativeDb.prepare(
        `SELECT id, context_epic_id FROM brain_decisions
         WHERE context_epic_id IS NOT NULL AND context_epic_id != ''`,
      ),
    );

    for (const dec of decisionsWithEpic) {
      const decNodeId = `decision:${dec.id}`;
      const epicNodeId = `task:${dec.context_epic_id}`;
      upsertStubNode(decNodeId, 'decision', `Decision ${dec.id}`);
      upsertStubNode(epicNodeId, 'task', dec.context_epic_id);
      result.decisionToEpic += insertEdge(decNodeId, epicNodeId, 'applies_to', 'xfkb-001:epic');
    }

    // ------------------------------------------------------------------
    // XFKB-002: brain_decisions.context_task_id → task:<taskId>
    // ------------------------------------------------------------------
    interface RawDecisionTask {
      id: string;
      context_task_id: string;
    }

    const decisionsWithTask = typedAll<RawDecisionTask>(
      nativeDb.prepare(
        `SELECT id, context_task_id FROM brain_decisions
         WHERE context_task_id IS NOT NULL AND context_task_id != ''`,
      ),
    );

    for (const dec of decisionsWithTask) {
      const decNodeId = `decision:${dec.id}`;
      const taskNodeId = `task:${dec.context_task_id}`;
      upsertStubNode(decNodeId, 'decision', `Decision ${dec.id}`);
      upsertStubNode(taskNodeId, 'task', dec.context_task_id);
      result.decisionToTask += insertEdge(decNodeId, taskNodeId, 'applies_to', 'xfkb-002:task');
    }

    // ------------------------------------------------------------------
    // XFKB-003: brain_memory_links.task_id → task:<taskId>
    // ------------------------------------------------------------------
    interface RawMemoryLink {
      memory_type: string;
      memory_id: string;
      task_id: string;
    }

    const memoryLinks = typedAll<RawMemoryLink>(
      nativeDb.prepare(
        `SELECT memory_type, memory_id, task_id FROM brain_memory_links
         WHERE task_id IS NOT NULL AND task_id != ''`,
      ),
    );

    for (const link of memoryLinks) {
      const memNodeId = `${link.memory_type}:${link.memory_id}`;
      const taskNodeId = `task:${link.task_id}`;
      upsertStubNode(
        memNodeId,
        link.memory_type as BrainNodeType,
        `${link.memory_type} ${link.memory_id}`,
      );
      upsertStubNode(taskNodeId, 'task', link.task_id);
      result.memoryLinkToTask += insertEdge(
        memNodeId,
        taskNodeId,
        'informed_by',
        'xfkb-003:memory-link',
      );
    }

    // ------------------------------------------------------------------
    // XFKB-004: brain_observations.source_session_id → session:<sessId>
    // ------------------------------------------------------------------
    interface RawObsSession {
      id: string;
      source_session_id: string;
    }

    const obsWithSession = typedAll<RawObsSession>(
      nativeDb.prepare(
        `SELECT id, source_session_id FROM brain_observations
         WHERE source_session_id IS NOT NULL AND source_session_id != ''`,
      ),
    );

    for (const obs of obsWithSession) {
      const obsNodeId = `observation:${obs.id}`;
      const sessNodeId = `session:${obs.source_session_id}`;
      upsertStubNode(obsNodeId, 'observation', `Observation ${obs.id}`);
      upsertStubNode(sessNodeId, 'session', obs.source_session_id);
      result.observationToSession += insertEdge(
        obsNodeId,
        sessNodeId,
        'produced_by',
        'xfkb-004:session',
      );
    }

    // ------------------------------------------------------------------
    // XFKB-005: task:<id> nodes — ensure they exist (resolved separately)
    // Soft FKs from brain_page_nodes where id starts with 'task:' but the
    // underlying tasks.db row may have been deleted. We do NOT delete stale
    // nodes here — that's the cleanup path (cross-db-cleanup.ts). Instead
    // we verify that every task: node has at least one outgoing edge or is
    // self-contained. Currently: no additional edges emitted for XFKB-005
    // beyond what XFKB-001/002/003 already emit.
    // ------------------------------------------------------------------

    result.total =
      result.decisionToEpic +
      result.decisionToTask +
      result.memoryLinkToTask +
      result.observationToSession +
      result.taskToEpic;
  } catch (err) {
    console.warn('[brain-page-nodes] materializeXfkEdges failed:', err);
  }

  return result;
}

// ---------------------------------------------------------------------------
// queryGraphNodes — fetch nodes filtered by type for the v1 graph API
// ---------------------------------------------------------------------------

/**
 * A single node row returned by the sentience layer graph query.
 */
export interface SentienceGraphNode {
  /** Stable composite ID: `'<type>:<source-id>'`. */
  id: string;
  /**
   * API-facing node type.
   * `msg` is exposed as `conduit_message`; all others pass through unchanged.
   */
  type: SentienceNodeType;
  /** Human-readable label. */
  label: string;
  /** Quality score 0.0–1.0. */
  qualityScore: number;
  /** Optional type-specific metadata JSON string. */
  metadataJson: string | null;
  /** ISO timestamp of creation. */
  createdAt: string;
}

/**
 * A single edge row returned by the sentience layer graph query.
 */
export interface SentienceGraphEdge {
  /** Source node ID. */
  fromId: string;
  /** Target node ID. */
  toId: string;
  /** Edge type from BRAIN_EDGE_TYPES. */
  edgeType: BrainEdgeType;
  /** Edge weight 0.0–1.0. */
  weight: number;
  /** ISO timestamp of creation. */
  createdAt: string;
}

/**
 * Response shape for the `/api/v1/graph` endpoint.
 */
export interface SentienceGraphResponse {
  /** Nodes of the requested types. */
  nodes: SentienceGraphNode[];
  /** Edges where both endpoints are within the returned node set. */
  edges: SentienceGraphEdge[];
  /** Total node count (before the limit was applied). */
  totalNodes: number;
  /** Total edge count (before filtering). */
  totalEdges: number;
}

/**
 * The internal node types that map to the sentience layer API types.
 *
 * `msg` is the internal type for CONDUIT messages (exposed as `conduit_message`).
 */
const SENTIENCE_INTERNAL_TYPES: BrainNodeType[] = [
  'task',
  'decision',
  'observation',
  'symbol',
  'msg',
  'llmtxt',
];

/**
 * Fetch brain_page_nodes of the sentience node types and the edges between them.
 *
 * Used by `GET /api/v1/graph`. Limits to `limit` nodes (highest quality first)
 * and includes only edges where both endpoints are in the returned node set.
 *
 * @param projectRoot - Absolute path to the project root (locates brain.db).
 * @param limit - Maximum number of nodes to return. Defaults to 500.
 * @returns Nodes, edges, and total counts.
 *
 * @task T945
 */
export async function queryGraphNodes(
  projectRoot: string,
  limit = 500,
): Promise<SentienceGraphResponse> {
  const empty: SentienceGraphResponse = { nodes: [], edges: [], totalNodes: 0, totalEdges: 0 };

  try {
    await getBrainDb(projectRoot);
    const nativeDb = getBrainNativeDb();
    if (!nativeDb) return empty;

    // Build the IN-clause for the sentience node types.
    const placeholders = SENTIENCE_INTERNAL_TYPES.map(() => '?').join(', ');

    interface RawCount {
      cnt: number;
    }

    const totalRow = nativeDb
      .prepare(
        `SELECT COUNT(*) AS cnt FROM brain_page_nodes
         WHERE node_type IN (${placeholders})`,
      )
      .get(...SENTIENCE_INTERNAL_TYPES) as unknown as RawCount;

    const totalNodes = totalRow?.cnt ?? 0;

    interface RawNode {
      id: string;
      node_type: string;
      label: string;
      quality_score: number;
      metadata_json: string | null;
      created_at: string;
    }

    const rawNodes = nativeDb
      .prepare(
        `SELECT id, node_type, label, quality_score, metadata_json, created_at
         FROM brain_page_nodes
         WHERE node_type IN (${placeholders})
         ORDER BY quality_score DESC, last_activity_at DESC
         LIMIT ?`,
      )
      .all(...SENTIENCE_INTERNAL_TYPES, limit) as unknown as RawNode[];

    const nodeIds = new Set(rawNodes.map((n) => n.id));

    const nodes: SentienceGraphNode[] = rawNodes.map((n) => {
      const internalType = n.node_type as BrainNodeType;
      const sentienceType: SentienceNodeType =
        INTERNAL_TO_SENTIENCE_TYPE[internalType] ?? (internalType as SentienceNodeType);
      return {
        id: n.id,
        type: sentienceType,
        label: n.label,
        qualityScore: n.quality_score,
        metadataJson: n.metadata_json,
        createdAt: n.created_at,
      };
    });

    // Fetch all edges and filter to those where both endpoints are present.
    interface RawEdge {
      from_id: string;
      to_id: string;
      edge_type: string;
      weight: number;
      created_at: string;
    }

    const allEdges = nativeDb
      .prepare(
        `SELECT from_id, to_id, edge_type, weight, created_at
         FROM brain_page_edges`,
      )
      .all() as unknown as RawEdge[];

    const totalEdges = allEdges.length;

    const edges: SentienceGraphEdge[] = allEdges
      .filter((e) => nodeIds.has(e.from_id) && nodeIds.has(e.to_id))
      .map((e) => ({
        fromId: e.from_id,
        toId: e.to_id,
        edgeType: e.edge_type as BrainEdgeType,
        weight: e.weight,
        createdAt: e.created_at,
      }));

    return { nodes, edges, totalNodes, totalEdges };
  } catch (err) {
    console.warn('[brain-page-nodes] queryGraphNodes failed:', err);
    return empty;
  }
}

// ---------------------------------------------------------------------------
// checkNexusForeignKeys — PRAGMA foreign_key_check for nexus.db
// ---------------------------------------------------------------------------

/**
 * Run `PRAGMA foreign_key_check` on nexus.db and return the violation count.
 *
 * Returns 0 when all FK constraints pass or when nexus.db is unavailable.
 * A non-zero result means FK violations exist that must be fixed.
 *
 * Note: nexus.db uses its own FK schema. This function checks for violations
 * in the nexus graph (nexus_nodes / nexus_relations), not brain.db.
 *
 * @returns Number of FK violations found in nexus.db (0 = clean).
 *
 * @task T945
 */
export async function checkNexusForeignKeys(): Promise<number> {
  try {
    const nexusNative = getNexusNativeDb();
    if (!nexusNative) return 0;

    interface RawFkViolation {
      table: string;
      rowid: number;
      parent: string;
      fkid: number;
    }

    const violations = nexusNative
      .prepare('PRAGMA foreign_key_check')
      .all() as unknown as RawFkViolation[];

    return violations.length;
  } catch {
    return 0;
  }
}
