/**
 * Memory graph API endpoint.
 * GET /api/memory/graph → { nodes: MemoryGraphNode[], edges: MemoryGraphEdge[] }
 *
 * Returns brain_page_nodes and brain_page_edges for the force-directed graph.
 * Limits to 500 nodes for performance (highest quality first).
 *
 * @remarks
 * These are raw database row types (`MemoryGraphNode`, `MemoryGraphEdge`) —
 * distinct from the unified super-graph types (`BrainNode`, `BrainEdge`)
 * from `@cleocode/contracts`. T989 renamed the local types to prevent
 * confusion with the canonical graph shapes.
 */

import { json } from '@sveltejs/kit';
import { getBrainDb } from '$lib/server/db/connections.js';
import type { RequestHandler } from './$types';

/** A single raw graph node row from the `brain_page_nodes` table. */
export interface MemoryGraphNode {
  id: string;
  node_type: string;
  label: string;
  quality_score: number;
  metadata_json: string | null;
  created_at: string;
}

/** A single raw graph edge row from the `brain_page_edges` table. */
export interface MemoryGraphEdge {
  from_id: string;
  to_id: string;
  edge_type: string;
  weight: number;
  created_at: string;
}

/** API response shape for the `/api/memory/graph` endpoint. */
export interface MemoryGraphResponse {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  total_nodes: number;
  total_edges: number;
}

const MAX_NODES = 500;

export const GET: RequestHandler = ({ locals }) => {
  const db = getBrainDb(locals.projectCtx);
  if (!db) {
    return json({
      nodes: [],
      edges: [],
      total_nodes: 0,
      total_edges: 0,
    } satisfies MemoryGraphResponse);
  }

  try {
    const totalNodeRow = db.prepare('SELECT COUNT(*) as cnt FROM brain_page_nodes').get() as {
      cnt: number;
    };
    const totalEdgeRow = db.prepare('SELECT COUNT(*) as cnt FROM brain_page_edges').get() as {
      cnt: number;
    };

    const nodes = db
      .prepare(
        `SELECT id, node_type, label, quality_score, metadata_json, created_at
         FROM brain_page_nodes
         ORDER BY quality_score DESC, last_activity_at DESC
         LIMIT ?`,
      )
      .all(MAX_NODES) as MemoryGraphNode[];

    const nodeIds = new Set(nodes.map((n) => n.id));

    // Only include edges where both endpoints are in the node set
    const allEdges = db
      .prepare(
        `SELECT from_id, to_id, edge_type, weight, created_at
         FROM brain_page_edges`,
      )
      .all() as MemoryGraphEdge[];

    const edges = allEdges.filter((e) => nodeIds.has(e.from_id) && nodeIds.has(e.to_id));

    return json({
      nodes,
      edges,
      total_nodes: totalNodeRow.cnt,
      total_edges: totalEdgeRow.cnt,
    } satisfies MemoryGraphResponse);
  } catch {
    return json({
      nodes: [],
      edges: [],
      total_nodes: 0,
      total_edges: 0,
    } satisfies MemoryGraphResponse);
  }
};
