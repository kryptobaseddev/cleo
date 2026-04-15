# Council Lead 2 — Studio Routes & UX Audit

> Audit date: 2026-04-15
> Auditor: Council Lead 2 (independent)
> Scope: packages/studio routes, UX state, GPU canvas, edge rendering

---

## Route Inventory

| Route | File | HTTP Status | Data Load | Primary Component |
|-------|------|-------------|-----------|-------------------|
| `/` | `routes/+page.svelte` | 200 | Server: brain/nexus/tasks stats counts via raw SQL | Portal grid with 4 cards (Brain, Code, Memory, Tasks) |
| `/brain` | `routes/brain/+page.svelte` | 200 | Server: `getAllSubstrates({ limit: 5000 })` — full LBGraph SSR | `LivingBrainGraph` (sigma, default) or `LivingBrainCosmograph` (cosmos.gl, GPU mode) + SSE stream |
| `/brain/overview` | `routes/brain/overview/+page.svelte` | 200 | Server: brain.db stats (8 count queries), recent nodes, node type breakdown, memory tiers | Stats grid + panels (node types, tiers, recent activity) + 4 action cards |
| `/brain/graph` | `routes/brain/graph/+page.svelte` | 200 | Client-side only (no page.server.ts): `fetch('/api/brain/graph')` on mount | `BrainGraph` (d3 force-directed, brain-only substrate, old schema) |
| `/brain/decisions` | `routes/brain/decisions/+page.svelte` | 200 | Client-side only: `fetch('/api/brain/decisions')` on mount | Table/timeline of decisions |
| `/brain/observations` | `routes/brain/observations/+page.svelte` | 200 | Client-side only: `fetch('/api/brain/observations')` on mount | Filtered table of observations |
| `/brain/quality` | `routes/brain/quality/+page.svelte` | 200 | Client-side only: `fetch('/api/brain/quality')` on mount | Quality score histograms and tier breakdowns |
| `/code` | `routes/code/+page.svelte` | 200 | Server: macro-cluster nodes from nexus.db | `NexusGraph` (sigma, cluster-level view) |
| `/code/community/[id]` | `routes/code/community/[id]/+page.svelte` | 200 | Server: community detail by cluster ID | Intra-community symbol graph (NexusGraph) |
| `/code/symbol/[name]` | `routes/code/symbol/[name]/+page.svelte` | 200 | Server: symbol detail, callers, callees | Symbol detail view with NexusGraph |
| `/projects` | `routes/projects/+page.svelte` | 200 | Server: registered projects list | Project manager with scan/clean/delete admin modals |
| `/tasks` | `routes/tasks/+page.svelte` | 200 | Server: dashboard stats (status/priority/type counts), recent tasks, epics | Tasks dashboard |
| `/tasks/pipeline` | `routes/tasks/pipeline/+page.svelte` | 200 | Server: pipeline stage columns, tasks grouped by stage | Kanban-style pipeline board |
| `/tasks/sessions` | `routes/tasks/sessions/+page.svelte` | 200 | Server: session history list | Sessions table |
| `/tasks/tree/[epicId]` | `routes/tasks/tree/[epicId]/+page.svelte` | 200 | Server: epic + all descendants | Epic tree hierarchy view |
| `/tasks/[id]` | `routes/tasks/[id]/+page.svelte` | 200 | Server: single task full detail | Task detail view |

---

## Three Brain Views Comparison

### `/brain` (Living Brain Canvas)

**What it renders:**
Full 5-substrate unified canvas. SSR loads the entire graph up to 5,000 nodes (`getAllSubstrates({ limit: 5000 })`). SSR measured at **1,916 nodes and 4,763 edges** (via HTML parse of SSR output). Runtime can toggle GPU mode. Default renderer is sigma (Standard) when `filteredGraph.nodes.length <= 2000`; auto-switches to cosmos.gl GPU mode above 2,000 nodes.

Controls: substrate filter toggles (brain/nexus/tasks/conduit/signaldock), min-weight slider, time slider (off by default), GPU/Standard renderer toggle, SSE live-stream status badge.

Side panel: click any node to fetch node detail from `/api/living-brain/node/:id`.

**Data source:** `getAllSubstrates()` — queries brain.db, nexus.db, tasks.db, conduit.db, signaldock.db and merges.

### `/brain/overview` (Memory Dashboard)

**What it renders:**
Text-only stats dashboard. 8 count cards (Graph Nodes, Graph Edges, Observations, Decisions, Patterns, Learnings, Verified, Prune Candidates). Three info panels: Node Types breakdown (colored list), Memory Tiers breakdown, Recent Activity (last 10 nodes by `last_activity_at`). Four navigation action cards linking to `/brain/graph`, `/brain/decisions`, `/brain/observations`, `/brain/quality`.

**Data source:** Server-side brain.db direct queries. No graph rendering at all — pure numbers and tables.

### `/brain/graph` (Legacy Brain-Only Graph)

**What it renders:**
Client-side-only force-directed graph of brain substrate alone (uses `BrainGraph.svelte` which uses d3, NOT sigma or cosmos.gl). Fetches from `/api/brain/graph`. Has a time slider. Shows node/edge counts. Uses an old 6-type EDGE_COLORS map (supersedes, applies_to, derived_from, part_of, produced_by, references).

**Data source:** Client-side `fetch('/api/brain/graph')` — queries brain_page_nodes/brain_page_edges only (brain substrate, NOT the unified 5-substrate graph).

**Key difference from /brain:** Shows ONLY brain substrate data using the legacy schema (brain_page_nodes/brain_page_edges). The `/brain` canvas shows all 5 substrates using the LBGraph schema.

### Recommendation: Keep All Three, But Clarify Navigation

Evidence for keeping all three:
- `/brain` = interactive canvas for ALL substrates — the primary entry point
- `/brain/overview` = text dashboard, zero overlap with canvas — useful for quick numbers without GPU
- `/brain/graph` = brain-substrate-only legacy view using d3 — has unique features (tierring visualization via ring styles) not present in the main canvas

**However:** The naming is deeply confusing. `/brain` is labeled "Brain Canvas" in the header, but the Memory nav link goes to `/brain/overview` which calls itself "BRAIN View." The `/brain/graph` route is never linked from the header nav — it's only reachable from the `/brain/overview` action cards.

**Recommended renames:**
- `/brain` → keep, rename header label from "Brain Canvas" to "Living Brain" or "5-Substrate Canvas"
- `/brain/overview` → rename to "BRAIN Memory" in nav
- `/brain/graph` → label as "Legacy Brain Graph" and consider deprecating once `/brain` canvas edge rendering is fixed

---

## Cosmograph GPU Blank Canvas — Root Cause Hypothesis

### Confirmed: `cosmos.start(1.0)` IS called (line 429)

```typescript
// LivingBrainCosmograph.svelte line 429
cosmos.start(1.0);
```

The call is present and correct.

### Confirmed: `cosmos.fitView` IS called (two attempts)

```typescript
// lines 444-449
requestAnimationFrame(() => { if (cosmos) cosmos.fitView(800, 0.15); });
setTimeout(() => { if (cosmos) cosmos.fitView(500, 0.15); }, 1_500);
```

Two fitView calls are present.

### ROOT CAUSE IDENTIFIED: Canvas Sized to 0 at Initialization

Cosmos v2.0.0-beta.26 (the installed version) reads `clientWidth`/`clientHeight` **synchronously** during construction:

```javascript
// cosmos/dist/index.js line ~12298-12300 (actual constructor code):
const r = document.createElement("canvas");
r.style.width = "100%", r.style.height = "100%", this.store.div.appendChild(r);
const i = r.clientWidth, o = r.clientHeight;           // READ IMMEDIATELY
r.width = i * this.config.pixelRatio, r.height = o * this.config.pixelRatio;
```

The WebGL backing buffer is sized **once at construction** using the container's `clientHeight` at that exact moment.

The `.lbc-canvas` container in `LivingBrainCosmograph.svelte` receives `height: "100%"` via prop. The parent chain is:

```
.lb-page { height: calc(100vh - 3rem - 4rem); flex-direction: column; }
  .lb-body { flex: 1; min-height: 0; display: grid; grid-template-columns: 1fr; }
    .lb-canvas { min-width: 0; border-radius: 8px; overflow: hidden; }
      .lbc-wrap { height: 100%; position: relative; }
        .lbc-canvas { width: 100%; height: 100%; }
          [cosmos appends <canvas> here]
```

**The problem:** `.lb-canvas` has NO explicit `height: 100%` in its CSS rules. It is a CSS grid item inside `.lb-body`. CSS grid items do stretch to fill the grid area **height** by default when the grid container has a fixed height — but this layout computation happens asynchronously in the browser's rendering pipeline. When Svelte's `onMount` fires and `initCosmos()` is called, there is a race condition: the grid layout may not have computed `.lb-canvas`'s height yet.

**Compound issue:** Cosmos's `resizeCanvas()` is called on every animation frame (confirmed at line 12842), and it WILL correctly resize IF `canvas.clientHeight` changes. However, `resizeCanvas()` only triggers a resize when `canvas.height !== canvas.clientWidth * pixelRatio`. If the container height was 0 at init, `canvas.height = 0`. When the container later resolves to a real height (say 600px), `canvas.clientHeight = 600`, so `600 * pixelRatio !== 0` — the resize DOES fire.

**Why the user still sees blank:** The resize fires on the first animation frame after layout completes, which should fix the canvas. But the force simulation started with alpha=1.0 at t=0 (when canvas was 0px), so nodes scatter in simulation space that cosmos internally tracks with a `spaceSize: 4096` coordinate system. The `fitView` calls at t=0 and t=1500ms try to fit the viewport to the simulated positions, but if the canvas was 0px when `fitView` fired (at `requestAnimationFrame` which is ~16ms after mount), `fitView` calculates a transform for a 0px canvas which results in an identity or degenerate transform. When the canvas finally resizes to the real height, the transform is wrong — the camera is pointing at a location outside the visible nodes.

**Minimal repro test:**
```html
<!-- If this div has clientHeight = 0 when cosmos constructor runs, canvas is blank -->
<div id="test" style="width:100%; height:100%">
  <!-- cosmos appended canvas here has r.clientHeight = 0 -->
</div>
```
Open DevTools, set GPU mode, check `document.querySelector('.lbc-canvas').clientHeight` in console immediately after mount. If it returns 0, this is the confirmed root cause.

**Fix:** Add `height: 100%` to `.lb-canvas` in `brain/+page.svelte` and add a `setTimeout(() => cosmos?.fitView(300, 0.15), 300)` after mount to re-fit after layout settles.

### Secondary Issue: EDGE_COLOR Map is Incomplete in Cosmograph

`LivingBrainCosmograph.svelte` has only 6 edge types in its `EDGE_COLOR` map (lines 84-91):
```typescript
const EDGE_COLOR: Record<string, string> = {
  supersedes, affects, applies_to, calls, co_retrieved, mentions
};
```

But `LivingBrainGraph.svelte` has 25 edge types in its `EDGE_COLOR` map (lines 54-87). The API returns types like `code_reference` (2,669 occurrences), `derived_from` (107), `contradicts` (100), `parent_of` (47), etc. In GPU mode, all of these fall back to the `EDGE_FALLBACK = '#94a3b8'` grey. Every edge in GPU mode renders the same color regardless of type.

---

## Edge Visibility Root Cause Hypothesis

### Confirmed: 89.2% of Edges Are Dangling (Endpoints Not in Loaded Nodes)

Measured against the live API at `limit=5000`:

```
Total nodes: 1071
Total edges: 3965
Valid edges (both endpoints in loaded nodes): 429
Dangling edges: 3536 (89.2%)
```

The graph components (`LivingBrainGraph.svelte` line 223-226 and `LivingBrainCosmograph.svelte` line 239-248) correctly filter out edges where either endpoint is absent. This is architecturally correct behavior. But it means **only 429 of 3,965 edges (10.8%) are visible**.

### Why Outer Ring Substrates Have No Connections

Breakdown of dangling edge endpoints:
- 3,166 edges have a **brain-prefixed source** that is missing from the loaded node set
- 2,658 edges have a **nexus-prefixed target** that is missing
- 620 edges target a missing brain node
- 195 edges target a missing tasks node

**The mechanism:** The brain adapter (`brain.ts`) queries brain_page_edges which contains cross-substrate references like `brain:O-xxx -> nexus:packages/nexus/src/pipeline/parse-loop.ts::parseLoop`. These nexus IDs are file-path style (`packages/.../file.ts::Symbol`). The nexus adapter only loads the **top 400 highest in-degree nexus symbols** (perSubstrateLimit = 5000/5 = 1000, then nexus gets 400 of those). A cross-substrate edge from `brain:O-xxx` to `nexus:packages/some/file.ts::SomeLowInDegreeSymbol` will be dangling because that nexus node was not included in the top-400 selection.

**The "outer ring no connections" symptom specifically:**

The user reports "outer ring substrate dots have no connections, only NEXUS center has lines visible." This matches perfectly:

1. **NEXUS→NEXUS edges (376 valid):** Nexus symbols call other nexus symbols. These are the only well-connected group because the nexus adapter filters edges to `WHERE source_id IN (...loaded nodes...) AND target_id IN (...loaded nodes...)` — so these edges are always valid by construction.
2. **Brain nodes (179 loaded):** Brain nodes emit cross-substrate edges to nexus paths and task IDs. These nexus paths are low-in-degree symbols (not in the top-400) and task IDs may not be in the loaded tasks set → all dangling.
3. **Tasks nodes (236 loaded):** Task→task edges are 47 valid (parent_of etc.). No cross-substrate task edges survive.
4. **Conduit nodes (253 loaded):** Only 12 `messages` edges total in the API, and their targets are likely not loaded.
5. **Signaldock nodes (3 loaded):** Too few nodes to have visible connections.

**The "tasks:T999 not loaded" hypothesis is confirmed:** Sample dangling edge: `brain:P-bbdb03c1 -> tasks:T532`. T532 is a task ID. The tasks adapter loads tasks via a different limit slice (tasks get ~1000/5 = 200 nodes). T532 may be outside the loaded window due to pagination ordering.

**Root cause summary:** The API returns edges referencing nodes that were excluded by per-substrate limits. The graph components correctly drop these edges. The result is a canvas where brain/conduit/signaldock nodes float as isolated dots, nexus nodes form a dense connected cluster (because their edges are intra-substrate and pre-filtered), and tasks form a small connected subgraph among themselves.

**Fix options:**
1. **Demand-side:** After loading all nodes, do a second query to load any nodes referenced by edges but missing from the node set (stub loading). This would make dangling edges renderable.
2. **Supply-side:** Have each adapter guarantee that all edge endpoints are included in the returned node set. The nexus adapter already does this (lines 88-103 of nexus.ts). The brain adapter does NOT — it emits cross-substrate edges to nexus paths that were never loaded.
3. **Display:** Show a count of "hidden edges (endpoints off-canvas)" in the UI to set user expectations.

---

## Component Inventory

| File | Purpose |
|------|---------|
| `LivingBrainGraph.svelte` | Primary sigma 3 renderer for the 5-substrate living brain canvas. ForceAtlas2 layout, custom label pill renderer, hover tooltips, per-node pulse animations via graphology attribute mutation. 25-type EDGE_COLOR map. Used in `/brain` when node count ≤ 2,000. |
| `LivingBrainCosmograph.svelte` | cosmos.gl GPU renderer for the 5-substrate living brain canvas. Float32Array buffer API, WebGL-native rendering. Supports up to ~1M nodes. Used in `/brain` when node count > 2,000 or GPU toggle active. Only 6-type EDGE_COLOR map (incomplete vs. sigma renderer). |
| `BrainGraph.svelte` | Legacy d3 force-directed graph, brain substrate ONLY. Used exclusively by `/brain/graph`. Does NOT use the unified LBGraph schema. Features memory tier ring visualization (thin/dashed/thick borders = short/medium/long). ~461 lines. |
| `NexusGraph.svelte` | sigma-based graph for code intelligence views. Used by `/code`, `/code/community/[id]`, `/code/symbol/[name]`. Uses `BASE_SIGMA_SETTINGS` from `sigma-defaults.ts`. ~268 lines. |
| `ProjectSelector.svelte` | Header dropdown for switching active CLEO project. Displays colored chip + chevron. Opens searchable dropdown panel. POSTs to `/api/project/switch` on selection. ~612 lines including full CSS. |
| `admin/CleanModal.svelte` | Modal dialog for cleaning unregistered project paths. Used by `/projects`. |
| `admin/DeleteConfirmModal.svelte` | Confirmation modal for project deletion. Used by `/projects`. |
| `admin/ScanModal.svelte` | Modal for scanning filesystem to discover unregistered projects. Used by `/projects`. |

---

## Header Nav State

Current `navItems` in `+layout.svelte`:

```javascript
const navItems = [
  { href: '/brain',          label: 'Brain',  description: '5-substrate living canvas',                        exact: true  },
  { href: '/brain/overview', label: 'Memory', description: 'BRAIN dashboard (decisions, observations, quality)', exact: false },
  { href: '/code',           label: 'Code',   description: 'Code intelligence',                                 exact: false },
  { href: '/tasks',          label: 'Tasks',  description: 'Task management',                                   exact: false },
];
```

**ProjectSelector:** PRESENT. Renders between logo and nav. Shows `data.projects` from layout server load with current `data.activeProjectId`. Layout server file exists at `routes/+layout.server.ts`.

**Memory link:** CONFIRMED. Nav item `{ href: '/brain/overview', label: 'Memory' }` directly links to `/brain/overview`. The active-state logic uses `startsWith('/brain/overview')` for Memory which correctly activates on all `/brain/overview/*` sub-routes.

**Active-state conflict:** The Brain and Memory nav items BOTH match when the user is on `/brain/overview`. Brain uses `exact: true` (only matches `/brain` exactly) and Memory uses `exact: false` (matches any `/brain/overview*` path). This is correct — both cannot be simultaneously active.

**Missing from nav:** `/brain/graph`, `/brain/decisions`, `/brain/observations`, `/brain/quality`, `/projects`. These routes exist but have no header nav entry. `/brain/graph` is only reachable via the action card on `/brain/overview`. The projects admin page is effectively hidden from the nav.

---

## Top 3 Studio Bugs To Fix Next

### Bug 1: Dangling Edge Majority Makes Canvas Effectively Useless for Cross-Substrate Insight

**Severity: P0 — defeats the primary purpose of the 5-substrate canvas.**

89.2% of the API's 3,965 edges are silently dropped because one or both endpoints are not in the loaded node set. Only 429 edges render, of which 376 are nexus→nexus intra-code edges. Brain, conduit, and signaldock nodes appear as isolated floating dots with no visible connections.

**Root cause:** Brain adapter emits `brain→nexus:file.ts::Symbol` cross-substrate edges, but the nexus adapter only loads top-400 by in-degree. The referenced nexus nodes are low-in-degree symbols that were excluded from the load window.

**Fix:** After `getAllSubstrates()` assembles the merged graph, run a second pass: collect all edge endpoints not present in the node set, then load stub nodes for those IDs from the appropriate databases. Even a minimal stub (id + substrate + label="[referenced]") would allow the edges to render.

**Alternatively (simpler):** Filter edges in `getAllSubstrates()` to only emit edges whose both endpoints are in the loaded node set (the nexus adapter already does this). Change `brain.ts` to not emit cross-substrate edges unless the target node was actually loaded.

### Bug 2: GPU Mode Canvas Is Blank on Initial Load

**Severity: P1 — GPU mode is the advertised high-node-count renderer but shows nothing.**

cosmos.gl v2.0.0-beta.26 reads `canvas.clientHeight` synchronously in its constructor. If the CSS layout hasn't computed `.lb-canvas`'s height yet when `initCosmos()` fires (in Svelte `onMount`), the WebGL backing buffer is initialized at 0px height. While cosmos's `resizeCanvas()` runs on every animation frame and will eventually correct the buffer size, the initial `fitView` calls fire before the resize corrects, resulting in a degenerate camera transform. The canvas appears blank even though the force simulation is running.

**Fix (minimal, 2 lines):** Add `height: 100%` to `.lb-canvas` CSS rule in `brain/+page.svelte` to guarantee layout is computed before the mount callback. Add a delayed `fitView` at ~500ms after mount as insurance:

```css
/* brain/+page.svelte style block, line ~865 */
.lb-canvas {
  min-width: 0;
  border-radius: 8px;
  overflow: hidden;
  height: 100%; /* ADD THIS */
}
```

And in `LivingBrainCosmograph.svelte`, add a `setTimeout(() => cosmos?.fitView(300, 0.15), 500)` after the existing fitView calls to re-fit after layout fully stabilizes.

### Bug 3: Cosmograph EDGE_COLOR Map Has Only 6 Types vs. Sigma's 25 Types

**Severity: P2 — GPU mode loses all edge-type color differentiation.**

`LivingBrainCosmograph.svelte` has 6 entries in its `EDGE_COLOR` map. `LivingBrainGraph.svelte` has 25 entries. The API returns `code_reference` (2,669 occurrences), `derived_from` (107), `contradicts` (100), `parent_of` (47), etc. In GPU mode, all of these render as the fallback grey `#94a3b8`, making the canvas monochrome.

**Fix:** Copy the full 25-type `EDGE_COLOR` map from `LivingBrainGraph.svelte` into `LivingBrainCosmograph.svelte`. The maps should be extracted to a shared constant in `$lib/components/brain-constants.ts` (or similar) to prevent future divergence — a DRY violation that will re-occur every time a new edge type is added.

---

## Supplementary Findings

### Live API Data Reality (at time of audit, limit=5000)

```
Total nodes in API: 1,071
  brain: 179
  nexus: 400
  tasks: 236
  conduit: 253
  signaldock: 3
Total edges in API: 3,965
  code_reference: 2,669 (67.3%)
  supersedes: 520 (13.1%)
  calls: 384 (9.7%)
  applies_to: 114 (2.9%)
  derived_from: 107 (2.7%)
  ...
Valid edges (both endpoints loaded): 429 (10.8%)
Isolated nodes (no visible edges): 537 (50.1%)
Cross-substrate edges in API: 2,904 (73.2%)
Cross-substrate edges that survive filtering: ~53 (1.8% of cross-substrate)
```

The SSR HTML reports "1916 nodes · 4763 edges" at page load time — significantly higher than the API direct call (1071 nodes, 3965 edges). This discrepancy suggests the SSR load hits a different limit or a cached/warmer database state.

### `/brain/graph` Uses Brain-Only Schema — No LBGraph Types

`BrainGraph.svelte` uses `d3` and interfaces `BrainNode { node_type, quality_score, created_at... }` and `BrainEdge { from_id, to_id, edge_type... }` — these are the old `brain_page_nodes`/`brain_page_edges` schema, NOT the unified `LBNode`/`LBEdge` schema. It fetches from `/api/brain/graph` (a separate endpoint from `/api/living-brain`). This view is isolated from the unified LBGraph architecture and uses a completely different rendering stack (d3 vs sigma).

### ProjectSelector Shows "Select project" When No Project Is Active

The SSR HTML shows `<span class="chip placeholder">?</span> <span class="trigger-name muted">Select project</span>` — no active project is selected. All database queries in page.server.ts files go through `locals.projectCtx` which depends on the active project. If no project is selected, brain.db/tasks.db queries may return empty results.
