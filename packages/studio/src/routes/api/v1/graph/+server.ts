/**
 * Universal Semantic Graph API — v1 endpoint.
 *
 * GET /api/v1/graph
 *   → { nodes, edges, totalNodes, totalEdges }
 *
 * Returns brain_page_nodes of the sentience layer types:
 *   task | decision | observation | symbol | conduit_message | llmtxt
 *
 * Only edges where **both** endpoints are present in the returned node set
 * are included, matching the T945 AC requirement.
 *
 * ## Query parameters
 *
 * | Param   | Default | Notes                                      |
 * |---------|---------|-------------------------------------------|
 * | `limit` | `500`   | Max nodes returned; capped at 5000.        |
 *
 * ## Response shape
 *
 * ```json
 * {
 *   "nodes": [{ "id", "type", "label", "qualityScore", "metadataJson", "createdAt" }],
 *   "edges": [{ "fromId", "toId", "edgeType", "weight", "createdAt" }],
 *   "totalNodes": 42,
 *   "totalEdges": 17
 * }
 * ```
 *
 * The `type` field maps `msg` (internal) to `conduit_message` (API-facing).
 *
 * @task T945
 * @epic T1056
 */

import { json } from '@sveltejs/kit';
import { getBrainDb } from '$lib/server/db/connections.js';
import type { RequestHandler } from './$types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Sentience node type strings exposed by this endpoint. */
type SentienceNodeType =
  | 'task'
  | 'decision'
  | 'observation'
  | 'symbol'
  | 'conduit_message'
  | 'llmtxt';

/** A single brain graph node row from brain_page_nodes. */
interface GraphNodeRow {
  id: string;
  node_type: string;
  label: string;
  quality_score: number;
  metadata_json: string | null;
  created_at: string;
}

/** A single brain graph edge row from brain_page_edges. */
interface GraphEdgeRow {
  from_id: string;
  to_id: string;
  edge_type: string;
  weight: number;
  created_at: string;
}

/** Response shape for GET /api/v1/graph. */
export interface V1GraphResponse {
  /** Nodes of the sentience types. */
  nodes: Array<{
    id: string;
    type: SentienceNodeType;
    label: string;
    qualityScore: number;
    metadataJson: string | null;
    createdAt: string;
  }>;
  /** Edges where both endpoints are in the node set. */
  edges: Array<{
    fromId: string;
    toId: string;
    edgeType: string;
    weight: number;
    createdAt: string;
  }>;
  /** Total node count (before limit). */
  totalNodes: number;
  /** Total edge count (before endpoint filtering). */
  totalEdges: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Internal node types that form the sentience layer.
 * `msg` is the internal type for CONDUIT messages.
 */
const SENTIENCE_INTERNAL_TYPES = ['task', 'decision', 'observation', 'symbol', 'msg', 'llmtxt'];

/**
 * Map internal `msg` type to the API-facing `conduit_message` string.
 * All other types are passed through unchanged.
 */
function toApiType(internalType: string): SentienceNodeType {
  if (internalType === 'msg') return 'conduit_message';
  return internalType as SentienceNodeType;
}

/** Parse and clamp the `limit` query parameter. */
function parseLimit(raw: string | null): number {
  const n = raw ? Number.parseInt(raw, 10) : 500;
  if (!Number.isFinite(n) || n <= 0) return 500;
  return Math.min(n, 5000);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/graph
 *
 * Returns the universal semantic graph nodes and edges for the active project.
 * Returns an empty graph (200 OK) when brain.db is unavailable.
 *
 * @task T945
 */
export const GET: RequestHandler = ({ locals, url }) => {
  const limit = parseLimit(url.searchParams.get('limit'));

  const emptyResponse: V1GraphResponse = {
    nodes: [],
    edges: [],
    totalNodes: 0,
    totalEdges: 0,
  };

  const db = getBrainDb(locals.projectCtx);
  if (!db) {
    return json(emptyResponse);
  }

  try {
    const placeholders = SENTIENCE_INTERNAL_TYPES.map(() => '?').join(', ');

    // Total count (before limit).
    const totalRow = db
      .prepare(`SELECT COUNT(*) AS cnt FROM brain_page_nodes WHERE node_type IN (${placeholders})`)
      .get(...SENTIENCE_INTERNAL_TYPES) as { cnt: number } | undefined;

    const totalNodes = totalRow?.cnt ?? 0;

    // Fetch nodes (highest quality first).
    const rawNodes = db
      .prepare(
        `SELECT id, node_type, label, quality_score, metadata_json, created_at
         FROM brain_page_nodes
         WHERE node_type IN (${placeholders})
         ORDER BY quality_score DESC, last_activity_at DESC
         LIMIT ?`,
      )
      .all(...SENTIENCE_INTERNAL_TYPES, limit) as GraphNodeRow[];

    const nodeIds = new Set(rawNodes.map((n) => n.id));

    const nodes: V1GraphResponse['nodes'] = rawNodes.map((n) => ({
      id: n.id,
      type: toApiType(n.node_type),
      label: n.label,
      qualityScore: n.quality_score,
      metadataJson: n.metadata_json,
      createdAt: n.created_at,
    }));

    // Fetch all edges, filter to those within the node set.
    const allEdges = db
      .prepare(`SELECT from_id, to_id, edge_type, weight, created_at FROM brain_page_edges`)
      .all() as GraphEdgeRow[];

    const totalEdges = allEdges.length;

    const edges: V1GraphResponse['edges'] = allEdges
      .filter((e) => nodeIds.has(e.from_id) && nodeIds.has(e.to_id))
      .map((e) => ({
        fromId: e.from_id,
        toId: e.to_id,
        edgeType: e.edge_type,
        weight: e.weight,
        createdAt: e.created_at,
      }));

    return json({
      nodes,
      edges,
      totalNodes,
      totalEdges,
    } satisfies V1GraphResponse);
  } catch {
    return json(emptyResponse);
  } finally {
    try {
      db.close();
    } catch {
      // Ignore close errors — connection is per-request.
    }
  }
};
