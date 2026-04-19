/**
 * Single Living Brain node + neighbors endpoint.
 *
 * GET /api/living-brain/node/:id
 *   → { node: LBNode, neighbors: LBNode[], edges: LBEdge[] }
 *
 * `:id` must be a substrate-prefixed node ID, e.g.:
 *   brain:O-abc123
 *   nexus:packages/core/src/store/tasks-schema.ts::createTask
 *   tasks:T626
 *   conduit:msg-xyz
 *   signaldock:agent-007
 *
 * Returns 404 if the node is not found.
 * Returns neighbors = nodes directly connected by at least one edge.
 */

import { getAllSubstrates, type LBEdge, type LBNode } from '@cleocode/brain';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export interface NodeNeighborsResponse {
  node: LBNode;
  neighbors: LBNode[];
  edges: LBEdge[];
}

export const GET: RequestHandler = ({ locals, params }) => {
  const nodeId = decodeURIComponent(params.id);
  if (!nodeId) {
    return json({ error: 'id is required' }, { status: 400 });
  }

  // Parse substrate from prefix
  const colonIdx = nodeId.indexOf(':');
  if (colonIdx === -1) {
    return json({ error: 'id must be substrate-prefixed, e.g. "brain:O-abc"' }, { status: 400 });
  }

  try {
    // Load the full graph (limit 2000 to maximize chance of finding neighbors)
    const graph = getAllSubstrates({ limit: 2000, projectCtx: locals.projectCtx });

    const node = graph.nodes.find((n) => n.id === nodeId);
    if (!node) {
      return json({ error: `Node not found: ${nodeId}` }, { status: 404 });
    }

    // Collect edges touching this node
    const edges = graph.edges.filter((e) => e.source === nodeId || e.target === nodeId);

    // Collect neighbor node IDs
    const neighborIds = new Set<string>();
    for (const e of edges) {
      if (e.source !== nodeId) neighborIds.add(e.source);
      if (e.target !== nodeId) neighborIds.add(e.target);
    }

    const neighbors = graph.nodes.filter((n) => neighborIds.has(n.id));

    return json({ node, neighbors, edges } satisfies NodeNeighborsResponse);
  } catch (err) {
    return json({ error: String(err) }, { status: 500 });
  }
};
