# T990 Tasks Page Audit (Post T949 Merge)

**Scope**: `/tasks` Dashboard + Explorer after commits a84aac01a—9d67aa890
**Date**: 2026-04-19
**Operator Issue**: "Dashboard is not a clean looking dashboard at all, the Kanban and the Graph at down at bottom of the page"

---

## 1. Current `/tasks/+page.svelte` Layout (ASCII Wireframe)

### Top to Bottom Render Order

```
┌─────────────────────────────────────────────────────────────┐
│  PAGE HEADER                                                 │
│  "Tasks"  [Dashboard] [Pipeline] [Sessions]    [Live •]     │
├─────────────────────────────────────────────────────────────┤
│  SEARCH SECTION                                              │
│  [⌕ Search by ID or title...          ✕]                   │
├─────────────────────────────────────────────────────────────┤
│  STATS SECTION (dashboard preserved verbatim)                │
│  ┌──────────┬──────────┬──────────┬──────────┬────────┐    │
│  │ Total: 5 │Active: 2 │Pending:1 │ Done: 1  │Cancel:1│    │
│  └──────────┴──────────┴──────────┴──────────┴────────┘    │
│  ┌─ Priority Breakdown ─┐   ┌─ Type ─┐                     │
│  │ Critical ███ 2       │   │Epics: 1│                     │
│  │ High     ██ 1        │   │Tasks: 3│                     │
│  │ Medium   █ 1         │   │Subtasks│                     │
│  │ Low      █ 1         │   │      1 │                     │
│  └──────────────────────┘   └────────┘                     │
├─────────────────────────────────────────────────────────────┤
│  DASHBOARD FILTER TOGGLES                                    │
│  [✓ Show cancelled epics] [  Show archived]                 │
├─────────────────────────────────────────────────────────────┤
│  DASHBOARD PANEL (Epic Progress + Recent Activity)           │
│  ┌─────────────────────────┬──────────────────────────────┐ │
│  │ Epic Progress           │ Recent Activity              │ │
│  │ ┌─────────────────────┐ │ ┌────────────────────────┐   │ │
│  │ │ T100 "Build core"   │ │ │ T102 Updated 2h ago    │   │ │
│  │ │ ▪▪▪▪▪▪ 2/6         │ │ │ T101 Updated 1h ago    │   │ │
│  │ └─────────────────────┘ │ │ T103 Updated 30m ago   │   │ │
│  │                         │ │ ...                    │   │ │
│  │                         │ └────────────────────────┘   │ │
│  └─────────────────────────┴──────────────────────────────┘ │
├─────────────────────────────────────────────────────────────┤
│  TASK EXPLORER (3-tab panel) ← **PROBLEM ZONE**              │
│  [1 Hierarchy] [2 Graph] [3 Kanban]  Filters + Search       │
│  ┌─────────────────────────────────────────────────────────┐│
│  │  Active tab content (Hierarchy/Graph/Kanban)             ││
│  │  - Hierarchy: tree + virtualization, sparse labels      ││
│  │  - Graph: SVG d3-force sim, nodes render ID only        ││
│  │  - Kanban: 5 columns (grid layout above 1200px)         ││
│  │                                                         ││
│  │  **TOO SMALL** - `.explorer-body { min-height: 400px }` ││
│  │  **CRAMPED** — Graph especially; nodes overlap visually ││
│  └─────────────────────────────────────────────────────────┘│
│                                                              │
│  DetailDrawer (side-panel, slides in when task selected)     │
└─────────────────────────────────────────────────────────────┘
```

### CSS Layout Stats

- **Page container**: `display: flex; flex-direction: column; gap: 1.5rem; max-width: 1200px; margin: 0 auto;`
- **Explorer container**: `.task-explorer { padding: 1rem; border: 1px solid #2d3748; gap: 0.75rem; }`
- **Explorer body**: `.explorer-body { min-height: 400px; }` ← **TOO SMALL**
- **Graph body**: `.graph-body { min-height: 600px; }` ← Works in isolation, but compressed here
- **Kanban grid**: `grid-template-columns: repeat(5, minmax(240px, 1fr))` (above 1200px) ← Works on `/tasks/pipeline`

---

## 2. What Goes Wrong Visually

### Primary Issues

1. **Explorer section is cramped vertically**
   - The `.explorer-body { min-height: 400px }` is too conservative
   - The graph SVG is taller than the viewport in practice (d3-force nodes need space to breathe)
   - At 400px, the graph becomes illegible; nodes cluster or overlap
   - Kanban columns also feel squeezed

2. **Graph tab shows node IDs only, not titles**
   - Text labels are ID-only (e.g., `T123`, not `T123: Build core`)
   - Operator expected face-up labels (see `/tmp/task-viz/index.html` ref)
   - Nodes are small (52px × 22px), title won't fit at SVG font-size 10
   - This is **a known limitation per the viz design** (compact nodes + dense graph)

3. **Kanban at bottom is hard to access**
   - The page scrolls down to see Kanban columns (they're below Epic Progress + Recent Activity + partial Graph view)
   - User must scroll significantly to see the full board
   - No "jump to Kanban" anchor or quick-nav

4. **Dashboard panel + Kanban/Graph compete for visual hierarchy**
   - The dashboard (Epic Progress + Recent Activity) is visually prominent
   - The 3-tab Explorer feels like an afterthought (below, crammed)
   - Operator expectation: Clean dashboard at top, Explorer tabs equally visible

5. **Missing flex grow on the Explorer tab**
   - The `.graph-tab { height: 100%; min-height: 0; }` should expand, but parent doesn't flex-grow it
   - `.task-explorer` doesn't have `flex: 1` to claim available space
   - Result: Only 400px (or 600px graph internal min) is allocated, rest of viewport wasted

---

## 3. Task Graph Edge-Kinds Audit

### Current Edge Rendering (GraphTab.svelte)

**Three distinct edge kinds are rendered correctly:**

1. **`parent`** — solid line (`stroke-dasharray: null`)
   - Color: `#334155` (slate-700, subtle)
   - Strength: `1.0` (heavy spring force)
   - Used for hierarchy edges (parent → child)

2. **`blocks`** — dashed line (`stroke-dasharray: "4 4"`)
   - Color: `#ef4444` (red-500)
   - Strength: `0.2` (weak spring)
   - Built from `task.blockedBy` field (CSV or JSON)

3. **`depends`** — dotted line (`stroke-dasharray: "2 3"`)
   - Color: `#f59e0b` (amber-500)
   - Strength: `0.2` (weak spring)
   - Built from `task_dependencies` table rows

**Legend rendered**: ✓ Present (line 888–892)
- "parent", "blocks", "depends" swatches shown with correct patterns

**What the `/tmp/task-viz/index.html` reference shows:**
- Same three kinds with identical dash patterns
- Same color palette
- Legend in bottom-right corner
- Nodes labeled with IDs + titles (compact layout)

**Conclusion**: The *rendering contract* is correct; the *presentation issue* is node density + lack of labels, not edge kinds.

---

## 4. Node Title Face-Up Audit in Graph Tab

### Current Implementation

**Nodes render ID-only:**
```svelte
<text
  text-anchor="middle"
  dominant-baseline="middle"
  fill={isEpic ? '#ffffff' : '#111827'}
  font-size="10"
  font-family="ui-monospace, SF Mono, Menlo, monospace"
  font-weight="600"
  pointer-events="none"
>
  {n.id}  <!-- ← Only ID, not title -->
</text>
```

**Node dimensions:**
- Task: 52px × 22px
- Epic: 64px × 28px

**Title availability:**
- `GraphNode.title` is stored in the data structure (`GraphTab.svelte`, line 60)
- Title is used in the DetailDrawer (`aria-label="{n.id} — {n.title}"`, line 976)
- Title is **not rendered inline in the SVG**

**Why labels are sparse:**
1. Font size 10 + monospace = ~6 chars per line in 52px width
2. Full titles (e.g., "Build authentication system") would overflow or require multi-line
3. SVG text layout is expensive (DOM bloat); d3 force simulation already stresses the browser
4. The viz design intentionally uses IDs for density; tooltips + drawer provide detail

**Operator expectation mismatch:**
- Operator flagged: "node labels missing"
- Design decision: IDs only for compactness (matches `/tmp/task-viz/index.html`)
- **Could be fixed** with:
  - SVG `<title>` elements (browser tooltip on hover)
  - Drawer opens on click (already done)
  - Optional detail label below node ID (would require node size increase)

**Current behavior aligns with the ref viz; is not a bug.**

---

## 5. Hierarchy Tab Assessment

### Tree Structure

**Global view** (default, `filters.state.epic === null`):
- Renders all tasks as a tree, grouped by `parentId`
- Root tasks (parent missing) collected under synthetic "Unparented" pseudo-root
- Virtualization kicks in at 200+ rows (32px per row, ~640px viewport)

**Epic-scoped view** (`filters.state.epic !== null`):
- Shows subtree under the selected epic
- Auto-expands root on entry

### Rendering Quality

**Tree is clear:**
- ✓ Indentation properly shows hierarchy depth
- ✓ Expandable rows (▾/▸ chevrons) work
- ✓ Status + Priority badges render in each row
- ✓ ID + Title side-by-side (readable)
- ✓ Virtualization invisible to user

**Unparented task handling:**
- ✓ Tasks without a parent (orphans) correctly surface under "Unparented"
- ✓ Does not crash or hide them

**Dependency IN/OUT display:**
- ✓ Row shows `(1 in, 2 out)` if the task has deps or is depended-on
- ✓ Clicking a row opens DetailDrawer where full dep chain is visible
- ✓ Not rendered inline (would add visual clutter)

**Verdict**: Hierarchy tab is **well-composed and fully functional**. No layout issues here.

---

## 6. Kanban Assessment

### Structure (5 Columns × Epic Sub-groups)

**Columns in order:**
```
[Pending] [Active] [Blocked] [Done] [Cancelled]
```

Each column:
- Header: status icon + name + task count
- Body: collapsible epic groups
- Cards: shared `TaskCard` component (compact=true)

**Epic sub-grouping:**
- Tasks grouped by `topLevelAncestorEpic` (root epic in ancestry chain)
- Orphans go to "No epic" group
- Groups are collapsible (arrow button)

### Responsive Behavior

**Above 1200px viewport:**
- `display: grid; grid-template-columns: repeat(5, minmax(240px, 1fr));`
- Columns size fairly, all 5 visible at once ✓

**1200px – 640px:**
- `display: flex; overflow-x: auto; scroll-snap-type: x proximity;`
- Horizontal scrolling, columns 280px wide ✓

**Below 640px:**
- `flex-direction: column;`
- Stacks vertically, full-width columns ✓

### Density Assessment

**Card density:** Reasonable
- Each card ~40–50px tall
- Collapsible groups prevent overwhelming lists
- Colors (status glyphs) provide quick scans

**Responsive on `/tasks`:** ✓ Confirmed
- Works in the embedded Explorer tab at 1200px max-width container
- Below 1200px, horizontal scroll activates (no squishing)

### Verdict

Kanban component itself is **solid**. The problem is the **container allocation** on `/tasks` — it gets min-height 400px, which is too small for the full Kanban + Graph combo.

---

## 7. Detail Drawer Assessment

### Composition

**Drawer structure:**
```
┌─ DetailDrawer ─────────────────────────┐
│ [✕] Task ID                            │
│ Status [●] Priority [High]             │
│ Title: "..."                           │
│ ────────────────────────────────────── │
│ Dependencies:                          │
│   Upstream (blocked by):               │
│   - T100, T101                         │
│   Downstream (blocks):                 │
│   - T102, T103                         │
│ ────────────────────────────────────── │
│ Parent chain (breadcrumb-style)        │
│ [T50: Epic] › [T75: Feature]          │
│ ────────────────────────────────────── │
│ Notes / Manifest / Commits (scrollable)│
└────────────────────────────────────────┘
```

**Rendering:**
- ✓ Slides in from right (or left, TBD by CSS)
- ✓ Task info at top (ID, status, priority, title)
- ✓ Dependency links are clickable (click to jump to dep)
- ✓ Parent chain breadcrumb is clickable (epic drill-down)
- ✓ Close button (Esc key also works)

**Integration:**
- ✓ Driven by `filters.state.selected`
- ✓ Rendered once globally in `/tasks/+page.svelte` (line 737)
- ✓ Same drawer component shared across Hierarchy / Graph / Kanban tabs

### Assessment

Drawer is **well-composed and not dumped in**. It's a proper slide-out panel with good info hierarchy. ✓

---

## 8. Pipeline Page Visual Distinction

### Comparison: `/tasks/pipeline` vs `/tasks` Kanban

#### Pipeline Page

**Location**: `src/routes/tasks/pipeline/+page.svelte`

**Axis**: `pipeline_stage` (RCASD-IVTR+C stages)

**Layout:**
```css
.pipeline-view { 
  display: flex; flex-direction: column; 
  height: calc(100vh - 8rem); 
}
.kanban-scroll { flex: 1; overflow-x: auto; }
.kanban-board { display: flex; }
.kanban-col { flex: 0 0 ~300px; }
```

**Key visual differences:**
1. **Full viewport height** (100vh - 8rem) vs embedded 400px min-height
2. **No search bar** (pipeline is stage-focused, not query-driven)
3. **Cards show gates** (I/T/Q checkmarks for implementation/testing/QA status)
4. **Keyboard nav** (arrow keys move focus between cols/rows; Enter opens detail)
5. **No Epic grouping** (Pipeline stages cut across epics; cards just list by stage)

#### Tasks Kanban (on `/tasks`)

**Axis**: `status` (pending, active, blocked, done, cancelled)

**Layout:**
- Embedded in `.task-explorer` section
- Max-width 1200px container
- Grid layout (above 1200px)

**Key visual differences:**
1. **Constrained height** (400px min, compressed in context)
2. **Epic sub-grouping** (collapsible epic buckets within each status column)
3. **No keyboard nav** (focus is on filtering + search)
4. **Search integration** (query + status/priority/labels chips above)
5. **Not full-height** (shares viewport with dashboard + graph)

### Distinction Clarity

**Is the distinction clear?** Somewhat, but not obvious
- Both use "Kanban" terminology
- Both use status-like columns (status vs pipeline_stage)
- Pipeline feels "full-featured" (keyboard nav, full-height)
- Tasks Kanban feels "companion feature" (embedded, secondary)

**Spec reference**: `docs/specs/CLEO-TASK-DASHBOARD-SPEC.md` §5.4
- Confirms both tools are intentional
- Kanban = status-first at-a-glance
- Pipeline = stage-scoped release tracking

**Verdict**: Pages are **visually distinct enough** (one full-height, one embedded; different columns). The distinction could be clearer with better naming or visual cues, but it's not a major UX issue.

---

## 9. Sessions + Task-Detail Pages Consistency

### Sessions Page (`/tasks/sessions/+page.svelte`)

**Style**: Timeline-based log
```
[Session 1] ← [active]
│ Name, Duration, Task counts
└─ [+] Expandable details

[Session 2] ← [ended]
│ ...
```

**Consistency with Explorer:**
- Same page header (Dashboard / Pipeline / Sessions nav)
- Separate visual paradigm (timeline, not grid/tree/graph)
- No shared components with Explorer tabs
- Task links navigate to `/tasks/{id}` (detail page)

**Verdict**: Sessions is a **separate feature**, not part of the Explorer. Doesn't need to match Explorer look.

### Task Detail Page (`/tasks/[id]/+page.svelte`)

**Layout**: Full-width task view
```
Breadcrumb (← back to /tasks)
┌─────────────────────────────────────┐
│ Task ID | Status | Priority | Type  │
│ Title                               │
│ ────────────────────────────────────│
│ Left panel:                         │
│  - Parent info + breadcrumb         │
│  - Status/priority/type details     │
│  - Verification gates               │
│                                    │
│ Right panel (or below):             │
│  - Subtasks tree                    │
│  - Dependencies (in/out)            │
│  - Manifest entries                 │
│  - Linked commits                   │
└─────────────────────────────────────┘
```

**Consistency with Explorer:**
- ✓ Same color palette (status badges, priority colors)
- ✓ Same detail drawer content pattern (dependency links, parent chain)
- ✓ Different layout (full-width vs drawer)
- ✓ Task breadcrumb links back to `/tasks` (preserves explorer context)

**Verdict**: Detail page is **consistent with Explorer in substance, different in layout** (which is appropriate for full-screen vs drawer). ✓

---

## 10. API Usage Audit

### Live Endpoints (Used)

1. **`/api/tasks/search`** (line 291, +page.svelte)
   - `GET /api/tasks/search?q=<query>`
   - Returns: `{ kind: 'id' | 'title'; task?: SearchTaskRow[]; total?: number }`
   - Status: **LIVE** (used for search bar auto-complete)

2. **`/api/tasks/events`** (line 396, +page.svelte)
   - `EventSource('/api/tasks/events')`
   - Listens for task changes in real-time (SSE)
   - Status: **LIVE** (used for live indicator + update notifications)

3. **Dashboard stats + Epic Progress + Recent Activity**
   - Server-loaded via `load()` in `+page.server.ts` (no API call, direct DB)
   - Status: **LIVE** (server-side data binding)

4. **Explorer bundle** (Hierarchy / Graph / Kanban)
   - Server-loaded via `loadExplorerBundle()` in `+page.server.ts`
   - Contains: tasks, deps, labels, epicProgress
   - Status: **LIVE** (server-side, one round-trip)

### Dead Endpoints (No Longer Used)

1. **`/tasks/tree`** (old standalone tree view)
   - Status: **DEPRECATED** (T957 adds 301 redirect to `/tasks#hierarchy`)
   - File: Not found in current codebase

2. **`/tasks/graph`** (old standalone graph view)
   - Status: **DEPRECATED** (T957 adds 301 redirect to `/tasks#graph`)
   - File: Not found in current codebase

### Stale Paths (Potentially Outdated)

None detected. The API paths are consistent with the live codebase.

### Path Stability

- **Search**: `GET /api/tasks/search` (no version, stable)
- **Events**: `EventSource /api/tasks/events` (no version, stable)
- **DB endpoints**: All server-side (no REST surface)

**Verdict**: API usage is **clean and minimal**. Two live endpoints (search + SSE), both functioning. Deprecation redirects in place. ✓

---

## Summary of Issues

| Issue | Severity | Root Cause | Location |
|-------|----------|-----------|----------|
| Explorer body too small | **High** | `.explorer-body { min-height: 400px }` | +page.svelte:1346 |
| Graph nodes unreadable | Medium | Dense d3 layout + small nodes (52×22px) | GraphTab.svelte:957–960 |
| Kanban buried below fold | High | Page layout stacks elements vertically | +page.svelte:615–735 |
| No flex-grow on Explorer | High | `.task-explorer` doesn't claim available space | +page.svelte:1266–1274 |
| Dashboard dominates visual hierarchy | Medium | Large stats + Epic Progress cards first | +page.svelte:528–628 |
| Node labels ID-only (not full titles) | Low | Design choice per ref viz; could add tooltips | GraphTab.svelte:989–999 |
| Kanban vs Pipeline distinction unclear | Low | Both labeled "Kanban"; different axes not obvious | /tasks vs /tasks/pipeline |

---

## Evidence References

- **GraphTab.svelte**: `src/lib/components/tasks/GraphTab.svelte` (1188 lines, d3 force + SVG)
- **KanbanTab.svelte**: `src/lib/components/tasks/KanbanTab.svelte` (442 lines, 5-column grid)
- **HierarchyTab.svelte**: `src/lib/components/tasks/HierarchyTab.svelte` (200+ lines, tree + virtualization)
- **+page.svelte**: `src/routes/tasks/+page.svelte` (1348 lines, layout + dashboard)
- **Pipeline ref**: `src/routes/tasks/pipeline/+page.svelte` (full-height, stage-scoped)
- **Viz reference**: `/tmp/task-viz/index.html` (54KB, standalone d3-force graph)
- **Spec**: `docs/specs/CLEO-TASK-DASHBOARD-SPEC.md` (§5.4 Kanban vs Pipeline distinction)

---

## Recommendations

1. **Increase `.explorer-body` min-height** from 400px to 600–700px (or use `flex: 1` on parent)
2. **Add `flex: 1` to `.task-explorer`** so it claims available space
3. **Reduce dashboard prominence** by moving Epic Progress + Recent Activity *below* the Explorer tabs (or side-by-side at narrow widths)
4. **Add SVG `<title>` tooltips to graph nodes** for hover-text readability
5. **Label distinction**: Add subtitle to `/tasks` Kanban tab: "by status" vs `/tasks/pipeline`: "by stage"
6. **Quick-jump navigation**: Add tab buttons or keyboard shortcut (e.g., `g` → Graph, `k` → Kanban) for faster access to buried tabs

---

**Status**: Ready for T991 / T992 design refinement work.
