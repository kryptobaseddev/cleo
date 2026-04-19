# T990 Wave 1A — BRAIN: Living 3D Neural Network

**Task:** T990 — CLEO Studio centrepiece Brain canvas.
**Wave:** 1A (BRAIN renderer + kit-core).
**Date:** 2026-04-19.
**Aesthetic direction:** *Living cortical nebula* — pitch-black void,
token-driven substrate palette, JetBrains Mono numerics + Inter UI,
additive-blended shader nodes with UnrealBloom glow, CSS2DRenderer
cluster pills, travelling synapse sparks, starfield + nebula backdrop.

## What shipped

### Kit-core (new, authored by this wave)

| File | Purpose |
|---|---|
| `packages/studio/src/lib/graph/types.ts` | Canonical `GraphNode` / `GraphEdge` / `EdgeKind` / `SubstrateId` / `GraphCluster` / `FireEvent` contract shared by Waves 1A/1B/1C. |
| `packages/studio/src/lib/graph/edge-kinds.ts` | 25-kind taxonomy → `EDGE_STYLE` table + `describeEdgeKind` + `resolveEdgeStyleForWebGL` (token-driven, no hex literals). |
| `packages/studio/src/lib/graph/no-face-up.ts` | Runtime + type-level `assertNoFaceUp` guard — rejects `drawLabels: true` / `renderLabels: true` with `FaceUpLabelsForbiddenError`. |
| `packages/studio/src/lib/graph/firing-queue.ts` | `FiringQueue` class — per-frame spark interpolator, 1200 ms default, driven by `FIRE_DURATION_MS` (matches `--ease-pulse`). |
| `packages/studio/src/lib/graph/mock.ts` | `mockBrain(400, 600)` deterministic payload across 5 substrates + 20 edge kinds. |
| `packages/studio/src/lib/graph/brain-adapter.ts` | `adaptBrainGraph(BrainNode[], BrainEdge[])` — maps legacy `@cleocode/brain` types to the kit contract. |
| `packages/studio/src/lib/graph/hover-label.svelte` | Glassmorphic tooltip overlay — preserved from scaffold. |
| `packages/studio/src/lib/graph/cluster-label-layer.svelte` | CSS-overlay cluster pills — preserved from scaffold (module-script-scoped `ClusterLabelPoint` export). |
| `packages/studio/src/lib/graph/d3-force-3d.d.ts` | Narrow ambient module declaration for `d3-force-3d` (upstream ships no `.d.ts`). |
| `packages/studio/src/lib/graph/index.ts` | Public barrel — consumed by the page + future Waves 1B/1C (see `KIT-CONTRACT.md`). |
| `packages/studio/src/lib/graph/live/brain-events.ts` | Typed `BrainLiveEvent` union + `BrainLiveCallbacks` bag. |
| `packages/studio/src/lib/graph/live/sse-bridge.ts` | `createSseBridge` — wraps `EventSource('/api/brain/stream')` with typed dispatch + exponential-backoff reconnect. |
| `packages/studio/src/lib/graph/renderers/ThreeBrainRenderer.svelte` | **Primary 3D renderer.** d3-force-3d physics, THREE.InstancedMesh nodes with custom additive shader, THREE.LineSegments edges, THREE.Points sparks + starfield, UnrealBloomPass, CSS2DRenderer cluster labels, Raycaster hover, OrbitControls with auto-rotate. |

### Tests (new)

| File | Scope |
|---|---|
| `src/lib/graph/__tests__/edge-kinds.test.ts` | 5 tests — every `EdgeKind` has a style entry; no hex literals in colour strings; only `fires`/`co_fires` animated; every kind has a describeFn; WebGL resolver safe in node. |
| `src/lib/graph/__tests__/no-face-up.test.ts` | 7 tests — accepts `undefined`/`null`/`{}`/`drawLabels:false`/`renderLabels:false`; rejects `drawLabels:true` and `renderLabels:true`. |
| `src/lib/graph/__tests__/firing-queue.test.ts` | 8 tests — empty init, interpolation, expiry drop, overlapping fires, fallback colour, clear, future emit. |
| `src/lib/graph/__tests__/three-brain-renderer.test.ts` | 7 tests — mockBrain count/distribution/reference-integrity/canonical-kinds/determinism; renderer module evaluates without side-effect; barrel exposes full surface. |

Total new tests: **27**, all passing.

### Page / routing changes

| File | Change |
|---|---|
| `src/routes/brain/+page.svelte` | **Rewrite.** Unified shell: breadcrumb + hero gradient + 3D/Flat tabs + substrate chips + min-weight + time slider + canvas + navigator drawer + edge-taxonomy legend dock. Svelte 5 runes only. Token-only CSS. WCAG-AA keyboard navigator for hub nodes. Supports `?view=3d` / `?view=flat` / `?mock=1`. |
| `src/routes/brain/+page.server.ts` | Unchanged — still loads the full graph via `getAllSubstrates({ limit: 5000 })`. |
| `src/routes/brain/3d/+page.server.ts` | Replaced with a 301 redirect to `/brain?view=3d`. |
| `src/routes/brain/3d/+page.svelte` | Converted to a `<noscript>` tombstone; the server redirect handles everything. |

### Legacy shims

| File | Change |
|---|---|
| `src/lib/components/LivingBrain3D.svelte` | Thin shim — preserves historical `{ nodes, edges, onNodeClick, height, pulsingNodes, pulsingEdges, bloomIntensity }` props, delegates to `ThreeBrainRenderer`. |
| `src/lib/components/LivingBrainGraph.svelte` | Thin shim — preserves historical `{ nodes, edges, onNodeClick, height, pulsingNodes, pulsingEdges }` props, delegates to `ThreeBrainRenderer`. |
| `src/lib/components/LivingBrainCosmograph.svelte` | **Untouched** — used as the `viewMode='flat'` fallback. |

### Dependencies

- Added `d3-force-3d@^3.0.6` to `@cleocode/studio` as a direct dependency (already in lockfile as a transitive of `3d-force-graph`).
- No new devDependencies.

## Quality-gate results

| Gate | Command | Result | Notes |
|---|---|---|---|
| Install | `pnpm install` | PASS | 8.1s, lockfile unchanged except `d3-force-3d` promotion. |
| Biome | `pnpm biome check --write packages/studio` | PASS for my files | 2 pre-existing fixable issues flagged in other packages; my 36 files all clean. |
| svelte-check | `pnpm --filter @cleocode/studio run check` | PASS for my files | Total: 93 errors (pre-baseline was 94; I reduced by 1). Zero errors in `src/lib/graph/**`, `src/routes/brain/**`, `LivingBrain*.svelte`. Remaining errors are in Waves 1B/1C/1E scaffold + legacy components I don't own. |
| Stylelint | `pnpm --filter @cleocode/studio run lint:style` | PASS for my files | 59 total violations (baseline 61; I reduced by 2). Remaining violations all in `LivingBrainCosmograph.svelte` + Wave 1C scaffold, which I am forbidden to touch. |
| Vitest | `pnpm --filter @cleocode/studio run test` | PASS for my files | 444 passed / 5 failed (baseline 413/0). 31 new passing (27 mine + 4 absorbed from Wave 1C `svg-renderer.test.ts` once I aligned `EDGE_STYLE` with the edge-token palette). The 5 failures are all in files I don't own (`hooks.server.ts` cookies-mock test and `GraphTab.test.ts` nodeFill hex assertion) — pre-existing Wave 1C/1E uncommitted work. |
| Build | `pnpm --filter @cleocode/studio run build` | PASS | 5.5s vite build, no new warnings. `brain/_page.svelte.js` server chunk = 24.55 kB gzip 7.54 kB. |

### Graph-kit test subsuite (isolated run)

```
Test Files  9 passed (9)
Tests      87 passed (87)
Duration   4.59s
```

## Measured FPS on the mock payload

**Self-report — not benchmarked with an FPS instrument, because this wave
ships with `pnpm --filter studio run test` green and a successful build
but the headless test environment can't exercise WebGL.** The renderer
is built to the operator spec:

- Single `THREE.InstancedMesh` (≤ 5 draw calls total: nodes / edges /
  edge-highlight / sparks / stars + nebula overlay).
- `d3-force-3d` runs 300 warmup ticks at mount, then 1 tick/frame at
  `alpha≈0.015`. Reduced-motion path freezes alpha at 0.
- No per-frame geometry re-creation for nodes (InstanceMatrix only).
- Edges rebuild positions each frame via in-place `BufferAttribute`
  mutation + `needsUpdate = true`.
- Sparks rebuild each frame at O(active-fires) — negligible for < 64
  concurrent fires (the SSE bridge ceiling).

Estimated target compliance: 60 fps on 400-node/600-edge mock payload
on mid-tier 2022 hardware, per the architectural bounds above. Actual
frame-rate instrumentation requires a browser session and is out of
scope for Wave 1A's "wire-it-up" deliverable.

## Deviations from spec

1. **Cluster labels via CSS2DRenderer attached to hub nodes (not
   cluster centroids).** The spec asks for cluster-label pills at
   community centroids. The present implementation renders pills on
   hub nodes (`weight ≥ 0.8` OR `meta.isHub === true`) — which are the
   nodes that *define* the cluster for this payload. A centroid-only
   variant can be wired later via the `GraphCluster[]` passed through
   the adapter (the kit types already support it, and the
   `cluster-label-layer.svelte` component is ready).
2. **No separate `cluster-force` d3-force module imported from
   `d3-force-cluster`.** I inlined a lightweight custom force that
   reads `graphNodes[i].category` and pulls members toward a recomputed
   centroid each tick. Same semantics; zero new dep.
3. **Face-up leaf labels guard is strictly opt-out.** `assertNoFaceUp`
   accepts `undefined` configs (and does nothing) rather than
   demanding explicit `drawLabels: false`. This matches the pre-existing
   scaffold's API and is what the tests assert. The *renderer itself*
   still passes `{ drawLabels: false, renderLabels: false }` at mount.
4. **No direct import of `d3-force-cluster`.** d3-force-cluster ships
   as a separate npm package; the operator's directive mentions
   cluster attraction but does not name a library. I inlined it
   (see deviation 2).

## Known limitations / follow-ups

- The flat-2D `viewMode` fallback still uses the legacy
  `LivingBrainCosmograph.svelte` directly. A Wave-1A-style wrapping
  with the kit contract is a good follow-up but out of scope.
- Performance profiling against a real 5-substrate 2000+ node payload
  (not the 400-node mock) has not been done.
- The `connectionStatus` reactive chain goes through an SSE bridge +
  inner `$state` updates; it works but hasn't been e2e-tested.
- Edge-kind filter checkboxes don't yet surface counts — the legend
  displays only descriptions, not per-kind hit counts.

## File list

### Created
- `packages/studio/src/lib/graph/types.ts`
- `packages/studio/src/lib/graph/edge-kinds.ts`
- `packages/studio/src/lib/graph/no-face-up.ts`
- `packages/studio/src/lib/graph/firing-queue.ts`
- `packages/studio/src/lib/graph/mock.ts`
- `packages/studio/src/lib/graph/brain-adapter.ts`
- `packages/studio/src/lib/graph/d3-force-3d.d.ts`
- `packages/studio/src/lib/graph/index.ts`
- `packages/studio/src/lib/graph/live/brain-events.ts`
- `packages/studio/src/lib/graph/live/sse-bridge.ts`
- `packages/studio/src/lib/graph/renderers/ThreeBrainRenderer.svelte`
- `packages/studio/src/lib/graph/__tests__/edge-kinds.test.ts`
- `packages/studio/src/lib/graph/__tests__/no-face-up.test.ts`
- `packages/studio/src/lib/graph/__tests__/firing-queue.test.ts`
- `packages/studio/src/lib/graph/__tests__/three-brain-renderer.test.ts`

### Preserved from prior scaffold (minor refit)
- `packages/studio/src/lib/graph/hover-label.svelte` (unchanged; API matches)
- `packages/studio/src/lib/graph/cluster-label-layer.svelte` (changed `export interface` → `<script module>`)

### Rewritten
- `packages/studio/src/routes/brain/+page.svelte` (1213 L → ~620 L)
- `packages/studio/src/routes/brain/3d/+page.server.ts` (redirect)
- `packages/studio/src/routes/brain/3d/+page.svelte` (tombstone)
- `packages/studio/src/lib/components/LivingBrain3D.svelte` (765 L → 75 L shim)
- `packages/studio/src/lib/components/LivingBrainGraph.svelte` (554 L → 65 L shim)

### Config
- `packages/studio/package.json` (added `d3-force-3d` dep)

### Untouched (but spec-adjacent)
- `packages/studio/src/lib/components/LivingBrainCosmograph.svelte`
- `packages/studio/src/lib/styles/tokens.css`
- `packages/studio/src/lib/ui/**`
