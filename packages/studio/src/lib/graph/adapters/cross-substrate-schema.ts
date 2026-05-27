/**
 * CLEO Studio — type definitions for cross-substrate bridge edges.
 *
 * A bridge edge connects nodes from two different CLEO substrates
 * (e.g. brain ↔ tasks, brain ↔ nexus). The `meta.isBridge: true` flag
 * is the primary signal the renderer (Agent B) uses to apply the accent-violet
 * style and increased line thickness.
 *
 * All bridge edges carry a higher default weight (0.7) than typical
 * intra-substrate edges so the force layout pulls cross-substrate
 * clusters toward each other, making the graph visually "alive".
 *
 * @task T990
 * @see cross-substrate.ts — implementation that emits these shapes
 */

import type { EdgeKind } from '../types.js';

/**
 * Discriminated union of all supported bridge-pair directions.
 *
 * The convention `A->B` means A is the source substrate and B is the
 * target substrate for the edge. Both directions are supported by the
 * {@link BridgeEdge.meta.bridgeType} field; the renderer does not
 * distinguish directionality for styling purposes.
 */
export type BridgeType =
  | 'task->brain'
  | 'task->nexus'
  | 'brain->nexus'
  | 'conduit->tasks'
  | 'conduit->brain'
  | 'signaldock->tasks'
  | 'signaldock->brain';

/**
 * A cross-substrate bridge edge with mandatory bridge-specific metadata.
 *
 * This is a strict subset of {@link import('../types.js').GraphEdge} — every
 * `BridgeEdge` is a valid `GraphEdge`, but a `GraphEdge` is only a
 * `BridgeEdge` when `meta.isBridge === true`.
 *
 * @example
 * ```ts
 * const bridge: BridgeEdge = {
 *   source: 'brain:O-abc123',
 *   target: 'tasks:T532',
 *   kind: 'produced_by',
 *   weight: 0.7,
 *   meta: {
 *     isBridge: true,
 *     bridgeType: 'task->brain',
 *     description: 'Observation produced during task T532',
 *   },
 * };
 * ```
 */
export interface BridgeEdge {
  /** Source node id — substrate-prefixed (e.g. `"brain:O-abc123"`). */
  source: string;
  /** Target node id — substrate-prefixed (e.g. `"tasks:T532"`). */
  target: string;
  /**
   * Canonical edge kind from the shared edge vocabulary.
   *
   * Bridge edges prefer semantically precise kinds (`produced_by`,
   * `derived_from`, `informed_by`, `references`, `documents`, `messages`)
   * over the generic `relates_to` fallback.
   */
  kind: EdgeKind;
  /**
   * Edge weight in [0, 1]. Defaults to 0.7 for bridge edges — deliberately
   * higher than the typical intra-substrate default to pull cross-cluster
   * layout together and make the graph feel connected.
   */
  weight: number;
  /** Bridge-specific metadata. Both `isBridge` and `bridgeType` are required. */
  meta: {
    /** Always `true` for bridge edges. The renderer uses this as the primary bridge signal. */
    isBridge: true;
    /** Describes the direction and substrates involved in this bridge. */
    bridgeType: BridgeType;
    /** Human-readable description shown in the hover tooltip. Optional. */
    description?: string;
    /** Additional free-form fields passed through from the source data. */
    [key: string]: unknown;
  };
}

/**
 * Summary statistics emitted by {@link import('./cross-substrate.js').computeBridges}
 * and logged to `console.info` so operators can verify bridge coverage.
 */
export interface BridgeStats {
  /** Total number of bridge edges emitted after deduplication and cap. */
  total: number;
  /** Bridges per category — keyed by {@link BridgeType}. */
  byType: Record<BridgeType, number>;
  /** True when the cap (2 × node count) was applied, truncating results. */
  capped: boolean;
}
