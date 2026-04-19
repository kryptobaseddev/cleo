/**
 * CLEO Studio — adapter from the runtime Brain graph shape
 * ({@link import('@cleocode/brain').BrainNode} /
 * {@link import('@cleocode/brain').BrainEdge}) to the shared kit
 * contract ({@link GraphNode} / {@link GraphEdge}).
 *
 * Used by the unified Brain page AND the legacy-shim components that
 * keep pre-T990 imports (`LivingBrain3D`, `LivingBrainGraph`) working
 * while their internals are retargeted at {@link ThreeBrainRenderer}.
 *
 * ## Bridge integration (Agent D / T990)
 *
 * {@link adaptBrainGraphWithBridges} is the preferred entry-point when
 * pre-computed cross-substrate bridge edges are available (e.g. from
 * Agent C's tier-0 server load). It merges the bridge edges into the
 * adapted graph so every `GraphEdge` with `meta.isBridge === true` is
 * included in the returned `edges` array.
 *
 * The original {@link adaptBrainGraph} signature is preserved unchanged
 * for backward compatibility.
 *
 * @task T990
 * @wave 1A
 */

import type { BrainEdge, BrainNode } from '@cleocode/brain';
import { ALL_EDGE_KINDS } from './edge-kinds.js';
import type { EdgeKind, GraphEdge, GraphNode } from './types.js';

/** Derived graph shape consumed by renderers. */
export interface AdaptedBrainGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * Convert a {@link BrainNode} + {@link BrainEdge} pair of arrays into
 * the kit contract. Computes:
 *
 *   - `freshness` from `createdAt` (30-day half-life),
 *   - `isHub` via a degree heuristic (top 20% by degree OR weight≥0.85),
 *   - clamps unknown edge `type` values to `'relates_to'`.
 *
 * @param nodes - Raw Brain nodes.
 * @param edges - Raw Brain edges.
 */
export function adaptBrainGraph(nodes: BrainNode[], edges: BrainEdge[]): AdaptedBrainGraph {
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  const maxDegree = Math.max(1, ...degree.values());

  const adaptedNodes: GraphNode[] = nodes.map((n) => {
    const d = degree.get(n.id) ?? 0;
    const isHub = d / maxDegree > 0.55 || (n.weight ?? 0) >= 0.85;
    return {
      id: n.id,
      substrate: n.substrate,
      kind: n.kind,
      label: n.label,
      category: (n.meta?.cluster_id as string | undefined) ?? n.substrate,
      weight: n.weight,
      freshness: freshnessFromCreatedAt(n.createdAt),
      meta: { ...n.meta, isHub },
    };
  });

  const nodeIds = new Set(adaptedNodes.map((n) => n.id));
  const validKinds = new Set<string>(ALL_EDGE_KINDS);

  const adaptedEdges: GraphEdge[] = edges
    .filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target))
    .map((e, i): GraphEdge => {
      const kind: EdgeKind = validKinds.has(e.type) ? (e.type as EdgeKind) : 'relates_to';
      return {
        id: `be-${i}:${e.source}>${e.target}:${e.type}`,
        source: e.source,
        target: e.target,
        kind,
        weight: e.weight,
        directional: true,
      };
    });

  return { nodes: adaptedNodes, edges: adaptedEdges };
}

/**
 * Merge pre-computed cross-substrate bridge edges into an already-adapted
 * brain graph.
 *
 * This is the preferred entry-point when Agent C's server load has called
 * {@link import('./adapters/cross-substrate.js').computeBridges} and
 * returned the bridge edge set. Bridges are appended to the edge array
 * **after** filtering to ensure both endpoints exist in the node set.
 *
 * The function is deliberately additive — it never modifies the original
 * `adapted` object in place.
 *
 * @param adapted - The result of a previous {@link adaptBrainGraph} call.
 * @param bridges - Pre-computed bridge edges (from `computeBridges`).
 *   May be empty; the function handles that gracefully.
 * @returns A new {@link AdaptedBrainGraph} whose `edges` array includes
 *   all valid bridge edges appended after the intra-substrate edges.
 *
 * @example
 * ```ts
 * const base = adaptBrainGraph(nodes, edges);
 * const bridges = computeBridges(base.nodes, { brainDb, tasksDb, nexusDb });
 * const full = adaptBrainGraphWithBridges(base, bridges);
 * // full.edges now contains both intra-substrate + cross-substrate edges
 * ```
 */
export function adaptBrainGraphWithBridges(
  adapted: AdaptedBrainGraph,
  bridges: GraphEdge[],
): AdaptedBrainGraph {
  if (bridges.length === 0) return adapted;

  const nodeIdSet = new Set(adapted.nodes.map((n) => n.id));

  // Filter: only include bridges where both endpoints exist in the node set
  const validBridges = bridges.filter((b) => nodeIdSet.has(b.source) && nodeIdSet.has(b.target));

  return {
    nodes: adapted.nodes,
    edges: [...adapted.edges, ...validBridges],
  };
}

/**
 * Map an ISO-8601 timestamp to a 0..1 freshness score with a 30-day
 * decay. Missing / invalid timestamps map to a mid-band 0.3 so they
 * still breathe.
 */
function freshnessFromCreatedAt(createdAt: string | null): number {
  if (!createdAt) return 0.3;
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return 0.3;
  const age = Math.max(0, Date.now() - t);
  const ms30d = 30 * 24 * 60 * 60 * 1000;
  return Math.max(0.15, 1 - age / ms30d);
}
