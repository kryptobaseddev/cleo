/**
 * Nexus adapter — converts raw nexus.db rows (nodes + relations) into the
 * kit-wide {@link GraphNode} / {@link GraphEdge} / {@link GraphCluster}
 * shape consumed by every renderer.
 *
 * This module is the ONE place where `nexus_nodes.kind` strings and
 * `nexus_relations.type` strings are mapped onto the kit's canonical
 * {@link EdgeKind} union. Everything downstream (layout, renderer,
 * filters, side panel) speaks only the normalised shape.
 *
 * @task T990
 * @wave 1B
 */

import type { EdgeKind, GraphCluster, GraphEdge, GraphNode } from '../types.js';

/**
 * Raw nexus_nodes row — camelCase to stay consistent with the rest of
 * the studio data layer. Column renaming happens in the loader.
 */
export interface NexusNodeRow {
  /** Stable row id. */
  id: string;
  /** Human-readable label. */
  label: string;
  /** Substrate-local kind (function / method / class / file / …). */
  kind: string;
  /** Optional file path where the symbol is defined. */
  filePath?: string | null;
  /** Optional community id (soft FK to `nexus_nodes.id` of the cluster node). */
  communityId?: string | null;
  /** Optional caller count (precomputed upstream). */
  callerCount?: number;
}

/**
 * Raw nexus_relations row.
 */
export interface NexusRelationRow {
  /** Optional row id — when absent, the adapter synthesises one. */
  id?: string;
  /** Source node id. */
  source: string;
  /** Target node id. */
  target: string;
  /** Relation type string as stored in `nexus_relations.type`. */
  type: string;
  /** Optional edge weight / confidence. */
  weight?: number;
}

/**
 * Edge kinds that explicitly encode direction. All other kinds render as
 * a non-arrow line by default (the kit overrides per-style below).
 */
const DIRECTIONAL_KINDS: ReadonlySet<EdgeKind> = new Set<EdgeKind>([
  'calls',
  'extends',
  'implements',
  'imports',
  'contains',
  'defines',
  'has_method',
  'has_property',
  'accesses',
  'member_of',
]);

/**
 * Strict mapping from the nexus relation-type string → canonical
 * {@link EdgeKind}. Any string that lands outside the mapping is folded
 * into `relates_to` so the renderer never crashes on unknown input.
 */
const NEXUS_RELATION_TO_EDGE_KIND: Readonly<Record<string, EdgeKind>> = {
  contains: 'contains',
  defines: 'defines',
  imports: 'imports',
  accesses: 'accesses',
  calls: 'calls',
  extends: 'extends',
  implements: 'implements',
  method_overrides: 'extends',
  method_implements: 'implements',
  has_method: 'has_method',
  has_property: 'has_property',
  member_of: 'member_of',
  documents: 'documents',
  applies_to: 'references',
  references: 'references',
  cites: 'cites',
  // Flow-domain — rendered as call-graph edges for now.
  step_in_process: 'calls',
  entry_point_of: 'defines',
  handles_route: 'calls',
  handles_tool: 'calls',
  fetches: 'calls',
  queries: 'accesses',
  wraps: 'derived_from',
};

/**
 * Map a nexus relation-type string to the canonical kit edge kind.
 *
 * Exported for tests + to let server loaders pre-classify when building
 * macro-view aggregates.
 *
 * @param type - The raw `nexus_relations.type` value.
 * @returns A canonical {@link EdgeKind}. Unknown strings map to `relates_to`.
 */
export function mapNexusRelationToEdgeKind(type: string): EdgeKind {
  return NEXUS_RELATION_TO_EDGE_KIND[type] ?? 'relates_to';
}

/**
 * Normalise caller-count into a 0-1 `weight`. Uses a log curve so
 * a single call doesn't appear identical to a mega-hub.
 *
 * @param callers - Raw caller count.
 */
function normaliseWeight(callers: number): number {
  if (callers <= 0) return 0.1;
  // log₁₀(1000) = 3 → maps 1000 callers to 1.0
  return Math.min(1, Math.log10(callers + 1) / 3);
}

/**
 * Convert nexus node + relation rows into the kit-wide graph shape.
 *
 * The function DOES NOT assign positions — callers pipe the output
 * into `layout/nexus-layout.ts` or let the cosmos simulation settle
 * the points from a random seed.
 *
 * @param nodes - Raw nexus_nodes rows.
 * @param relations - Raw nexus_relations rows.
 * @param opts - Optional override knobs.
 */
export function adaptNexusRows(
  nodes: NexusNodeRow[],
  relations: NexusRelationRow[],
  opts?: {
    /** When true, drop member_of edges (they clutter the macro view). */
    dropMemberOf?: boolean;
  },
): {
  nodes: GraphNode[];
  edges: GraphEdge[];
  clusters: GraphCluster[];
} {
  const nodeIndex = new Map<string, GraphNode>();
  const clusterIndex = new Map<string, GraphCluster>();

  for (const row of nodes) {
    if (!row.id) continue;
    const isCommunity = row.kind === 'community';
    const node: GraphNode = {
      id: row.id,
      substrate: 'nexus',
      kind: row.kind || 'symbol',
      label: row.label || row.id,
      category: row.communityId ?? null,
      weight: normaliseWeight(row.callerCount ?? 0),
      meta: {
        filePath: row.filePath ?? null,
        callerCount: row.callerCount ?? 0,
      },
    };
    nodeIndex.set(row.id, node);

    // Community synthetic nodes are surfaced as clusters, not as nodes.
    if (isCommunity) {
      const cluster: GraphCluster = {
        id: row.id,
        label: row.label || row.id,
        substrate: 'nexus',
        memberIds: [],
      };
      clusterIndex.set(row.id, cluster);
    }
  }

  // Thread every node into its cluster's memberIds list.
  for (const node of nodeIndex.values()) {
    if (!node.category) continue;
    const cluster = clusterIndex.get(node.category);
    if (cluster) cluster.memberIds.push(node.id);
  }

  const edges: GraphEdge[] = [];
  for (let i = 0; i < relations.length; i++) {
    const row = relations[i];
    if (!row.source || !row.target) continue;
    if (row.source === row.target) continue;
    if (!nodeIndex.has(row.source) || !nodeIndex.has(row.target)) continue;

    const kind = mapNexusRelationToEdgeKind(row.type);
    if (opts?.dropMemberOf && kind === 'member_of') continue;

    edges.push({
      id: row.id ?? `nxr-${i}-${row.source}-${row.target}-${kind}`,
      source: row.source,
      target: row.target,
      kind,
      weight: typeof row.weight === 'number' ? Math.min(1, Math.max(0, row.weight)) : undefined,
      directional: DIRECTIONAL_KINDS.has(kind),
    });
  }

  return {
    nodes: [...nodeIndex.values()],
    edges,
    clusters: [...clusterIndex.values()],
  };
}

/**
 * Adapt a pre-aggregated macro view: one node per community, one edge
 * per dominant-type cross-community aggregate.
 *
 * The macro view receives synthetic nodes whose `kind` is `community`
 * and synthetic edges whose `kind` matches the dominant relation type
 * across the aggregate window (killing the "cross-community"
 * hardcoding flagged by the T990 code audit).
 */
export interface MacroCommunityRow {
  id: string;
  label: string;
  memberCount: number;
  topKind: string;
}

/**
 * One macro edge — caller supplies the dominant {@link EdgeKind} so
 * the renderer can style it correctly.
 */
export interface MacroEdgeRow {
  source: string;
  target: string;
  kind: EdgeKind;
  weight: number;
}

/**
 * Build a macro-view graph from pre-aggregated community rows.
 *
 * @param communities - One row per community.
 * @param edges - One row per directional community pair.
 */
export function adaptNexusMacro(
  communities: MacroCommunityRow[],
  edges: MacroEdgeRow[],
): {
  nodes: GraphNode[];
  edges: GraphEdge[];
  clusters: GraphCluster[];
} {
  const graphNodes: GraphNode[] = communities.map((c) => ({
    id: c.id,
    substrate: 'nexus',
    kind: 'community',
    label: c.label,
    category: c.id,
    weight: Math.min(1, Math.log10(c.memberCount + 1) / 3),
    meta: {
      memberCount: c.memberCount,
      topKind: c.topKind,
    },
  }));

  const clusters: GraphCluster[] = communities.map((c) => ({
    id: c.id,
    label: c.label,
    substrate: 'nexus',
    memberIds: [c.id],
  }));

  const nodeIds = new Set(graphNodes.map((n) => n.id));
  const graphEdges: GraphEdge[] = edges
    .filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target) && e.source !== e.target)
    .map((e, idx) => ({
      id: `macro-${idx}-${e.source}-${e.target}`,
      source: e.source,
      target: e.target,
      kind: e.kind,
      weight: Math.min(1, e.weight / 100),
      directional: DIRECTIONAL_KINDS.has(e.kind),
    }));

  return { nodes: graphNodes, edges: graphEdges, clusters };
}
