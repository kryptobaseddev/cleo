/**
 * Memory graph API endpoint.
 * GET /api/memory/graph → aggregate BRAIN graph statistics
 *
 * Delegates to `@cleocode/core` public memory API (T9615/T9616).
 * Zero raw SQL in this handler.
 *
 * @remarks
 * The CORE `getMemoryGraph` returns aggregate statistics (node count, edge
 * count, type distribution) rather than the full node/edge rows. The response
 * shape is updated to reflect this; callers that need per-node data should
 * use the search or observations endpoints instead.
 */

import { getMemoryGraph, type MemoryGraphStats } from '@cleocode/core';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export type { MemoryGraphStats };

/** API response shape for the `/api/memory/graph` endpoint. */
export interface MemoryGraphResponse {
  /** Total node count in the BRAIN page graph. */
  total_nodes: number;
  /** Total edge count in the BRAIN page graph. */
  total_edges: number;
  /** Distribution of edge types across the graph. */
  edge_type_distribution: Record<string, number>;
  /** Average number of edges per node. */
  average_edges_per_node: number;
}

export const GET: RequestHandler = async ({ locals }) => {
  try {
    const stats = await getMemoryGraph({
      projectPath: locals.projectCtx.projectPath,
    });
    return json({
      total_nodes: stats.nodeCount,
      total_edges: stats.edgeCount,
      edge_type_distribution: stats.edgeTypeDistribution,
      average_edges_per_node: stats.averageEdgesPerNode,
    } satisfies MemoryGraphResponse);
  } catch {
    return json({
      total_nodes: 0,
      total_edges: 0,
      edge_type_distribution: {},
      average_edges_per_node: 0,
    } satisfies MemoryGraphResponse);
  }
};
