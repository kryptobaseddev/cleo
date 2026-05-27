/**
 * CLEO Studio — shared graph kit types.
 *
 * These types are the public contract between the Brain, Code, and Tasks
 * visualisation waves (T990 Waves 1A / 1B / 1C). Waves 1B and 1C import
 * {@link GraphNode}, {@link GraphEdge}, {@link EdgeKind} and
 * {@link SubstrateId} directly from this module — changes here are
 * breaking changes across the whole graph surface and must be reflected
 * in `KIT-CONTRACT.md`.
 *
 * @task T990
 * @wave 1A
 */

/**
 * Substrate identifiers for CLEO's 5 data graphs.
 *
 * Matches the runtime {@link import('@cleocode/brain').BrainSubstrate}
 * naming (`'brain'`, NOT `'memory'`). Keep the two planes aligned.
 */
export type SubstrateId = 'brain' | 'nexus' | 'tasks' | 'conduit' | 'signaldock';

/**
 * Canonical edge taxonomy across brain + nexus + tasks + conduit.
 *
 * The renderer looks up styling (colour, dash, thickness, arrow) via
 * {@link import('./edge-kinds.js').EDGE_STYLE} — every variant in this
 * union MUST have a corresponding entry there. An edge-kinds.test.ts
 * unit guards that invariant.
 */
export type EdgeKind =
  // hierarchy / structure
  | 'parent'
  | 'contains'
  | 'has_method'
  | 'has_property'
  | 'member_of'
  // code
  | 'calls'
  | 'extends'
  | 'implements'
  | 'imports'
  | 'accesses'
  | 'defines'
  // tasks
  | 'blocks'
  | 'depends'
  // memory
  | 'supersedes'
  | 'contradicts'
  | 'derived_from'
  | 'produced_by'
  | 'informed_by'
  | 'references'
  | 'cites'
  | 'documents'
  // runtime
  | 'fires'
  | 'co_fires'
  | 'messages'
  // fallback
  | 'relates_to';

/**
 * Normalised graph node shared by every renderer and every substrate.
 */
export interface GraphNode {
  /** Stable key. Must be unique across the whole graph. */
  id: string;
  /** Source substrate. */
  substrate: SubstrateId;
  /** Node kind within its substrate (`observation`, `symbol`, `task`, ...). */
  kind: string;
  /** Human-readable display label. */
  label: string;
  /** Cluster / community id. Drives cluster-label-layer + cluster-force. */
  category?: string | null;
  /** 0..1. Drives node size + line weight. */
  weight?: number;
  /** 0..1. Drives breathing-animation speed. */
  freshness?: number;
  /** Substrate-specific detail blob. */
  meta?: Record<string, unknown>;
}

/**
 * Normalised graph edge shared by every renderer and every substrate.
 */
export interface GraphEdge {
  /** Unique edge id. The firing queue uses this to address a specific edge. */
  id: string;
  /** Source node id — must reference a {@link GraphNode.id}. */
  source: string;
  /** Target node id — must reference a {@link GraphNode.id}. */
  target: string;
  /** Edge kind — keys into {@link import('./edge-kinds.js').EDGE_STYLE}. */
  kind: EdgeKind;
  /** 0..1. Drives thickness + spring stiffness. */
  weight?: number;
  /** When true the renderer draws an arrow head at the target. */
  directional?: boolean;
  /** Substrate-specific meta. */
  meta?: Record<string, unknown>;
}

/**
 * A named cluster (community / category) surfaced via cluster-label-layer.
 *
 * `centroid` is computed by the renderer each frame once the underlying
 * force simulation has positioned the member nodes — callers never set
 * it by hand.
 */
export interface GraphCluster {
  /** Cluster key. Unique within the graph. */
  id: string;
  /** Human-readable label rendered by cluster-label-layer. */
  label: string;
  /** Primary substrate this cluster belongs to. */
  substrate: SubstrateId;
  /** Node ids in this cluster. */
  memberIds: string[];
  /** Optional centroid written by the renderer post-layout. */
  centroid?: { x: number; y: number; z?: number };
}

/**
 * One synapse-firing event enqueued by the SSE bridge.
 *
 * The firing queue interpolates along the addressed edge from the source
 * to the target for {@link FIRE_DURATION_MS} ms, rendering a travelling
 * spark at the current `t` each frame.
 */
export interface FireEvent {
  /** Fire id — opaque, used for dedupe / cancellation. */
  id: string;
  /** Target edge id — must match a {@link GraphEdge.id}. */
  edgeId: string;
  /** 0..1 intensity. Drives spark brightness. */
  intensity: number;
  /** `Date.now()` at enqueue. */
  emittedAt: number;
}

/**
 * Default fire duration, in milliseconds.
 *
 * Matches the `--ease-pulse` motion token (1200ms) so synapse sparks
 * travel in lockstep with pulse CSS animations.
 */
export const FIRE_DURATION_MS = 1200 as const;

/**
 * Ordered list of every substrate CLEO projects. Mirror of
 * {@link SubstrateId}. Consumers use this to iterate in a stable order
 * without enumerating the union by hand.
 */
export const ALL_SUBSTRATES: readonly SubstrateId[] = [
  'brain',
  'nexus',
  'tasks',
  'conduit',
  'signaldock',
] as const;
