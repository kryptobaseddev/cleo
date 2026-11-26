/**
 * Barrel for all substrate adapters.
 *
 * Re-exports individual adapter functions and provides the unified
 * `getAllSubstrates()` function that merges results from all five substrates
 * (read from the project and global `cleo.db`) into a single BrainGraph.
 */

export { getAgentRegistrySubstrate } from './agent-registry.js';
export { getBrainSubstrate } from './brain.js';
export { getConduitSubstrate } from './conduit.js';
export { getNexusSubstrate } from './nexus.js';
export { getTasksSubstrate } from './tasks.js';

import { allTyped, readProjectStore, tryQuery } from '../db-connections.js';
import { type ProjectContext, resolveDefaultProjectContext } from '../project-context.js';
import type {
  BrainEdge,
  BrainGraph,
  BrainNode,
  BrainNodeKind,
  BrainQueryOptions,
  BrainSubstrate,
  BrainSubstrateResult,
} from '../types.js';
import { getAgentRegistrySubstrate } from './agent-registry.js';
import { getBrainSubstrate } from './brain.js';
import { getConduitSubstrate } from './conduit.js';
import { getNexusSubstrate } from './nexus.js';
import { getTasksSubstrate } from './tasks.js';

/** Substrate names ordered for iteration. */
const ALL_SUBSTRATES: BrainSubstrate[] = ['brain', 'nexus', 'tasks', 'conduit', 'agent-registry'];

/** Maps substrate name to its adapter function. */
const ADAPTER_MAP: Record<BrainSubstrate, (options: BrainQueryOptions) => BrainSubstrateResult> = {
  brain: getBrainSubstrate,
  nexus: getNexusSubstrate,
  tasks: getTasksSubstrate,
  conduit: getConduitSubstrate,
  'agent-registry': getAgentRegistrySubstrate,
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
 * @param ctx - Project whose `cleo.db` code graph resolves nexus stubs.
 * @param errors - Collects a failed nexus stub read, so the stubs it would
 *   have recovered are never dropped silently (T14656).
 * @param isFailedTarget - True for a target whose kind's node query failed: it
 *   gets no query-less stub, since the node may exist but failed to load (T14659).
 * @returns Array of stub BrainNode objects for missing targets.
 */
function loadStubNodesForEdgeTargets(
  loadedNodeIds: Set<string>,
  edges: BrainEdge[],
  ctx: ProjectContext,
  errors: string[],
  isFailedTarget: (nodeId: string) => boolean,
): BrainNode[] {
  // Collect all target IDs referenced by edges but not yet loaded
  const missingTargetIds = new Set<string>();
  for (const edge of edges) {
    if (!loadedNodeIds.has(edge.target)) {
      missingTargetIds.add(edge.target);
    }
  }

  if (missingTargetIds.size === 0) return [];

  // Partition missing target IDs by substrate
  const stubsBySubstrate = new Map<BrainSubstrate, string[]>();
  for (const nodeId of missingTargetIds) {
    const sep = nodeId.indexOf(':');
    if (sep === -1) continue;

    const substrateStr = nodeId.slice(0, sep);
    const substrate = substrateStr as BrainSubstrate;
    if (!(['brain', 'nexus', 'tasks', 'conduit', 'agent-registry'] as const).includes(substrate)) {
      continue;
    }

    if (!stubsBySubstrate.has(substrate)) {
      stubsBySubstrate.set(substrate, []);
    }
    stubsBySubstrate.get(substrate)!.push(nodeId);
  }

  const stubs: BrainNode[] = [];

  // Load stubs for nexus targets (most common cross-substrate case)
  const nexusStubs = stubsBySubstrate.get('nexus');
  if (nexusStubs && nexusStubs.length > 0) {
    readProjectStore(
      ctx,
      (db) => {
        const rawNexusIds = nexusStubs.map((id) => id.replace(/^nexus:/, ''));
        const placeholders = rawNexusIds.map(() => '?').join(',');

        // Query minimal node data: id, kind, name
        const stubRows = tryQuery(errors, 'nexus_nodes (stubs)', () =>
          allTyped<{ id: string; kind: string; name: string }>(
            db.prepare(
              `SELECT id, kind, COALESCE(name, label) AS name
             FROM main.nexus_nodes
             WHERE id IN (${placeholders})`,
            ),
            ...rawNexusIds,
          ),
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
      },
      (message) => errors.push(message),
    );
  }

  // For other substrates (tasks, brain, conduit, signaldock), create minimal stubs
  // without DB queries — they are rare as cross-substrate edge targets.
  for (const [substrate, nodeIds] of stubsBySubstrate) {
    if (substrate === 'nexus') continue; // already handled above

    for (const nodeId of nodeIds) {
      if (isFailedTarget(nodeId)) continue; // never fake a node that failed to load
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
 * Returns the kind of a query-less stub target when its ID alone settles it.
 *
 * Brain IDs carry no kind; the brain adapter drops its own failed-kind
 * endpoints, so a missing brain target is never judged here.
 *
 * @param substrate - The target's substrate.
 * @param rawId - The target ID without its substrate prefix.
 * @returns The target's kind, or null when the ID does not determine it.
 */
function stubTargetKind(substrate: BrainSubstrate, rawId: string): BrainNodeKind | null {
  switch (substrate) {
    case 'tasks':
      return rawId.startsWith('ses_') ? 'session' : 'task';
    case 'conduit':
      return 'message';
    case 'agent-registry':
      return 'agent';
    default:
      return null;
  }
}

/**
 * Queries all five substrates and merges the results into a unified BrainGraph.
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
 * Stub nodes carry `meta.isStub: true` for optional UI differentiation. A
 * target whose kind's node query failed gets no query-less stub: its edge is
 * dropped and counted in that substrate's error (T14658). A missing target of
 * a kind that loaded is stubbed as before, even when another query of its
 * substrate failed (T14659).
 * A substrate whose read failed is named in `errors` with the SQL error, so a
 * broken query never passes for an empty substrate (T14647). Each query is
 * caught on its own, so one failure never skips a substrate's other queries;
 * an unopenable store and a failed nexus stub read are reported too (T14656).
 *
 * @param options - Query options forwarded to each substrate adapter.
 * @returns Merged BrainGraph across all requested substrates, with stub nodes for unresolved edge targets.
 */
export function getAllSubstrates(options: BrainQueryOptions = {}): BrainGraph {
  const substrates = options.substrates ?? ALL_SUBSTRATES;
  const limit = options.limit ?? 500;

  const allNodes: BrainNode[] = [];
  const allEdges: BrainEdge[] = [];

  const nodeCounts = Object.fromEntries(ALL_SUBSTRATES.map((s) => [s, 0])) as Record<
    BrainSubstrate,
    number
  >;

  const edgeCounts = Object.fromEntries([...ALL_SUBSTRATES, 'cross'].map((s) => [s, 0])) as Record<
    BrainSubstrate | 'cross',
    number
  >;

  const errors: Partial<Record<BrainSubstrate, string>> = {};
  const failedKinds = new Map<BrainSubstrate, ReadonlySet<BrainNodeKind>>();

  for (const substrate of substrates) {
    const adapter = ADAPTER_MAP[substrate];
    if (!adapter) continue;

    const { nodes, edges, error, failedKinds: kinds } = adapter({ ...options, limit });
    if (error !== undefined) errors[substrate] = error;
    if (kinds !== undefined) failedKinds.set(substrate, new Set(kinds));

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
  const uniqueNodes: BrainNode[] = [];
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
  /** The kind of `nodeId` when that kind's node query failed, else null. */
  const failedTargetKind = (nodeId: string): BrainNodeKind | null => {
    const sep = nodeId.indexOf(':');
    const substrate = nodeId.slice(0, sep) as BrainSubstrate;
    const kind = stubTargetKind(substrate, nodeId.slice(sep + 1));
    return kind !== null && failedKinds.get(substrate)?.has(kind) ? kind : null;
  };
  const isFailedTarget = (nodeId: string): boolean => failedTargetKind(nodeId) !== null;
  const stubErrors: string[] = [];
  const stubNodes = loadStubNodesForEdgeTargets(
    seenIds,
    allEdges,
    options.projectCtx ?? resolveDefaultProjectContext(),
    stubErrors,
    isFailedTarget,
  );
  // A failed stub read is a nexus read failure; it joins any nexus adapter error.
  for (const message of stubErrors) {
    if (errors.nexus?.includes(message)) continue;
    errors.nexus = errors.nexus === undefined ? message : `${errors.nexus}; ${message}`;
  }
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

  // An edge whose unloaded target is of a failed kind got no stub: drop it and
  // count it under that substrate's error (T14658, T14659).
  const dropped = new Map<
    string,
    { substrate: BrainSubstrate; kind: BrainNodeKind; count: number }
  >();
  const edges = allEdges.filter((edge) => {
    const kind = seenIds.has(edge.target) ? null : failedTargetKind(edge.target);
    if (kind === null) return true;
    const substrate = edge.target.slice(0, edge.target.indexOf(':')) as BrainSubstrate;
    const key = `${substrate}:${kind}`;
    const entry = dropped.get(key) ?? { substrate, kind, count: 0 };
    entry.count += 1;
    dropped.set(key, entry);
    edgeCounts[edge.substrate] -= 1;
    return false;
  });
  for (const { substrate, kind, count } of dropped.values()) {
    errors[substrate] =
      `${errors[substrate]}; dropped ${count} edge(s) whose ${kind} target did not load because its node query failed`;
  }

  const truncated = uniqueNodes.length >= limit;

  return {
    nodes: truncated ? uniqueNodes.slice(0, limit) : uniqueNodes,
    edges,
    counts: { nodes: nodeCounts, edges: edgeCounts },
    truncated,
    ...(Object.keys(errors).length > 0 ? { errors } : {}),
  };
}
