# CLEO Studio — Graph Kit Contract (Wave 1A Lock)

> **Read this before making any change inside `packages/studio/src/lib/graph/`.**
>
> Waves 1B (CODE) and 1C (TASKS) import types + helpers from this kit.
> Breaking changes here require a contract bump (this file) AND a
> coordinated PR across every consuming wave.

**Package:** `@cleocode/studio`
**Kit location:** `src/lib/graph/` (+ `src/lib/graph/live/`, `src/lib/graph/renderers/`)
**Barrel:** `src/lib/graph/index.ts`

---

## 1. Types (`./types.ts`)

```ts
export type SubstrateId =
  | 'brain' | 'nexus' | 'tasks' | 'conduit' | 'signaldock';

export type EdgeKind =
  | 'parent' | 'contains' | 'has_method' | 'has_property' | 'member_of'
  | 'calls' | 'extends' | 'implements' | 'imports' | 'accesses' | 'defines'
  | 'blocks' | 'depends'
  | 'supersedes' | 'contradicts' | 'derived_from' | 'produced_by' | 'informed_by'
  | 'references' | 'cites' | 'documents'
  | 'fires' | 'co_fires' | 'messages'
  | 'relates_to';

export interface GraphNode {
  id: string;                     // unique across graph
  substrate: SubstrateId;
  kind: string;                   // substrate-specific kind
  label: string;
  category?: string | null;       // cluster id
  weight?: number;                // 0..1 → size
  freshness?: number;             // 0..1 → breath speed
  meta?: Record<string, unknown>; // `meta.isHub = true` → labelled
}

export interface GraphEdge {
  id: string;                     // unique edge id — used by FiringQueue
  source: string;                 // GraphNode.id
  target: string;                 // GraphNode.id
  kind: EdgeKind;
  weight?: number;                // 0..1 → thickness + spring
  directional?: boolean;          // arrowhead
  meta?: Record<string, unknown>;
}

export interface GraphCluster {
  id: string;
  label: string;
  substrate: SubstrateId;
  memberIds: string[];
  centroid?: { x: number; y: number; z?: number }; // renderer-written
}

export interface FireEvent {
  id: string;
  edgeId: string;
  intensity: number; // 0..1
  emittedAt: number; // Date.now() / performance.now()
}

export const FIRE_DURATION_MS: 1200;
export const ALL_SUBSTRATES: readonly SubstrateId[]; // 5-element ordered array
```

**Invariants (enforced by tests):**
- Every `EdgeKind` variant has an `EDGE_STYLE[kind]` entry.
- `node.id` is unique across the full graph.
- `edge.id` is unique within the graph.
- `edge.source` + `edge.target` reference extant `GraphNode.id` values.

## 2. Edge taxonomy (`./edge-kinds.ts`)

```ts
export interface EdgeStyle {
  color: string;      // CSS expression — var(--edge-…) or color-mix, NEVER hex
  dash?: string;      // SVG dasharray, e.g. "6 3"
  arrow?: boolean;
  thickness: number;  // px at unit zoom
  animated?: boolean; // only `fires` + `co_fires`
}

export const EDGE_STYLE: Record<EdgeKind, EdgeStyle>;
export const ALL_EDGE_KINDS: readonly EdgeKind[];
export function describeEdgeKind(kind: EdgeKind): string;
export function resolveEdgeStyleForWebGL(kind: EdgeKind): [number, number, number];
export function invalidateEdgeStyleCache(): void;
```

**Token bindings (driven by `tokens.css` `--edge-*` family):**

| EdgeKind group | Tokens used |
|---|---|
| `parent` / `contains` / `member_of` | `--edge-structural` |
| `has_method` / `has_property` | `--edge-structural-soft` |
| `calls` | `--edge-call` |
| `extends` | `--edge-extends` |
| `implements` | `--edge-implements` |
| `imports` / `accesses` | `--edge-import`, `--edge-import-soft` |
| `defines` | `--edge-definition` |
| `blocks` | `--edge-workflow` (dashed 6 3) |
| `depends` | `--edge-workflow-soft` (dashed 2 3) |
| `supersedes` / `derived_from` / `produced_by` / `informed_by` | `--edge-knowledge`, `--edge-knowledge-soft` |
| `contradicts` | `--edge-contradicts` (dashed 4 2) |
| `references` / `cites` | `--edge-citation` |
| `documents` | `--edge-citation-soft` |
| `fires` | `--edge-fires` (animated) |
| `co_fires` | `--edge-cofires` (animated) |
| `messages` | `--edge-messages` |
| `relates_to` | `--edge-relates` |

## 3. No-face-up guard (`./no-face-up.ts`)

```ts
export class FaceUpLabelsForbiddenError extends Error {}

export interface NoFaceUpOptions {
  drawLabels?: boolean;
  renderLabels?: boolean;
}

export function assertNoFaceUp(opts: unknown): asserts opts is NoFaceUpOptions & {
  drawLabels?: false;
  renderLabels?: false;
};
```

Rejects `drawLabels: true` and `renderLabels: true`. Accepts `undefined`,
`null`, empty objects, and `false` on both fields.

## 4. Firing queue (`./firing-queue.ts`)

```ts
export interface ActiveFire {
  edgeId: string;
  t: number;                         // 0..1
  colorRgb: [number, number, number];
  intensity: number;
}

export class FiringQueue {
  constructor(duration?: number /* ms, default FIRE_DURATION_MS */);
  readonly size: number;
  readonly duration: number;
  enqueue(ev: FireEvent): void;
  clear(): void;
  tick(nowMs: number, edgesById?: ReadonlyMap<string, GraphEdge>): ActiveFire[];
}

export function createFiringQueue(): FiringQueue; // default duration
```

Contract:
- `enqueue` is safe from any thread-like context (no allocation cost beyond an array push).
- `tick` is monotonic; decreasing `nowMs` between calls is undefined.
- Expired entries are compacted out of the internal array in-place.
- Future-emitted entries (`emittedAt > nowMs`) are kept but not returned.

## 5. SSE bridge (`./live/sse-bridge.ts`)

```ts
export function createSseBridge(options: SseBridgeOptions): SseBridgeHandle;

export interface SseBridgeOptions {
  url?: string;                         // default: /api/brain/stream
  initialReconnectMs?: number;          // default: 2000
  maxReconnectMs?: number;              // default: 30000
  callbacks: BrainLiveCallbacks;
}

export interface SseBridgeHandle {
  dispose: () => void;
  readonly status: () => BrainLiveStatus;
}

export interface BrainLiveCallbacks {
  onConnect?: () => void;
  onStatus?: (s: BrainLiveStatus) => void;
  onNodeCreate?: (e: Extract<BrainLiveEvent, { type: 'node.create' }>) => void;
  onEdgeStrengthen?: (e: Extract<BrainLiveEvent, { type: 'edge.strengthen' }>) => void;
  onTaskStatus?: (e: Extract<BrainLiveEvent, { type: 'task.status' }>) => void;
  onMessageSend?: (e: Extract<BrainLiveEvent, { type: 'message.send' }>) => void;
  onHeartbeat?: (e: Extract<BrainLiveEvent, { type: 'heartbeat' }>) => void;
  onError?: (err: Error) => void;
}

export type BrainLiveEvent = import('@cleocode/brain').BrainStreamEvent;
export type BrainLiveStatus = import('@cleocode/brain').BrainConnectionStatus;
```

## 6. Brain adapter (`./brain-adapter.ts`)

```ts
export interface AdaptedBrainGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function adaptBrainGraph(
  nodes: import('@cleocode/brain').BrainNode[],
  edges: import('@cleocode/brain').BrainEdge[],
): AdaptedBrainGraph;
```

Computes:
- `freshness` from `createdAt` with a 30-day linear decay (min 0.15).
- `meta.isHub = true` when `degree / maxDegree > 0.55` OR `weight >= 0.85`.
- Clamps unknown edge `type` values to `'relates_to'`.

## 7. Renderer (`./renderers/ThreeBrainRenderer.svelte`)

```ts
interface Props {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onNodeSelect?: (node: GraphNode) => void;
  onHover?: (node: GraphNode | null) => void;
  bloomStrength?: number;        // default 1.2 (reduced-motion: 0.4)
  height?: string;               // default '100%'
  pulsingNodes?: Set<string>;
  pendingFires?: FireEvent[];
  autoRotate?: boolean;          // default true
  backdrop?: boolean;            // default true (starfield + nebula)
}
```

Honours `prefers-reduced-motion` — freezes simulation alpha, drops
bloom strength to 0.4, disables spark travel + starfield rotation +
auto-rotate.

## 8. UI primitives (`./hover-label.svelte`, `./cluster-label-layer.svelte`)

```ts
// hover-label.svelte
interface HoverLabelProps {
  node: GraphNode | null;
  x: number;
  y: number;
  secondary?: string | null;
  accent?: string;  // var(--…)
}

// cluster-label-layer.svelte  (module-scoped export)
export interface ClusterLabelPoint {
  id: string;
  label: string;
  memberCount?: number;
  x: number;
  y: number;
  tint?: string;
}
interface ClusterLabelLayerProps {
  points: ClusterLabelPoint[];
  zoom: number;
  fadeBelowZoom?: number;  // default 0.4
  visible?: boolean;       // default true
}
```

## 9. Mock payload (`./mock.ts`)

```ts
export interface MockBrainPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
  clusters: GraphCluster[];
}

export function mockBrain(
  nodeCount?: number, /* default 400 */
  edgeCount?: number, /* default 600 */
  seed?: number,      /* default 0xc1e09013 */
): MockBrainPayload;
```

Determinism is load-bearing. Identical seed → identical payload.

## 10. Barrel surface (`./index.ts`)

Waves 1B + 1C must import **only from `$lib/graph`** — never from
internal module paths. Current exports (reflect order after biome's
organise-imports pass):

- `AdaptedBrainGraph`, `adaptBrainGraph`
- `ClusterLabelLayer`, `ClusterLabelPoint`
- `ALL_EDGE_KINDS`, `EDGE_STYLE`, `EdgeStyle`, `describeEdgeKind`,
  `invalidateEdgeStyleCache`, `resolveEdgeStyleForWebGL`
- `ActiveFire`, `FiringQueue`, `createFiringQueue`
- `HoverLabel`
- `BrainLiveCallbacks`, `BrainLiveEvent`, `BrainLiveStatus`
- `SseBridgeHandle`, `SseBridgeOptions`, `createSseBridge`
- `MockBrainPayload`, `mockBrain`
- `FaceUpLabelsForbiddenError`, `NoFaceUpOptions`, `assertNoFaceUp`
- `ThreeBrainRenderer`
- `ALL_SUBSTRATES`, `EdgeKind`, `FIRE_DURATION_MS`, `FireEvent`,
  `GraphCluster`, `GraphEdge`, `GraphNode`, `SubstrateId`

## 11. Change procedure

1. Change `types.ts` / `edge-kinds.ts` / `no-face-up.ts` /
   `firing-queue.ts` → bump this doc's "wave lock" version:

   **Current lock: `1A.0` (2026-04-19)**

2. Update the corresponding `__tests__/*.test.ts` unit to reflect
   the new invariant.
3. Update every consumer (Brain page, LivingBrain3D shim,
   LivingBrainGraph shim, Wave 1B pages, Wave 1C pages).
4. Run the full `pnpm --filter @cleocode/studio run test` —
   contract changes typically light up the `edge-kinds.test.ts` +
   `svg-renderer.test.ts` suites first.
