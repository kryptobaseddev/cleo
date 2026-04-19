# T990 · Graph Engine Recommendation for Studio Redesign

**Author:** frontend-architect agent
**Date:** 2026-04-17
**Budget:** 7 minutes
**Decision horizon:** T990 Studio redesign (consolidate 5 engines → 2)

---

## 1. Inventory — every engine, every render surface

Canonical search was executed against `packages/` filtered to `.ts`, `.svelte`, `package.json` (excluding `node_modules`, `dist`). Findings are grouped by **engine** and mapped to **render surface**.

### 1.1 Engines declared in `packages/studio/package.json`

| Engine | Version | Where imported |
|---|---|---|
| `sigma` | `^3.0.2` | `LivingBrainGraph.svelte`, `NexusGraph.svelte`, `TaskDepGraph.svelte`, `sigma-defaults.ts` |
| `@cosmograph/cosmos` | `^2.0.0-beta.26` | `LivingBrainCosmograph.svelte` |
| `3d-force-graph` | `^1.80.0` | `LivingBrain3D.svelte` |
| `d3` (`d3-force`, `d3-zoom`, `d3-selection`) | `^7.9.0` | `BrainGraph.svelte`, `tasks/GraphTab.svelte` |
| `graphology` + `graphology-layout-forceatlas2` | `^0.26.0` / `^0.10.1` | shared model + layout for all sigma surfaces (`LivingBrainGraph`, `NexusGraph`, `TaskDepGraph`, `living-brain-graph.ts` store) |
| `three` + `three-stdlib` | `^0.183.2` | post-processing composer inside `LivingBrain3D` (driven by `3d-force-graph`) |

**Also in the monorepo (not rendering, but share the graph model):**

- `packages/nexus/src/pipeline/community-processor.ts` — `graphology` + `graphology-communities-louvain` (Louvain clustering, server-side).
- `packages/cleo/package.json` — same `graphology` + `graphology-communities-louvain` (CLI side).

### 1.2 Render surfaces

| Surface | Route / component | Engine | Notes |
|---|---|---|---|
| **Brain — Standard 2D** | `routes/brain/+page.svelte` → `LivingBrainGraph.svelte` | **sigma 3** (WebGL) + graphology + ForceAtlas2 | Default. Custom pill-label renderer, edge-arrow program, pulse animation on observed nodes. |
| **Brain — GPU** | same page, `rendererMode === 'gpu'` → `LivingBrainCosmograph.svelte` | **cosmos.gl 2.0 beta** (WebGL / regl) | Auto-engages >2 000 nodes. No per-node / per-link animation API — pulses approximated via `setPointColors` tween. |
| **Brain — 3D** | `routes/brain/3d/+page.svelte` → `LivingBrain3D.svelte` | **3d-force-graph** + THREE.js post-processing | Bloom / glow via `postProcessingComposer`. No per-node update API — whole graph re-assigned on change. |
| **Brain — legacy SVG** | `BrainGraph.svelte` (still present) | **d3-force + SVG** | Small-graph path, pre-cosmos. Has detail-panel; imported by older routes. **Redundant with LivingBrainGraph.** |
| **Nexus — code graph** | `NexusGraph.svelte` (used by code / code-intelligence surfaces) | **sigma 3** + graphology + ForceAtlas2 | Edge semantics: `calls` / `imports` / `extends`. Hover + click node. 11 279 symbols / 23 782 relations possible. |
| **Task — dependency explorer** | `routes/tasks/...` → `tasks/GraphTab.svelte` | **d3-force + SVG** | 3 edge kinds (`parent` solid, `blocks` `4 4` dashed red, `depends` `2 3` dotted). Zoom/pan, blocked-halo, release-layout. |
| **Task — mini dep graph** | `TaskDepGraph.svelte` | **sigma 3** + graphology + ForceAtlas2 | Focal task + upstream/downstream ring. |
| **Pipeline timeline** | `tasks/KanbanTab.svelte`, `RecentActivityFeed.svelte`, etc. | **No graph engine** — CSS/flex layout | Not a graph surface. Pure DOM; exclude from consolidation. |

### 1.3 Engine count, as-is

**5 rendering engines** across 7 graph surfaces. This matches the operator's concern exactly.

1. sigma 3 (+ graphology layout) — Brain 2D, Nexus, TaskDepGraph mini
2. cosmos.gl — Brain GPU
3. 3d-force-graph (+ THREE) — Brain 3D
4. d3-force (SVG) — Task GraphTab, legacy BrainGraph
5. graphology — shared data model (kept — not a renderer)

---

## 2. Overlap map — where consolidation wins

| Cluster | Current engines | Consolidatable? | Proposed single engine |
|---|---|---|---|
| Brain 2D + Brain GPU + Brain 3D | sigma · cosmos.gl · 3d-force-graph | **Yes — one engine, three viewpoints** | **`@cosmograph/cosmos` (cosmos.gl)** |
| Legacy `BrainGraph.svelte` (d3-force SVG) | d3-force | **Delete / fold into Brain canonical** | remove surface |
| Nexus code graph | sigma 3 | **Yes — same engine as Brain** | cosmos.gl |
| TaskDepGraph mini | sigma 3 | **Yes — same engine as Task GraphTab** | d3-force (SVG) |
| Task GraphTab | d3-force SVG | **Keep separate from Brain** | d3-force (SVG) |

**Outcome:** 5 engines → **2 engines**.

- **cosmos.gl** — single high-density / live-animation surface (Brain in all three viewpoints, Nexus code graph).
- **d3-force + SVG** — single low-density / semantic-edge surface (Task GraphTab, TaskDepGraph mini, any ad-hoc ≤300-node relationship view).

`graphology` stays as the shared in-memory graph model and retains its Louvain community detection role — neither of those are render concerns.

---

## 3. Operator requirements distilled

> "Feels like a living brain — synapses firing, live connections forming, amazing single view"
> "NO face-up titles anywhere — hover only, cluster labels only"
> "Task graph: parents + deps + blockers with visually distinct edges"
> "Code: connections correct (GitNexus-reference)"

Translated to concrete engine requirements:

| R# | Requirement | Engine capability needed |
|---|---|---|
| R1 | Neural aesthetic — synapse pulses, glow, traveling spikes | GPU shaders with per-link + per-node color/uniform mutation |
| R2 | Live connections forming in real-time (SSE / memory observe / nexus update) | Incremental node/edge add without full re-upload |
| R3 | One canonical Brain view (no three modes presented to user) | Single engine that scales 100 → 100 000 nodes |
| R4 | No face-up titles; hover-only; cluster labels only | Off-canvas label suppression + cluster-label overlay layer |
| R5 | Task graph must preserve **3 visually distinct edge kinds** | Per-edge stroke-dasharray + color (SVG strength) |
| R6 | Code graph connections must be visibly correct (GitNexus reference) | Directed edges with arrowheads, hover highlight neighbors |
| R7 | 60 fps interaction on typical dev laptop | WebGL/GPU for >2 k nodes; SVG fine below 500 |
| R8 | Dark theme, brand-consistent theming | Color as Float32 uniform (GPU) or CSS variable (SVG) |
| R9 | Accessible — keyboard nav, screen-reader node list (WCAG 2.1 AA) | Separate DOM list/table complements canvas; canvas is augmentative |

---

## 4. Engine recommendation

### 4.1 Brain + Nexus → **cosmos.gl (`@cosmograph/cosmos` 2.x)**

**One engine for every high-density substrate.** The three Brain modes collapse into one rendering pipeline with three "camera modes" layered on top:

- **Flat 2D** — default; cosmos.gl's native projection.
- **Depth (pseudo-3D)** — cosmos.gl supports z-positioning via link distance and radial layout; cheaper than switching engines for occasional depth cues.
- **True 3D** — only if the brain truly benefits from it. Realistically we can **retire `3d-force-graph`**; the synapse-firing aesthetic reads better in 2D with glow shaders than in 3D orbiting camera. Operator's quote ("amazing single view") favors a single persistent canvas.

**Why cosmos.gl specifically (over sigma 3 and 3d-force-graph):**

| Criterion | cosmos.gl 2.x | sigma 3 | 3d-force-graph |
|---|---|---|---|
| Node ceiling before jank | **100 000 +** | ~2 000 (already hits limit in `+page.svelte:397`) | ~5 000 |
| Layout on GPU (force sim) | **Yes — simulation is on GPU** | No — CPU ForceAtlas2 | No — CPU d3-force (wrapped) |
| Per-link color uniform | Yes (`setLinkColors`) | Yes | Partial |
| Real-time mutation | `setPointColors` / `setLinkColors` on Float32Array — O(changed) upload | Full `graph.refresh()` CPU cycle | Full graph replacement |
| Shader access for synapses | **Yes — regl backend, custom fragment shaders feasible** | No (custom programs possible but not shader-first) | Via THREE postprocess (heavier) |
| Bundle cost | ~220 KB min+gzip | ~90 KB | ~600 KB (THREE dependency) |
| Maturity | Beta (`2.0.0-beta.26`) — **risk flag** | Stable 3.x | Stable but unmaintained pace |

**cosmos.gl trade-off acknowledged:** still in beta (v2.0.0-beta.26). The code already wraps around this in `LivingBrainCosmograph.svelte:10-38` noting missing per-node animation API. The mitigation is the shared "graph kit" (§6) which abstracts synapse pulses behind a local API; if cosmos.gl's API shifts, the kit absorbs the change.

**Neural aesthetic implementation path with cosmos.gl:**

1. Map node `weight` / `hebbian_strength` → point size + alpha (already done).
2. Map edge `co_fire_count` (STDP) → link color temperature (cool blue → hot cyan → white).
3. Synapse fire: on memory observe SSE event, push the event's (src,tgt) into a **firing queue**; every frame, advance each fire along the link by interpolating a sub-segment color override to white. This runs through `setLinkColors` diffs — O(firing edges), not O(all edges).
4. Bloom: cosmos.gl doesn't ship bloom, but **additive blending + radial alpha falloff in a custom shader** gives the synapse glow without the 600 KB THREE cost.

### 4.2 Task + TaskDepGraph + any semantic low-density graph → **d3-force + SVG**

**Why d3-force stays, why `TaskDepGraph.svelte` moves to it:**

| Criterion | d3-force (SVG) | cosmos.gl |
|---|---|---|
| Per-edge `stroke-dasharray` (3 kinds: solid / `4 4` / `2 3`) | **Trivial (CSS/SVG attr)** | Requires per-edge sub-segment patterns or a texture atlas — heavy |
| Arrowhead markers | Native `<marker>` | Requires custom geometry |
| Accessibility (focusable `<g>` nodes, ARIA labels) | **Native** | Canvas is opaque to AT |
| Bundle | d3 is already in — **zero new cost** | N/A |
| Node ceiling for semantic graphs | Plenty at ≤500 (tasks typically ≤300) | Overkill |

`TaskDepGraph.svelte` (currently sigma) is a ≤30-node focal view — d3-force/SVG is strictly better there and lets it share styles and edge-kind logic with `tasks/GraphTab.svelte`. Consolidating removes sigma's entire footprint from the Task surface.

### 4.3 Engines removed under this recommendation

- **sigma 3** — removed. `LivingBrainGraph` and `NexusGraph` migrate to cosmos.gl; `TaskDepGraph` migrates to d3-force/SVG.
- **3d-force-graph** — removed. 3D mode is retired; single cosmos.gl canvas with glow shader achieves the "living brain" aesthetic with less complexity.
- **three** / **three-stdlib** — removed from studio deps. (Still usable elsewhere if a cinematic moment is desired, but not on the default path.)
- **graphology-layout-forceatlas2** — removed (cosmos.gl owns layout).
- **Legacy `BrainGraph.svelte`** — deleted; `LivingBrainGraph` cosmos.gl replacement is canonical.

`graphology` **stays** — it's the portable graph model used server-side by nexus Louvain clustering and client-side for community metadata; it is **not** a renderer.

---

## 5. Why cosmos.gl specifically fits the neural aesthetic

The operator's directive is the emotional spec: *synapses firing, live connections forming, amazing single view.* Three concrete reasons cosmos.gl nails this that the other engines cannot match in the same canvas:

1. **GPU force simulation.** Every other candidate stops animating the layout once stable — cosmos.gl can keep a low-amplitude "breathing" sim alive at negligible CPU cost, which reads as life even when no data is changing. sigma + ForceAtlas2 freezes to save CPU; 3d-force-graph tick rate collapses above 3 000 nodes.

2. **Per-link color as Float32 uniform.** A synapse fire is just a time-varying RGBA on one link. With cosmos.gl you write a 4-float slice into an already-allocated buffer; the draw call is one frame of GPU work. On sigma you re-render every visible edge via 2D canvas; on 3d-force-graph you re-assign the `linkColor` accessor and incur a THREE material rebuild.

3. **Additive blending with regl.** regl (cosmos.gl's underlying abstraction) exposes blend-mode config directly. Setting `{ src: 'src alpha', dst: 'one' }` on the node + link programs gives the **glow pile-up** at active clusters for free — that's what makes a brain look like a brain instead of a graph.

The beta status is a real risk. Mitigate by (a) pinning the exact version, (b) isolating all cosmos.gl calls behind the shared graph kit (§6), (c) keeping a feature flag that falls back to a minimal static canvas if init fails — the existing code already has an `onInitializationError` slot in `LivingBrainCosmograph.svelte:51-53` that proves this pattern works.

---

## 6. Shared graph kit — `packages/studio/src/lib/graph/`

Consolidation only pays off if the call sites share code. Propose this module boundary:

```
packages/studio/src/lib/graph/
├── index.ts                        # Barrel — single import surface
├── types.ts                        # Node / Edge / EdgeKind unions (re-export contracts)
├── model/
│   ├── graphology-adapter.ts       # graphology <-> cosmos buffers
│   └── layout.ts                   # ForceAtlas2 / cosmos layout presets
├── renderers/
│   ├── CosmosRenderer.svelte       # wraps cosmos.gl for Brain + Nexus
│   └── SvgRenderer.svelte          # wraps d3-force for Task + small graphs
├── edges/
│   ├── edge-kinds.ts               # 'parent' | 'blocks' | 'depends' | 'call' | 'synapse'
│   ├── edge-style-svg.ts           # dash patterns, arrowheads, colors
│   └── edge-style-cosmos.ts        # buffer encoding + synapse shader program
├── labels/
│   ├── hover-label.svelte          # ONE tooltip component — shared by both renderers
│   ├── cluster-label-layer.svelte  # Absolute-positioned cluster labels (operator R4)
│   └── no-face-up.ts               # Guard utility: asserts `drawLabels: false` on cosmos + `text` suppressed on SVG
├── interactions/
│   ├── hover.ts                    # Shared hover detection (quadtree for SVG, cosmos picker for GPU)
│   ├── pan-zoom.ts                 # d3-zoom wrapper — single behavior module
│   └── pick-neighbors.ts           # Hover-highlight neighbors (used by all surfaces)
├── live/
│   ├── sse-bridge.ts               # Listens to /api/brain/events, /api/nexus/events
│   ├── firing-queue.ts             # Pending synapse fires → per-frame interp
│   └── synapse-shader.ts           # regl fragment program for traveling spike
└── __tests__/
    ├── edge-kinds.test.ts
    ├── no-face-up.test.ts          # regression guard against operator R4
    └── firing-queue.test.ts
```

**Contracts enforced by the kit:**

- All node data is `BrainNode | NexusSymbol | GraphNode` from `@cleocode/contracts` — no inline types.
- **R4 (no face-up titles)** is programmatic: `no-face-up.ts` exports a type-level + runtime assertion called by every renderer factory. Attempting to enable inline labels fails a unit test *and* throws in dev.
- Cluster labels render via a **DOM overlay layer** positioned from cosmos viewport coords — they survive zoom at a fixed font size and are reachable by screen readers.
- **R5 (3 distinct edge kinds)** is centralized in `edges/edge-kinds.ts`: `parent` solid, `blocks` `4 4` dashed, `depends` `2 3` dotted — one source of truth consumed by both renderers' style shims.
- **R6 (code graph correctness)** uses `GitNexus` node IDs as the canonical key; the kit rejects duplicate/collision IDs at `from(nodes, edges)` time.
- **R7 (perf)** — the CosmosRenderer auto-activates `simulationPaused` when the viewport is off-screen (`IntersectionObserver`), saving GPU cycles on hidden tabs.

**Live-update wiring (R1 + R2) — synapse fire flow:**

```
brain SSE --> sse-bridge.ts
           -> firing-queue.enqueue({ src, tgt, intensity, ts })
frame N    -> firing-queue.tick(dt) returns [{ linkIdx, color }]
           -> cosmos.setLinkColors(diff)
           -> synapse-shader amplifies additive glow along the fire's t in [0,1]
```

This gives the operator a visibly living brain without ever re-running layout.

---

## 7. Migration plan summary

| Step | Surface | Action |
|---|---|---|
| 1 | `TaskDepGraph.svelte` | Port from sigma → SvgRenderer (reuse `tasks/GraphTab.svelte` edge styles) |
| 2 | `NexusGraph.svelte` | Port from sigma → CosmosRenderer |
| 3 | `LivingBrainGraph.svelte` | Replace internals with CosmosRenderer; keep outer component as thin shim for backwards compat |
| 4 | `routes/brain/+page.svelte` | Remove renderer-mode toggle; cosmos is the single path (retain `?view=3d` only if 3D survives user testing) |
| 5 | `LivingBrain3D.svelte` | Delete (or move to an experimental route gated by flag) |
| 6 | `BrainGraph.svelte` (legacy) | Delete |
| 7 | `package.json` | Remove `sigma`, `3d-force-graph`, `three`, `three-stdlib`, `graphology-layout-forceatlas2` |
| 8 | `lib/graph/` | Land shared kit with tests & `no-face-up` guard |

**Net deps removed:** sigma, 3d-force-graph, three, three-stdlib, graphology-layout-forceatlas2 — approx **~1.1 MB unzipped**, **~280 KB gzip** shaved from the studio bundle.

---

## 8. TL;DR

- **One engine for neural / dense / live surfaces: `@cosmograph/cosmos` (cosmos.gl).**
- **One engine for semantic / small / edge-kind-rich surfaces: d3-force + SVG.**
- **Retire:** sigma 3, 3d-force-graph, three (from studio), legacy `BrainGraph.svelte`.
- **Keep:** graphology (model only, not a renderer).
- **Wrap both in `packages/studio/src/lib/graph/`** with programmatic enforcement of R4 (no face-up titles) and R5 (three distinct edge kinds) so no future surface drifts.

---

## Files referenced

- `/mnt/projects/cleocode/packages/studio/package.json`
- `/mnt/projects/cleocode/packages/studio/src/routes/brain/+page.svelte`
- `/mnt/projects/cleocode/packages/studio/src/routes/brain/+page.server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/brain/3d/+page.server.ts`
- `/mnt/projects/cleocode/packages/studio/src/lib/components/LivingBrainGraph.svelte`
- `/mnt/projects/cleocode/packages/studio/src/lib/components/LivingBrainCosmograph.svelte`
- `/mnt/projects/cleocode/packages/studio/src/lib/components/LivingBrain3D.svelte`
- `/mnt/projects/cleocode/packages/studio/src/lib/components/BrainGraph.svelte`
- `/mnt/projects/cleocode/packages/studio/src/lib/components/NexusGraph.svelte`
- `/mnt/projects/cleocode/packages/studio/src/lib/components/TaskDepGraph.svelte`
- `/mnt/projects/cleocode/packages/studio/src/lib/components/sigma-defaults.ts`
- `/mnt/projects/cleocode/packages/studio/src/lib/components/tasks/GraphTab.svelte`
- `/mnt/projects/cleocode/packages/studio/src/lib/components/__tests__/LivingBrainCosmograph.test.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/api/tasks/graph/+server.ts`
- `/mnt/projects/cleocode/packages/studio/src/lib/stores/living-brain-graph.ts`
- `/mnt/projects/cleocode/packages/nexus/src/pipeline/community-processor.ts`
- `/mnt/projects/cleocode/packages/nexus/src/pipeline/index.ts`
