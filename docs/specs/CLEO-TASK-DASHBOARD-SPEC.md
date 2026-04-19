# CLEO Studio Task Dashboard Specification

**Version**: 1.1.0
**Status**: **SHIPPED** — v2026.4.97 (2026-04-19)
**Scope**: `packages/studio/src/routes/tasks/**`
**Approach**: Option C hybrid — operator-approved 2026-04-17, shipped 2026-04-19
**Authority pointer**: `docs/specs/CLEO-API-AUTHORITY.md` §2 (row: Studio UI)

This spec defines the `/tasks` surface in Studio after the standalone
`/tmp/task-viz/` proof-of-concept was merged. All design decisions below are
SHIPPED as of v2026.4.97. Design rationale is preserved alongside shipped
reality; see §0 Shipped Matrix for commit traceability.

> **Companion specs**:
> - `docs/specs/CLEO-STUDIO-HTTP-SPEC.md` — HTTP endpoints the UI consumes
> - `docs/specs/CLEO-TASKS-API-SPEC.md` — data contract
> - `docs/specs/CLEO-API-AUTHORITY.md` — authority chain
>
> **Evidence base**:
> - `.cleo/agent-outputs/T910-docs-audit/studio-tasks-ui-audit.md`
> - `.cleo/agent-outputs/T910-docs-audit/studio-tasks-architecture.md`
> - `.cleo/agent-outputs/T910-docs-audit/task-schema-audit.md` (deferred semantics)

---

## 0. Shipped

T949 shipped in v2026.4.97 (merge commit `14e5d0986`, preceded by release
commit `ff984706d`). All 12 children done:

| Task | Subject | Commit |
|------|---------|--------|
| T950 | 8 shared Svelte 5 components | `1e534911d` |
| T951 | URL-state filter store | `5f0da1777` |
| T952 | SSR data loader (`_computeExplorerPayload`) | `de45aba60` |
| T953 | Hierarchy tab | `b0a27f897` |
| T954 | Graph tab (d3-force + ported viz UX) | `4481a8c03` |
| T955 | Kanban tab (status columns + epic sub-grouping) | `13a659390` |
| T956 | `/tasks` hybrid wiring (dashboard + 3-tab Explorer) | `a84aac01a` |
| T957 | 301 redirects from `/tasks/tree` + `/tasks/graph` | `27e7e26b2` |
| T958 | Deferred → Cancelled rename (T910 audit finding) | `708718a08` |
| — | SSR render + dedupe hotfix (GraphTab each_key + filters eager init) | `9d67aa890` |
| T959 | E2E playwright tests | landed on `main` post-release |
| T960 | This spec update | this commit |

Shipped state: `/tasks` is the hybrid page (dashboard on top, 3-tab Task
Explorer below); `/tasks/pipeline` unchanged; `/tasks/tree` and
`/tasks/graph` 301-redirect to `/tasks?view=…`; `/tasks/tree/<id>` stays as
a deep-link target; the Deferred filter chip and CSS class are renamed to
Cancelled while `?deferred=1` still parses via a one-shot-warn shim.

---

## 1. Design Decision: Option C Hybrid

Three merge options were evaluated; the operator approved **Option C** on
2026-04-17.

| Option | Summary | Verdict |
|--------|---------|---------|
| A — Dashboard eats tabs | `/tasks` = single page with 4 tabs (Dashboard/Graph/Hierarchy/Pipeline) | Rejected — buries Epic Progress + Recent Activity |
| B — 3 separate pages adopt viz UX | Keep URLs, add viz polish per page | Rejected — cross-tab state lost on every nav |
| **C — Hybrid (APPROVED)** | `/tasks` keeps dashboard panel + embeds 3-tab Task Explorer below; `/tasks/pipeline` stays; `/tasks/tree` + `/tasks/graph` 301-redirect | **APPROVED** |

Rationale (from
`.cleo/agent-outputs/T910-docs-audit/studio-tasks-ui-audit.md` §6 and
`studio-tasks-architecture.md` §3.1):

- Preserves 100% of Priority-1 features (Epic Progress, Recent Activity, SSE).
- Brings in 100% of viz UX wins (filters, search, keyboard, pinned drawer,
  global hierarchy).
- Pipeline stays separate because RCASD-IVTR+C `pipeline_stage` is a
  lifecycle concept, distinct from kanban-by-`status`.
- Incremental: top panel unchanged; new Explorer ships as a separate
  component bundle.

---

## 2. Route Map (shipped)

```
/                                PORTAL (unchanged)
/tasks                           DASHBOARD + TASK EXPLORER (hybrid) — SHIPPED T956
/tasks/[id]                      DETAIL (unchanged)
/tasks/pipeline                  RCASD-IVTR+C KANBAN (unchanged — by pipeline_stage)
/tasks/sessions                  SESSION HISTORY (unchanged)
/tasks/tree/[epicId]             DEEP-LINK EPIC TREE (unchanged — shareable)

301 REDIRECT (shipped T957 · commit 27e7e26b2 — preserve query params):
/tasks/graph        → /tasks?view=graph                 (preserve ?archived, ?epic)
/tasks/tree         → /tasks?view=hierarchy             (no epicId)
/tasks/tree/<id>    → stays (deep-link); UI surfaces "Open in Explorer →"
                     linking to /tasks?view=hierarchy&epic=<id>
```

Source: merge of
`.cleo/agent-outputs/T910-docs-audit/studio-tasks-ui-audit.md` §6 and
`studio-tasks-architecture.md` §3.1, operator-approved and shipped
2026-04-19 in v2026.4.97.

---

## 3. `/tasks` Page Anatomy (Hybrid)

```
┌────────────────────────────────────────────────────────────────────────┐
│ Header: project selector · live-SSE dot · search box                   │
├────────────────────────────────────────────────────────────────────────┤
│ TOP PANEL — Dashboard (PRESERVED verbatim)                             │
│                                                                        │
│   [Stats row] [Priority bars] [Type chips] [Filter chips]              │
│                                                                        │
│   ┌─────────────────────────────┐  ┌─────────────────────────────┐     │
│   │ Epic Progress               │  │ Recent Activity             │     │
│   │ (direct-children per T874)  │  │ (last 20 by updated_at)     │     │
│   └─────────────────────────────┘  └─────────────────────────────┘     │
├────────────────────────────────────────────────────────────────────────┤
│ BOTTOM PANEL — Task Explorer (NEW, 3 tabs)                             │
│                                                                        │
│   [Tab bar: Hierarchy | Graph | Kanban]                                │
│   [Shared toolbar: search · status chips · priority chips · labels ·   │
│    archived toggle · epic dropdown · keyboard help]                    │
│                                                                        │
│   ┌─────────────────────────────────────┐  ┌──────────────────┐        │
│   │ Active tab view                     │  │ Detail Drawer    │        │
│   │ (Hierarchy / Graph / Kanban)        │  │ (pinned, 360px,  │        │
│   │                                     │  │ closable)        │        │
│   └─────────────────────────────────────┘  └──────────────────┘        │
└────────────────────────────────────────────────────────────────────────┘

Prominent button: [Open Pipeline Board →]  (links to /tasks/pipeline)
```

---

## 4. Top Panel — Dashboard (PRESERVED)

The top panel MUST be preserved VERBATIM from
`packages/studio/src/routes/tasks/+page.svelte:209-434`. Preservation is
enforced via:

- Unit tests asserting the presence of `.epic-progress` and
  `.recent-activity` regions.
- Snapshot tests for the Epic Progress row order and progress-bar layout.

### 4.1 Live SSE indicator

Source: `packages/studio/src/routes/tasks/+page.svelte:186-202`.
Subscribes to `GET /api/tasks/events` (SSE,
`packages/studio/src/routes/api/tasks/events/+server.ts`).

**MUST NOT regress:**

- 2-second poll cadence.
- Green dot when connected; "updated Xm ago" relative timestamp.
- Heartbeat when idle.

### 4.2 Stat cards + priority bars + type chips

Source: `+page.svelte:260-340`. Stats = `{ total, active, pending, done,
cancelled, archived }` with per-status border color. Priority breakdown
rendered as horizontal bars. Type chips show epic/task/subtask counts.

### 4.3 Filter chips

Source: `+page.svelte:348-368`. URL-round-tripped:

- `?archived=1` — include `status = 'archived'` rows
- `?deferred=1` — deprecated label; see §10

Filter chips use `<a href>` links with `data-sveltekit-noscroll` for
SSR-correct state.

### 4.4 Epic Progress panel

Source: server compute at
`packages/studio/src/routes/tasks/+page.server.ts:102-145`
(`_computeEpicProgress(db, {includeDeferred})`), UI at
`+page.svelte:371-409`.

**MUST NOT regress:**

- **Direct-children basis** per T874 (not recursive descendant counting).
- Per-epic progress bar shows `done/total` on direct children only.
- Row click → `/tasks/tree/{epic.id}` (keeps existing deep-link target).
- Toggle between "hide cancelled" (default) and "show cancelled" via
  `?deferred=1`.

### 4.5 Recent Activity panel

Source: `+page.server.ts:204-212` and `+page.svelte:412-434`. Shows last
20 non-archived tasks by `updated_at DESC` with `formatTime()` relative
display.

**MUST NOT regress:**

- Row click → `/tasks/{id}` (full detail page).
- Archive toggle shown separately from cancellation toggle.

---

## 5. Bottom Panel — Task Explorer (NEW)

Three tabs under ONE shared toolbar + ONE shared detail drawer. Switching
tabs does NOT re-query the server; the same payload projects into each view.

### 5.1 Shared toolbar

Above the tab content, below the tab bar:

| Control | Purpose | URL param |
|---------|---------|-----------|
| Search box | ID exact match navigates to `/tasks/{id}`; otherwise client-side title filter | `?q=` |
| Status chips (multi-select) | Pending / Active / Blocked / Done / Cancelled | `?status=a,b,c` (CSV) |
| Priority chips (multi-select) | Critical / High / Medium / Low | `?priority=a,b,c` (CSV) |
| Labels dropdown (multi-select) | Tag filter (discovered from `tasks.label.list`) | `?labels=a,b,c` (CSV) |
| Archived toggle | Include `status = 'archived'` rows | `?archived=1` |
| Epic dropdown | Restrict to epic's subtree | `?epic=T###` |
| Keyboard-help button | Opens modal with shortcut list (§7) | — |

CSV params match the existing `/api/tasks` convention (`+server.ts:46-58`).
Repeated-params form is rejected.

### 5.2 Tab 1 — Hierarchy

**Scope**: global tree across all epics, with optional `?epic=` filter.

Derived from both:
- `/tasks/tree/[epicId]/+page.svelte` (per-epic collapsible tree, recursive
  CTE loader at `tree/[epicId]/+page.server.ts:118-150`).
- Viz global tree (see
  `.cleo/agent-outputs/T910-docs-audit/studio-tasks-ui-audit.md` §3B).

**MUST preserve** (from Studio):
- Expand / collapse per node (caret toggle, keyboard Enter/Space).
- Expand All / Collapse All buttons.
- Dep badges `↑N` (red, blockers) and `↓N` (amber, dependents) per node.
- Gate icons I/T/Q per row (from `gatesFromJson()`, rendered green on pass).
- Parent-order sort within siblings.

**MUST add** (from viz):
- Unparented tasks surfaced under a root bucket labelled "Unparented".
- Virtualization when visible set exceeds 1000 nodes.
- Descendant count per node (inline).

**Epic-scoped drill-down**:
- `?epic=T###` restricts to that epic's descendants.
- When `?epic=` is set, a breadcrumb shows "All > Epic T###" with a
  back-link clearing the param.
- Deep-link URL `/tasks/tree/[epicId]` continues to work and is equivalent
  to `/tasks?view=hierarchy&epic=<id>` (the redirect preserves
  bookmarkability).

### 5.3 Tab 2 — Graph

**Engine**: KEEP Studio's current d3-force renderer from
`packages/studio/src/routes/tasks/graph/+page.svelte:77-256`. Do NOT switch
to vis-network (per operator decision — adapted from HITL Q4 recommendation).

**MUST preserve** (from Studio):
- **Three edge kinds** with distinct dash styles:
  - `parent` — solid
  - `blocks` — dashed `4 4`
  - `depends` — dotted `2 3`
- Epic vs task vs subtask distinguished by stroke color AND radius.
- Subtree filter via `?epic=T###` (reverse-index BFS at
  `graph/+page.server.ts:103-123`).
- Fill color by status (same palette as other views).
- Hover tooltip panel (top-right).
- Keyboard arrow-key navigation on nodes.

**MUST add** (from viz, ported onto d3-force):
- **Pinned detail drawer** (shared with other tabs — see §5.5) replaces
  `goto('/tasks/{id}')` on click. Full-page nav still reachable via a
  button inside the drawer.
- **Search and filter** — shared toolbar applies live.
- **"Blocked" halo** — pending tasks with at least one unfinished upstream
  dep get a red drop-shadow. Logic: `status IN ('pending','active','blocked')
  AND EXISTS (upstream where status NOT IN ('done','archived'))`. Computed
  client-side from the already-loaded `edges` array.
- **Live counter** "X of Y tasks" reflecting filter state, in the header.
- **Epic nodes rendered as rounded rectangles** (`<rect>`) instead of
  circles — achievable without adding vis-network.

### 5.4 Tab 3 — Kanban (by `status`)

**Axis**: `status` — explicitly different from `/tasks/pipeline`, which
uses `pipeline_stage`.

Columns (5): `pending | active | blocked | done | cancelled`.

Inside each column, tasks are grouped by **top-level ancestor epic** with
collapsible group headers. This matches the viz Kanban behaviour
(`/tmp/task-viz/index.html:920-925`) and differs from Studio Pipeline
(flat list).

Card content (same as Pipeline cards):
- ID badge
- Status icon + title (2-line clamp)
- Priority chip · size chip
- I/T/Q gate dots

Keyboard navigation (same as Pipeline):
- Arrow Left/Right — switch column
- Arrow Up/Down — switch card in column
- Enter — open detail drawer (not full page — §5.5)

### 5.5 Shared detail drawer

Port viz drawer at `/tmp/task-viz/index.html:330-459` into
`packages/studio/src/lib/components/tasks/TaskDetailDrawer.svelte`.

**Anatomy** (evidence: viz file cited above):

```
┌──────────────────────────────────────────────┐
│ [T123]  [× close]                            │
│ Title here (wraps)                           │
│ ┌────────────────────────────────────────┐   │
│ │ Status    │ Priority                   │   │
│ │ Type      │ Size                       │   │
│ │ Parent    │ Labels                     │   │
│ │ Pipeline  │ Updated                    │   │
│ └────────────────────────────────────────┘   │
│ Acceptance criteria (bullets)                │
│ ───────────────────────────────              │
│ Depends on (↑N)                              │
│   T12 · T45 · …                              │
│ Depended on by (↓N)                          │
│   T98 · T120 · …                             │
│ Parent chain                                 │
│   Epic T-X → Task T-Y → this                 │
│ ───────────────────────────────              │
│ [Open full page →]   [Start working]         │
└──────────────────────────────────────────────┘
```

**Behaviour**:
- Opens on node click (graph), row click (hierarchy), card click (kanban).
- Pinned; navigation inside the drawer (clicking a dep) REPINS the drawer,
  does NOT navigate the page.
- `Esc` closes.
- URL-synced via `?selected=T###` for deep-linking.
- **"Open full page →"** button navigates to `/tasks/{id}` for the full
  detail page — preserves existing behaviour as opt-in.

**Data source**: existing `/api/tasks/[id]` and `/api/tasks/[id]/deps`.
No new endpoint needed.

### 5.6 Shared state management

Per Svelte 5 runes, no stores:

- `activeView: 'hierarchy' | 'graph' | 'kanban'` — `$derived` from
  `$page.url` + `?view=`. Default: `hierarchy`.
- `filters: ExplorerFilters` — parsed from URL on load.
- `selectedId: string | null` — drives the drawer. Synced to `?selected=`.
- `collapsedIds: Set<string>` — hierarchy only, persists to
  `sessionStorage`, NOT URL.
- `hoverId: string | null` — graph only, ephemeral.

Empty stores directory (`packages/studio/src/lib/stores/`) stays empty.

### 5.7 Server load (single query per request)

`/tasks/+page.server.ts` (extended):

1. Load dashboard data as today: stats, Epic Progress, Recent Activity.
2. Additionally load explorer payload via new `_computeExplorerPayload(db,
   filters)` helper:
   - Nodes (all non-archived by default, +archived if toggled)
   - Edges (parent + depends + blocks kinds)
   - Counts (for live "X of Y" header)
3. Return combined payload; tabs project client-side without re-query.

Per
`.cleo/agent-outputs/T910-docs-audit/studio-tasks-architecture.md` §3.2,
this avoids 3 duplicate queries.

---

## 6. Shared Components to Build

All under `packages/studio/src/lib/components/tasks/` (new namespace):

| Component | Replaces | Source |
|-----------|----------|--------|
| `TaskFilterBar.svelte` | Inline `.filter-chip` CSS duplicated in `+page.svelte` and `graph/+page.svelte` | Unify |
| `TaskCard.svelte` | Inline card markup in 4 places | Extract |
| `StatusBadge.svelte`, `PriorityBadge.svelte`, `GateBadges.svelte`, `DepBadges.svelte` | `statusIcon()`, `statusClass()`, `priorityClass()`, `gatesFromJson()` duplicated 4× | Consolidate |
| `TaskDetailDrawer.svelte` | `goto('/tasks/{id}')` in 3 tabs | Port from viz |
| `DependencyGraph.svelte` | Inline d3-force code in `graph/+page.svelte` | Extract |
| `HierarchyTree.svelte` | Inline tree code in `tree/[epicId]/+page.svelte` | Extract |
| `StatusKanban.svelte` | NEW (no source) | New — kanban by status |
| `EpicProgressCard.svelte` | Inline in `+page.svelte:371-410` | Extract |
| `LiveIndicator.svelte` | Inline in `+page.svelte:183-202` | Extract |
| `TasksNav.svelte` | `.tasks-nav` + `.nav-tab` duplicated in 3 pages | Extract |

Shared helpers at `packages/studio/src/lib/tasks/format.ts`:

- `priorityClass(p)`, `statusIcon(s)`, `statusClass(s)`, `gatesFromJson(json)`,
  `gatesPassed(task)`, `formatTime(iso)`, `progressPct(done, total)`

Sources: duplicated across 4 files today (
`+page.svelte:142-181`,
`pipeline/+page.svelte:12-31`,
`graph/+page.svelte:39-65`,
`tree/[epicId]/+page.svelte:57-76`
).

---

## 7. Keyboard Shortcuts

Shared across the Task Explorer (NOT the top dashboard panel):

| Key | Action |
|-----|--------|
| `/` | Focus search box |
| `Esc` | Clear search, or close detail drawer if open |
| `1` | Switch to Hierarchy tab |
| `2` | Switch to Graph tab |
| `3` | Switch to Kanban tab |
| `?` | Open keyboard-help modal |
| `↑ / ↓ / ← / →` | Tab-specific navigation (see §5.2, §5.3, §5.4) |
| `Enter` | Open detail drawer for focused node/row/card |
| `Space` | Toggle expand/collapse (hierarchy only) |
| `Ctrl/Cmd + K` | Global search palette — deferred follow-up (see §12 Q5) |

Source: viz baseline
(`/tmp/task-viz/index.html:1510-1518`).

---

## 8. URL Contract

One URL, full state:

```
/tasks
  ?view=hierarchy|graph|kanban
  &q=<search>
  &status=pending,active,blocked,done,cancelled
  &priority=critical,high,medium,low
  &labels=<csv>
  &epic=T###
  &archived=1
  &selected=T###
  # legacy preserved:
  &deferred=1            (Studio UI synonym — see §10)
```

**Shareable / bookmarkable**: yes. Server load reads the URL and pre-filters
the initial payload. The UI hydrates with the same state.

Redirect rules (301, preserve query string):

- `/tasks/graph?X` → `/tasks?view=graph&X`
- `/tasks/tree` → `/tasks?view=hierarchy`
- `/tasks/tree/<id>?X` → stays (deep-link), but with prominent
  "Open in Explorer →" link → `/tasks?view=hierarchy&epic=<id>&X`

---

## 9. Preservation Checklist (SHIPPED)

Every item below SHIPPED in v2026.4.97. The checklist is retained as
verified ship evidence; boxes are checked to reflect merged state.

### Priority 1 — non-negotiable (SHIPPED)

- [x] **Epic Progress panel** (direct-children per T874, cancelled toggle,
  per-epic progress bar). Source:
  `packages/studio/src/routes/tasks/+page.svelte`. Ship: T956 `a84aac01a`.
- [x] **Recent Activity feed** (last 20 by `updated_at`, `formatTime()`).
  Ship: T956 `a84aac01a`.
- [x] **Live SSE indicator** (2s poll, heartbeat) + `/api/tasks/events`.
  Ship: T956 `a84aac01a`.
- [x] **URL-round-tripped filter state** (`?deferred`/`?cancelled`,
  `?archived`, `?epic`). SSR-correct, shareable. Ship: T951 `5f0da1777`.
- [x] **Full task detail page** `/tasks/[id]` — unchanged.
- [x] **Three-kind edges in graph** (parent / blocks / depends). Ship: T954
  `4481a8c03`.
- [x] **Dep badges with counts** `↑N / ↓N` on hierarchy nodes. Ship: T950
  `1e534911d` (DepBadges.svelte) + T953 `b0a27f897`.
- [x] **I/T/Q gate icons** on hierarchy AND kanban cards. Ship: T950
  `1e534911d` (GateBadges.svelte) + T955 `13a659390`.
- [x] **RCASD-IVTR+C Pipeline Board at `/tasks/pipeline`** — unchanged.
- [x] **"Design / ADR" label override** for `architecture_decision` (T880)
  — unchanged.
- [x] **Terminal-status column resolver** (`status = 'done'` wins over
  `pipeline_stage = 'research'`) — unchanged.
- [x] **Server-side recursive CTE with 500-task cap** on hierarchy —
  unchanged; `_computeExplorerPayload` layers above. Ship: T952 `de45aba60`.
- [x] **Arrow-key card navigation** on pipeline kanban — unchanged.
- [x] **Epic Progress rows link to `/tasks/tree/{id}`** — unchanged deep-link.

### Priority 2 — nice to keep (SHIPPED)

- [x] Mini Sigma graph in tree side-panel (`/tasks/tree/[epicId]` view).
- [x] Stats cards with border-color per status.
- [x] Priority horizontal bars.
- [x] `/tasks/sessions` route — unchanged.
- [x] Search with 250ms debounce + AbortController + navigate-on-exact-id.
  Ship: T951 `5f0da1777`.
- [x] Graph hover tooltip panel. Ship: T954 `4481a8c03`.

### Priority 3 — new features from viz (SHIPPED)

- [x] **Pinned detail drawer** (replaces full-page nav on Explorer tabs).
  Ship: T950 `1e534911d` (TaskDetailDrawer.svelte).
- [x] **Labels filter** end-to-end. Ship: T951 `5f0da1777` + T952 `de45aba60`.
- [x] **Status + priority chip multi-select**. Ship: T950 `1e534911d`
  (TaskFilterBar.svelte).
- [x] **Global hierarchy view** (all tasks, not epic-scoped). Ship: T953
  `b0a27f897`.
- [x] **Blocked halo** on graph. Ship: T954 `4481a8c03`.
- [x] **Live "X of Y tasks" counter** in header. Ship: T956 `a84aac01a`.
- [x] **Keyboard shortcuts** (§7). Ship: T950 + T953 + T954 + T955.
- [x] **Status-kanban tab** (distinct from pipeline-kanban). Ship: T955
  `13a659390`.
- [x] **Unparented tasks surfaced** in global hierarchy. Ship: T953 `b0a27f897`.
- [x] **Epic nodes as rounded rectangles** on graph. Ship: T954 `4481a8c03`.

---

## 10. Deferred Label — Rename (SHIPPED T958 · `708718a08`)

Per `docs/specs/CLEO-TASKS-API-SPEC.md` §4 and the evidence at
`.cleo/agent-outputs/T910-docs-audit/task-schema-audit.md`:

- `deferred` is NOT a status, column, enum, or migration artifact.
- It is a Studio-UI-only synonym for `status = 'cancelled'` applied to
  `type = 'epic'`, toggled by `?deferred=1`.

**Shipped in T958** (`708718a08`):

- UI text change: filter chip label "Show deferred epics" → **"Show
  cancelled epics"**.
- Tooltip: "Include cancelled epics in the Epic Progress panel." (drop
  "deferred").
- CSS class rename: `.epic-deferred` → `.epic-cancelled`.

**Unchanged** (backward compatibility — shipped):

- URL query param `?deferred=1` still parses (aliased to the cancelled
  filter) via a one-shot-warn shim.
- Existing bookmarks continue to work.
- Server-side log records both names during the deprecation window.

**Deprecation window**: one release cycle. In the following release, the URL
param MAY be renamed to `?cancelled=1`, with a redirect from the old name.

Filed as `@HITL` Q1 in `CLEO-TASKS-API-SPEC.md` §11 — operator approved
2026-04-17; shipped 2026-04-19.

---

## 11. Accessibility

Task Explorer MUST meet:

- **Keyboard-navigable** per §7 — no mouse required for any Priority-1
  action.
- **Screen reader compatible**: every icon pairs with a
  `title` / `aria-label`; tab order follows visual order; detail drawer is
  announced as a dialog when opened.
- **High contrast**: the dark palette (bg `#0f1117` / text `#f1f5f9`) meets
  WCAG AA for normal text. Chip colours tested against WebAIM contrast checker.
- **No motion for reduced-motion preference**: graph `viewBox` still
  animates on layout change, but the animation duration is `0ms` when
  `prefers-reduced-motion: reduce`.

Verification: add a single axe-core smoke test for `/tasks` covering the
top panel and each Explorer tab.

---

## 12. UX Questions — Resolved at Ship (v2026.4.97)

All `@HITL` items surfaced in the audits were resolved prior to merge.
Recorded here for decision traceability; originals preserved in
`.cleo/agent-outputs/T910-docs-audit/`.

- **Q1 — Detail drawer vs full-page nav default.** RESOLVED: drawer-first.
  Primary click opens the pinned drawer; the drawer includes an "Open full
  page →" button that navigates to `/tasks/{id}`. Shipped in T950
  (`1e534911d`, `TaskDetailDrawer.svelte`).
- **Q2 — Virtualization threshold.** RESOLVED: 1000 nodes. Hierarchy tab
  virtualizes when the visible set exceeds 1000. Shipped in T953
  (`b0a27f897`).
- **Q3 — Labels in the graph tab.** RESOLVED: dropdown filter only. No
  label pills rendered on graph nodes (kept readable). Shipped in T954
  (`4481a8c03`).
- **Q4 — Sessions in Explorer.** RESOLVED: stay at `/tasks/sessions`. Not
  added as a 4th Explorer tab.
- **Q5 — Global search palette (`Ctrl/Cmd+K`).** DEFERRED — not in T949
  scope. Tracked as a follow-up initiative.
- **Q6 — Unparented task policy.** RESOLVED: surface under an "Unparented"
  root bucket in Hierarchy (data-quality signal worth seeing). Shipped in
  T953 (`b0a27f897`).
- **Q7 — vis-network revisit.** DEFERRED. d3-force with `<rect>` epic nodes
  was sufficient; vis-network switch not needed. Revisit only if operators
  request richer graph UX (pinning, annotation) post-ship.

---

## 12A. Lessons Learned (ship-time surprises)

Captured from commit `9d67aa890` (SSR render + dedupe hotfix) and the
Svelte 5 rune-module migration surfaced during the T955/T956 merge.

- **GraphTab `{#each simNodes as n (n.id)}` needed dedupe.** ExplorerBundle
  can yield duplicate `id` values at boundary conditions (e.g. a task that
  is both parent-resolved and depends-resolved through the same hop).
  Svelte 5's `each_key_duplicate` check is strict; the each-key uniqueness
  invariant was silently assumed. Fix landed in `9d67aa890`: dedupe by
  `Map<id, node>` before projection into d3-force.
- **`{#if filters}` guard with `filters` only set in `$effect` meant zero
  SSR render for the Explorer.** The Task Explorer initially mounted no
  content during SSR because `filters` was populated lazily by an effect
  that never runs on the server. Fix: (a) move filter initialization to an
  eager `$state` value derived from `url.searchParams`, so SSR gets the
  tabs; (b) make the filter store SSR-safe by skipping `popstate` subscription
  and `history.replaceState` when `window` is undefined.
- **Svelte 5 runes in `.ts` modules require the `.svelte.ts` suffix** plus
  the vitest svelte plugin configured for that extension. Hit during T951
  when the filter store was first written as `filters.ts`; renamed to
  `filters.svelte.ts` to get rune support.

---

## 13. Migration Plan — Execution Record

Per
`.cleo/agent-outputs/T910-docs-audit/studio-tasks-architecture.md` §3.
All steps SHIPPED in v2026.4.97.

1. [x] **Shared helpers** at `lib/tasks/format.ts`. Ship: T950 `1e534911d`.
2. [x] **Extract existing components** (`EpicProgressCard`,
   `RecentActivityFeed`, `LiveIndicator`) under `lib/components/tasks/`.
   Ship: T950 `1e534911d`.
3. [x] **Build new components** (`TaskFilterBar`, `TaskDetailDrawer`,
   `DependencyGraph`, `HierarchyTree`, `StatusKanban`, `TaskCard`,
   `StatusBadge`, `PriorityBadge`, `GateBadges`, `DepBadges`, `TasksNav`).
   Ship: T950 `1e534911d` (8 shared Svelte 5 components).
4. [x] **`_computeExplorerPayload(db, filters)`** in `+page.server.ts`.
   Ship: T952 `de45aba60`.
5. [x] **Wire Explorer into `+page.svelte`** below the dashboard panel.
   Ship: T956 `a84aac01a`.
6. [x] **Redirects** (`/tasks/graph` → `/tasks?view=graph`, `/tasks/tree` →
   `/tasks?view=hierarchy`). Ship: T957 `27e7e26b2`.
7. [x] **Filter label** per §10 (Deferred → Cancelled). Ship: T958
   `708718a08`.
8. [x] **axe-core smoke test** per §11. Ship: T959 (e2e playwright +
   accessibility smoke).
9. [x] **Preservation-checklist tests** covering every item in §9. Ship:
   T959.
10. [x] **Companion spec updates** (`CLEO-STUDIO-HTTP-SPEC.md` for
    `/api/tasks/label.list`). Ship: T962.

---

## References

### Studio code
- `packages/studio/src/routes/tasks/+page.svelte` (1045 LoC)
- `packages/studio/src/routes/tasks/+page.server.ts` (222 LoC)
- `packages/studio/src/routes/tasks/tree/[epicId]/+page.svelte` (947 LoC)
- `packages/studio/src/routes/tasks/tree/[epicId]/+page.server.ts` (216 LoC)
- `packages/studio/src/routes/tasks/graph/+page.svelte` (538 LoC)
- `packages/studio/src/routes/tasks/graph/+page.server.ts` (227 LoC)
- `packages/studio/src/routes/tasks/pipeline/+page.svelte` (384 LoC)
- `packages/studio/src/routes/tasks/pipeline/+page.server.ts` (172 LoC)
- `packages/studio/src/routes/tasks/[id]/+page.svelte` (1436 LoC)
- `packages/studio/src/lib/components/TaskDepGraph.svelte` (213 LoC)
- `packages/studio/src/hooks.server.ts`
- `packages/studio/src/lib/server/db/connections.ts`

### API contracts
- `packages/studio/src/routes/api/tasks/events/+server.ts` (SSE producer)
- `packages/studio/src/routes/api/tasks/+server.ts` (list)
- `packages/studio/src/routes/api/tasks/graph/+server.ts`
- `packages/studio/src/routes/api/tasks/[id]/+server.ts`

### Viz baseline
- `/tmp/task-viz/index.html` — proof-of-concept
- `/tmp/task-viz/CRUD-API-AUDIT.md`
- `/tmp/task-viz/CRUD-ARCHITECTURE-CORRECTED.md`

### Companion specs
- `docs/specs/CLEO-API-AUTHORITY.md`
- `docs/specs/CLEO-TASKS-API-SPEC.md`
- `docs/specs/CLEO-STUDIO-HTTP-SPEC.md`

### Audit evidence
- `.cleo/agent-outputs/T910-docs-audit/studio-tasks-ui-audit.md`
- `.cleo/agent-outputs/T910-docs-audit/studio-tasks-architecture.md`
- `.cleo/agent-outputs/T910-docs-audit/task-schema-audit.md`
- `.cleo/agent-outputs/T910-docs-audit/http-endpoint-inventory.md`

### Related ADRs
- `.cleo/adrs/ADR-051-programmatic-gate-integrity.md`
- `docs/adr/ADR-052-sdk-consolidation.md`
- `docs/adr/ADR-053-playbook-runtime.md`

---

**End.**
