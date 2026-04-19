/**
 * CLEO Studio — graph kit public surface.
 *
 * Waves 1B (Code) and 1C (Tasks) depend on {@link GraphNode},
 * {@link GraphEdge}, {@link EdgeKind}, and {@link SubstrateId} from
 * this barrel. Breaking changes here MUST be reflected in
 * `.cleo/agent-outputs/T990-design-work/wave-1a-brain/KIT-CONTRACT.md`.
 *
 * @task T990
 * @wave 1A
 */

export { type AdaptedBrainGraph, adaptBrainGraph } from './brain-adapter.js';
export {
  type ClusterLabelPoint,
  CORTICAL_REGIONS,
  default as ClusterLabelLayer,
} from './cluster-label-layer.svelte';
export {
  ALL_EDGE_KINDS,
  describeEdgeKind,
  EDGE_STYLE,
  type EdgeStyle,
  invalidateEdgeStyleCache,
  resolveEdgeStyleForWebGL,
} from './edge-kinds.js';
export {
  type ActiveFire,
  createFiringQueue,
  FiringQueue,
} from './firing-queue.js';
export { default as HoverLabel } from './hover-label.svelte';
export type {
  BrainLiveCallbacks,
  BrainLiveEvent,
  BrainLiveStatus,
} from './live/brain-events.js';
export {
  createSseBridge,
  type SseBridgeHandle,
  type SseBridgeOptions,
} from './live/sse-bridge.js';
export { type MockBrainPayload, mockBrain } from './mock.js';
export {
  assertNoFaceUp,
  FaceUpLabelsForbiddenError,
  type NoFaceUpOptions,
} from './no-face-up.js';
export { default as ThreeBrainRenderer } from './renderers/ThreeBrainRenderer.svelte';
export {
  ALL_SUBSTRATES,
  type EdgeKind,
  FIRE_DURATION_MS,
  type FireEvent,
  type GraphCluster,
  type GraphEdge,
  type GraphNode,
  type SubstrateId,
} from './types.js';
