# CLEO Studio `/tasks` UI/UX Deep Audit

Task: T910 research (merge standalone `/tmp/task-viz/index.html` into Studio without regressing existing features).

Scope: Svelte routes under `packages/studio/src/routes/tasks/**`, shared lib components, API routes under `packages/studio/src/routes/api/tasks/**`, and the root layout.

Every claim below is backed by a `file:line` reference. No assumptions — if a behaviour is not observed in code it is flagged in the Open Questions section.

---

## 0. File inventory

| Path | LOC | Role |
|------|-----|------|
| `packages/studio/src/routes/tasks/+page.svelte` | 1045 | Dashboard (stats, search, Epic Progress, Recent Activity) |
| `packages/studio/src/routes/tasks/+page.server.ts` | 222 | Dashboard loader — stats, recent, epic progress, filters |
| `packages/studio/src/routes/tasks/tree/[epicId]/+page.svelte` | 947 | Collapsible epic → subtask tree with dep side-panel |
| `packages/studio/src/routes/tasks/tree/[epicId]/+page.server.ts` | 216 | Recursive CTE descendant loader + dep-count map |
| `packages/studio/src/routes/tasks/graph/+page.svelte` | 538 | d3-force 2D SVG force-directed graph |
| `packages/studio/src/routes/tasks/graph/+page.server.ts` | 227 | Nodes + parent/blocks/depends edges loader |
| `packages/studio/src/routes/tasks/pipeline/+page.svelte` | 384 | Kanban by `pipeline_stage` (RCASD-IVTR+C) |
| `packages/studio/src/routes/tasks/pipeline/+page.server.ts` | 172 | Column builder with terminal-status resolver |
| `packages/studio/src/routes/tasks/[id]/+page.svelte` | 1436 | Full task detail |
| `packages/studio/src/routes/tasks/[id]/+page.server.ts` | 349 | Task + subtasks + verification + MANIFEST + git |
| `packages/studio/src/routes/tasks/sessions/+page.svelte` | 546 | Work-session history (not a viz tab) |
| `packages/studio/src/lib/components/TaskDepGraph.svelte` | 213 | Mini Sigma.js graph (used inside /tree drawer) |
| `packages/studio/src/lib/server/db/connections.ts` | 159 | `getTasksDb(ctx)` — opens `node:sqlite` per request |
| `packages/studio/src/routes/+layout.svelte` | 147 | Top header with 5 nav links (Brain/Memory/Code/Tasks/Admin) |
| `packages/studio/src/routes/+page.svelte` | 239 | Root portal cards (4 portals), NOT a tasks dashboard |

> Note: there is NO `packages/studio/src/routes/tasks/tree/+page.svelte` — `/tasks/tree` with no epicId 404s. The tree view is only reachable via `/tasks/tree/{epicId}` (from Epic Progress link on the dashboard).

API endpoints under `packages/studio/src/routes/api/tasks/`:

| Path | Role |
|------|------|
| `+server.ts` | List with `status/priority/type/limit` filters |
| `events/+server.ts` | SSE poll of `tasks.updated_at` every 2s |
| `graph/+server.ts` | Epic-subtree or 1-hop neighbourhood graph (sigma-ready) |
| `pipeline/+server.ts` | Columns by pipeline_stage |
| `search/+server.ts` | ID lookup or fuzzy LIKE title/description |
| `sessions/+server.ts` | Session list |
| `[id]/+server.ts` | Single task fetch (45 LOC) |

DB wiring: `getTasksDb(locals.projectCtx)` opens `node:sqlite` fresh per request against `ctx.tasksDbPath` (no cache). See `packages/studio/src/lib/server/db/connections.ts:98-102`.

---

## 1. Page-by-page matrix

### 1A. `/tasks` (Dashboard)

| Extract point | Evidence |
|---|---|
| **Purpose** | Read-only dashboard: live-indicator, search, status/priority/type stat cards, filter toggles, Epic Progress list, Recent Activity list. (`+page.svelte:209-435`) |
| **Layout** | Single centered column, `max-width: 1200px`. Lower two-column grid `.lower-grid { grid-template-columns: 1fr 1fr; }` collapsing to 1fr at <800px. (`+page.svelte:940-948`) |
| **Components used** | None shared. All markup inline. Search debounce/normalize uses `$lib/tasks/search.ts → normalizeSearch()`. (`+page.svelte:7`) |
| **Data shape** | `{ stats: DashboardStats | null, recentTasks: RecentTask[], epicProgress: EpicProgress[], filters: DashboardFilters }`. (`+page.server.ts:23-65`) |
| **Filters / search** | URL-driven `?deferred=1` and `?archived=1` toggle chips. Text search → `/api/tasks/search` (250ms debounce + AbortController). (`+page.server.ts:151-153`, `+page.svelte:57-132`) |
| **Interactive elements** | Search input with clear button, filter chips (toggle URL), clickable epic rows → `/tasks/tree/{id}`, clickable recent-task rows → `/tasks/{id}`, live SSE indicator. (`+page.svelte:186-202, 230-248, 380-407`) |
| **State management** | Svelte 5 runes: `$state`, `$effect` for SSE and search debounce. `toggleUrl()` round-trips filters through URL (SSR-correct). (`+page.svelte:25-34`) |
| **Visual style** | Inline `<style>` scoped block, dark-mode only, accent purple `#a855f7`. No Tailwind. No design-tokens file. (`+page.svelte:438-1045`) |
| **UX to preserve** | Live SSE indicator, 250ms debounced search that navigates on exact ID match, filter chips round-tripping through URL, purple-accented Epic Progress with progress bars. |

**Verification of operator questions:**

- **Epic Progress** exists — `+page.svelte:371-409`, computed server-side at `+page.server.ts:102-145` by `_computeEpicProgress(db, {includeDeferred})`. Direct-children basis per T874.
- **Recent Activity** exists — `+page.svelte:412-434`, last 20 rows by `updated_at DESC`, filter by active/pending/done (+archived if toggled). `+page.server.ts:201-212`.
- **Deferred filter** — `?deferred=1`. NOT backed by a `deferred` status. Instead toggles inclusion of **`status='cancelled'` epics**. The epic filter string is `status NOT IN ('archived','cancelled')` by default, relaxed to `status != 'archived'` when `includeDeferred` is true. The UI labels cancelled-status epics as "deferred" via the `badge-cancelled` chip (`+page.svelte:389-391`). Owner suspicion confirmed: **"deferred" is a UI label for `status='cancelled'` epics**, not a DB field. (`+page.server.ts:109-112`, `+page.svelte:384-391`)
- **Archived filter** — `?archived=1`. Backed by the real `status='archived'` value. When off, recent activity filter is `status IN ('active','pending','done')`; when on, it adds `archived`. A dedicated `stats.archived` count is shown regardless. (`+page.server.ts:201-212`, `+page.svelte:307-310`)

Sub-nav tabs on dashboard: **Dashboard / Pipeline / Graph / Sessions**. **No "Tree" tab** — tree is only reachable per-epic. (`+page.svelte:213-218`)

### 1B. `/tasks/tree/[epicId]`

| Extract point | Evidence |
|---|---|
| **Purpose** | Collapsible hierarchy rooted at a single epic. Shows status, gate icons (I/T/Q), pipeline_stage chip, dep badges. Opens a right side-panel on a dep-badge click with a mini sigma graph + upstream/downstream lists. |
| **Layout** | Two-column flex, tree main + 320px sticky `aside.dep-panel`. Max-width expands to 1400px when panel open. (`+page.svelte:387-405`) |
| **Components used** | `TaskDepGraph` (Sigma.js + graphology) embedded in side-panel. (`+page.svelte:4, 318`) |
| **Data shape** | `{ epic: TreeNode, stats: TreeStats }` where TreeNode has children recursively + `blockedByCount` / `blockingCount`. (`+page.server.ts:9-33`) |
| **Filters / search** | None on this page (scope is the epic's descendants only). |
| **Interactive elements** | Expand/collapse toggle per node, Expand All / Collapse All buttons, keyboard Enter/Space toggles node, dep-badge buttons open side-panel, side-panel close `✕`, "Open full task →" link. (`+page.svelte:41-55, 95-100, 103-157`) |
| **State management** | `collapsed: Set<string>`, `sidePanel: SidePanelData | null`. Side-panel fetches `/api/tasks/graph?taskId=X` + `/api/tasks/{id}/deps` in parallel. (`+page.svelte:14-29, 124-156`) |
| **Visual style** | Same dark theme; gates shown as three tiny squares I/T/Q colored green on pass (`+page.svelte:662-678`). Dep badges: red `↑N` for blockers, amber `↓N` for dependents (`+page.svelte:710-720`). |
| **UX to preserve** | Dep badges with inline counts, side-panel drawer with mini graph, keyboard toggle, gate icons inline, recursive-CTE server compute (handles 500-task cap at `+page.server.ts:133`). |

Tree scope: **ONLY the chosen epic's descendants**. Query uses `WITH RECURSIVE desc AS (… parent_id = ? UNION ALL …) LIMIT 500`. See `+page.server.ts:118-150`. Depth cap 4 at `+page.server.ts:59`.

### 1C. `/tasks/graph`

| Extract point | Evidence |
|---|---|
| **Purpose** | Whole-database relations graph: nodes are tasks, edges are parent (hierarchy), blocks (from `blocked_by`), depends (from `task_dependencies`). Force-directed SVG. |
| **Layout** | Full-width SVG, `viewBox="0 0 1200 700"`. Header + filter chips + legend + tooltip absolutely positioned top-right. (`+page.svelte:139-278`) |
| **Components used** | `d3-force` from `d3` ^7.9.0 (already in Studio deps). NO external graph library. (`+page.svelte:19, 77-109`) |
| **Data shape** | `{ graph: { nodes, edges, filters, counts } }`. Nodes carry `{id, title, type, status, priority, pipelineStage, parentId}`. Edge kind ∈ `parent | blocks | depends`. (`+page.server.ts:22-55`) |
| **Filters / search** | URL-driven `?archived=1` and `?epic=TXXX` (subtree restriction via reverse-index BFS at `+page.server.ts:103-123`). No text search on this page. |
| **Interactive elements** | Hover node → tooltip panel top-right showing id/title/status/priority/stage. Click node → `goto('/tasks/{id}')`. Arrow-key navigation for accessibility. (`+page.svelte:111-113, 228-252`) |
| **State management** | `simNodes`, `simLinks`, `hoverId` as `$state` arrays. d3-force mutates positions; Svelte re-renders on each tick by re-assigning arrays. (`+page.svelte:74-103`) |
| **Visual style** | Epic vs task vs subtask distinguished by **stroke color** (epic=amber `#fbbf24`, subtask=slate `#94a3b8`, task=`#2d3748`) AND **radius** (epic=12, subtask=6, task=8). Fill by status. Edge dash: parent=solid, blocks=dashed `4 4`, depends=dotted `2 3`. (`+page.svelte:39-65`) |
| **UX to preserve** | d3-force in-process layout (no server dep), subtree filter via `?epic`, three edge kinds with dash-pattern differentiation, hover tooltip, keyboard nav. |

**Notable**: sim runs ≤ 300 ticks or 5 seconds then stops (`+page.svelte:106`). Whole-DB graph is heavy on large projects — no virtualization.

### 1D. `/tasks/pipeline`

| Extract point | Evidence |
|---|---|
| **Purpose** | Kanban board by **`pipeline_stage`** (RCASD-IVTR+C), not by `status`. Shows all 11 canonical stages plus `unassigned`. |
| **Layout** | Horizontal scroll flex board, 220px columns, `height: calc(100vh - 8rem)`. (`+page.svelte:89-130, 197-220`) |
| **Components used** | None shared. Inline cards. |
| **Data shape** | `{ columns: PipelineColumn[] }` where each column has `{id, label, count, tasks[]}`. (`+page.server.ts:84-89`) |
| **Filters / search** | None. Hardcoded `WHERE status != 'archived'`. (`+page.server.ts:126`) |
| **Interactive elements** | Arrow-key navigation (Left/Right for column, Up/Down for card), Enter opens `/tasks/{id}`, cards link via `<a href>`. (`+page.svelte:48-64, 100-122`) |
| **State management** | Local `focusedCol`, `focusedRow` `$state` for keyboard navigation. |
| **Visual style** | Columns: research, consensus, architecture_decision (labelled "Design / ADR" per T880), specification, decomposition, implementation, validation, testing, release, done, cancelled, [+ unassigned if any]. Cards show id, status icon, title (2-line clamp), priority, size chip, I/T/Q gate dots. (`+page.server.ts:55-69`) |
| **UX to preserve** | Terminal-status resolver (`resolveColumnId` at `+page.server.ts:97-111` — `status='done'` always wins over `pipeline_stage`), custom labels like "Design / ADR", keyboard navigation, gate dots on cards. |

Conceptually: **this is NOT a kanban-by-status**. It is a kanban-by-RCASD-IVTR+C-stage. The standalone viz tab "Kanban" is a kanban-by-status (pending / in-progress / done / cancelled). They are different views.

---

## 2. Component inventory (shared / reusable)

| Component | Path | Purpose | Props | Used in |
|---|---|---|---|---|
| `TaskDepGraph` | `lib/components/TaskDepGraph.svelte` | Mini Sigma.js + graphology + forceAtlas2 graph of N-hop neighbourhood | `nodes: GraphNode[]`, `edges: GraphEdge[]`, `height?: string` | `/tasks/tree/[epicId]` side-panel only |
| `ProjectSelector` | `lib/components/ProjectSelector.svelte` | Project picker in header | `projects`, `activeProjectId` | Root layout header |
| `BrainGraph`, `LivingBrain*`, `NexusGraph` | `lib/components/*.svelte` | Non-task graphs | — | `/brain`, `/code` pages only |
| `sigma-defaults.ts` | `lib/components/sigma-defaults.ts` | `BASE_SIGMA_SETTINGS` constant | — | `TaskDepGraph.svelte:15` |

Reuse opportunities: **TaskDepGraph is the only reusable task-viz primitive**. The dep/pipeline/tree pages each inline their own markup and styles — there is no shared TaskCard, TaskRow, or StatusBadge component.

Helpers duplicated across pages (candidates for consolidation):

| Helper | Defined in |
|---|---|
| `priorityClass(p)` | `/tasks/+page.svelte:142`, `/tree/+page.svelte:57`, `/graph/+page.svelte` uses inline class names, `/pipeline/+page.svelte:12`, `/[id]/+page.svelte:12` |
| `statusIcon(s)` | Same 4 places |
| `statusClass(s)` | Same 4 places |
| `gatesFromJson(json)` / `gatesPassed(task)` | `/tree/+page.svelte:78`, `/pipeline/+page.svelte:33` |
| `formatTime(iso)` | `/tasks/+page.svelte:168` |

---

## 3. Current gaps vs standalone viz (`/tmp/task-viz/index.html`)

The standalone viz has three tabs in a single-page app. Studio spreads equivalent concepts across routes.

### 3A. Dep Graph tab (viz) vs `/tasks/graph` (Studio)

| Aspect | Viz | Studio `/tasks/graph` | Overlap / Gap |
|---|---|---|---|
| Library | vis-network (UMD from CDN) | d3-force + hand-rolled SVG | Different renderers. Studio bundle is slimmer (no vis-network). |
| Node shape | Epic = **box**, task = **dot**, subtask = small dot | All circles; epic/task/subtask distinguished by **radius + stroke color** | Gap: Studio does not render epics as rectangles — less visually distinct. |
| Edges | Only `task_dependencies` (depends/blocks) | parent + blocks + depends, three dash styles | Studio is richer — shows parent hierarchy AND deps. |
| Blocked styling | Red border + red drop-shadow around blocked nodes | Color by status only; no special "blocked" halo | Gap: Studio does not highlight blocked-by-unfinished-deps. |
| Detail panel | Right-slide 360px aside with: id badge, title, 7-field meta grid, labels pills, Depends on (out) list, Depended on by (in) list, Parent chain list | No embedded detail panel on /graph page; only a transient hover tooltip | **Major gap**: no pinned detail view. Clicking navigates away to `/tasks/{id}` — loses graph context. |
| Search | Header search box with `/` hotkey | No search on /graph page | Gap. |
| Status/priority chip filters | Inline chip groups with multi-select and color dots | Only `?archived=1` toggle and `?epic=TXXX` subtree | Gap — no status/priority filter. |
| Labels filter | Dropdown with per-label counts, multi-select checkboxes | None. Labels not exposed as a filter anywhere | Gap. Labels ARE loaded on `/tasks/{id}` detail (`+page.server.ts:47`) but never as a filter. |
| Keyboard | `/` focus search, `1/2/3` switch tabs, Esc clear search | Tab-based arrow nav on nodes only | Gap — no `/` or tab shortcuts. |
| Stats counter | "X of Y tasks" live in header | "X nodes · P parent · B blocks · D depends" counts, but no total vs visible | Gap — no live filter-count feedback. |
| Graph hint | "Drag pan · Scroll zoom · Click node for detail" hint top-right | None | Minor gap. |
| Empty state | Loading spinner overlay | Empty state message w/ CLI hint | Studio better on empty state. |

### 3B. Hierarchy tab (viz) vs `/tasks/tree/[epicId]` (Studio)

| Aspect | Viz | Studio `/tasks/tree` | Overlap / Gap |
|---|---|---|---|
| Scope | **ALL tasks** globally — shows all roots, including unparented (`__root__` bucket at `viz:1218`) | **ONLY one epic's descendants** — `/tasks/tree/{epicId}` param required. No `/tasks/tree` landing page. | **Major scope gap**: Studio has no global hierarchy view. |
| Unparented tasks | Included under `__root__` in viz | Hidden — no route to see tasks without a parent | **Major gap**: unparented tasks are invisible in Studio. |
| Expand/collapse | Caret toggles + click anywhere on row to go | Caret toggles only; click anywhere on row navigates | Overlap. |
| Dep badges per node | None in viz hierarchy | **↑N / ↓N** badges with counts (`tree:255-278`) | Studio is RICHER here — preserve. |
| Gate icons per node | None in viz | I/T/Q squares (`tree:247-251`) | Studio is richer — preserve. |
| Descendant count | Shown per node (`viz:1255`) | Not shown per node — only overall stats at top | Gap. |
| Search / filter | Status/priority/label chips on the same page | None on tree page | Gap. |
| Side detail panel | Same shared panel as Dep Graph tab | Yes — dep side-panel with mini sigma graph (`tree:300-383`) | Studio has panel — BUT it's triggered by dep-badge clicks only, not by generic node clicks (which navigate away). |

### 3C. Kanban tab (viz) vs `/tasks/pipeline` (Studio)

These are **different concepts**:

| Aspect | Viz Kanban | Studio Pipeline |
|---|---|---|
| Bucketing signal | `status` (+ derived `in-progress` = `pipeline_stage='implementation'`) — `viz:916-925` | `pipeline_stage` directly (11 canonical RCASD-IVTR+C stages) |
| Columns | 4: pending / in-progress / done / cancelled | 11–12: research → release → done → cancelled [+ unassigned] |
| Grouping inside column | Groups by **root parent** with collapsible `kgroup` headers and per-group counts | Flat list sorted by priority then created_at |
| Card content | id, size, type=Epic chip, title (up to 120 chars) | id, status icon, title (2-line clamp), priority, size chip, I/T/Q gate dots |
| Filtering | Status/priority/labels apply | None on pipeline page |
| Keyboard | None on kanban | Arrow keys navigate focus |
| Empty state | "No tasks" per column | "—" per column |

**Finding**: these serve different needs. Viz-Kanban is a workflow inbox; Pipeline is a process-stage flow. Both should survive the merge.

### 3D. Unique-to-viz features Studio lacks

1. **Labels (tags) as filter** — not exposed anywhere in Studio tasks UI
2. **Status chip filter AND priority chip filter** — only on viz
3. **Global text search scoped to current view** — Studio search is dashboard-only and navigates on ID match
4. **Unified right-rail pinned detail** — Studio uses nav to `/tasks/{id}` instead
5. **Keyboard `1/2/3` to switch view** — Studio has no view-switch shortcuts
6. **Pressing `/` focuses search** — Studio has no hotkey
7. **Esc clears search** — Studio has X button, not Esc
8. **Epic rendered as box / rectangle on graph** — Studio uses radius+stroke
9. **"Blocked" visual halo** (red drop-shadow on pending tasks with unfinished upstream deps) — Studio /graph does not compute or show this
10. **Group-by-root-epic inside kanban column** — Pipeline page is flat
11. **Live "X of Y tasks" counter reflecting filter state** — Studio shows raw totals only
12. **Global hierarchy (everything, not scoped to one epic)** — Studio has none

### 3E. Unique-to-Studio features viz lacks

1. **Live SSE task-updated indicator** (`/tasks/+page.svelte:186-202`)
2. **Epic Progress with per-epic done/total progress bars**
3. **Recent Activity feed** (last 20 tasks by updated_at)
4. **Priority breakdown with horizontal bars**
5. **Type breakdown chips (epics/tasks/subtasks)**
6. **Full task detail page** `/tasks/{id}` (1436 LOC — verification gates, MANIFEST, linked git commits, acceptance criteria)
7. **Sessions route** `/tasks/sessions` — work-session history
8. **Pipeline view with RCASD-IVTR+C stages** (fundamentally different from status-kanban)
9. **Dep badges with counts on every tree node**
10. **Gate badges (I/T/Q) rendered on tree AND pipeline cards**
11. **Parent + blocks + depends edges (three kinds) in graph** — viz only shows dependencies
12. **URL-preserved filters** (`?deferred`, `?archived`, `?epic`) — shareable / bookmarkable / SSR-correct

---

## 4. Preservation checklist (MUST survive the merge)

Priority 1 — do not lose under any circumstance:

- [ ] **Epic Progress card** — server-computed direct-children basis, deferred/cancelled toggle, per-epic progress bar (`+page.svelte:371-409`)
- [ ] **Recent Activity feed** — last 20 with `updated_at` formatted (`+page.svelte:412-434`)
- [ ] **Live SSE indicator** — `/api/tasks/events` heartbeat (`+page.svelte:186-202`)
- [ ] **URL-round-tripped filter state** (`?deferred`, `?archived`, `?epic`, `?archived`) — SSR-correct, shareable
- [ ] **Full task detail at `/tasks/{id}`** — all 1436 lines, incl. verification gates, acceptance, MANIFEST, linked commits
- [ ] **Three-kind edges** on graph (parent / blocks / depends) with distinct dash patterns
- [ ] **Dep badges with counts** (↑N / ↓N) on tree nodes
- [ ] **I/T/Q gate icons** on tree rows AND pipeline cards
- [ ] **RCASD-IVTR+C pipeline-stage kanban** — this is the owner's process board, not a duplicate of status-kanban
- [ ] **"Design / ADR" label override** for `architecture_decision` (T880)
- [ ] **Terminal-status column resolver** (`resolveColumnId` — status=done wins over pipeline_stage=research)
- [ ] **Server-side recursive CTE with 500-task cap** on tree
- [ ] **Arrow-key card navigation** on pipeline

Priority 2 — nice to keep:

- [ ] Mini Sigma graph in tree side-panel
- [ ] Stats cards with border-color per status
- [ ] Priority horizontal bars
- [ ] Sessions route
- [ ] Search with 250ms debounce + AbortController + navigate-on-exact-id
- [ ] Graph hover tooltip panel top-right

---

## 5. Open questions for HITL

1. **"Deferred" label semantics** — In Studio, `?deferred=1` toggles **`status='cancelled'` epics**. In the viz, the kanban has a "Cancelled" column too. Is the owner content with calling cancelled-epics "deferred" in the dashboard? The code at `+page.svelte:389-391` renders a `deferred` badge on cancelled-status epics. **Suggested**: rename UI label to "Cancelled" OR keep "Deferred" but document the mapping in a tooltip.
2. **Tree view global root** — Studio has no `/tasks/tree` (only `/tasks/tree/{epicId}`). Viz shows all roots including unparented. **Q**: should the merged hierarchy tab show ALL tasks (matching viz) or keep the epic-scoped view (matching Studio today)? Recommendation below leans ALL-tasks with an epic filter.
3. **Kanban concept clash** — Viz kanban is by-status; Pipeline is by-pipeline_stage. Both are useful. **Q**: should the merged /tasks have BOTH a "Status Board" (new, matching viz) AND keep `/tasks/pipeline` (RCASD stages)? Or collapse into one with a stage-vs-status toggle?
4. **Labels** — Studio does not currently filter by labels anywhere. Viz does. **Q**: adopt label filtering in merged view? Labels ARE stored in tasks.db (seen at `[id]/+page.server.ts:47`).
5. **Graph library choice** — Keep d3-force (current Studio, lighter) or adopt vis-network (viz, richer but CDN + bigger)? d3-force can render epics as rectangles (use `<rect>` instead of `<circle>`) — doable without vis-network.
6. **Unparented tasks** — Viz treats them as roots; Studio hides them. **Q**: should merged hierarchy surface them (owner intent unclear, possibly a data-quality signal worth seeing)?
7. **Detail panel pattern** — Viz uses a pinned right-rail on all 3 tabs. Studio uses navigate-to-`/tasks/{id}`. A pinned panel preserves graph context. **Q**: drawer overlay vs navigate?
8. **Keyboard shortcuts** — Owner liked `1/2/3` `/` `Esc`? Adopting these across Studio is low-risk but changes header semantics.

---

## 6. Merge approach — three options + recommendation

### Option A — "Dashboard eats tabs"

`/tasks` becomes the canonical single-page Task Explorer with 4 tabs:

```
/tasks
  ├── Dashboard (summary: stats, Epic Progress, Recent Activity)  [new default tab]
  ├── Graph    (d3 force OR vis-network — decision pending)
  ├── Hierarchy (all tasks, grouped by epic, unparented surfaced)
  └── Pipeline (RCASD-IVTR+C stage kanban — unchanged)
```

`/tasks/graph`, `/tasks/tree/[id]`, `/tasks/pipeline` all redirect to `/tasks?tab=graph|hierarchy|pipeline`. `/tasks/{id}` remains (full detail).

- **Pro**: one URL, shared search / filter bar, shared detail drawer, matches viz mental model.
- **Con**: big refactor. Four sub-routes get deleted/redirected. Server loaders must combine or gate on `?tab`.
- **Risk**: the existing Dashboard content (stats, Epic Progress, Recent Activity) needs a home — either a 5th "Summary" tab or a sidebar on the other tabs.

### Option B — "Three separate pages adopt viz UX"

Keep URL structure. Each of `/tasks/graph`, `/tasks/tree`, `/tasks/pipeline` adopts the viz patterns: status/priority/label chips, text search, pinned detail drawer, keyboard shortcuts. `/tasks` stays as Dashboard.

- **Pro**: minimal URL changes, incremental migration, preserves bookmarks.
- **Con**: cross-tab state (filters, search) does not persist between routes. Users re-filter on every navigation. Detail drawer duplicated in 3 files.
- **Risk**: duplication drifts over time. Medium effort × 3.

### Option C — "Hybrid: /tasks summary + embedded Task Explorer" (RECOMMENDED)

Top half of `/tasks` keeps Epic Progress + Recent Activity + stat cards + live indicator unchanged. Below those, embed a 3-tab Task Explorer component:

```
/tasks  (one route, one server load combined)
  ├─ [Top panel — unchanged]
  │    Stats · Filter chips · Epic Progress · Recent Activity
  └─ [Task Explorer below]
       Tabs: Hierarchy | Dep Graph | Kanban
       Shared toolbar: search · status · priority · label chips · keyboard shortcuts
       Shared right drawer: pinned task detail (drawer, not navigation)
```

- `/tasks/tree/[epicId]` redirects to `/tasks?tab=hierarchy&epic={id}`
- `/tasks/graph` redirects to `/tasks?tab=graph`
- `/tasks/pipeline` stays as-is — it is the RCASD-IVTR+C board, a different tool. Linked from the top of `/tasks` as a prominent button ("Open Pipeline Board →").
- Sessions stays as-is.

**Why C over A/B:**

- Preserves 100% of Priority-1 features (Epic Progress, Recent Activity, SSE — see §4)
- Brings in 100% of viz UX wins (filters, search, keyboard, pinned drawer, global hierarchy)
- Pipeline stays authoritative — it is conceptually distinct (stage, not status) and the owner's process board
- One fewer page to maintain than Option B
- Incremental: top panel compiles/ships untouched; new Task Explorer component ships as a separate bundle under `lib/components/tasks/`

Hard prerequisites for Option C:

1. Extract `priorityClass`, `statusIcon`, `statusClass`, `gatesFromJson`, `formatTime` into `lib/tasks/format.ts` (currently duplicated 4×).
2. Extract `TaskCard`, `TaskRow`, `StatusBadge`, `GateBadges`, `DepBadges` from inline markup — each will be used in 3 tabs.
3. Add `label` filter support end-to-end: server projection on `/tasks` loader + a `labels` index on tasks.db (or parse `labels` column at read time).
4. Decide graph library — d3-force + `<rect>` for epics is achievable without new deps; keep single-bundle story.
5. Decide drawer interaction: drawer replaces `goto('/tasks/{id}')` in explorer tabs; retain `goto` as a "Open full page" CTA inside the drawer for full detail.

---

## 7. Appendix: quick evidence index

- SSE `/api/tasks/events` — `packages/studio/src/routes/api/tasks/events/+server.ts:1-40`
- Epic Progress compute — `packages/studio/src/routes/tasks/+page.server.ts:102-145`
- Pipeline terminal-resolver — `packages/studio/src/routes/tasks/pipeline/+page.server.ts:97-111`
- Pipeline label override "Design / ADR" — `+page.server.ts:58`
- Graph 3-kind edge builder — `packages/studio/src/routes/tasks/graph/+page.server.ts:130-178`
- Tree recursive CTE — `packages/studio/src/routes/tasks/tree/[epicId]/+page.server.ts:118-150`
- Dep side-panel with Sigma mini graph — `packages/studio/src/routes/tasks/tree/[epicId]/+page.svelte:300-383`
- URL filter round-trip — `packages/studio/src/routes/tasks/+page.svelte:25-34`
- Layout nav items (Brain/Memory/Code/Tasks/Admin) — `packages/studio/src/routes/+layout.svelte:12-18`
- Root `/` (portal cards, NOT a dashboard) — `packages/studio/src/routes/+page.svelte:9-46`
- Viz tab structure — `/tmp/task-viz/index.html:740-764`
- Viz kanbanColumn logic — `/tmp/task-viz/index.html:920-925`
- Viz isBlocked logic — `/tmp/task-viz/index.html:907-914`
- Viz keyboard shortcuts — `/tmp/task-viz/index.html:1510-1518`
- Viz pinDetail — `/tmp/task-viz/index.html:1124-1200`
