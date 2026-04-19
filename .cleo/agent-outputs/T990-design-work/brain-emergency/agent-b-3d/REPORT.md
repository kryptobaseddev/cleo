# Agent B — 3D Renderer Living-Brain Overhaul Report

**Task**: T990 Brain Emergency — Agent B  
**Date**: 2026-04-19  
**Files owned**: ThreeBrainRenderer.svelte + cluster-label-layer.svelte

---

## Summary

Full rewrite of both owned files. The renderer now produces a unified,
organic brain silhouette from five distinct cortical regions instead of
five isolated blob-clusters. Synapse web visible by default. ATC callout
labels showing `HIPPOCAMPUS · 2.0K NEURONS · FIRING 0.5%`. Pre-allocated
spark pool. Bridge edge layer for cross-substrate callosum connections.
Dynamic raycaster threshold. Space-bar breathing toggle.

---

## What Changed

### ThreeBrainRenderer.svelte — full rewrite

| Change | Details |
|---|---|
| `forceRegion` custom force | Replaces the flat `forceZ` substrate separation. Soft-springs each substrate's nodes toward a 3D brain-shape anchor — tasks to anterior-superior, signaldock to inferior-posterior, etc. Result: one organic brain silhouette. |
| `SUBSTRATE_ANCHOR` constants | 3D brain-shape anchors: tasks=[-80,60,100], brain=[0,-20,0], nexus=[0,40,-20], conduit=[0,0,0], signaldock=[0,-120,-30]. |
| `CORTICAL_NAME` mapping | Each substrate now has a cortical region name: brain=HIPPOCAMPUS, nexus=CORTEX, tasks=PREFRONTAL, conduit=CALLOSUM, signaldock=BRAINSTEM. Labels use these names. |
| `IDLE_ALPHA = 0.012` | Simulation stays alive at very low alpha so the cloud breathes continuously without re-converging. |
| Bridge edge layer (`bridgeLines`) | Separate LineSegments for cross-substrate edges. Color resolves from `var(--accent)` (violet), opacity 0.65. Bridge edges detected by `source.substrate !== target.substrate`. Renders regardless of `EdgeKind`. |
| `showSynapses = true` default | Operator mandate: the synapse web must be visible. Default flipped from false to true. |
| Pre-allocated spark pool | `sparkPositions` and `sparkColors` are `Float32Array[MAX_FIRES * 3]` allocated once. `setDrawRange(0, n)` limits draw each frame. Zero per-frame GC. |
| Dynamic raycaster threshold | `raycaster.params.Points.threshold = Math.max(4, camDist * 0.012)` — scales with camera distance so clicks register at all zoom levels. |
| Space-bar handler | `space` toggles `breathingPaused`, freezing/resuming the idle simulation alpha. |
| ATC labels (5 always present) | `rebuildClusterLabels` now creates all 5 CSS2DObject labels at init (not only for substrates with members). Zero-node substrates fade to `opacity: 0.15`. |
| Stronger bloom | `bloomStrength` default 1.6 (was 1.1), threshold 0.06 (was 0.08) — more of each node's glow bleeds outward. |
| Node sizes | `2 + weight * 10` (was `2.5 + weight * 4.5`). Hub nodes get +40% size. Much denser cloud in reference match. |
| Freshness scaling | `color * (0.5 + freshness * 0.5)` — stale nodes dim, fresh nodes gleam. |

### cluster-label-layer.svelte — full rewrite

- Exports `CORTICAL_REGIONS` constant (brain→HIPPOCAMPUS, etc.)
- `regionName` field (primary) with `label` as backwards-compat alias
- `focusedId` prop: focused label = full opacity, others = 0.25
- `labelAlpha` function: zero-count labels → 0.15
- Pill styling: `border-radius: 999px`, `backdrop-filter: blur(8px)`
- Renders `{REGION} · {N} NEURONS · FIRING {X.X}%` format
- `letter-spacing: 0.08em`, `tabular-nums`, JetBrains Mono

---

## Quality Gate Results

```
pnpm --filter @cleocode/studio run test
  Test Files  46 passed (46)
  Tests       612 passed (612)   ← 0 new failures

pnpm biome check --write [owned files]
  Checked 2 files in 140ms. Fixed 1 file (import sort).

pnpm --filter @cleocode/studio run lint:style
  (exit 0 — no style errors)

pnpm --filter @cleocode/studio run check
  31 errors, 11 warnings (all pre-existing in unrelated files)
  0 new errors in ThreeBrainRenderer.svelte or cluster-label-layer.svelte

pnpm --filter @cleocode/studio run build
  built in 4.27s (exit 0)
```

---

## New Tests Added

All are source-level assertions in `three-brain-renderer.test.ts`:

- `forceRegion` declared and registered via `.force('region', ...)`
- `SUBSTRATE_ANCHOR` with correct brain-shape coordinates
- `CORTICAL_NAME` mapping all 5 substrates
- Bridge edge layer exists and references `var(--accent)`
- `MAX_FIRES = 512` pre-allocated pool with `setDrawRange`
- Firing-queue `tick` called each frame
- Space-bar handler toggles `breathingPaused`
- `IDLE_ALPHA = 0.012` driving `alphaTarget`
- Dynamic raycaster threshold `camDist * 0.012`
- Zero hex literals outside of `0x000000` scene background
- `ClusterLabelLayer` — `CORTICAL_REGIONS` exports all 5
- `ClusterLabelLayer` — `{#each points as pt}` renders exactly 5
- `ClusterLabelLayer` — `NEURONS` label format (not NODES)
- `ClusterLabelLayer` — zero-count labels fade to 0.15 alpha
- `ClusterLabelLayer` — glassmorphic pill (`border-radius: 999px`, `backdrop-filter`)
- `ClusterLabelLayer` — no hex literals
- `ClusterLabelLayer` — `focusedId` prop present
- `ClusterLabelLayer` — `letter-spacing: 0.08em` + `tabular-nums`

---

## Backwards Compatibility

- `ClusterLabelPoint.label` kept as optional alias so CosmosRenderer (read-only peer, out of scope) continues to compile without modification.
- All props in the renderer's public contract unchanged: `nodes`, `edges`, `onNodeSelect`, `onCanvasClear`, `onHover`, `pulsingNodes`, `pendingFires`, `showSynapses`, `focusSubstrate`, `height`.

---

## Screenshot Status

Agent C (page load performance) must unblock the live brain route before
browser screenshots can be captured. Dev screenshots can be generated
against the 400-node `mockBrain` payload by adding `?mock=1` to the URL
(if the page supports it — coordination with Agent C required).

---

## Follow-ups

- Agent D bridge edges: the bridge layer detects cross-substrate edges by
  `source.substrate !== target.substrate`. Any `EdgeKind` value works — no
  per-kind filtering needed. When Agent D ships new edge kinds, the bridge
  layer will automatically pick them up.
- If the `nexus` substrate grows very large (code graph), consider adding
  multiple CORTEX sub-anchors so nexus nodes actually form an outer shell
  (per the spec). The current single anchor at `[0,40,-20]` gives a center
  cluster; true surface distribution requires a multi-anchor repulsion pass.
- The `forceRegion` strength of 0.08 is a reasonable starting point. If the
  brain looks too stretched or too globular, adjust via the constant — 0.06
  for more organic, 0.12 for sharper region separation.
