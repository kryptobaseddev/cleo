/**
 * Brain graph traversal queries using recursive CTEs and native SQLite.
 *
 * Implements BFS traversal, typed neighbor lookup, 360-degree context view,
 * and aggregate statistics for the brain_page_nodes / brain_page_edges graph
 * populated by T528 + T530.
 *
 * Uses getBrainNativeDb() (DatabaseSync) for recursive CTEs that Drizzle's
 * ORM layer cannot express directly.
 *
 * @task T535
 * @epic T523
 */

import type { BrainEdgeType, BrainPageEdgeRow, BrainPageNodeRow } from '../store/brain-schema.js';
import { getBrainDb, getBrainNativeDb } from '../store/brain-sqlite.js';

// ---------------------------------------------------------------------------
// Return types
// ---------------------------------------------------------------------------

/** A node returned from a BFS traversal, annotated with its discovery depth. */
export interface TraceNode extends BrainPageNodeRow {
  /** Distance from the seed node (0 = seed itself). */
  depth: number;
}

/** A neighbor node with the edge that connects it to the queried node. */
export interface RelatedNode {
  /** The neighbour node. */
  node: BrainPageNodeRow;
  /** Edge relationship type. */
  edgeType: BrainEdgeType;
  /** Direction: 'out' (queried node is from_id) or 'in' (queried node is to_id). */
  direction: 'out' | 'in';
  /** Edge weight/confidence 0.0–1.0. */
  weight: number;
}

/** Full context for a single node: itself, incoming edges, outgoing edges, and neighbour nodes. */
export interface NodeContext {
  /** The node itself. */
  node: BrainPageNodeRow;
  /** Edges where this node is the target (in-edges). */
  inEdges: BrainPageEdgeRow[];
  /** Edges where this node is the source (out-edges). */
  outEdges: BrainPageEdgeRow[];
  /** All neighbour nodes reachable via in- or out-edges, deduplicated. */
  neighbors: RelatedNode[];
}

/** Aggregate statistics for the graph. */
export interface GraphStats {
  /** Node counts grouped by node_type. */
  nodesByType: Array<{ nodeType: string; count: number }>;
  /** Edge counts grouped by edge_type. */
  edgesByType: Array<{ edgeType: string; count: number }>;
  /** Total node count. */
  totalNodes: number;
  /** Total edge count. */
  totalEdges: number;
}

// ---------------------------------------------------------------------------
// Internal raw-row types (native db returns plain objects)
// ---------------------------------------------------------------------------

interface RawNode {
  id: string;
  node_type: string;
  label: string;
  quality_score: number;
  content_hash: string | null;
  last_activity_at: string;
  metadata_json: string | null;
  created_at: string;
  updated_at: string | null;
}

interface RawEdge {
  from_id: string;
  to_id: string;
  edge_type: string;
  weight: number;
  provenance: string | null;
  created_at: string;
  // T673-M3 plasticity columns — may be absent from partial SELECTs
  last_reinforced_at?: string | null;
  reinforcement_count?: number;
  plasticity_class?: string;
  last_depressed_at?: string | null;
  depression_count?: number;
  stability_score?: number | null;
}

/** Map a snake_case raw row to a camelCase BrainPageNodeRow. */
function mapNode(raw: RawNode): BrainPageNodeRow {
  return {
    id: raw.id,
    nodeType: raw.node_type as BrainPageNodeRow['nodeType'],
    label: raw.label,
    qualityScore: raw.quality_score,
    contentHash: raw.content_hash,
    lastActivityAt: raw.last_activity_at,
    metadataJson: raw.metadata_json,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

/** Map a snake_case raw row to a camelCase BrainPageEdgeRow. */
function mapEdge(raw: RawEdge): BrainPageEdgeRow {
  return {
    fromId: raw.from_id,
    toId: raw.to_id,
    edgeType: raw.edge_type as BrainEdgeType,
    weight: raw.weight,
    provenance: raw.provenance,
    createdAt: raw.created_at,
    // T673-M3 plasticity columns (default to neutral values if absent from SELECT)
    lastReinforcedAt: raw.last_reinforced_at ?? null,
    reinforcementCount: raw.reinforcement_count ?? 0,
    plasticityClass: (raw.plasticity_class ?? 'static') as BrainPageEdgeRow['plasticityClass'],
    lastDepressedAt: raw.last_depressed_at ?? null,
    depressionCount: raw.depression_count ?? 0,
    stabilityScore: raw.stability_score ?? null,
  };
}

// ---------------------------------------------------------------------------
// traceBrainGraph — BFS traversal via recursive CTE
// ---------------------------------------------------------------------------

/**
 * Traverse the brain knowledge graph using BFS from a seed node.
 *
 * Uses a recursive CTE that follows edges in both directions. Nodes are
 * returned in ascending depth order, then descending quality_score. The seed
 * node itself is returned at depth 0.
 *
 * @param projectRoot - Absolute path to the project root (locates brain.db)
 * @param nodeId      - Starting node ID (format: '<type>:<source-id>')
 * @param maxDepth    - Maximum traversal depth (default 3)
 * @returns Array of nodes annotated with their discovery depth
 *
 * @example
 * ```typescript
 * const nodes = await traceBrainGraph('/project', 'decision:D-abc123', 2);
 * for (const n of nodes) console.log(n.depth, n.id, n.label);
 * ```
 */
export async function traceBrainGraph(
  projectRoot: string,
  nodeId: string,
  maxDepth = 3,
): Promise<TraceNode[]> {
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();

  if (!nativeDb) return [];

  // Check whether the seed node exists
  const seedCheck = nativeDb
    .prepare('SELECT 1 FROM brain_page_nodes WHERE id = ?')
    .get(nodeId) as unknown as { 1: number } | undefined;
  if (!seedCheck) return [];

  // Recursive CTE — bidirectional BFS with cycle detection via path string.
  // The path is '|'-delimited node IDs. We check membership with a LIKE guard.
  const rows = nativeDb
    .prepare(
      `
    WITH RECURSIVE connected(id, depth, path) AS (
      SELECT id, 0, id
      FROM brain_page_nodes
      WHERE id = ?

      UNION ALL

      SELECT
        CASE WHEN e.from_id = c.id THEN e.to_id ELSE e.from_id END AS next_id,
        c.depth + 1,
        c.path || '|' || CASE WHEN e.from_id = c.id THEN e.to_id ELSE e.from_id END
      FROM brain_page_edges e
      JOIN connected c ON (e.from_id = c.id OR e.to_id = c.id)
      WHERE c.depth < ?
        AND ('|' || c.path || '|') NOT LIKE (
          '%|' || CASE WHEN e.from_id = c.id THEN e.to_id ELSE e.from_id END || '|%'
        )
    )
    SELECT DISTINCT n.id, n.node_type, n.label, n.quality_score,
           n.content_hash, n.last_activity_at, n.metadata_json,
           n.created_at, n.updated_at,
           MIN(c.depth) AS depth
    FROM connected c
    JOIN brain_page_nodes n ON n.id = c.id
    GROUP BY n.id
    ORDER BY depth ASC, n.quality_score DESC
    `,
    )
    .all(nodeId, maxDepth) as unknown as Array<RawNode & { depth: number }>;

  return rows.map((r) => ({ ...mapNode(r), depth: r.depth }));
}

// ---------------------------------------------------------------------------
// relatedBrainNodes — 1-hop neighbours with edge metadata
// ---------------------------------------------------------------------------

/**
 * Return the immediate (1-hop) neighbours of a node, including edge metadata.
 *
 * Follows edges in both directions. Results are sorted by edge weight
 * descending, then quality_score descending.
 *
 * @param projectRoot - Absolute path to the project root
 * @param nodeId      - Node to inspect (format: '<type>:<source-id>')
 * @param edgeType    - Optional edge type filter (e.g. 'applies_to')
 * @returns Array of neighbour nodes with edge relationship info
 *
 * @example
 * ```typescript
 * const related = await relatedBrainNodes('/project', 'decision:D-abc123', 'applies_to');
 * ```
 */
export async function relatedBrainNodes(
  projectRoot: string,
  nodeId: string,
  edgeType?: string,
): Promise<RelatedNode[]> {
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();

  if (!nativeDb) return [];

  const edgeFilter = edgeType ? 'AND e.edge_type = ?' : '';

  // Build params array for the union query
  // Each half needs: nodeId [, edgeType]
  const queryParams: string[] = edgeType ? [nodeId, edgeType, nodeId, edgeType] : [nodeId, nodeId];

  // Two unions: outgoing (this node is from_id) and incoming (this node is to_id)
  const rows = nativeDb
    .prepare(
      `
    SELECT n.id, n.node_type, n.label, n.quality_score,
           n.content_hash, n.last_activity_at, n.metadata_json,
           n.created_at, n.updated_at,
           e.edge_type, e.weight, 'out' AS direction
    FROM brain_page_edges e
    JOIN brain_page_nodes n ON n.id = e.to_id
    WHERE e.from_id = ? ${edgeFilter}

    UNION

    SELECT n.id, n.node_type, n.label, n.quality_score,
           n.content_hash, n.last_activity_at, n.metadata_json,
           n.created_at, n.updated_at,
           e.edge_type, e.weight, 'in' AS direction
    FROM brain_page_edges e
    JOIN brain_page_nodes n ON n.id = e.from_id
    WHERE e.to_id = ? ${edgeFilter}

    ORDER BY weight DESC, quality_score DESC
    `,
    )
    .all(...queryParams) as unknown as Array<
    RawNode & { edge_type: string; weight: number; direction: string }
  >;

  return rows.map((r) => ({
    node: mapNode(r),
    edgeType: r.edge_type as BrainEdgeType,
    direction: r.direction as 'out' | 'in',
    weight: r.weight,
  }));
}

// ---------------------------------------------------------------------------
// contextBrainNode — 360-degree view of a single node
// ---------------------------------------------------------------------------

/**
 * Return a 360-degree view of a single graph node.
 *
 * Provides the node itself, all incoming edges, all outgoing edges, and the
 * full set of neighbour nodes with their edge relationships.
 *
 * @param projectRoot - Absolute path to the project root
 * @param nodeId      - Node to inspect (format: '<type>:<source-id>')
 * @returns Full context record, or null if the node does not exist
 *
 * @example
 * ```typescript
 * const ctx = await contextBrainNode('/project', 'decision:D-abc123');
 * if (ctx) {
 *   console.log(ctx.node.label, ctx.outEdges.length, 'outgoing edges');
 * }
 * ```
 */
export async function contextBrainNode(
  projectRoot: string,
  nodeId: string,
): Promise<NodeContext | null> {
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();

  if (!nativeDb) return null;

  const rawNode = nativeDb
    .prepare(
      `SELECT id, node_type, label, quality_score, content_hash,
              last_activity_at, metadata_json, created_at, updated_at
       FROM brain_page_nodes WHERE id = ?`,
    )
    .get(nodeId) as unknown as RawNode | undefined;

  if (!rawNode) return null;

  const node = mapNode(rawNode);

  const rawOutEdges = nativeDb
    .prepare(
      `SELECT from_id, to_id, edge_type, weight, provenance, created_at
       FROM brain_page_edges WHERE from_id = ? ORDER BY weight DESC`,
    )
    .all(nodeId) as unknown as RawEdge[];

  const rawInEdges = nativeDb
    .prepare(
      `SELECT from_id, to_id, edge_type, weight, provenance, created_at
       FROM brain_page_edges WHERE to_id = ? ORDER BY weight DESC`,
    )
    .all(nodeId) as unknown as RawEdge[];

  const outEdges = rawOutEdges.map(mapEdge);
  const inEdges = rawInEdges.map(mapEdge);

  // Collect unique neighbour IDs from both directions
  const seenIds = new Set<string>([nodeId]);
  const neighbors: RelatedNode[] = [];

  for (const e of rawOutEdges) {
    if (!seenIds.has(e.to_id)) {
      seenIds.add(e.to_id);
      const rawNeighbour = nativeDb
        .prepare(
          `SELECT id, node_type, label, quality_score, content_hash,
                  last_activity_at, metadata_json, created_at, updated_at
           FROM brain_page_nodes WHERE id = ?`,
        )
        .get(e.to_id) as unknown as RawNode | undefined;
      if (rawNeighbour) {
        neighbors.push({
          node: mapNode(rawNeighbour),
          edgeType: e.edge_type as BrainEdgeType,
          direction: 'out',
          weight: e.weight,
        });
      }
    }
  }

  for (const e of rawInEdges) {
    if (!seenIds.has(e.from_id)) {
      seenIds.add(e.from_id);
      const rawNeighbour = nativeDb
        .prepare(
          `SELECT id, node_type, label, quality_score, content_hash,
                  last_activity_at, metadata_json, created_at, updated_at
           FROM brain_page_nodes WHERE id = ?`,
        )
        .get(e.from_id) as unknown as RawNode | undefined;
      if (rawNeighbour) {
        neighbors.push({
          node: mapNode(rawNeighbour),
          edgeType: e.edge_type as BrainEdgeType,
          direction: 'in',
          weight: e.weight,
        });
      }
    }
  }

  // Sort neighbours by weight descending
  neighbors.sort((a, b) => b.weight - a.weight);

  return { node, inEdges, outEdges, neighbors };
}

// ---------------------------------------------------------------------------
// graphStats — aggregate counts by type
// ---------------------------------------------------------------------------

/**
 * Return aggregate counts for brain_page_nodes and brain_page_edges by type.
 *
 * @param projectRoot - Absolute path to the project root
 * @returns Counts by node type and edge type, plus totals
 *
 * @example
 * ```typescript
 * const stats = await graphStats('/project');
 * console.log(stats.totalNodes, stats.totalEdges);
 * ```
 */
export async function graphStats(projectRoot: string): Promise<GraphStats> {
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();

  if (!nativeDb) {
    return { nodesByType: [], edgesByType: [], totalNodes: 0, totalEdges: 0 };
  }

  const nodeRows = nativeDb
    .prepare(
      `SELECT node_type, COUNT(*) AS count
       FROM brain_page_nodes GROUP BY node_type ORDER BY count DESC`,
    )
    .all() as unknown as Array<{ node_type: string; count: number }>;

  const edgeRows = nativeDb
    .prepare(
      `SELECT edge_type, COUNT(*) AS count
       FROM brain_page_edges GROUP BY edge_type ORDER BY count DESC`,
    )
    .all() as unknown as Array<{ edge_type: string; count: number }>;

  const totalNodes = nodeRows.reduce((s, r) => s + r.count, 0);
  const totalEdges = edgeRows.reduce((s, r) => s + r.count, 0);

  return {
    nodesByType: nodeRows.map((r) => ({ nodeType: r.node_type, count: r.count })),
    edgesByType: edgeRows.map((r) => ({ edgeType: r.edge_type, count: r.count })),
    totalNodes,
    totalEdges,
  };
}
