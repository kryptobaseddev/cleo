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

import { allTyped, getNexusDb } from '../db-connections.js';
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
 * Loads minimal stub nodes for any edge target IDs not already loaded.
 *
 * This second-pass loader ensures that cross-substrate edges
 * (particularly brain→nexus bridges) don't reference unloaded target nodes.
 *
 * Stub nodes carry only minimal metadata: {id, substrate, kind, label}.
 * Full details defer to side-panel click or future full-load request.
 *
 * @param loadedNodeIds - Set of already-loaded node IDs (substrate-prefixed).
 * @param edges - All edges collected from substrates (may reference unloaded targets).
 * @returns Array of stub LBNode objects for missing targets.
 */
function loadStubNodesForEdgeTargets(loadedNodeIds: Set<string>, edges: LBEdge[]): LBNode[] {
  // Collect all target IDs referenced by edges but not yet loaded
  const missingTargetIds = new Set<string>();
  for (const edge of edges) {
    if (!loadedNodeIds.has(edge.target)) {
      missingTargetIds.add(edge.target);
    }
  }

  if (missingTargetIds.size === 0) return [];

  // Partition missing target IDs by substrate
  const stubsBySubstrate = new Map<LBSubstrate, string[]>();
  for (const nodeId of missingTargetIds) {
    const sep = nodeId.indexOf(':');
    if (sep === -1) continue;

    const substrateStr = nodeId.slice(0, sep);
    const substrate = substrateStr as LBSubstrate;
    if (!(['brain', 'nexus', 'tasks', 'conduit', 'signaldock'] as const).includes(substrate)) {
      continue;
    }

    if (!stubsBySubstrate.has(substrate)) {
      stubsBySubstrate.set(substrate, []);
    }
    stubsBySubstrate.get(substrate)!.push(nodeId);
  }

  const stubs: LBNode[] = [];

  // Load stubs for nexus targets (most common cross-substrate case)
  const nexusStubs = stubsBySubstrate.get('nexus');
  if (nexusStubs && nexusStubs.length > 0) {
    const db = getNexusDb();
    if (db) {
      try {
        const rawNexusIds = nexusStubs.map((id) => id.replace(/^nexus:/, ''));
        const placeholders = rawNexusIds.map(() => '?').join(',');

        // Query minimal node data: id, kind, name
        const stubRows = allTyped<{ id: string; kind: string; name: string }>(
          db.prepare(
            `SELECT id, kind, name
             FROM nexus_nodes
             WHERE id IN (${placeholders})`,
          ),
          ...rawNexusIds,
        );

        for (const row of stubRows) {
          const kind =
            row.kind === 'file' || row.kind === 'folder' || row.kind === 'module'
              ? 'file'
              : 'symbol';
          stubs.push({
            id: `nexus:${row.id}`,
            kind,
            substrate: 'nexus',
            label: row.name,
            weight: undefined,
            createdAt: null,
            meta: { nexus_kind: row.kind, isStub: true },
          });
        }
      } catch {
        // Silently continue on error; stubs are supplemental
      }
    }
  }

  // For other substrates (tasks, brain, conduit, signaldock), create minimal stubs
  // without DB queries — they are rare as cross-substrate edge targets.
  for (const [substrate, nodeIds] of stubsBySubstrate) {
    if (substrate === 'nexus') continue; // already handled above

    for (const nodeId of nodeIds) {
      const rawId = nodeId.replace(new RegExp(`^${substrate}:`), '');
      stubs.push({
        id: nodeId,
        kind: 'observation', // generic fallback kind
        substrate,
        label: rawId,
        weight: undefined,
        createdAt: null,
        meta: { isStub: true },
      });
    }
  }

  return stubs;
}

/**
 * Queries all five substrates and merges the results into a unified LBGraph.
 *
 * When `options.substrates` is provided, only those substrates are queried.
 * Node IDs are substrate-prefixed, so deduplication is safe to perform
 * by ID equality alone.
 *
 * After all substrates are loaded, performs a second-pass stub-node load:
 * any edge target ID not yet in the loaded node set is fetched as a minimal
 * stub (id, substrate, kind, label). This recovers cross-substrate edges
 * that would otherwise be silently dropped.
 *
 * Stub nodes carry `meta.isStub: true` for optional UI differentiation.
 *
 * @param options - Query options forwarded to each substrate adapter.
 * @returns Merged LBGraph across all requested substrates, with stub nodes for unresolved edge targets.
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

  // Second pass: load stub nodes for any edge target IDs not yet loaded.
  // This recovers cross-substrate edges that would otherwise be silently dropped
  // (e.g. brain→nexus bridges to low-in-degree symbols).
  //
  // When a substrates filter is explicitly provided, only add stubs for substrates
  // within the requested set — never inject nodes from excluded substrates, as that
  // would violate the caller's filter contract.
  const requestedSubstrateSet = options.substrates ? new Set<string>(options.substrates) : null;
  const stubNodes = loadStubNodesForEdgeTargets(seenIds, allEdges);
  for (const stubNode of stubNodes) {
    if (!seenIds.has(stubNode.id)) {
      // Skip stubs from substrates not in the requested set
      if (requestedSubstrateSet && !requestedSubstrateSet.has(stubNode.substrate)) {
        continue;
      }
      seenIds.add(stubNode.id);
      uniqueNodes.push(stubNode);
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
