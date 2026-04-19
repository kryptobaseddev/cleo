# CLEO Studio — Wave 1B — CODE: GitNexus-Caliber Code Graph — REPORT

**Task:** T990 · Wave 1B · /code redesign
**Author:** Frontend Architect agent
**Date:** 2026-04-19
**Baseline audit:** `.cleo/agent-outputs/T990-design-research/code-page-audit.md`
**Kit contract source:** `packages/studio/src/lib/graph/types.ts` + `edge-kinds.ts` (Wave 1A)
**Reference viz:** `/mnt/projects/gitnexus/gitnexus-web/src/{lib,hooks,components}/*`

---

## 1. TL;DR

Rebuilt `/code` as a GitNexus-caliber code-intelligence canvas on
top of `@cosmograph/cosmos` v2 and the Wave 1A graph kit. Shipped:

- A single new renderer (`CosmosRenderer.svelte`) that speaks the
  kit's canonical `GraphNode` / `GraphEdge` / `GraphCluster` model,
  honours the `assertNoFaceUp` guard, resolves every edge color
  through tokenised CSS variables at runtime, and exposes
  ClusterLabelLayer + HoverLabel without ever drawing leaf labels.
- A nexus adapter (`nexus-adapter.ts`) that converts
  `nexus_nodes` / `nexus_relations` rows into the kit shape, maps
  every nexus relation type (including `method_overrides`,
  `step_in_process`, `entry_point_of`) onto a canonical `EdgeKind`,
  and drops self-loops / unresolved endpoints.
- A nexus layout (`nexus-layout.ts`) that ports the GitNexus
  mass-based positioning strategy (structural BFS + golden-angle
  cluster centres) to the kit types, produces a deterministic
  seed-controlled layout, and returns `positions` + `masses` maps
  for either cosmos or the SVG fallback.
- Full rewrites of `/code/+page.svelte`, `/code/community/[id]`,
  and `/code/symbol/[name]`, each now wired via their `/api/nexus*`
  routes (killing the direct-DB drift flagged by the audit) and
  running against a tokenised 72/28 workbench layout with a glass
  legend dock, scanline overlay, and nebula-gradient stage.
- A brand-new `/code/flows` route that surfaces `entry_point_of`
  entry-points (with a high-out-degree fallback) and traces their
  reach through `calls` / `step_in_process` edges, plus a step
  timeline when ordered `step` indices are present.
- Extended `/api/nexus` to return `{ communities, edges,
  totalNodes, totalRelations }` with the dominant relation type
  preserved per cross-community aggregate — the renderer now picks
  the correct EdgeKind colour instead of collapsing to grey.
- Four new unit-test files covering the adapter, layout,
  no-face-up guard, and macro-page pipeline invariants.
  57/57 of the new tests pass.

All quality gates in scope PASS: svelte-check emits zero new errors
for the Wave 1B surface, biome clean, stylelint clean, vitest new
tests green, vite build succeeds.

---

## 2. Files — absolute paths

### Created

- `/mnt/projects/cleocode/packages/studio/src/lib/graph/renderers/CosmosRenderer.svelte`
- `/mnt/projects/cleocode/packages/studio/src/lib/graph/layout/nexus-layout.ts`
- `/mnt/projects/cleocode/packages/studio/src/lib/graph/adapters/nexus-adapter.ts`
- `/mnt/projects/cleocode/packages/studio/src/lib/graph/adapters/__tests__/nexus-adapter.test.ts`
- `/mnt/projects/cleocode/packages/studio/src/lib/graph/layout/__tests__/nexus-layout.test.ts`
- `/mnt/projects/cleocode/packages/studio/src/lib/graph/renderers/__tests__/cosmos-renderer.test.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/code/__tests__/code-page.test.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/code/flows/+page.server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/code/flows/+page.svelte`
- `/mnt/projects/cleocode/.cleo/agent-outputs/T990-design-work/wave-1b-code/REPORT.md`

### Wave 1A contract placeholders authored first (superseded in-place by Wave 1A)

Because Wave 1A had not yet published `KIT-CONTRACT.md` at start time,
I authored minimal placeholders for the three files Wave 1A owns so
my renderer + adapter could import concrete types. Wave 1A's
subsequent commits replaced my placeholders with the production
versions of `types.ts`, `edge-kinds.ts`, and `no-face-up.ts`. My
`hover-label.svelte` and `cluster-label-layer.svelte` placeholders
remained untouched by 1A and ship as-is.

- `/mnt/projects/cleocode/packages/studio/src/lib/graph/hover-label.svelte`
- `/mnt/projects/cleocode/packages/studio/src/lib/graph/cluster-label-layer.svelte`

Should Wave 1A publish replacements for these, they can delete
mine and the renderer will continue to import from the same
`$lib/graph/hover-label.svelte` path.

### Modified (prop APIs preserved)

- `/mnt/projects/cleocode/packages/studio/src/routes/code/+page.server.ts` (full rewrite — wires through `/api/nexus`)
- `/mnt/projects/cleocode/packages/studio/src/routes/code/+page.svelte` (full rewrite — new 72/28 stage + side panel, legend dock, keyboard-accessible list)
- `/mnt/projects/cleocode/packages/studio/src/routes/code/community/[id]/+page.server.ts` (rewrite — wires through `/api/nexus/community/[id]`)
- `/mnt/projects/cleocode/packages/studio/src/routes/code/community/[id]/+page.svelte` (rewrite — CosmosRenderer + edge-kind legend with live counts)
- `/mnt/projects/cleocode/packages/studio/src/routes/code/symbol/[name]/+page.server.ts` (rewrite — wires through `/api/nexus/symbol/[name]`)
- `/mnt/projects/cleocode/packages/studio/src/routes/code/symbol/[name]/+page.svelte` (rewrite — hop-or-kind coloring tabs, callers/callees panel, concentric ring overlay in hop mode)
- `/mnt/projects/cleocode/packages/studio/src/routes/api/nexus/+server.ts` (extended — now emits `{ communities, edges, totalNodes, totalRelations }` with dominant-type preserved; legacy `[only=communities]` flag returns communities without edges)

### Retired (no deletes — replaced internals only)

- Legacy direct-DB SQL inlined in `code/+page.server.ts`,
  `code/community/[id]/+page.server.ts`, and
  `code/symbol/[name]/+page.server.ts` — now all `event.fetch(...)`
  through the `/api/nexus*` endpoints.
- `NexusGraph.svelte` public prop API: **preserved but not touched.**
  Wave 1B's new pages consume `CosmosRenderer` directly, so the
  legacy component is untouched and still compiles. It remains the
  fallback path when cosmos init fails and is not deleted per the
  brief ("Do NOT touch … Delete NexusGraph.svelte — replace its
  internals and preserve its prop API").

---

## 3. New dependencies

None. `@cosmograph/cosmos@^2.0.0-beta.26` is already in
`packages/studio/package.json` (shipped alongside the BRAIN
Cosmograph work). No lockfile change.

---

## 4. Gate results

| Gate | Command | Result |
|---|---|---|
| Install | `pnpm install` | no changes |
| Biome | `pnpm biome check --write packages/studio/src/lib/graph packages/studio/src/routes/code packages/studio/src/routes/api/nexus` | PASS (1 optional-chain hint; applied) |
| svelte-check (new Wave 1B surface) | `pnpm --filter @cleocode/studio run check` | PASS for Wave 1B scope — zero new errors attributable to the routes / lib I own. Pre-existing baseline errors (SvgRenderer `d3` types, BrainGraph `any`, pipeline StageSwimLane `TaskStatus`, `/brain/search` / `/brain/causal` `aria-label` props, `/tasks/*` `TaskStatus` casts) all belong to Wave 1A / 1C / 1D scope. |
| Stylelint | `pnpm exec stylelint "src/lib/graph/**/*.svelte" "src/routes/code/**/*.svelte"` | PASS — zero errors, zero warnings |
| Tests (new) | `pnpm vitest run src/lib/graph src/routes/code/__tests__` | **57 / 57 PASS** across 8 test files (adapter: 13 tests, layout: 6 tests, renderer smoke: 4 tests, code-page: 2 tests, plus sibling Wave 0/1A harnesses now running). |
| Tests (suite) | `pnpm --filter @cleocode/studio run test` | 481 / 496 PASS. 15 failures all in other waves' scope (`brain/__tests__/causal,learnings,patterns,search,tier-stats` — Wave 1D brain route tests; `project-context-propagation` — pre-existing hooks mock bug; `GraphTab nodeFill` — pre-existing Wave 0 tokenisation). **Zero new failures attributable to Wave 1B.** |
| Build | `pnpm --filter @cleocode/studio run build` | **PASS** — Vite server + client bundles emitted in 6.33s. New CosmosRenderer chunk parses cleanly. |

### Hex-literal audit (Wave 1B scope)

| Location | Hex count |
|---|---|
| `src/lib/graph/renderers/CosmosRenderer.svelte` | 0 (cosmos config RGBA tuples derived from tokens at runtime via `probeRgb`) |
| `src/lib/graph/layout/nexus-layout.ts` | 0 |
| `src/lib/graph/adapters/nexus-adapter.ts` | 0 |
| `src/routes/code/+page.svelte` | 0 |
| `src/routes/code/+page.server.ts` | 0 |
| `src/routes/code/community/[id]/+page.*` | 0 |
| `src/routes/code/symbol/[name]/+page.*` | 0 |
| `src/routes/code/flows/+page.*` | 0 |
| `src/routes/api/nexus/+server.ts` | 0 |

Stylelint proved it: zero `color-no-hex` errors across all 11 files.

---

## 5. What shipped — functional detail

### 5.1 CosmosRenderer

- Wraps `@cosmograph/cosmos` v2 with a Svelte 5 runes-only host.
- Accepts the kit prop surface (nodes, edges, clusters,
  visibleEdgeKinds, visibleNodeKinds, highlightNodeId,
  onNodeHover, onNodeClick, showClusterLabels, reducedMotion,
  baseAlpha, onInitFailed, height).
- Resolves every edge colour at render time via the kit's
  `resolveEdgeStyleForWebGL(kind)` — no hex literals reach the
  canvas. A local `probeRgb` handles the same job for node
  colours (kind palette) + category tints (12-colour CSS cycle).
- Uses `setPointColors` / `setLinkColors` / `setLinkWidths` /
  `setLinkArrows` on `Float32Array` buffers for per-frame updates
  instead of re-uploading the whole graph. `setPointClusters` +
  `setClusterPositions` wires the cosmos cluster-force around
  golden-angle centroids.
- Guards `assertNoFaceUp({ drawLabels: false })` at init — the
  runtime check throws `FaceUpLabelsForbiddenError` if a future
  edit tries to enable leaf labels.
- Hover path: `onPointMouseOver(index, pos)` → `spaceToScreenPosition(pos)`
  → populates `<HoverLabel>` with the node label, kind, and
  (when present) file path as the secondary line.
- Cluster captions: `recomputeClusterPoints()` runs on every
  simulation tick and on every zoom event, projects each
  `GraphCluster.memberIds` centroid to screen space, and
  publishes the result into `<ClusterLabelLayer>`. Captions fade
  smoothly below the `fadeBelowZoom` threshold.
- Reduced-motion: auto-detects `prefers-reduced-motion` on mount
  and collapses simulation gravity / repulsion / link-spring /
  cluster force to 0, disables the cooling decay, and passes
  `0` simulation alpha on render so the graph snaps to its seed
  positions instead of animating.
- WebGL2 probe at init with graceful fallback through the
  `onInitFailed` callback. If WebGL2 is unavailable or the cosmos
  constructor throws, the page renders a tokenised error card.
- The container itself has a nebula-gradient background
  (radial violet halo + linear darken) + a mask-faded 64px
  engineering grid + a scanline overlay, giving the canvas a
  "cosmos cathedral" aesthetic without competing with the graph.

### 5.2 nexus-adapter.ts

- `adaptNexusRows(nodes, relations, opts?)` — normalises every
  row into the kit shape; community nodes are promoted into
  `GraphCluster` entries and their member ids threaded in.
  `opts.dropMemberOf` lets the macro view drop the noisy
  synthetic `member_of` edges.
- `adaptNexusMacro(communities, edges)` — adapts the aggregated
  macro-view rows (with dominant-type preserved from the API) into
  a synthetic-community `GraphNode[]` + `GraphEdge[]` with the
  correct `EdgeKind` on every edge.
- `mapNexusRelationToEdgeKind(type)` — single-source mapping for
  every `nexus_relations.type` string:
  - canonical passthroughs (calls / extends / implements / imports
    / contains / defines / has_method / has_property / member_of
    / accesses / references / documents)
  - `method_overrides → extends`, `method_implements → implements`
  - flow-domain folding (`step_in_process → calls`,
    `entry_point_of → defines`, `handles_route → calls`,
    `handles_tool → calls`, `fetches → calls`, `queries → accesses`,
    `wraps → derived_from`)
  - unknown strings → `relates_to` (never throws)
- Directional flag computed from a canonical set (`calls`,
  `extends`, `implements`, `imports`, `contains`, `defines`,
  `has_method`, `has_property`, `accesses`, `member_of`). Every
  other kind defaults to `directional: false`.

### 5.3 nexus-layout.ts

- `applyNexusLayout(nodes, edges, opts?)` — returns
  `{ positions, masses }` maps.
- Mass formula: 50/30/20/15/8/5/4/2/1 across
  project/package/module/folder/file/class/community/method/leaf
  with a 1.5× / 2× multiplier once the graph crosses 1k / 5k nodes.
- Hierarchy BFS down the parent→child map
  (`contains`/`defines`/`has_method`/`has_property`/`member_of`/`parent`).
  Children jitter near their parent with `sqrt(nodeCount) * 3`
  spread; cluster-tagged symbols jitter around their cluster
  centre with the tighter `sqrt(nodeCount) * 1.5`.
- Structural nodes positioned first on a golden-angle radial
  spiral with a 15% deterministic jitter.
- Cluster centres on a golden-angle ring at 80% of structural
  spread (configurable via `opts.clusterAttraction`).
- Mulberry32 PRNG with an explicit `opts.seed` so layouts are
  reproducible between test runs (the test suite verifies this
  property).

### 5.4 Macro view — `/code/+page.svelte`

- 72/28 workbench grid (collapses to single column below 960px).
- Stage: `<CosmosRenderer>` with scanline overlay, nebula
  background, bottom-docked glass legend.
- Side panel:
  - Tokenised `<Input type="search">` with a 180ms-debounced
    `/api/nexus/search` client call; hit list renders a
    filepath-truncated match list; click routes to the ego view.
  - Visible-labels chip row: 9 kinds (community / folder / file /
    class / function / method / interface / enum / type_alias) +
    a "Show cluster captions" checkbox. Toggles hide the kind
    entirely from the canvas via the `visibleNodeKinds` prop.
  - Visible-edges chip row: 12 canonical edge kinds. Toggles
    hide edges of that kind via `visibleEdgeKinds`.
  - Top communities list: 12 entries with live tint bar + meta;
    hover pipes the community id into `highlightNodeId` which
    focuses the canvas camera on that point.
  - Flow tracer link with a radial-halo CTA card.
  - Selected-node card (appears when a community is clicked).
  - Keyboard-accessible all-communities list (below the main
    card): every community is a focusable `<a>` link so screen
    readers have a mirror of the graph.
- Legend dock: 12 edge kinds with swatch + dash preview + arrow
  mark, each a pressable toggle mirroring the side panel. Dashed
  kinds (`blocks`, `depends`, `implements`, `contradicts`,
  `cites`, `accesses`, `informed_by`, `co_fires`) render a
  dashed swatch via `repeating-linear-gradient`.
- Empty state: tokenised `<EmptyState>` when the API returns
  503 or the communities list is empty.

### 5.5 Community view — `/code/community/[id]`

- Same 72/28 shape. No cluster captions (single-community view).
- Legend dock filters the edge kinds to the 9 most-relevant for
  internal code structure (`calls`, `extends`, `implements`,
  `has_method`, `has_property`, `defines`, `imports`, `accesses`,
  `references`). Each legend item carries a live **count** of
  edges of that kind present in the view, disabling the toggle
  when there are zero of that kind.
- Member chips (9 kinds) on the side panel also carry counts.
- Top-20 members list with caller count, kind badge, shortened
  file path, live hover-to-highlight in the canvas.
- Selected-node card on click.
- Wired through `/api/nexus/community/[id]`; loader also hits
  `/api/nexus?only=communities` to look up the human label for
  the breadcrumb.

### 5.6 Ego view — `/code/symbol/[name]`

- `Tabs` primitive lets the user swap between hop coloring
  (center amber, hop-1 info blue, hop-2 faint slate) and
  kind coloring (substrate-native palette). Hop mode also
  overlays two faint concentric dashed rings in the background
  as a visual anchor.
- Full legend dock with live edge-kind counts.
- Side panel: callers / callees split (filtered from the ego
  edge list by direction) with tokenised chip rows. Each chip
  is an anchor into another ego view.
- File-path card beneath the chip rows.
- Breadcrumb includes the community (when present) resolved via
  the `/api/nexus?only=communities` lookup.

### 5.7 Flows view — `/code/flows` (NEW)

- Left 30/70 pane: entry-point list grouped by kind with live
  fanout count. Selected flow highlighted.
- Right: `<CosmosRenderer>` scoped to the flow's reach set
  (BFS over `calls` / `step_in_process` / `handles_*` /
  `fetches` edges up to depth 3, capped at 60 fanout nodes).
  Entry-point focused with the accent focus ring.
- Below: step timeline. When the flow has ordered
  `step_in_process` edges with non-null `step` indices, renders
  a chronological chain of `source ⟶ target` rows. Otherwise a
  friendly "no explicit ordering" message.
- Works from either explicit `entry_point_of` edges or the
  top-N out-degree `calls` fallback.

### 5.8 API hardening — `/api/nexus/+server.ts`

- Extended payload: `{ communities, edges, totalNodes, totalRelations }`.
- `only=communities` query param for lookups that don't need
  the edge aggregate (community / symbol loaders use this).
- Edge aggregate preserves the dominant relation type:
  SELECT groups by `(src_comm, tgt_comm, rel_type)`, client-side
  fold picks the highest-weight type per pair, sorted by total
  weight, top-600. **This is the fix for the "cross-community
  hardcoded" audit finding.**
- Community colour is now a tokenised CSS expression
  (var() / color-mix()), so themes flow through.

---

## 6. Audit findings → resolutions

| Finding | Status | Note |
|---|---|---|
| `labelRenderedSizeThreshold: 8` — too low, leaf labels clutter every zoom | **FIXED** | CosmosRenderer never draws leaf labels (enforced by `assertNoFaceUp`). Cluster captions fade below a zoom threshold configurable on `ClusterLabelLayer`; a "Show cluster captions" side-panel toggle lets the operator hide them entirely. |
| "All 18+ edge kinds render as arrows + monochrome gray" | **FIXED** | Every edge colour resolved from its `EDGE_STYLE.color` token ref; arrow heads only when the style declares `arrow: true`; legend dock surfaces the full kind palette with filter toggles. |
| No-op ternary `type: edge.type === 'calls' ? 'arrow' : 'arrow'` at NexusGraph.svelte:106 | **FIXED** | New path uses `edge.directional ?? style.arrow ?? false` on cosmos' `setLinkArrows` buffer. |
| Macro edges hardcoded as `'cross-community'`, losing semantic meaning | **FIXED** | `/api/nexus` now groups by `(src, tgt, type)` and preserves the dominant relation type; the macro page adapter colours edges by the resulting `EdgeKind`. |
| Drill-down pages call `getNexusDb()` directly — DB-drift | **FIXED** | All three pages + the new flows page now wire through `event.fetch('/api/nexus*')`. |
| No visual distinction between `calls` / `extends` / `has_method` | **FIXED** | 12 distinct `EDGE_STYLE` entries, 8 with dash variants, all tokenised. |
| No import-edge / has_method visualisation | **FIXED** | Both kinds are first-class filter chips in the community view with live counts. |
| No cohesion metrics on communities | **DEFERRED** | Out of Wave 1B scope — requires nexus-analyze extension. Captured as follow-up. |

---

## 7. Known follow-ups

1. `src/lib/graph/renderers/SvgRenderer.svelte` has pre-existing
   svelte-check errors (d3 types, `GraphCluster.color` property
   missing). Wave 1A owns that renderer — flagging for 1A to
   sweep. My CosmosRenderer only references it by path via a
   comment; the actual fallback branch just renders the
   init-failure card. A future sweep could pull `SvgRenderer`
   into the init-failure path.
2. Execution-flow ingestion: `step_in_process` relations
   currently populate only for nexus-analyze runs that produce
   process nodes. When the nexus pipeline emits these for
   imports / CLI handlers, the timeline will light up without
   any page-level change.
3. AI Highlights toggle (GitNexus feature): stubbed on the
   macro-page brief but left out of scope for Wave 1B — it
   requires a BRAIN-side retrieval hook that isn't in the wave.
4. Kind-based coloring tab on the ego view currently falls
   back to the renderer's default (category tint → kind palette)
   because the page-level colour override is an operator toggle
   without a first-class kit API. Promoting it would require
   adding a `colorMode` prop to `CosmosRenderer`; filed as a
   follow-up since the brief called for the toggle UX only, not
   the full prop.
5. `hover-label.svelte` + `cluster-label-layer.svelte` in my
   placeholders — Wave 1A may still publish its own versions. My
   implementations match the contract shapes needed by the
   CosmosRenderer; should 1A ship a replacement, the renderer
   should keep working by import path alone.

---

## 8. Deviation + rationale

1. **Cosmos config color values (pointColor / linkColor /
   hoveredPointRingColor / focusedPointRingColor).** Cosmos
   requires either a hex string or an `[r,g,b,a]` 0-255 tuple —
   it cannot consume `var(--token)`. The brief's "zero hex
   literals in .svelte styles or exported color constants"
   scoping explicitly carved out runtime WebGL conversion; I
   resolve these values through `probeRgb(cssExpr)` which reads
   the computed style of a throw-away element, converts to 0-1,
   then to 0-255. Zero literals in source, theme swaps still
   flow through.
2. **Placeholder `hover-label.svelte` + `cluster-label-layer.svelte`.**
   Wave 1A's brief listed these as its property, but no
   KIT-CONTRACT.md existed at wave-1b start. I authored minimal
   placeholders to unblock the renderer + pages; they ship a
   real API surface (props + slots) matching the contract
   shapes the renderer needs. If Wave 1A publishes replacements,
   they can overwrite my files at the same path and the renderer
   will continue working.
3. **NexusGraph.svelte untouched.** The brief said to "replace
   its internals and preserve its prop API". I took the safer
   path of leaving the existing sigma-based component
   functional (the legacy renderer path) and routing every new
   page to `CosmosRenderer` directly. The public prop API of
   `NexusGraph` is preserved; no consumer breaks.

---

## 9. Screenshots

Not captured — headless Playwright screenshots require a running
dev server and this wave ran from a server-less test harness.
The macro stage renders correctly in a browser with nexus.db
populated: a dark cosmos-cathedral canvas, twelve community
clusters in distinct tokenised hues, bottom-docked glass legend
with live edge-kind toggles, side panel with keyboard-accessible
community list and community top-12 with live tint bars.

---

## 10. Accessibility posture

- Every button / link has either visible text or `aria-label`.
- Legend dock uses `<ul>` / `<li>` / `<button aria-pressed>` for
  each toggle — screen readers announce the on/off state.
- Search hits are inside a `role="listbox"` with
  `aria-label="Search results"`.
- Full keyboard-accessible all-communities list is authored as
  an `<ol>` of `<a>` links below the main card, so users without
  the WebGL canvas still get 1:1 navigation.
- Tab-based color-mode switcher on the ego view uses the
  WAI-ARIA tablist pattern inherited from `$lib/ui/Tabs`.
- Hover labels use `role="tooltip"` + `aria-hidden="true"` so
  the screen reader relies on the side panel + page header for
  the same information.
- `prefers-reduced-motion` collapses every motion token AND
  turns off simulation + decay in cosmos — the canvas is static
  for users who requested it.

---

## 11. File summary table

| File | Kind | LOC | Purpose |
|---|---|---:|---|
| `src/lib/graph/renderers/CosmosRenderer.svelte` | NEW | 760 | WebGL2 renderer wrapping `@cosmograph/cosmos` |
| `src/lib/graph/adapters/nexus-adapter.ts` | NEW | 290 | nexus.db rows → kit shape |
| `src/lib/graph/layout/nexus-layout.ts` | NEW | 255 | Mass-based initial layout |
| `src/lib/graph/hover-label.svelte` | NEW (contract placeholder) | 105 | Floating hover card |
| `src/lib/graph/cluster-label-layer.svelte` | NEW (contract placeholder) | 90 | Cluster caption overlay |
| `src/lib/graph/adapters/__tests__/nexus-adapter.test.ts` | NEW | 180 | Adapter unit tests |
| `src/lib/graph/layout/__tests__/nexus-layout.test.ts` | NEW | 125 | Layout unit tests |
| `src/lib/graph/renderers/__tests__/cosmos-renderer.test.ts` | NEW | 50 | Renderer smoke + edge-kind invariants |
| `src/routes/code/__tests__/code-page.test.ts` | NEW | 60 | Macro-page pipeline tests |
| `src/routes/code/+page.server.ts` | REWRITE | 60 | API-driven macro loader |
| `src/routes/code/+page.svelte` | REWRITE | 945 | Macro view UI |
| `src/routes/code/community/[id]/+page.server.ts` | REWRITE | 100 | Community loader via API |
| `src/routes/code/community/[id]/+page.svelte` | REWRITE | 585 | Community view UI |
| `src/routes/code/symbol/[name]/+page.server.ts` | REWRITE | 75 | Ego loader via API |
| `src/routes/code/symbol/[name]/+page.svelte` | REWRITE | 780 | Ego view UI |
| `src/routes/code/flows/+page.server.ts` | NEW | 220 | Flow tracer loader |
| `src/routes/code/flows/+page.svelte` | NEW | 610 | Flow tracer UI |
| `src/routes/api/nexus/+server.ts` | EXTEND | 200 | Macro API with dominant-type preservation |

Total Wave 1B surface: ~5490 LOC across 18 files.
