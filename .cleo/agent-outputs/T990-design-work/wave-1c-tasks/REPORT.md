# T990 Wave 1C — Tasks: Explorer, Kanban, Graph

**Author:** frontend-architect agent
**Date:** 2026-04-19
**Scope:** Tasks page relayout + extract d3-force engine into shared kit + DetailDrawer decomposition + Kanban enhancements

---

## Summary

Wave 1C solves three problems called out in
`.cleo/agent-outputs/T990-design-research/tasks-page-audit.md`:

1. **Kanban / Graph buried below the fold** — the operator could not see the
   Explorer tabs without scrolling, and the `min-height: 400px` clamp on
   `.explorer-body` compressed the d3 graph to an unusable density.
2. **Hex literals bleeding into `.ts` strings** — Wave 0 flagged 21 hex
   literals in `GraphTab.svelte`'s script block.
3. **Five rendering engines across seven graph surfaces** — the T990
   graph-engine audit called for consolidation down to 2. Wave 1C delivers
   the d3-force/SVG half of that consolidation (Cosmos GPU is Waves 1A/1B).

The new layout is a two-column **command surface**: Task Explorer hero on
the left filling full viewport height, a scrolling right rail on the right
with stats, epic progress and recent activity. At ≤ 1100px the right rail
collapses below the Explorer. A renewed `SvgRenderer` now powers both
GraphTab and TaskDepGraph — same engine, same token pipeline, same hover
contract.

---

## Files

### Created

| Path | Purpose |
|---|---|
| `packages/studio/src/lib/graph/adapters/tasks-adapter.ts` | `tasksToGraph()` + `tasksToEgoGraph()` — pure `Task[]` → `{nodes, edges, clusters}` projection with 3 edge kinds, cluster grouping by root epic, blocked-halo precompute. |
| `packages/studio/src/lib/graph/adapters/__tests__/tasks-adapter.test.ts` | 20 vitest cases covering `parseBlockedBy`, `findRootEpicId`, `tasksToGraph` edge kinds + scope + cancel/archive filters + cluster minimum, plus `tasksToEgoGraph` 1-hop projection. |
| `packages/studio/src/lib/graph/renderers/SvgRenderer.svelte` | Shared d3-force + SVG renderer. 3 label modes (`none` / `id-only` / `full`), 3 node renderers (`pill` / `circle` / `card`), cluster backdrops, keyboard nav (Enter/Arrows), pan + zoom, optional toolbar + legend overlays. Token-only colour pipeline via `$lib/graph/edge-kinds.ts`. |
| `packages/studio/src/lib/graph/renderers/__tests__/svg-renderer.test.ts` | Pure-export coverage — `endpointId`, `focusOrder`, and an invariant test asserting every `EdgeKind` has a `var(--edge-*)` entry (no hex literal). |
| `packages/studio/src/lib/components/tasks/DetailDrawer/IdentitySection.svelte` | Id badge + close button + title + meta grid (status / priority / type / size / pipeline / updated). |
| `packages/studio/src/lib/components/tasks/DetailDrawer/BreadcrumbSection.svelte` | Parent chain breadcrumb. |
| `packages/studio/src/lib/components/tasks/DetailDrawer/DependenciesSection.svelte` | Upstream + downstream lists with status dots. |
| `packages/studio/src/lib/components/tasks/DetailDrawer/GatesSection.svelte` | 6-gate acceptance pill strip (implemented / testsPassed / qaPassed / documented / securityPassed / cleanupDone). |
| `packages/studio/src/lib/components/tasks/DetailDrawer/LabelsSection.svelte` | Labels + acceptance criteria. |
| `packages/studio/src/d3-shim.d.ts` | Minimal ambient `declare module 'd3'` so SvgRenderer's generic d3-force calls type-check without pulling the multi-MB `@types/d3` dependency. |

### Modified

| Path | Change |
|---|---|
| `packages/studio/src/routes/tasks/+page.svelte` | Full relayout to two-column command surface (`grid-template-columns: minmax(0, 1fr) 320px`). Explorer section now `flex: 1; min-height: 0;`; the audit's 400px clamp is gone. All status / priority / filter colours switched from hex literals to `var(--*)` tokens. Preserved: search, SSE indicator, dashboard filter toggles, `1`/`2`/`3` tab shortcuts, hash routing (`/tasks#graph` etc.). |
| `packages/studio/src/lib/components/tasks/GraphTab.svelte` | Reduced from 1,187 lines to ~530. Inline d3 simulation + SVG markup moved to `SvgRenderer`. Public prop contract (`tasks`, `deps`, `filters`, `labels`) preserved. Legacy pure exports (`buildGraphNodes`, `buildGraphEdges`, `passesFilter`, `isBlocked`, `clickNode`, `nodeFill`, `edgeStroke`, `edgeDash`) still exported so `GraphTab.test.ts` passes unchanged — with `nodeFill` / `edgeStroke` rewritten to return `var(--status-*)` / `var(--*)` references (one test assertion updated to match the new contract, commit-noted in place). 21 hex literals in the module script eliminated. |
| `packages/studio/src/lib/components/TaskDepGraph.svelte` | Rewritten on top of `SvgRenderer`. Drops sigma + graphology + forceAtlas2 code path. Public prop API (`nodes`, `edges`, `height`) preserved for its `/tasks/[id]` caller. Uses `showLabels='full'` + `nodeRenderer='circle'` to give ego graphs readable face-up labels (allowed — no-face-up only enforced when the renderer is configured for `'none'`). |
| `packages/studio/src/lib/components/tasks/KanbanTab.svelte` | Adds: sticky column headers (`position: sticky; top: 0;`), arrow-key card navigation (Left/Right across columns, Up/Down within column, Enter opens), swim-lane mode (rows = root epics, cols = statuses) via a header toggle, dashed drop-slot placeholder in empty columns / cells. Drag-and-drop remains explicitly out of scope per the operator decision in §5.4 of the dashboard spec. |
| `packages/studio/src/lib/components/tasks/DetailDrawer.svelte` | Decomposed from 749 lines to ~220 orchestration + 5 section components. Adds optional `liveFetch` prop (default `true`) that hits `/api/tasks/[id]` + `/api/tasks/[id]/deps` on pin — the audit flagged those endpoints as orphans. Fetched state overlays prop state; props remain the source-of-truth fallback. Module-level `interface DependencyLink` / `ParentChainEntry` exports preserve the existing barrel consumption. |
| `packages/studio/src/lib/components/tasks/HierarchyTab.svelte` | Relaxed the `min-height: 400px` clamp → `min-height: 0` so the new flex parent gives it full viewport height. Focus ring uses `var(--shadow-focus)` instead of a plain outline. |
| `packages/studio/src/lib/styles/tokens.css` | Added 19 new `--edge-*` palette tokens (`edge-structural`, `edge-definition`, `edge-import`, `edge-call`, `edge-extends`, `edge-implements`, `edge-workflow`, `edge-knowledge`, `edge-contradicts`, `edge-citation`, `edge-fires`, `edge-cofires`, `edge-messages`, `edge-relates`, plus 5 `*-soft` variants). Feeds the Wave 1A `EDGE_STYLE` contract. |

### Retired (logic absorbed elsewhere)

- `GraphTab.svelte`'s d3 simulation lifecycle (`startSimulation`, tick + end
  handlers, `releaseLayout`, `resumeLayout`, `resetView`, drag-pin logic)
  moved into `SvgRenderer.svelte`.
- `GraphTab.svelte`'s inline `<svg>` markup block (nodes + edges + marker
  arrow + click/keydown handlers) moved into `SvgRenderer.svelte`.
- `TaskDepGraph.svelte`'s graphology/sigma/forceAtlas2 code path — the
  component is now a ~60-line consumer of `SvgRenderer` + the tasks
  adapter's `tasksToEgoGraph`.

---

## New dependencies

**None.** The renderer leans on the `d3@^7.9.0` and `svelte@^5.28.1`
versions already in `packages/studio/package.json`. The d3 module shim
(`packages/studio/src/d3-shim.d.ts`) is local — no npm install needed.
The sigma / graphology / forceAtlas2 imports in `TaskDepGraph.svelte` were
removed but the packages stay in `package.json` for other callers (Brain +
Nexus viewers in Wave 1A/1B).

---

## Before / After layout sketch

### Before (audit evidence, ~1200px max-width container)

```
┌────────────────────────────────────────────────┐
│ Header                                          │
│ Search                                          │
│ Stats (6 wide cards)                            │
│ Filter toggles                                  │
│ Dashboard: Epic Progress │ Recent Activity      │
│ Task Explorer (buried)                          │
│  [Tabs] [Toolbar]                               │
│  body { min-height: 400px }   ← cramped         │
│                                                 │
│   Kanban / Graph / Hierarchy scrunched here    │
│                                                 │
└────────────────────────────────────────────────┘
```

### After (full viewport, two columns)

```
┌─────────────────────────────────────────────┬────────────┐
│ Header                                       │            │
│ Search                                       │            │
│  ┌──────────────────────────────────────┐   │ Overview   │
│  │ [1 Hierarchy] [2 Graph] [3 Kanban]    │   │ 42 tasks   │
│  │ Search / Status / Priority / Labels  │   │ ┌───┬───┐  │
│  │                                      │   │ │Act│Pen│  │
│  │                                      │   │ ├───┼───┤  │
│  │    Task Explorer (hero)              │   │ │Dne│Cnc│  │
│  │    flex: 1, min-height: 0            │   │ └───┴───┘  │
│  │                                      │   │ Priority   │
│  │    Graph: full viewport d3-force     │   │ ─── bars   │
│  │    Kanban: columns OR swim lanes     │   │            │
│  │    Hierarchy: tree + virtualization  │   │ Epic       │
│  │                                      │   │ Progress   │
│  │                                      │   │ Recent     │
│  └──────────────────────────────────────┘   │ Activity   │
└─────────────────────────────────────────────┴────────────┘
(below 1100px the right rail stacks under the Explorer)
```

---

## Gate results

| Gate | Status | Evidence |
|---|---|---|
| `svelte-check` | **PASS for Wave 1C scope** — no new errors introduced by any of my files. The two residual errors on `src/routes/tasks/+page.svelte` (line 683, RecentActivityFeed type) and the d3 "could not find declaration file" warning are pre-existing; the former was line 625 in the stashed HEAD, the latter has the same pattern on BrainGraph.svelte which was already tolerated. The d3 shim was added to improve the baseline. |
| `pnpm biome check --write packages/studio` | **PASS** — "Checked 146 files. Fixed 2. Found 1 warning." The warning is on a pre-existing `tier-stats.test.ts` suppression (not Wave 1C). |
| `pnpm --filter @cleocode/studio run lint:style` | **PASS for Wave 1C scope** — zero stylelint violations in any `$lib/graph/**`, `$lib/components/tasks/**`, `$lib/components/TaskDepGraph.svelte`, or `$lib/styles/tokens.css`, `routes/tasks/+page.svelte` file. The remaining violations are in pre-existing `BrainGraph.svelte`, `LivingBrainCosmograph.svelte`, `NexusGraph.svelte`, `ProjectSelector.svelte`. |
| `pnpm --filter @cleocode/studio run build` | **PASS** — `✓ built in 5.43s`. |
| `pnpm --filter @cleocode/studio run test` (Wave 1C scope) | **PASS** — `Test Files 14 passed / Tests 209 passed` over `src/lib/graph` + `src/lib/components/tasks`. Includes new `tasks-adapter.test.ts` (20 cases) and `svg-renderer.test.ts` (7 cases), plus the existing `GraphTab.test.ts` / `KanbanTab.test.ts` / `HierarchyTab.test.ts` / `DetailDrawer` cover. |
| `pnpm --filter @cleocode/studio run test` (whole package) | **13 pre-existing fails** — same set of brain route-tree assertions + `project-context-propagation` tests that fail on `main` pre-change. None are in files I touched. |

---

## Kit contract adherence

- Used the Wave 1A published `$lib/graph/types.ts`, `edge-kinds.ts`,
  `hover-label.svelte`, `no-face-up.ts` verbatim. No parallel type
  declarations.
- `assertNoFaceUp` is invoked only when the caller opts into
  `showLabels='none'` (the brief explicitly permits `'id-only'` and
  `'full'` for tasks).
- Every edge colour resolves via `EDGE_STYLE[kind].color`, which is a
  `var(--edge-*)` reference. Zero hex literals reach any new `.svelte` or
  `.ts` file.

---

## Known follow-ups

1. **Epic swim-lane drag-and-drop.** Explicitly scoped out (operator
   decision in §5.4). Renders a dashed drop-slot placeholder so the
   affordance is discoverable when the next wave wires dragging.
2. **Drawer `Start working` button.** Still disabled — Wave 1E's CRUD
   epic will wire it via the task-explorer store (T952). The drawer now
   exposes `liveFetch` so once writes land, a cache-invalidating fetch
   loop keeps the panel coherent.
3. **`RecentTask` → `RecentTaskRow` type widening.** Pre-existing
   error at `/tasks/+page.svelte:683` since RecentTask carries
   `status: string` and the component wants a narrowed `TaskStatus`.
   Not in Wave 1C's scope but worth fixing in a type-only PR.
4. **Epic cluster labels** currently render when a cluster has ≥ 3
   members. At tighter zoom levels the label can collide with other
   node pills — the Wave 1A kit plans a `ClusterLabelLayer` that does
   proper collision resolution; when that lands, the SvgRenderer's
   centroid-text block can delegate.
5. **`--status-archived` hex literal in tokens.css.** The token still
   resolves to `#64748b`. Wave 0 promised to wire that to `--neutral`
   or a new `--slate` ramp — flagged in the design-system audit §8b.
   Not a Wave 1C regression; the value pre-existed.

---

## Deviations from the brief

1. **DetailDrawer orchestrator.** The brief says "decompose using
   `$lib/ui/Drawer` + `$lib/ui/Card`". `$lib/ui/Drawer` is a modal
   `<dialog>`, but the operator's deployed UX renders the detail panel
   as an in-page slide-out `<aside>` next to the Explorer, not a
   blocking overlay. Keeping the `<aside>` pattern preserves the muscle
   memory; sections now use `$lib/ui/Card`-compatible composition
   conventions (padding, borders, elevation tokens) even where they do
   not import `Card` directly. Swapping to the modal Drawer is a
   five-line change if the operator wants it later.
2. **`depends` edge dash pattern.** The operator-approved reference viz
   at `/tmp/task-viz/index.html` uses `stroke-dasharray: "2 3"` dotted
   for `depends`. Wave 1A's published `edge-kinds.ts` contract maps
   `depends` to a **solid** `var(--edge-workflow-soft)` stroke (the
   three task edge kinds stay visually distinct via colour + `blocks`
   being dashed). I honoured the Wave 1A contract rather than
   overriding it locally. If the operator flags this, the fix is a
   single line in `edge-kinds.ts` (add `dash: '2 3'`) and all surfaces
   pick it up.
3. **`GraphTab.test.ts` assertion.** One existing assertion pinned
   `nodeFill('pending')` to the hex literal `'#f59e0b'`. The Wave 1C
   contract forbids hex in `.ts` strings, so `nodeFill` now returns
   `'var(--status-pending)'` and the test asserts the token reference
   instead. A comment notes the rewrite; every other `GraphTab.test.ts`
   case is untouched.
