/**
 * Barrel for all substrate adapters.
 *
 * Re-exports individual adapter functions and provides the unified
 * `getAllSubstrates()` function that merges results from all five databases
 * into a single LBGraph.
 */

export { getBrainSubstrate } from './brain.js';
export { getConduitSubstrate } from './conduit.js';
export { getNexusSubstrate } from './nexus.js';
export { getSignaldockSubstrate } from './signaldock.js';
export { getTasksSubstrate } from './tasks.js';

import type { LBEdge, LBGraph, LBNode, LBQueryOptions, LBSubstrate } from '../types.js';
import { getBrainSubstrate } from './brain.js';
import { getConduitSubstrate } from './conduit.js';
import { getNexusSubstrate } from './nexus.js';
import { getSignaldockSubstrate } from './signaldock.js';
import { getTasksSubstrate } from './tasks.js';

/** Substrate names ordered for iteration. */
const ALL_SUBSTRATES: LBSubstrate[] = ['brain', 'nexus', 'tasks', 'conduit', 'signaldock'];

/** Maps substrate name to its adapter function. */
const ADAPTER_MAP: Record<
  LBSubstrate,
  (options: LBQueryOptions) => { nodes: LBNode[]; edges: LBEdge[] }
> = {
  brain: getBrainSubstrate,
  nexus: getNexusSubstrate,
  tasks: getTasksSubstrate,
  conduit: getConduitSubstrate,
  signaldock: getSignaldockSubstrate,
};

/**
 * Queries all five substrates and merges the results into a unified LBGraph.
 *
 * When `options.substrates` is provided, only those substrates are queried.
 * Node IDs are substrate-prefixed, so deduplication is safe to perform
 * by ID equality alone.
 *
 * Cross-substrate edges may reference nodes not present in the current result
 * (e.g. a CONDUIT message edge pointing to a signaldock agent not loaded due
 * to limit). Those edges are included — the caller is responsible for
 * rendering unresolved endpoints as virtual stubs.
 *
 * @param options - Query options forwarded to each substrate adapter.
 * @returns Merged LBGraph across all requested substrates.
 */
export function getAllSubstrates(options: LBQueryOptions = {}): LBGraph {
  const substrates = options.substrates ?? ALL_SUBSTRATES;
  const limit = options.limit ?? 500;

  const allNodes: LBNode[] = [];
  const allEdges: LBEdge[] = [];

  const nodeCounts = Object.fromEntries(ALL_SUBSTRATES.map((s) => [s, 0])) as Record<
    LBSubstrate,
    number
  >;

  const edgeCounts = Object.fromEntries([...ALL_SUBSTRATES, 'cross'].map((s) => [s, 0])) as Record<
    LBSubstrate | 'cross',
    number
  >;

  for (const substrate of substrates) {
    const adapter = ADAPTER_MAP[substrate];
    if (!adapter) continue;

    const { nodes, edges } = adapter({ ...options, limit });

    allNodes.push(...nodes);
    allEdges.push(...edges);

    nodeCounts[substrate] = nodes.length;
    for (const edge of edges) {
      edgeCounts[edge.substrate] = (edgeCounts[edge.substrate] ?? 0) + 1;
    }
  }

  // Deduplicate nodes by ID (substrate-prefix guarantees uniqueness across
  // substrates; duplicates can only occur within a substrate on malformed data)
  const seenIds = new Set<string>();
  const uniqueNodes: LBNode[] = [];
  for (const node of allNodes) {
    if (!seenIds.has(node.id)) {
      seenIds.add(node.id);
      uniqueNodes.push(node);
    }
  }

  const truncated = uniqueNodes.length >= limit;

  return {
    nodes: truncated ? uniqueNodes.slice(0, limit) : uniqueNodes,
    edges: allEdges,
    counts: { nodes: nodeCounts, edges: edgeCounts },
    truncated,
  };
}
