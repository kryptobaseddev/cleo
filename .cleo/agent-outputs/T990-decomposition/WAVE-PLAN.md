# T990 Studio UI/UX Redesign — Wave Plan

**Epic:** T990 — Studio UI/UX Design System: complete redesign across all pages  
**Date:** 2026-04-20  
**Author:** RCASD Decomposition Lead  
**Source Audits:** 8 documents in `.cleo/agent-outputs/T990-design-research/`  
**Total Tasks:** 35  
**Epic Lifecycle Stage:** research → implementation (this plan advances it)

---

## Operator Context (verbatim, drives every decision)

> "This UI/UX looks like SHIT!! The Dashboard is not a clean looking dashboard at all, the Kanban and the Graph at down at bottom of the page."

Root cause confirmed across audits:
- No design system — 38 `<style>` blocks with ~240 hex literals, no shared tokens
- T949 merge-first approach created a stacked layout where Kanban/Graph are buried
- Three separate brain renderers in two pages (fragmentation, inconsistent UX)
- Code page: labelRenderedSizeThreshold too low (all titles face-up), all edges monochrome
- 5 graph engines in use; cosmos.gl + d3 is the correct consolidation target
- API wiring is clean post-T962 (no broken fetches to fix at URL level); only orphan/consolidation work needed

---

## Wave Dependency Graph

```
Wave A (foundation)
  ↓
Wave B (pages) ← parallel after A completes
  ↓
Wave C (brain consolidation) ← serial after B
Wave D (API wiring repair) ← parallel with C after B
  ↓
Wave E (integration + owner review) ← serial after C+D
```

---

## Wave A — Design System Foundation

**Parallelism:** All Wave A tasks are mutually independent and can run in parallel.  
**Blocker for:** Everything. No Wave B/C/D work starts until A is complete.  
**Count:** 6 tasks

---

### T990-WA-001 — Theme Tokens

**Title:** Establish global CSS design tokens (tokens.css)

**Description:** Create `packages/studio/src/lib/styles/tokens.css` with the complete token set extracted verbatim from the operator-approved viz reference (`/tmp/task-viz/index.html`). Replace the four-variant-background, six-purple-accent, three-warning-color chaos identified in `design-system-audit.md`. Import once from `+layout.svelte`.

**Acceptance Criteria:**
1. `src/lib/styles/tokens.css` exists and is imported in `src/routes/+layout.svelte`
2. Tokens cover: surface (`--bg`, `--bg-elev-1`, `--bg-elev-2`), border (`--border`, `--border-strong`), text (`--text`, `--text-dim`, `--text-faint`), accent (single `--accent: #a78bfa`, `--accent-soft`, `--accent-halo`), semantic (`--success`, `--warning`, `--danger`, `--info`, `--neutral` + soft variants), status (`--status-*` 7 states), priority (`--priority-*` 4 levels), shape (`--radius-xs/sm/md/lg/pill`), spacing (`--space-1` through `--space-10` on 4px grid), typography (`--text-2xs` through `--text-3xl`, `--font-sans`, `--font-mono`, `--leading-tight`, `--leading-normal`), motion (`--ease`, `--ease-slow`, `--ease-spring`), elevation (`--shadow-sm/md/lg/hover/focus`)
3. `@media (prefers-reduced-motion: reduce)` block zeros out all motion tokens
4. `font-family` stack corrected (body ends with `sans-serif`, not `monospace` — bug in current `+layout.svelte:61`)
5. No raw hex literals remain in `+layout.svelte` `:global(body)` rule after this task
6. `pnpm biome check` passes with zero new violations

**Labels:** `design`, `studio`, `wave-A`, `tokens`, `design-system`  
**Size:** small  
**Dependencies:** none  
**Files to touch:**
- `packages/studio/src/lib/styles/tokens.css` (new)
- `packages/studio/src/routes/+layout.svelte`

---

### T990-WA-002 — Typography + Font Loading

**Title:** Load Inter Variable + JetBrains Mono Variable; apply typography scale

**Description:** Per `design-system-audit.md` §9: install `@fontsource-variable/inter` and `@fontsource-variable/jetbrains-mono`, wire `<link rel="preload">` in `app.html`, apply `--font-sans` / `--font-mono` tokens globally. Collapse the 13-step font-size chaos into the 8-step `--text-*` scale. Set `font-variant-numeric: tabular-nums` on body for ID/count legibility.

**Acceptance Criteria:**
1. `@fontsource-variable/inter` and `@fontsource-variable/jetbrains-mono` are in `package.json` devDependencies
2. `app.html` has `<link rel="preload">` for both fonts with `font-display: swap`
3. `:global(body)` in `+layout.svelte` uses `var(--font-sans)` and `font-variant-numeric: tabular-nums`
4. All `font-size` values in `tasks/` island components replaced with `var(--text-*)` tokens (at least TaskCard, StatusBadge, FilterChipGroup)
5. No non-standard sizes (`0.55rem`, `0.675rem`, `0.7rem`) remain in those three files
6. `pnpm run build` exits 0 with fonts bundled

**Labels:** `design`, `studio`, `wave-A`, `typography`, `design-system`  
**Size:** small  
**Dependencies:** T990-WA-001 (tokens must exist first)  
**Files to touch:**
- `packages/studio/src/app.html`
- `packages/studio/src/routes/+layout.svelte`
- `packages/studio/package.json`
- `packages/studio/src/lib/components/tasks/TaskCard.svelte`
- `packages/studio/src/lib/components/tasks/StatusBadge.svelte`
- `packages/studio/src/lib/components/tasks/FilterChipGroup.svelte`

---

### T990-WA-003 — UI Primitives Library

**Title:** Build `src/lib/ui/` primitives: Button, Modal, Tabs, Card, Spinner, EmptyState, Drawer, Tooltip

**Description:** Per `design-system-audit.md` §8c: 14 distinct primitives are missing; every route reimplements raw `<button>`, inline modals (3 copies of backdrop+focus-trap), and per-page tab bars. Build the primitives layer consuming `var(--...)` tokens. Modal consolidates `CleanModal`, `ScanModal`, `DeleteConfirmModal` shells. DetailDrawer extracts shell to `Drawer.svelte`. Tabs replaces all 4+ inline tab implementations.

**Acceptance Criteria:**
1. `src/lib/ui/` contains: `Button.svelte` (variants: primary/secondary/ghost/danger; sizes: sm/md), `Modal.svelte` (backdrop + focus-trap + ESC close), `Tabs.svelte` + `TabPanel.svelte`, `Card.svelte` (padding variant + interactive hover), `Spinner.svelte`, `EmptyState.svelte` (icon + title + subtext + action slot), `Drawer.svelte` (slide-from-right), `Tooltip.svelte` (popover API)
2. Each primitive reads only `var(--...)` tokens — zero raw hex literals
3. Each primitive has TSDoc on all exported props
4. `Modal.svelte` passes focus to first focusable child on open; returns focus on close; ESC closes
5. All primitives export from `src/lib/ui/index.ts` barrel
6. `pnpm run test` passes (existing tests unbroken); new unit tests for Modal focus-trap and Button variants

**Labels:** `design`, `studio`, `wave-A`, `components`, `design-system`  
**Size:** large  
**Dependencies:** T990-WA-001, T990-WA-002  
**Files to touch:**
- `packages/studio/src/lib/ui/` (new directory, 9+ files)
- `packages/studio/src/lib/ui/index.ts` (barrel)

---

### T990-WA-004 — Accessibility Baseline

**Title:** Apply WCAG AA baseline: focus rings, aria-labels, skip link, reduced-motion

**Description:** Per `design-system-audit.md` §6: `:focus-visible` exists only in 6 `tasks/` components. `outline: none` with no replacement in 4 files is a regression. `#475569` on `#0f1117` fails contrast (3.2:1). Nav source-order puts links after main (keyboard users skip nav). Zero `prefers-reduced-motion` support in synapse animations. Fix all.

**Acceptance Criteria:**
1. `:focus-visible` ring (`box-shadow: var(--shadow-focus)`) applied to all interactive elements in `+layout.svelte`, admin modals, brain pages, and code pages (minimum: every `<button>`, `<a>`, `<input>` with `outline: none`)
2. `#475569` color use audited and replaced with `var(--text-dim)` (#9aa3b2) or `var(--neutral)` where used as body text
3. Skip-to-content link added as first child of `<body>` in `+layout.svelte`
4. Nav source order fixed: `<nav>` appears before `<main>` in DOM (or explicit `tabindex` plan documented)
5. All SVG icons in global nav have `aria-label` or `aria-hidden="true"` with adjacent visible label
6. `prefers-reduced-motion` zeros `--ease`, `--ease-slow`, `--ease-spring` via existing token (T990-WA-001 sets this up); verified by smoke test at reduced-motion breakpoint
7. WCAG AA contrast check passes for all `var(--text-faint)` use cases (update any that fail)

**Labels:** `design`, `studio`, `wave-A`, `a11y`, `design-system`  
**Size:** medium  
**Dependencies:** T990-WA-001  
**Files to touch:**
- `packages/studio/src/routes/+layout.svelte`
- `packages/studio/src/lib/components/admin/CleanModal.svelte`
- `packages/studio/src/lib/components/admin/ScanModal.svelte`
- `packages/studio/src/lib/components/admin/DeleteConfirmModal.svelte`

---

### T990-WA-005 — Graph Kit Foundation

**Title:** Build `src/lib/graph/` shared kit: CosmosRenderer, SvgRenderer, edge-kinds, no-face-up guard

**Description:** Per `graph-engine-recommendation.md` §6: consolidate 5 graph engines → 2 (cosmos.gl for Brain/Nexus, d3-force/SVG for Tasks). Build the shared kit that enforces R4 (no face-up titles) and R5 (three distinct edge kinds) programmatically. This kit is the contract layer all page-level graph work in Wave B/C builds on.

**Acceptance Criteria:**
1. `src/lib/graph/` exists with structure from `graph-engine-recommendation.md` §6: `index.ts` barrel, `types.ts` (imports from `@cleocode/contracts`), `renderers/CosmosRenderer.svelte`, `renderers/SvgRenderer.svelte`, `edges/edge-kinds.ts`, `edges/edge-style-cosmos.ts`, `edges/edge-style-svg.ts`, `labels/hover-label.svelte`, `labels/cluster-label-layer.svelte`, `labels/no-face-up.ts`
2. `no-face-up.ts` exports a runtime assertion that throws in dev when inline labels are enabled on any renderer; unit test in `__tests__/no-face-up.test.ts` verifies the assertion fires
3. `edge-kinds.ts` defines `'parent' | 'blocks' | 'depends' | 'call' | 'synapse' | 'extends' | 'imports' | 'has_method'` union; `edge-style-svg.ts` maps each to `{stroke, strokeDasharray, markerEnd}` — `parent` solid slate, `blocks` `4 4` red, `depends` `2 3` amber (matches existing `tasks/GraphTab.svelte` contract)
4. `CosmosRenderer.svelte` wraps `@cosmograph/cosmos` with `drawLabels: false` enforced and `IntersectionObserver`-based simulation pause when off-screen
5. `SvgRenderer.svelte` wraps d3-force with zoom/pan, ARIA-focusable `<g>` nodes, and edge-kind rendering from `edge-style-svg.ts`
6. `pnpm run test` passes including new `__tests__/edge-kinds.test.ts` and `__tests__/no-face-up.test.ts`

**Labels:** `design`, `studio`, `wave-A`, `graph`, `design-system`  
**Size:** large  
**Dependencies:** T990-WA-001  
**Files to touch:**
- `packages/studio/src/lib/graph/` (new directory, ~12 files)
- `packages/studio/package.json` (verify `@cosmograph/cosmos`, `d3` present; remove `sigma`, `3d-force-graph`, `three` from plan — actual removal in Wave C)

---

### T990-WA-006 — Live SSE Bridge + Synapse Firing Queue

**Title:** Build `src/lib/graph/live/` SSE bridge and per-frame synapse firing queue

**Description:** Per `graph-engine-recommendation.md` §6 and `brain-page-audit.md` §6: the SSE stream events (`node.create`, `edge.strengthen`, `task.status`, `message.send`) must drive per-frame cosmos.gl `setLinkColors` diffs for the neural aesthetic. Build the firing queue that `CosmosRenderer.svelte` consumes each frame — no full graph rebuild on pulse.

**Acceptance Criteria:**
1. `src/lib/graph/live/sse-bridge.ts` connects to `/api/brain/stream` and `/api/tasks/events`, parses typed events, and pushes to `firing-queue`
2. `src/lib/graph/live/firing-queue.ts` implements `enqueue({src, tgt, intensity, ts})`, `tick(dt)` returning `{linkIdx, color}[]` — max 32 concurrent fires; oldest evicted when queue full
3. `tick()` interpolates fire position `t ∈ [0,1]` over 1200ms; intensity-modulated RGBA returned per frame (brighten 200ms, hold 300ms, decay 700ms — matches `design-system-audit.md` §10b)
4. Unit test in `__tests__/firing-queue.test.ts`: enqueue 5 fires, tick 60 frames, verify all complete; verify eviction at capacity
5. `sse-bridge.ts` handles `hello` and `heartbeat` as no-ops; reconnects on connection drop (3 retries, exponential backoff 1s/2s/4s)
6. `pnpm run test` passes including new tests

**Labels:** `design`, `studio`, `wave-A`, `graph`, `brain-viz`, `live`  
**Size:** medium  
**Dependencies:** T990-WA-005  
**Files to touch:**
- `packages/studio/src/lib/graph/live/sse-bridge.ts` (new)
- `packages/studio/src/lib/graph/live/firing-queue.ts` (new)
- `packages/studio/src/lib/graph/live/__tests__/firing-queue.test.ts` (new)

---

## Wave B — Per-Page Redesigns

**Parallelism:** All Wave B tasks are parallel after Wave A completes. No Wave B task depends on another Wave B task.  
**Count:** 12 tasks (one per major page/route group)

---

### T990-WB-001 — Root Dashboard Redesign (`/`)

**Title:** Redesign root dashboard: clean portal grid with live stats

**Description:** Per `dashboard-admin-audit.md` §1: the root dashboard is a good portal hub but has duplicate stats (Brain + Memory both show brain stats), no loading states, and no error handling when `+page.server.ts` fails. The operator's "clean dashboard" directive means the root must feel like a polished entry point — not a dumping ground. Redesign the 4-card portal using `Card.svelte` primitives and token-based styling.

**Acceptance Criteria:**
1. Root page (`/`) uses `Card.svelte` from `src/lib/ui/` for all portal tiles; zero inline `<style>` block hex literals
2. Brain and Memory portal tiles show distinct stats (Brain = live node count + substrate breakdown; Memory = observation count + tier distribution) — remove duplicate
3. `Spinner.svelte` shown while stats load; `EmptyState.svelte` shown if DB unavailable (replaces current bare "Database not found" red text)
4. All card icons have `aria-hidden="true"` + adjacent visible text
5. Portal layout responsive: 4-col ≥1200px, 2-col ≥600px, 1-col <600px
6. Page renders at localhost:3456/ with correct stats visible; no console errors

**Labels:** `design`, `studio`, `wave-B`, `dashboard`  
**Size:** medium  
**Dependencies:** Wave A complete (T990-WA-001 through T990-WA-003)  
**Files to touch:**
- `packages/studio/src/routes/+page.svelte`
- `packages/studio/src/routes/+page.server.ts`
- `packages/studio/src/routes/+layout.svelte` (nav active states via tokens)

---

### T990-WB-002 — Tasks Dashboard Redesign (`/tasks`)

**Title:** Redesign /tasks page: clean dashboard above fold, Explorer as primary view

**Description:** Per `tasks-page-audit.md` §1-5: the operator's core complaint. Dashboard stats + Epic Progress + Recent Activity must be compact above-fold cards — not dominating the screen. The 3-tab Explorer (Hierarchy/Graph/Kanban) must be promoted to primary visual weight and claim `flex: 1` to fill the viewport. Kanban must never be "buried below fold." The Explorer body min-height increases from 400px to viewport-fill.

**Acceptance Criteria:**
1. Dashboard section (stats + Epic Progress + Recent Activity) collapses into a single compact row of `Card.svelte` tiles with `Spinner.svelte` loading states — occupies ≤20vh above the Explorer
2. Explorer section has `flex: 1; min-height: 0` on `.task-explorer` and `height: 100%` on `.explorer-body` so it fills remaining viewport
3. Tab bar (Hierarchy / Graph / Kanban) is visually prominent (uses `Tabs.svelte` from `src/lib/ui/`); active tab uses `--accent-soft` indicator
4. Graph tab body has `min-height: 600px` (maintained); Kanban at top of its tab, not buried — user sees Kanban immediately on tab switch without scrolling
5. Kanban tab subtitle reads "by status"; Pipeline tab link in nav reads "by stage" to distinguish the two views (per `tasks-page-audit.md` §8)
6. `DetailDrawer` uses `Drawer.svelte` shell from `src/lib/ui/`; no regressions on click-to-open
7. Page renders at localhost:3456/tasks with Kanban visible without scroll when Kanban tab is active

**Labels:** `design`, `studio`, `wave-B`, `tasks`, `kanban`, `dashboard`  
**Size:** large  
**Dependencies:** Wave A complete  
**Files to touch:**
- `packages/studio/src/routes/tasks/+page.svelte` (major refactor)
- `packages/studio/src/lib/components/tasks/KanbanTab.svelte` (extract into Tabs primitive)
- `packages/studio/src/lib/components/tasks/HierarchyTab.svelte`
- `packages/studio/src/lib/components/tasks/DetailDrawer.svelte`

---

### T990-WB-003 — Tasks Pipeline Page Redesign (`/tasks/pipeline`)

**Title:** Redesign /tasks/pipeline: full-viewport RCASD stage board with gate chips

**Description:** Per `tasks-page-audit.md` §8: pipeline page already has `height: calc(100vh - 8rem)` which is correct. The redesign focuses on visual polish — token-based colors, gate checkmarks (I/T/Q) using `Badge.svelte`, keyboard navigation preserved, and clear "Pipeline (by stage)" identity distinct from the `/tasks` status board.

**Acceptance Criteria:**
1. Pipeline page uses `Card.svelte` for column headers and `Badge.svelte` for I/T/Q gate indicators
2. Zero raw hex literals in `+page.svelte` — all colors via `var(--...)` tokens
3. `height: calc(100vh - 8rem)` layout preserved (no regression)
4. Keyboard navigation (arrow keys between cols/rows, Enter to open detail) passes manual smoke test
5. Page title clearly reads "Pipeline" with subtitle "RCASD stages" to distinguish from `/tasks` Kanban
6. `pnpm run test` passes with no regressions on existing pipeline tests

**Labels:** `design`, `studio`, `wave-B`, `tasks`, `pipeline`  
**Size:** small  
**Dependencies:** Wave A complete, T990-WB-002 (Tabs + Drawer primitives referenced)  
**Files to touch:**
- `packages/studio/src/routes/tasks/pipeline/+page.svelte`
- `packages/studio/src/routes/tasks/pipeline/+page.server.ts` (minor — stats section)

---

### T990-WB-004 — Tasks Graph Tab Fix (`/tasks` graph tab)

**Title:** Fix task graph tab: larger node canvas, SVG title tooltips, edge-kind legend

**Description:** Per `tasks-page-audit.md` §3-4 and `graph-engine-recommendation.md` §4.2: the three edge kinds (parent/blocks/depends) are rendered correctly but the graph body is too small (400px), nodes show ID only (no title tooltip), and the d3-force `SvgRenderer` from the graph kit must replace the inline implementation. Accessibility: focusable `<g>` nodes with `aria-label`.

**Acceptance Criteria:**
1. `GraphTab.svelte` replaces its internal d3-force wiring with `SvgRenderer.svelte` from `src/lib/graph/` — edge kinds delegate to `edge-style-svg.ts` (no duplicate edge-kind logic)
2. `TaskDepGraph.svelte` (currently sigma) is migrated to `SvgRenderer` — sigma dependency removed from this surface
3. Every SVG node has `<title>{n.id} — {n.title}</title>` for browser tooltip; node `<g>` elements have `tabindex="0"` and `aria-label="{n.id}: {n.title}"`
4. Graph body height is viewport-fill when Graph tab is active (inherits from T990-WB-002 flex layout)
5. Edge-kind legend renders from `edge-kinds.ts` centralized definitions (no duplicated legend code)
6. `pnpm run test` passes; no graph layout regressions

**Labels:** `design`, `studio`, `wave-B`, `tasks`, `graph`  
**Size:** medium  
**Dependencies:** Wave A complete (T990-WA-005 graph kit), T990-WB-002  
**Files to touch:**
- `packages/studio/src/lib/components/tasks/GraphTab.svelte`
- `packages/studio/src/lib/components/tasks/TaskDepGraph.svelte`

---

### T990-WB-005 — Brain Overview Page Redesign (`/brain`)

**Title:** Redesign /brain: remove renderer-mode toggle; cosmos.gl single canvas with substrate controls

**Description:** Per `brain-page-audit.md` §8 and `graph-engine-recommendation.md` §4.1: the three-renderer toggle (2D/GPU/3D) is replaced by a single cosmos.gl canvas. The page uses `CosmosRenderer.svelte` from the graph kit with `cluster-label-layer.svelte` for substrate group labels. The time-slider (currently missing in `3d/+page.svelte`) is present on this unified page. No face-up inline labels; hover-only via `hover-label.svelte`.

**Acceptance Criteria:**
1. `/brain/+page.svelte` uses `CosmosRenderer.svelte` exclusively — no `{#if rendererMode}` branches across sigma/cosmos/3d
2. The renderer-mode toggle (2D/GPU/3D buttons) is removed from the UI
3. Side-panel (node detail), substrate filter chips, and time-slider are all present in the unified page
4. `cluster-label-layer.svelte` renders substrate group labels (brain/nexus/tasks/conduit/signaldock) as DOM overlays at cluster centroid — not inline canvas labels
5. Hover over any node shows `hover-label.svelte` tooltip with full node name (never truncated to 24 chars on-canvas)
6. `no-face-up.ts` assertion passes (no inline canvas labels rendered)
7. SSE stream (`/api/brain/stream`) wired through `sse-bridge.ts` — `node.create` and `edge.strengthen` events animate via `firing-queue`
8. `LivingBrainCosmograph.svelte` and `LivingBrainGraph.svelte` internals replaced by graph kit (old files kept as thin shims until Wave C cleanup)

**Labels:** `design`, `studio`, `wave-B`, `brain-viz`, `graph`  
**Size:** large  
**Dependencies:** Wave A complete (T990-WA-005, T990-WA-006)  
**Files to touch:**
- `packages/studio/src/routes/brain/+page.svelte`
- `packages/studio/src/routes/brain/+page.server.ts`
- `packages/studio/src/lib/components/LivingBrainCosmograph.svelte` (shim wrapper)
- `packages/studio/src/lib/components/LivingBrainGraph.svelte` (shim wrapper)

---

### T990-WB-006 — Memory Observations + Decisions Pages (`/brain/observations`, `/brain/decisions`)

**Title:** Redesign memory list pages: filter parity, sort controls, pagination, loading/empty states

**Description:** Per `memory-page-audit.md` §3-4: observations has filters but decisions has none; sorting is hardcoded; pagination is absent (200-entry cap); empty and loading states are bare text. Apply consistent design using `Card.svelte`, `Spinner.svelte`, `EmptyState.svelte`, and `FilterChipGroup` from tasks island. Add sort controls to both pages.

**Acceptance Criteria:**
1. Both pages use `Spinner.svelte` during load and `EmptyState.svelte` (with "No observations match your filters" or "No decisions recorded yet" + hint text) on empty
2. Decisions page gains filter chips: confidence (high/medium/low/unknown), tier (short/medium/long), date range
3. Both pages have sort controls: "Newest first" / "Oldest first" / "Highest quality" (for observations), "Most confident" (for decisions)
4. Both pages implement offset/limit pagination — "Load more" button (not infinite scroll) appending to list; current count + total shown
5. Context links (`context_task_id`, `context_epic_id`) in decisions are clickable — navigate to `/tasks/{id}`
6. Zero raw hex literals in both `+page.svelte` files — all `var(--...)` tokens

**Labels:** `design`, `studio`, `wave-B`, `memory`, `brain`  
**Size:** medium  
**Dependencies:** Wave A complete (T990-WA-001 through T990-WA-003)  
**Files to touch:**
- `packages/studio/src/routes/brain/observations/+page.svelte`
- `packages/studio/src/routes/brain/decisions/+page.svelte`
- `packages/studio/src/routes/api/memory/decisions/+server.ts` (add sort + pagination params)

---

### T990-WB-007 — Memory Graph + Quality + Tier-Stats Pages (`/brain/graph`, `/brain/quality`, `/brain/tier-stats`)

**Title:** Add tier-stats page; redesign memory graph + quality pages with token styling

**Description:** Per `memory-page-audit.md` §5-6: `/brain/tier-stats` endpoint exists but has no frontend page. Memory graph is a static 500-node view (no SSE, no utility differential from main brain canvas). Quality page is functional but bare. Build the missing tier-stats page with stacked bar charts; polish graph + quality pages using design system primitives.

**Acceptance Criteria:**
1. New page `packages/studio/src/routes/brain/tier-stats/+page.svelte` created; fetches `/api/memory/tier-stats`; renders per-table (observations/learnings/patterns/decisions) stacked bar chart showing short/medium/long split using CSS bars with token colors (`--info` short, `--accent` medium, `--success` long)
2. "Upcoming promotions" section lists entries from `upcomingLongPromotions[]` with countdown (daysUntil) and promotion track
3. `/brain/quality/+page.svelte` gets loading + empty states via primitives; distribution bars use `var(--success/warning/danger)` tokens instead of inline hex
4. `/brain/graph/+page.svelte` gets `Spinner.svelte` + time-slider label text distinguishing it from the main `/brain` canvas ("Retrospective memory graph — static snapshot")
5. Navigation in `/brain` sub-section sidebar (or breadcrumb) includes link to `/brain/tier-stats`
6. All three pages pass `pnpm biome check`

**Labels:** `design`, `studio`, `wave-B`, `memory`, `brain`  
**Size:** medium  
**Dependencies:** Wave A complete  
**Files to touch:**
- `packages/studio/src/routes/brain/tier-stats/+page.svelte` (new)
- `packages/studio/src/routes/brain/quality/+page.svelte`
- `packages/studio/src/routes/brain/graph/+page.svelte`
- `packages/studio/src/routes/brain/+layout.svelte` (if exists, for sub-nav link)

---

### T990-WB-008 — Code Page Redesign (`/code`, `/code/community/[id]`, `/code/symbol/[name]`)

**Title:** Fix code page: raise label threshold, semantic edge coloring, NexusGraph → CosmosRenderer

**Description:** Per `code-page-audit.md`: label threshold 8 is too low (all community names face-up at default zoom); all edges are monochrome arrows with a no-op ternary; edge types (`calls`, `extends`, `imports`, `has_method`) are visually indistinguishable. Raise threshold to 14 for macro view; implement type-based edge coloring; port `NexusGraph.svelte` to use `CosmosRenderer.svelte` from the graph kit.

**Acceptance Criteria:**
1. `NexusGraph.svelte` uses `CosmosRenderer.svelte` internally — sigma dependency removed from this component; all edge colors delegated to `edge-style-cosmos.ts`
2. `labelRenderedSizeThreshold` is NOT used (cosmos.gl has no inline labels) — `cluster-label-layer.svelte` renders community labels as DOM overlay; `no-face-up.ts` assertion passes
3. Edge type coloring implemented: `calls` → blue (#3b82f6), `extends/implements` → violet (#a855f7), `imports` → amber (#f59e0b), `has_method/has_property` → cyan (#06b6d4), unmapped → slate (#94a3b8)
4. The no-op ternary in `NexusGraph.svelte:106` is removed; edge style comes from `edge-style-cosmos.ts`
5. Hover over any node shows `hover-label.svelte` with full symbol name and kind badge
6. Macro view (`/code`) and community drill-down (`/code/community/[id]`) render correctly; ego network (`/code/symbol/[name]`) renders hop-distance coloring via `CosmosRenderer` color prop
7. `pnpm run test` passes; code route smoke test passes

**Labels:** `design`, `studio`, `wave-B`, `code`, `graph`, `nexus`  
**Size:** large  
**Dependencies:** Wave A complete (T990-WA-005 graph kit)  
**Files to touch:**
- `packages/studio/src/lib/components/NexusGraph.svelte`
- `packages/studio/src/routes/code/+page.svelte`
- `packages/studio/src/routes/code/community/[id]/+page.svelte`
- `packages/studio/src/routes/code/symbol/[name]/+page.svelte`

---

### T990-WB-009 — Admin Page Redesign (`/projects`)

**Title:** Redesign admin/projects: bulk reindex, health diagnostics, token-based styling

**Description:** Per `dashboard-admin-audit.md` §4-8: admin page is functionally solid but has three separate modal shells (no shared `Modal.svelte`), no bulk operations, poor stale detection UX (date only, no time). Refactor modals to use `Modal.svelte` primitive; add "Reindex All" toolbar action; improve stale indicator to show date+time.

**Acceptance Criteria:**
1. `CleanModal.svelte`, `ScanModal.svelte`, `DeleteConfirmModal.svelte` all use `Modal.svelte` from `src/lib/ui/` for their backdrop/close/focus-trap shell — each modal removes its own duplicate `backdrop` + `close-on-escape` implementation
2. "Reindex All" button added to global toolbar; triggers sequential reindex of all projects with progress indicator; guarded by confirmation modal
3. "Last Indexed" field shows `{date} {time}` (e.g. "2026-04-20 14:32") instead of date-only
4. Stale threshold (currently hardcoded 7 days in component) extracted to a `STALE_THRESHOLD_DAYS` constant in the component file (first step toward configurability)
5. All buttons use `Button.svelte` from `src/lib/ui/` — no raw `<button>` with inline styles
6. Zero raw hex literals in `routes/projects/+page.svelte` — all `var(--...)` tokens

**Labels:** `design`, `studio`, `wave-B`, `admin`  
**Size:** medium  
**Dependencies:** Wave A complete (T990-WA-001 through T990-WA-003)  
**Files to touch:**
- `packages/studio/src/routes/projects/+page.svelte`
- `packages/studio/src/lib/components/admin/CleanModal.svelte`
- `packages/studio/src/lib/components/admin/ScanModal.svelte`
- `packages/studio/src/lib/components/admin/DeleteConfirmModal.svelte`

---

### T990-WB-010 — Sessions Page Redesign (`/tasks/sessions`)

**Title:** Redesign sessions timeline page with token styling and expandable session cards

**Description:** Per `tasks-page-audit.md` §9: sessions page is a separate timeline feature, not part of the Explorer. It shares the nav header but has its own visual paradigm. Apply token-based styling via `Card.svelte`, ensure expandable session rows use consistent animation tokens, and surface session health (task counts, duration, errors if any).

**Acceptance Criteria:**
1. Sessions page uses `Card.svelte` for session entries; expandable rows use `var(--ease-slow)` for open/close animation
2. Active session prominently marked with pulsing `--status-active` badge
3. Session duration shown in human-readable form (e.g., "2h 14m") not raw seconds
4. Zero raw hex literals — all `var(--...)` tokens
5. Responsive: sessions stack vertically on <640px, comfortable at 1200px
6. `pnpm biome check` passes

**Labels:** `design`, `studio`, `wave-B`, `sessions`, `tasks`  
**Size:** small  
**Dependencies:** Wave A complete  
**Files to touch:**
- `packages/studio/src/routes/tasks/sessions/+page.svelte`
- `packages/studio/src/routes/tasks/sessions/+page.server.ts` (minor — duration formatting)

---

### T990-WB-011 — Task Detail Page Redesign (`/tasks/[id]`)

**Title:** Redesign task detail page: two-panel layout, WCAG AA, linked deps

**Description:** Per `tasks-page-audit.md` §9: task detail page has good structure but no shared primitives, inline hex colors, and the `DetailDrawer` pattern (sidebar for sub-tasks and deps) is replicated here as a full-page layout. Use `Card.svelte` panels, wire `DetailDrawer`'s `Drawer.svelte` shell for sub-task expansion, and make dep links navigable.

**Acceptance Criteria:**
1. Two-panel layout: left panel (task metadata: ID, status, priority, type, parent breadcrumb) + right panel (subtasks, deps in/out, manifest, commits) with responsive single-column on <768px
2. All status/priority badges use `Badge.svelte` (tone prop) from `src/lib/ui/`
3. Dependency links (blocked-by, blocks) navigate to `/tasks/{depId}` on click — confirmed working
4. Parent breadcrumb chain is clickable navigating up the task hierarchy
5. Zero raw hex literals; all `var(--...)` tokens
6. Page passes WCAG AA contrast check for all visible text

**Labels:** `design`, `studio`, `wave-B`, `tasks`  
**Size:** small  
**Dependencies:** Wave A complete  
**Files to touch:**
- `packages/studio/src/routes/tasks/[id]/+page.svelte`
- `packages/studio/src/routes/tasks/[id]/+page.server.ts` (minor)

---

### T990-WB-012 — Global Navigation + Layout Redesign

**Title:** Redesign global nav + layout: active states, project selector polish, consistent shell

**Description:** Per `dashboard-admin-audit.md` §2: the nav has correct 5-item structure but active state uses `rgba(59,130,246,0.1)` blue-on-blue (fails WCAG AA, ratio ~3:1). ProjectSelector at 612 lines needs a `Select.svelte` primitive underneath. Nav source order fix from T990-WA-004 applies here at the layout level.

**Acceptance Criteria:**
1. Active nav item uses `--accent-soft` background with `--accent` text (not blue-on-blue) — contrast ratio ≥ 4.5:1 verified
2. Nav source order: `<nav>` in DOM before `<main>` OR explicit `tabindex` plan; skip-to-content link jumps past nav to `<main>`
3. `ProjectSelector.svelte` refactored to use `Select.svelte` from `src/lib/ui/` for the dropdown primitive; existing search, stats, health indicator preserved
4. Logo "CLEO Studio" text uses `var(--text-dim)` (not hardcoded `#94a3b8`)
5. All nav link hover/active states use only `var(--...)` tokens
6. `pnpm biome check` passes; no regressions in project-switching flow

**Labels:** `design`, `studio`, `wave-B`, `layout`, `nav`  
**Size:** medium  
**Dependencies:** Wave A complete (T990-WA-001 through T990-WA-004)  
**Files to touch:**
- `packages/studio/src/routes/+layout.svelte`
- `packages/studio/src/lib/components/ProjectSelector.svelte`

---

## Wave C — BRAIN Neural View Consolidation

**Parallelism:** Wave C runs serial after all Wave B tasks complete. WC tasks run in the order listed.  
**Rationale:** Depends on CosmosRenderer being validated in production on the `/brain` page (WB-005) before the consolidation cleanup removes the old renderers.  
**Count:** 5 tasks

---

### T990-WC-001 — Cosmos Synapse Shader + Glow Aesthetic

**Title:** Implement synapse glow shader: additive blending, edge-temperature coloring, STDP visualization

**Description:** Per `brain-page-audit.md` §6 and `graph-engine-recommendation.md` §5: cosmos.gl's regl backend supports additive blending (`{src: 'src alpha', dst: 'one'}`) for the glow pile-up at active clusters. Wire the `firing-queue` (T990-WA-006) into per-frame `setLinkColors` calls; apply edge temperature coloring (cool blue → hot cyan → white) based on `co_fire_count`/STDP edge weight. This delivers the "synapses firing" neural aesthetic.

**Acceptance Criteria:**
1. `src/lib/graph/live/synapse-shader.ts` implements the 3-phase fire interpolation (brighten/hold/decay) and returns per-link color diffs consumed by `CosmosRenderer`
2. Additive blending enabled on CosmosRenderer's cosmos instance for the brain surface — verified by visual inspection that clustered active nodes show glow pile-up effect
3. Edge temperature coloring: edges with `co_fire_count > 10` render cyan/white; cold edges render dim blue; colors transition smoothly via `setLinkColors` diff
4. `IntersectionObserver` pauses cosmos simulation + firing queue when brain canvas is off-screen (existing T990-WA-005 contract); verified by switching tabs and confirming requestAnimationFrame stops
5. Glow effect respects `prefers-reduced-motion: reduce` — all fire animations stop; edges remain colored by temperature but do not animate
6. At 500 nodes, brain page maintains 60fps on a 2019 MacBook Pro (measured via browser devtools Performance tab — documented in output)

**Labels:** `design`, `studio`, `wave-C`, `brain-viz`, `graph`, `neural-view`  
**Size:** large  
**Dependencies:** T990-WB-005 (brain overview live with CosmosRenderer), T990-WA-006 (firing queue)  
**Files to touch:**
- `packages/studio/src/lib/graph/live/synapse-shader.ts` (new)
- `packages/studio/src/lib/graph/renderers/CosmosRenderer.svelte` (wire firing queue)
- `packages/studio/src/routes/brain/+page.svelte` (enable additive blend mode)

---

### T990-WC-002 — Cortical Cluster Spatial Layout

**Title:** Apply substrate-based radial layout: cortical region separation for brain/nexus/tasks/conduit/signaldock

**Description:** Per `brain-page-audit.md` §6: all 5 substrates are mixed in one force space, making it impossible to see which nodes belong to which "cortical region." Implement substrate-specific radial radius offsets (brain nodes at center, tasks at mid-radius, nexus at outer ring, etc.) as a cosmos.gl layout preset in `layout.ts`. Cluster labels from `cluster-label-layer.svelte` anchor to each substrate centroid.

**Acceptance Criteria:**
1. `src/lib/graph/model/layout.ts` exports a `corticalRadiusPreset` that maps each substrate to a radial force radius: brain (r=0 center), tasks (r=200), conduit (r=300), signaldock (r=350), nexus (r=450)
2. `CosmosRenderer.svelte` accepts a `layoutPreset` prop; when `preset='cortical'`, cosmos simulation applies substrate-specific gravity centers via cosmos.gl's `setPointPositions` or link-strength tuning
3. `cluster-label-layer.svelte` computes centroid of each substrate's visible nodes and renders substrate label (e.g., "BRAIN", "NEXUS") at centroid in DOM overlay — not canvas labels
4. Cluster labels are `aria-hidden="true"` (decorative spatial cue, not navigable content)
5. Switching to cortical layout from force layout is smooth (600ms transition); no hard pop
6. Visual inspection confirms substrate regions are spatially distinct while force sim remains live

**Labels:** `design`, `studio`, `wave-C`, `brain-viz`, `graph`, `neural-view`  
**Size:** medium  
**Dependencies:** T990-WC-001  
**Files to touch:**
- `packages/studio/src/lib/graph/model/layout.ts` (corticalRadiusPreset)
- `packages/studio/src/lib/graph/renderers/CosmosRenderer.svelte`
- `packages/studio/src/lib/graph/labels/cluster-label-layer.svelte`

---

### T990-WC-003 — Consolidate /brain/3d into unified canvas; delete legacy renderers

**Title:** Delete LivingBrain3D, LivingBrainGraph, BrainGraph legacy components; redirect /brain/3d

**Description:** Per `graph-engine-recommendation.md` §7: after `CosmosRenderer` is validated in production, remove the three legacy renderers and the separate `/brain/3d` page. `LivingBrainCosmograph.svelte` shim (now wrapping CosmosRenderer) becomes the canonical brain component. The `/brain/3d` route becomes a redirect to `/brain`. Remove sigma, 3d-force-graph, three, three-stdlib, graphology-layout-forceatlas2 from `package.json`.

**Acceptance Criteria:**
1. `LivingBrain3D.svelte`, `LivingBrainGraph.svelte`, `BrainGraph.svelte` are deleted
2. `/brain/3d/+page.svelte` redirects to `/brain` (SvelteKit `redirect(301, '/brain')`)
3. `/brain/3d/+page.server.ts` removed
4. `packages/studio/package.json` no longer lists: `sigma`, `@sigma/node-border`, `3d-force-graph`, `three`, `three-stdlib`, `graphology-layout-forceatlas2` — bundle size reduction of ~280KB gzip documented
5. `LivingBrainCosmograph.svelte` renamed to `BrainCanvas.svelte` and documented as the canonical brain renderer component
6. `pnpm run build` exits 0; `pnpm run test` passes; route existence test in `brain/__tests__/route-existence.test.ts` updated to expect `/brain/3d` returns 301

**Labels:** `design`, `studio`, `wave-C`, `brain-viz`, `cleanup`  
**Size:** medium  
**Dependencies:** T990-WC-001, T990-WC-002, T990-WB-005 (all validated in production)  
**Files to touch:**
- `packages/studio/src/lib/components/LivingBrain3D.svelte` (delete)
- `packages/studio/src/lib/components/LivingBrainGraph.svelte` (delete)
- `packages/studio/src/lib/components/BrainGraph.svelte` (delete)
- `packages/studio/src/routes/brain/3d/+page.svelte` (redirect)
- `packages/studio/package.json`
- `packages/studio/src/lib/components/LivingBrainCosmograph.svelte` → `BrainCanvas.svelte` (rename)

---

### T990-WC-004 — Brain Sub-pages: Patterns + Learnings Pages (missing from memory)

**Title:** Create /brain/patterns and /brain/learnings pages; wire memory.pattern.find + memory.learning.find

**Description:** Per `memory-page-audit.md` §10: patterns and learnings pages are missing; API endpoints for `memory.pattern.find` and `memory.learning.find` need to be created. These are the "procedural" and "semantic" substrates of BRAIN — critical for the neural canvas to have rich node data to display.

**Acceptance Criteria:**
1. New API route `packages/studio/src/routes/api/memory/patterns/+server.ts` created; calls `cleo memory pattern.find` via CLEO dispatch; returns `{patterns[], total}` with filter params (impact, type, search)
2. New API route `packages/studio/src/routes/api/memory/learnings/+server.ts` created; calls `cleo memory learning.find`; returns `{learnings[], total}` with filter params
3. New page `src/routes/brain/patterns/+page.svelte`: card list with filter chips for impact (high/medium/low), sort, search; uses `Spinner.svelte` and `EmptyState.svelte`
4. New page `src/routes/brain/learnings/+page.svelte`: same pattern as patterns page
5. Both pages linked from the brain sub-navigation (breadcrumb or sidebar); tier color coding consistent with observations/decisions pages
6. `pnpm run test` passes including new smoke tests for the two new routes

**Labels:** `design`, `studio`, `wave-C`, `memory`, `brain`  
**Size:** medium  
**Dependencies:** T990-WB-006, T990-WB-005  
**Files to touch:**
- `packages/studio/src/routes/brain/patterns/+page.svelte` (new)
- `packages/studio/src/routes/brain/learnings/+page.svelte` (new)
- `packages/studio/src/routes/api/memory/patterns/+server.ts` (new)
- `packages/studio/src/routes/api/memory/learnings/+server.ts` (new)

---

### T990-WC-005 — Consolidate Sigma from NexusGraph; remove sigma package

**Title:** Complete sigma removal: NexusGraph final migration to CosmosRenderer, sigma uninstalled

**Description:** After T990-WB-008 ported `NexusGraph.svelte` to `CosmosRenderer.svelte`, and T990-WB-004 migrated `TaskDepGraph.svelte` to `SvgRenderer.svelte`, sigma should have zero remaining consumers. This task verifies, removes the package, and updates the route-existence smoke test.

**Acceptance Criteria:**
1. `grep -r "from 'sigma'" packages/studio/src` returns zero hits
2. `grep -r "from '@sigma/" packages/studio/src` returns zero hits
3. `sigma` and all `@sigma/*` packages removed from `packages/studio/package.json`
4. `sigma-defaults.ts` deleted (no consumers remain)
5. `pnpm run build` exits 0 after sigma removal
6. Bundle size reduction documented (sigma ~90KB gzip)

**Labels:** `design`, `studio`, `wave-C`, `cleanup`, `graph`  
**Size:** small  
**Dependencies:** T990-WC-003, T990-WB-008, T990-WB-004  
**Files to touch:**
- `packages/studio/package.json`
- `packages/studio/src/lib/components/sigma-defaults.ts` (delete)

---

## Wave D — API Wiring Repair

**Parallelism:** Wave D runs in parallel with Wave C after all Wave B tasks complete. WD tasks are independent of each other.  
**Count:** 4 tasks

---

### T990-WD-001 — Wire /api/tasks/[id] and /api/tasks/[id]/deps into DetailDrawer

**Title:** Wire DetailDrawer to fetch task detail + deps on demand via typed API client

**Description:** Per `api-wiring-audit.md` §3: `/api/tasks/[id]` and `/api/tasks/[id]/deps` are orphaned endpoints — `DetailDrawer.svelte:56` documents them but never fetches. The drawer currently receives deps via prop from the parent page load (one full round-trip). Wire the drawer to lazy-fetch via the typed API client (from T990-WD-004) when a task is selected, enabling drawer-without-reload for future client-side navigation.

**Acceptance Criteria:**
1. `DetailDrawer.svelte` calls `/api/tasks/${id}` on `selectedTaskId` change via typed client; renders task detail from response without full page reload
2. `/api/tasks/${id}/deps` called lazily when "Dependencies" section is expanded; deps render without full page reload
3. Loading state shows `Spinner.svelte` inside the drawer sections during fetch
4. Error state shows `EmptyState.svelte` with retry button if fetch fails
5. Existing prop-based path (`data.tasks`) still works as initial state; API response supplements/overrides
6. `pnpm run test` passes; drawer tests updated

**Labels:** `design`, `studio`, `wave-D`, `api`, `tasks`  
**Size:** medium  
**Dependencies:** Wave B complete, T990-WD-004 (typed client)  
**Files to touch:**
- `packages/studio/src/lib/components/tasks/DetailDrawer.svelte`
- `packages/studio/src/routes/api/tasks/[id]/+server.ts` (verify shape matches)
- `packages/studio/src/routes/api/tasks/[id]/deps/+server.ts` (verify shape matches)

---

### T990-WD-002 — Consolidate /brain/overview inlined SQL → /api/memory/tier-stats

**Title:** Remove inline SQL from brain/overview; fetch from /api/memory/tier-stats

**Description:** Per `api-wiring-audit.md` §3 and `memory-page-audit.md` §6: `routes/brain/overview/+page.server.ts` inlines the same SQL as `/api/memory/tier-stats` — the API endpoint exists and returns the correct shape but the page ignores it. Remove the inline SQL duplication; use the API endpoint. Eliminates a drift risk where the SQL could diverge.

**Acceptance Criteria:**
1. `routes/brain/overview/+page.server.ts` (if it still exists) replaced with a `fetch('/api/memory/tier-stats')` call using the typed client
2. Alternatively, extract query to `$lib/server/brain/tier-stats.ts` shared service consumed by both the API route and the page load — whichever approach is chosen is documented
3. The overview page renders the same tier stats as before
4. `api-wiring-audit.md` finding "duplicated by overview/+page.server.ts direct-DB load" is resolved — confirmed by code review
5. `pnpm run build` exits 0; `pnpm run test` passes

**Labels:** `design`, `studio`, `wave-D`, `api`, `memory`  
**Size:** small  
**Dependencies:** Wave B complete, T990-WB-007 (tier-stats page exists)  
**Files to touch:**
- `packages/studio/src/routes/brain/overview/+page.server.ts`
- `packages/studio/src/lib/server/brain/tier-stats.ts` (new shared service, if that approach chosen)

---

### T990-WD-003 — Delete orphan API endpoints and dead tree redirect

**Title:** Clean up dead API endpoints: tree/[epicId] delete, tasks/[id] orphan docs fix

**Description:** Per `api-wiring-audit.md` §3: `/api/tasks/tree/[epicId]` is a dead endpoint — the route is a 301 redirect shell, the API serves nothing. Remove it. Clean up the `DetailDrawer.svelte:56` stale doc comment referencing it. Wire `/api/tasks/[id]` into the drawer (done in T990-WD-001), validating the endpoint is no longer "orphaned."

**Acceptance Criteria:**
1. `packages/studio/src/routes/api/tasks/tree/[epicId]/+server.ts` deleted
2. The redirect shell `src/routes/tasks/tree/[epicId]/+page.svelte` is preserved (still redirects users) but the API endpoint is gone
3. `DetailDrawer.svelte:56` stale doc comment updated to reference the now-wired fetch (from T990-WD-001)
4. `pnpm run build` exits 0; no 404s on the tasks route tree
5. `api-wiring-audit.md` "Delete or clearly mark deprecated" recommendation for `/api/tasks/tree/[epicId]` is resolved

**Labels:** `design`, `studio`, `wave-D`, `api`, `cleanup`  
**Size:** small  
**Dependencies:** T990-WD-001  
**Files to touch:**
- `packages/studio/src/routes/api/tasks/tree/[epicId]/+server.ts` (delete)
- `packages/studio/src/lib/components/tasks/DetailDrawer.svelte` (doc comment update)

---

### T990-WD-004 — Typed API Client

**Title:** Build src/lib/api/client.ts: typed fetch wrapper with LAFS envelope, retry, abort

**Description:** Per `api-wiring-audit.md` §7-8: 7 of 10 fetch sites use naive `throw new Error('HTTP ' + res.status)` and discard the `error.message` from LAFS envelopes. Build a single typed client wrapping all Studio API surfaces. Goals: `Result<T, CleoApiError>` return type (no throw), LAFS envelope parsing, 3-retry exponential backoff on 503, abort signal passthrough.

**Acceptance Criteria:**
1. `packages/studio/src/lib/api/client.ts` exists; exports `api` object with namespaced methods: `api.brain.*`, `api.memory.*`, `api.tasks.*`, `api.project.*`, `api.streams.*` per `api-wiring-audit.md` §8 spec
2. All methods return `Result<T, CleoApiError>` discriminated union (not throw); `CleoApiError` includes `code`, `message`, `status`
3. On 503 response, retries up to 3 times with 1s/2s/4s exponential backoff before returning error result
4. Abort signal passthrough: every `GET` method accepts optional `AbortSignal` (matched by existing `/api/tasks/search` site #10)
5. Parses LAFS `{success, data?, error?}` envelope: on `success: false`, returns error result with `error.message` (not `HTTP NNN`)
6. At least the brain and memory fetch sites in `routes/brain/` are migrated to use the typed client (Wave B pages may use it natively if implemented after this — Wave D may need to run before/parallel with part of Wave B)

**Labels:** `design`, `studio`, `wave-D`, `api`, `dx`  
**Size:** medium  
**Dependencies:** Wave A complete (T990-WA-001); can be built parallel to Wave B  
**Files to touch:**
- `packages/studio/src/lib/api/client.ts` (new)
- `packages/studio/src/routes/brain/+page.svelte` (migrate fetch calls)
- `packages/studio/src/routes/brain/decisions/+page.svelte`
- `packages/studio/src/routes/brain/quality/+page.svelte`

---

## Wave E — Integration + Owner Review

**Parallelism:** All Wave E tasks run serially in the order listed. Represent the integration and sign-off phase.  
**Count:** 3 tasks

---

### T990-WE-001 — Performance Gates: 60fps Graph + <2s Initial Render

**Title:** Validate performance gates: 60fps graph interaction, <2s initial render across all pages

**Description:** Per T990 acceptance criteria §12: "initial render < 2s, graph interactions 60fps, no layout thrash." Now that all pages are redesigned and the graph kit is consolidated, measure performance across all pages. Fix any remaining regressions before sign-off.

**Acceptance Criteria:**
1. Each Studio page measured via Chrome DevTools Performance tab at localhost:3456: initial LCP < 2000ms for `/`, `/tasks`, `/brain`, `/code`, `/projects`
2. Brain page at 500 nodes: cosmos.gl simulation + synapse firing maintains 60fps (measured via `requestAnimationFrame` timestamp delta — logged to console for 10s, no frame > 20ms)
3. Task graph at 300 nodes (typical project): SvgRenderer d3-force interaction (drag node) maintains 60fps
4. No layout thrash detected — no forced synchronous layouts in Performance timeline during page load
5. Bundle size for `studio` package documented before/after: `pnpm run build --report` size diff recorded in task output
6. Any page failing gates has a root-cause analysis written in the task output before completion

**Labels:** `design`, `studio`, `wave-E`, `performance`  
**Size:** medium  
**Dependencies:** Wave B + Wave C + Wave D all complete  
**Files to touch:**
- No new code expected; if fixes needed, they target `CosmosRenderer.svelte` or SvelteKit load functions

---

### T990-WE-002 — Full Accessibility Audit + WCAG AA Compliance Report

**Title:** Run axe-playwright against all routes; fix remaining WCAG AA violations

**Description:** Per T990 acceptance criteria §11 and `design-system-audit.md` §6: WCAG AA across all interactive elements is a hard gate. Run `axe-playwright` against all 12 routes; fix any remaining violations not addressed in Wave A/B. Document the final compliance report.

**Acceptance Criteria:**
1. `axe-playwright` configured in existing e2e suite; runs against all routes: `/`, `/tasks`, `/tasks/pipeline`, `/brain`, `/brain/observations`, `/brain/decisions`, `/brain/graph`, `/brain/quality`, `/brain/tier-stats`, `/code`, `/projects`, `/tasks/sessions`
2. Zero critical (level A) or serious (level AA) axe violations on any route
3. Color contrast: all body text ≥ 4.5:1; large text ≥ 3:1; verified programmatically
4. `prefers-reduced-motion` tested: all synapse animations stop; no motion tokens fire
5. Keyboard tab order tested on `/brain` and `/tasks`: all interactive elements reachable via Tab; focus ring visible on each
6. Compliance report written as output at `.cleo/agent-outputs/T990-decomposition/wcag-report.md`

**Labels:** `design`, `studio`, `wave-E`, `a11y`  
**Size:** medium  
**Dependencies:** T990-WE-001  
**Files to touch:**
- `packages/studio/tests/a11y/` (new or extended e2e tests)
- Any components with remaining violations

---

### T990-WE-003 — Operator Review + Sign-off Checklist

**Title:** Live review session at localhost:3456: operator sign-off per-page, final polish

**Description:** Per T990 acceptance criteria §13: "Live at http://localhost:3456/ with operator reviewing each page before ship." This task gates the epic completion. The orchestrator prepares a structured review checklist (one card per page), runs the Studio server, and records operator feedback. Any blocking feedback becomes a new child task under T990 before this task can complete.

**Acceptance Criteria:**
1. Studio server running at localhost:3456 with current main branch
2. Review checklist covers all 12 routes: `/`, `/tasks`, `/tasks/pipeline`, `/brain`, `/brain/observations`, `/brain/decisions`, `/brain/graph`, `/brain/quality`, `/brain/tier-stats`, `/code`, `/projects`, `/tasks/sessions` — operator marks each as pass/block
3. Operator explicitly confirms: dashboard is clean and not cluttered with Kanban/Graph below the fold
4. Operator explicitly confirms: brain page feels like a "living brain" — synapses visibly animate on memory observe events
5. Operator explicitly confirms: code page node labels are not all face-up; edge types are visually distinct
6. Any blocking feedback results in new T990-WE-003-BLOCK-* child tasks before this task completes
7. T990 epic lifecycle marked complete; `cleo memory observe` recording what was learned from this redesign

**Labels:** `design`, `studio`, `wave-E`, `review`, `sign-off`  
**Size:** small  
**Dependencies:** T990-WE-001, T990-WE-002  
**Files to touch:**
- No code changes expected; only review documentation + potential follow-up task creation

---

## Summary

### Wave Task Counts

| Wave | Tasks | Parallelism | Blocker For |
|------|-------|-------------|-------------|
| A — Design System Foundation | 6 | Fully parallel | All other waves |
| B — Per-Page Redesigns | 12 | Fully parallel (after A) | Wave C, D |
| C — BRAIN Neural Consolidation | 5 | Serial (after B) | Wave E |
| D — API Wiring Repair | 4 | Parallel with C (after B) | Wave E |
| E — Integration + Owner Review | 3 | Serial (after C+D) | Epic complete |
| **Total** | **35** | | |

### Size Distribution

| Size | Count | Tasks |
|------|-------|-------|
| small | 8 | WA-001, WA-002, WB-003, WB-010, WB-011, WC-005, WD-002, WD-003 |
| medium | 17 | WA-004, WA-006, WB-001, WB-002 (wait — large), WB-006, WB-007, WB-009, WB-012, WC-002, WC-004, WD-001, WD-004, WE-001, WE-002 |
| large | 5 | WA-003, WA-005, WB-002, WB-005, WB-008, WC-001 |

*(Note: WB-002 and WC-001 are large; adjusted count above.)*

### Critical Path (Longest Serial Chain)

```
WA-001 (tokens)
  → WA-005 (graph kit)
    → WA-006 (firing queue)
      → WB-005 (brain overview live)
        → WC-001 (synapse shader)
          → WC-002 (cortical layout)
            → WC-003 (cleanup legacy renderers)
              → WE-001 (perf gates)
                → WE-002 (a11y audit)
                  → WE-003 (operator sign-off)
```

Estimated minimum 10 sequential dependency hops. Individual task sizes suggest ~4-6 sessions to completion.

---

## Critical Risks

1. **cosmos.gl beta (v2.0.0-beta.26):** API may shift between now and Wave C completion. Mitigation: pin exact version; `CosmosRenderer.svelte` is the only cosmos.gl consumer (one file to change if API breaks). Existing `onInitializationError` slot already provides fallback path.

2. **Wave A graph kit size (T990-WA-005) may be underestimated:** Building 12 interconnected files in the graph kit (CosmosRenderer, SvgRenderer, edge kinds, labels, live bridge) is substantial. If this blocks Wave B, break WA-005 into WA-005a (renderers only) and WA-005b (label + interaction layers) to unblock some Wave B tasks earlier.

3. **Sigma removal (T990-WC-005) may reveal unexpected consumers:** Grep at wave design time shows 4 sigma consumers. If any server-side pipeline (nexus community-processor.ts) also uses sigma for client-side preview, removal will fail. Pre-check: `grep -r "sigma" packages/ --include="*.ts" --include="*.svelte"` before starting WC-005.

4. **T990-WB-002 tasks page refactor is large (1348-line file):** The `/tasks/+page.svelte` is the most complex file in the codebase for this redesign. It directly addresses the operator's core complaint. If scope expands, split into WB-002a (layout/flex restructure) and WB-002b (component migration).

5. **T990-WD-004 typed client ordering:** The API client is most useful if built before Wave B pages, but listed as Wave D because it is a repair/polish task. Consider moving WD-004 to Wave A as WA-007 to ensure all Wave B pages use it natively. Operator decision needed.

---

## Operator Decisions Needed

1. **WD-004 placement:** Should the typed API client (currently Wave D) be promoted to Wave A so all Wave B pages are built on it from the start? This avoids a second pass to migrate fetch calls.

2. **3D view fate:** The `graph-engine-recommendation.md` recommends retiring 3d-force-graph entirely (cosmos.gl with additive blend glow achieves the neural aesthetic without the THREE.js overhead). The operator's original directive mentions "amazing single view" — should a `?view=3d` feature flag be preserved behind an experimental toggle, or is full removal approved?

3. **Memory write surfaces (out of scope for T990):** `memory-page-audit.md` §10 identifies a missing write UI (observe, decision.store, pattern.store, learning.store, verify). These are 10+ operations absent from Studio. Should a T990-WF "Write Surfaces" wave be added to this epic, or filed as a separate epic?

4. **Auth on mutation endpoints:** `api-wiring-audit.md` §6 flags zero auth on 6 POST/DELETE endpoints. Currently safe for localhost. If Studio will ever be exposed on `0.0.0.0` (e.g., for team use), CSRF token work should be added to Wave D. Is network exposure planned?

5. **`/brain/overview` route:** The audit notes `/brain/overview` as a "legacy/unclear purpose" fallback. Should it be redirected to `/brain` (main canvas) or preserved as its own page for the tier-stats visualization? T990-WB-007 creates `/brain/tier-stats` separately — if overview becomes redundant, it should be redirected.

---

## Source Audit → Wave Task Cross-Reference

| Audit File | Primary Wave Tasks Derived |
|------------|---------------------------|
| `design-system-audit.md` | WA-001, WA-002, WA-003, WA-004 |
| `graph-engine-recommendation.md` | WA-005, WA-006, WC-001, WC-002, WC-003, WC-005 |
| `brain-page-audit.md` | WB-005, WC-001, WC-002, WC-003 |
| `tasks-page-audit.md` | WB-002, WB-003, WB-004, WB-010, WB-011 |
| `memory-page-audit.md` | WB-006, WB-007, WC-004, WD-002 |
| `code-page-audit.md` | WB-008 |
| `dashboard-admin-audit.md` | WB-001, WB-009, WB-012 |
| `api-wiring-audit.md` | WD-001, WD-002, WD-003, WD-004 |
