/**
 * Memory graph API endpoint.
 * GET /api/memory/graph → { nodes: BrainNode[], edges: BrainEdge[] }
 *
 * Returns brain_page_nodes and brain_page_edges for the force-directed graph.
 * Limits to 500 nodes for performance (highest quality first).
 */

import { json } from '@sveltejs/kit';
import { getBrainDb } from '$lib/server/db/connections.js';
import type { RequestHandler } from './$types';

/** A single graph node from brain_page_nodes. */
export interface BrainNode {
  id: string;
  node_type: string;
  label: string;
  quality_score: number;
  metadata_json: string | null;
  created_at: string;
}

/** A single graph edge from brain_page_edges. */
export interface BrainEdge {
  from_id: string;
  to_id: string;
  edge_type: string;
  weight: number;
  created_at: string;
}

/** API response shape. */
export interface BrainGraphResponse {
  nodes: BrainNode[];
  edges: BrainEdge[];
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
    } satisfies BrainGraphResponse);
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
      .all(MAX_NODES) as BrainNode[];

    const nodeIds = new Set(nodes.map((n) => n.id));

    // Only include edges where both endpoints are in the node set
    const allEdges = db
      .prepare(
        `SELECT from_id, to_id, edge_type, weight, created_at
         FROM brain_page_edges`,
      )
      .all() as BrainEdge[];

    const edges = allEdges.filter((e) => nodeIds.has(e.from_id) && nodeIds.has(e.to_id));

    return json({
      nodes,
      edges,
      total_nodes: totalNodeRow.cnt,
      total_edges: totalEdgeRow.cnt,
    } satisfies BrainGraphResponse);
  } catch {
    return json({
      nodes: [],
      edges: [],
      total_nodes: 0,
      total_edges: 0,
    } satisfies BrainGraphResponse);
  }
};
