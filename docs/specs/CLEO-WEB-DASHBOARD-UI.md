# CLEO Web Dashboard - UI/UX Specification

**Epic**: T4284 (CLEO Nexus Command Center WebUI)
**Version**: 1.0.0
**Status**: Active Specification
**Last Updated**: 2026-02-12

**Companion Document**: [CLEO-WEB-DASHBOARD-SPEC.md](./CLEO-WEB-DASHBOARD-SPEC.md) -- Architecture, API, data sources

---

## 1. Design Philosophy

### 1.1 Identity

CLEO is a developer tool. The dashboard should feel like a well-built IDE panel -- information-dense, keyboard-navigable, and zero-friction. It is not a marketing site. Every pixel should serve a purpose.

### 1.2 Aesthetic: Technical Terminal Meets Modern Dashboard

The visual style combines the clarity of a terminal with the usability of a modern dashboard:

- **Monospace data** -- Task IDs, versions, timestamps, and code references use monospace fonts
- **Dense information** -- No hero sections or excessive whitespace. Data comes first.
- **High contrast** -- Clear visual hierarchy. Status and priority are immediately scannable.
- **Dark-first** -- Dark theme by default. Developers work in dark mode.
- **Retro-modern** -- Pixel-sharp edges, subtle glow effects on active elements, terminal-inspired color palette with modern layout

### 1.3 Inspiration

- 8bitcn component library (pixel aesthetic, high contrast)
- GitHub's project boards (dense task data)
- Grafana dashboards (metrics and charts done right)
- Linear (clean task management, fast keyboard navigation)
- Vercel's dashboard (status indicators, minimal chrome)

---

## 2. Color System

### 2.1 Core Palette (Dark Theme)

```
Background Levels:
  --bg-base:      #0a0e17    Deep navy-black (page background)
  --bg-surface:   #111827    Slate-900 (cards, panels)
  --bg-elevated:  #1e293b    Slate-800 (hover states, dropdowns)
  --bg-overlay:   #334155    Slate-700 (modals, tooltips)

Text:
  --text-primary:   #f1f5f9  Slate-100 (headings, important)
  --text-secondary: #94a3b8  Slate-400 (body text)
  --text-muted:     #64748b  Slate-500 (timestamps, metadata)
  --text-disabled:  #475569  Slate-600

Borders:
  --border-default: #1e293b  Slate-800
  --border-subtle:  #334155  Slate-700
  --border-focus:   #38bdf8  Sky-400 (focus rings)
```

### 2.2 Semantic Colors

```
Task Status:
  --status-pending:   #6b7280  Gray-500     (circle outline)
  --status-active:    #22d3ee  Cyan-400     (pulsing dot)
  --status-blocked:   #f87171  Red-400      (solid red)
  --status-done:      #4ade80  Green-400    (checkmark)

Priority:
  --priority-critical: #ef4444  Red-500     (flashing border)
  --priority-high:     #f97316  Orange-500  (solid dot)
  --priority-medium:   #3b82f6  Blue-500   (solid dot)
  --priority-low:      #6b7280  Gray-500   (hollow dot)

Phases:
  --phase-setup:       #a78bfa  Violet-400
  --phase-core:        #22d3ee  Cyan-400
  --phase-testing:     #fbbf24  Amber-400
  --phase-polish:      #34d399  Emerald-400
  --phase-maintenance: #94a3b8  Slate-400

Accent:
  --accent-primary:    #22d3ee  Cyan-400   (links, active nav)
  --accent-success:    #4ade80  Green-400
  --accent-warning:    #fbbf24  Amber-400
  --accent-danger:     #f87171  Red-400
  --accent-info:       #60a5fa  Blue-400
```

### 2.3 Light Theme (Phase 2+)

Invert the background scale. Keep semantic colors. Reduce saturation slightly for readability.

```
  --bg-base:      #f8fafc
  --bg-surface:   #ffffff
  --bg-elevated:  #f1f5f9
  --text-primary: #0f172a
  --text-secondary: #475569
```

---

## 3. Typography

```
Font Stack:
  --font-display:  'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace
  --font-body:     'Inter', -apple-system, BlinkMacSystemFont, sans-serif
  --font-mono:     'JetBrains Mono', 'Fira Code', monospace

Scale:
  --text-xs:    0.75rem / 1rem      (12px -- timestamps, badges)
  --text-sm:    0.875rem / 1.25rem  (14px -- table cells, metadata)
  --text-base:  1rem / 1.5rem       (16px -- body, descriptions)
  --text-lg:    1.125rem / 1.75rem  (18px -- section headers)
  --text-xl:    1.25rem / 1.75rem   (20px -- page titles)
  --text-2xl:   1.5rem / 2rem       (24px -- dashboard numbers)
  --text-3xl:   1.875rem / 2.25rem  (30px -- hero metrics)

Usage:
  Task IDs (T1234):      font-mono, text-sm, cyan accent
  Task titles:           font-body, text-base, text-primary
  Descriptions:          font-body, text-sm, text-secondary
  Metric numbers:        font-mono, text-3xl, text-primary
  Metric labels:         font-body, text-xs, text-muted, uppercase
  Timestamps:            font-mono, text-xs, text-muted
  Code/paths:            font-mono, text-sm, bg-elevated, rounded
```

---

## 4. Layout Structure

### 4.1 Application Shell

```
+-------+------------------------------------------------------+
| LOGO  |  Breadcrumb / Page Title            [Search] [?] [S] |
+-------+------------------------------------------------------+
|       |                                                      |
| N     |                                                      |
| A     |           MAIN CONTENT AREA                          |
| V     |                                                      |
|       |           (scrollable, panels vary by view)          |
| B     |                                                      |
| A     |                                                      |
| R     |                                                      |
|       |                                                      |
| 56px  |                                                      |
| wide  |                                                      |
|       +------------------------------------------------------+
|       |  Status Bar: CLEO v0.96.0 | 566 tasks | ws:connected |
+-------+------------------------------------------------------+
```

- **Left nav**: 56px collapsed (icons only), 240px expanded (icons + labels)
- **Top bar**: 48px tall. Logo, breadcrumb, global search, settings
- **Status bar**: 28px tall. Version, task count, WebSocket status, last sync time
- **Main content**: Fills remaining space. Scrollable. Content depends on active view.

### 4.2 Navigation Items

```
Icon    Label           View               Phase
----    -----           ----               -----
[D]     Dashboard       /                  Phase 1
[T]     Tasks           /tasks             Phase 1
[G]     Graph           /graph             Phase 1
[S]     Sessions        /sessions          Phase 1
[R]     Releases        /releases          Phase 1
[H]     Health          /health            Phase 1
---     separator
[A]     Analytics       /analytics         Phase 2
[B]     Brain           /brain             Phase 2
---     separator
[N]     Nexus           /nexus             Phase 4
[C]     Compliance      /compliance        Phase 2
---     separator
[*]     Settings        /settings          Phase 1
```

Active nav item: left cyan border + bg-elevated + cyan text.
Hover: bg-elevated.

---

## 5. View Designs

### 5.1 Dashboard View (/)

The landing page. Shows the state of the project at a glance.

```
+------------------------------------------------------------------+
|  DASHBOARD                                        claude-todo     |
+------------------------------------------------------------------+
|                                                                    |
|  +----------+ +----------+ +----------+ +----------+              |
|  | 566      | | 42       | | 12       | | 4,165    |              |
|  | Total    | | Active   | | Blocked  | | Archived |              |
|  | Tasks    | | Tasks    | | Tasks    | | Tasks    |              |
|  +----------+ +----------+ +----------+ +----------+              |
|                                                                    |
|  +---------------------------+  +-------------------------------+  |
|  | PHASE PROGRESS            |  | PRIORITY BREAKDOWN           |  |
|  |                           |  |                               |  |
|  | setup     [==========] C |  |  Critical  |||       12       |  |
|  | core      [====      ] 40%|  |  High      ||||||||  89       |  |
|  | testing   [==========] C |  |  Medium    |||||||||||||  234  |  |
|  | polish    [          ] 0% |  |  Low       ||||||||   98      |  |
|  | maint     [          ] 0% |  |                               |  |
|  +---------------------------+  +-------------------------------+  |
|                                                                    |
|  +---------------------------+  +-------------------------------+  |
|  | RECENT ACTIVITY           |  | ACTIVE SESSIONS               |  |
|  |                           |  |                               |  |
|  | 2m ago  T2200 completed   |  | [*] Session abc123           |  |
|  | 5m ago  v0.96.0 released  |  |     Focus: T4284             |  |
|  | 12m ago T4440 completed   |  |     Tasks done: 3             |  |
|  | 1h ago  Session started   |  |     Duration: 2h 15m          |  |
|  | ...                       |  |                               |  |
|  +---------------------------+  +-------------------------------+  |
|                                                                    |
|  +--------------------------------------------------------------+ |
|  | RELEASES                                                      | |
|  |                                                                | |
|  | v0.96.0  [RELEASED]  2026-02-12  1 task   ================== | |
|  | v0.95.4  [RELEASED]  2026-02-11  2 tasks  ================== | |
|  | v0.66.0  [PLANNED]   --          4 tasks  [====          ] 25%| |
|  +--------------------------------------------------------------+ |
+------------------------------------------------------------------+
```

**Metric cards**: Large number (text-3xl, mono), label below (text-xs, muted, uppercase). Colored left border matches semantic meaning.

**Phase progress**: Horizontal bar chart. Filled portion = done%, remainder = pending. Completed phases show "C" badge.

**Priority breakdown**: Horizontal bar chart with counts. Color-coded by priority.

**Recent activity**: Reverse-chronological. Task ID is a clickable link. Relative timestamps.

**Active sessions**: Card per session. Pulsing green dot for active. Focus task is clickable.

**Releases**: Row per release. Status badge (released=green, planned=blue). Progress bar for planned releases.

### 5.2 Task List View (/tasks)

```
+------------------------------------------------------------------+
|  TASKS                                          566 total         |
+------------------------------------------------------------------+
|                                                                    |
|  [Filter: Status v] [Priority v] [Phase v] [Label v] [Search___] |
|  Applied: status=pending | priority=high          [Clear Filters] |
|                                                                    |
|  +--------------------------------------------------------------+ |
|  | St | ID     | Title                    | Pri | Phase | Labels | |
|  |----|--------|--------------------------|-----|-------|--------| |
|  | .  | T301   | Fix validation perf...   | !!  | core  | perf   | |
|  | .  | T745   | Implement DAG conve...   | !!  | core  | arch   | |
|  | *  | T1965  | Fix doctor schema v...   | !   | core  | bug    | |
|  | x  | T2044  | Port migration syst...   | !   | core  | migr   | |
|  |    |        |                          |     |       |        | |
|  | Legend: . pending  * active  x blocked  + done                | |
|  +--------------------------------------------------------------+ |
|                                                                    |
|  +---------- TASK DETAIL PANEL (right slide-out) --------+        |
|  |                                                        |        |
|  | T301 - Fix validation performance regression     [!H]  |        |
|  | Status: pending    Phase: core    Size: medium         |        |
|  | Created: 2025-12-16  Updated: 2026-01-15              |        |
|  |                                                        |        |
|  | Description:                                           |        |
|  | The validation pipeline has a performance regression   |        |
|  | when processing tasks with deep dependency chains...   |        |
|  |                                                        |        |
|  | Dependencies: T299, T300                               |        |
|  | Labels: performance, validation, bug                   |        |
|  |                                                        |        |
|  | Acceptance Criteria:                                   |        |
|  | [ ] Validation completes in < 500ms for 100 tasks     |        |
|  | [ ] No regression in accuracy                          |        |
|  |                                                        |        |
|  | Notes (3):                                             |        |
|  | > 2026-01-15: Profiled -- bottleneck in graph...      |        |
|  | > 2026-01-10: Initial investigation started           |        |
|  |                                                        |        |
|  | Files:                                                 |        |
|  | lib/validation/validation.sh                          |        |
|  +--------------------------------------------------------+        |
+------------------------------------------------------------------+
```

**Table features**:
- Sortable columns (click header)
- Row click opens detail panel (slide-in from right, 400px wide)
- Row hover highlights
- Status column uses compact icons (dot, star, x, checkmark)
- Priority uses `!!` (critical), `!` (high), `.` (medium), blank (low)
- Task ID is monospace, cyan
- Truncated titles with tooltip on hover

**Filters**:
- Dropdown selectors with checkboxes (multi-select)
- Active filters shown as pills with X to remove
- URL query params update with filters (shareable/bookmarkable)
- "Clear Filters" button

**Detail panel**:
- Slide-in from right edge (like Linear)
- Full task metadata
- Dependencies shown as clickable task IDs
- Notes in reverse-chronological order, blockquote style
- Acceptance criteria as checkbox list (read-only Phase 1-2, editable Phase 3+)
- Close with Escape or click outside

### 5.3 Graph View (/graph)

```
+------------------------------------------------------------------+
|  DEPENDENCY GRAPH                         119 edges, 566 nodes    |
+------------------------------------------------------------------+
|                                                                    |
|  [Root: All v] [Depth: 3 v] [Show: deps|blocks|all v] [Fit] [Z] |
|                                                                    |
|  +--------------------------------------------------------------+ |
|  |                                                                | |
|  |        [T2199]--->[T2200]--->[T2201]                          | |
|  |           |                                                    | |
|  |           +------>[T2202]                                     | |
|  |                      |                                         | |
|  |                   [T2203]                                     | |
|  |                                                                | |
|  |   Node colors: status    Edge arrows: dependency direction    | |
|  |   Node size:   subtask count                                  | |
|  |   Click node:  show detail                                    | |
|  |   Drag node:   reposition                                     | |
|  |   Scroll:      zoom                                           | |
|  |   Drag bg:     pan                                            | |
|  +--------------------------------------------------------------+ |
|                                                                    |
|  Hovered: T2200 - Research: Version Bump Tooling Evaluation       |
|  Status: done | Priority: medium | Deps: T2199 | Blocks: T2201   |
+------------------------------------------------------------------+
```

**Graph implementation**: D3.js force-directed layout.

**Node design**:
- Circle, 20-40px diameter (scaled by subtask count)
- Fill color = status color
- Border = priority color (2px for high/critical, 1px for others)
- Label = task ID (text-xs, mono) displayed below node
- Hover: enlarge, show title tooltip, highlight connected edges
- Click: open task detail panel

**Edge design**:
- Curved arrows from dependency to dependent
- Color: subtle gray default, highlight on hover
- Arrowhead at target

**Controls**:
- Root filter: focus on a specific epic or task subtree
- Depth slider: 1-5 levels deep
- Show toggle: dependencies, blockers, or all
- Fit button: auto-zoom to fit all visible nodes
- Zoom controls: +/-/reset

**Bottom bar**: Shows hovered node info (task ID, title, status, connections).

### 5.4 Sessions View (/sessions)

```
+------------------------------------------------------------------+
|  SESSIONS                                     622 total           |
+------------------------------------------------------------------+
|                                                                    |
|  [Filter: active | ended | archived v]  [Sort: recent v]         |
|                                                                    |
|  ACTIVE SESSIONS                                                  |
|  +--------------------------------------------------------------+ |
|  | [*] session_20260212_194742_e6736f                            | |
|  |     Started: 2h 15m ago                                       | |
|  |     Focus: T4284 - EPIC: CLEO Nexus Command Center WebUI     | |
|  |     Tasks completed: 3 | Focus changes: 7                    | |
|  +--------------------------------------------------------------+ |
|                                                                    |
|  RECENT SESSIONS                                                  |
|  +--------------------------------------------------------------+ |
|  | session_20260211_...  | ended   | 4h 32m | 5 tasks | 12 foc | |
|  | session_20260210_...  | ended   | 2h 11m | 2 tasks | 4 foc  | |
|  | session_20260209_...  | archived| 6h 05m | 8 tasks | 15 foc | |
|  +--------------------------------------------------------------+ |
|                                                                    |
|  SESSION METRICS (Phase 2)                                        |
|  +---------------------------+  +-------------------------------+ |
|  | Avg Duration: 3h 22m      |  | [Chart: sessions/day]        | |
|  | Avg Tasks/Session: 4.2    |  |                               | |
|  | Total Token Usage: 1.2M   |  |                               | |
|  +---------------------------+  +-------------------------------+ |
+------------------------------------------------------------------+
```

**Active session card**: Green pulsing dot. Large card format. Focus task is clickable.

**Session list**: Compact rows. Duration, task count, focus change count.

**Session detail** (click to expand):
- Full focus history timeline (vertical, newest at top)
- Token usage breakdown
- Efficiency score
- Scope info (epic/task)

### 5.5 Releases View (/releases)

```
+------------------------------------------------------------------+
|  RELEASES                                                         |
+------------------------------------------------------------------+
|                                                                    |
|  +--------------------------------------------------------------+ |
|  |  v0.96.0  RELEASED  2026-02-12                               | |
|  |  Tasks: T2200                                                 | |
|  |  Changelog: feat(release): portable config-driven version...  | |
|  |  [=======================================] 100%               | |
|  +--------------------------------------------------------------+ |
|  |  v0.95.4  RELEASED  2026-02-11                               | |
|  |  Tasks: T4439, T4440                                          | |
|  |  [=======================================] 100%               | |
|  +--------------------------------------------------------------+ |
|  |  v0.66.0  PLANNED   --                                       | |
|  |  Tasks: T301, T745, T1965, T2044                              | |
|  |  [==========                             ] 25% (1/4 done)    | |
|  |                                                                | |
|  |  Blocking:                                                     | |
|  |    T301 (pending) - Fix validation performance regression     | |
|  |    T745 (pending) - Implement DAG conversion                  | |
|  |    T2044 (pending) - Port migration system                    | |
|  +--------------------------------------------------------------+ |
+------------------------------------------------------------------+
```

**Released**: Green badge, full changelog preview, all tasks linked.
**Planned**: Blue badge, progress bar, blocking tasks listed with status.
**Phase 3+**: Add "Ship Release" button for planned releases at 100%.

### 5.6 Health View (/health)

```
+------------------------------------------------------------------+
|  SYSTEM HEALTH                                                    |
+------------------------------------------------------------------+
|                                                                    |
|  +----------+ +----------+ +----------+ +----------+              |
|  | v0.96.0  | | 2.10.0   | | Healthy  | | 1        |              |
|  | CLEO     | | Schema   | | Status   | | Warnings |              |
|  | Version  | | Version  | |          | |          |              |
|  +----------+ +----------+ +----------+ +----------+              |
|                                                                    |
|  +--------------------------------------------------------------+ |
|  | SCHEMA VERSIONS                                                | |
|  |   todo.json:    2.10.0  [OK]                                 | |
|  |   config.json:  2.10.0  [OK]                                 | |
|  |   archive:      2.4.0   [OK]                                 | |
|  |   log:          2.4.0   [OK]                                 | |
|  +--------------------------------------------------------------+ |
|                                                                    |
|  +--------------------------------------------------------------+ |
|  | INJECTIONS                                                     | |
|  |   CLAUDE.md:   Injected  [OK]                                | |
|  |   AGENTS.md:   Injected  [OK]                                | |
|  |   GEMINI.md:   Not found [--]                                | |
|  +--------------------------------------------------------------+ |
|                                                                    |
|  +--------------------------------------------------------------+ |
|  | STORAGE                                                        | |
|  |   Active tasks:   566    (todo.json: 1.2 MB)                 | |
|  |   Archived tasks: 4,165  (todo-archive.json: 8.4 MB)         | |
|  |   Sessions:       622    (sessions.json: 2.1 MB)             | |
|  |   Audit log:      2,256  (log.json: 890 KB)                  | |
|  |   Backups:        25     (.cleo/backups/: 45 MB)              | |
|  |   Research:       43     (.cleo/research/: 320 KB)            | |
|  +--------------------------------------------------------------+ |
|                                                                    |
|  +--------------------------------------------------------------+ |
|  | WARNINGS                                                       | |
|  |   [!] 2 commands without individual docs (issue, web)         | |
|  +--------------------------------------------------------------+ |
+------------------------------------------------------------------+
```

### 5.7 Analytics View (/analytics) -- Phase 2

```
+------------------------------------------------------------------+
|  ANALYTICS                                     Last 30 days       |
+------------------------------------------------------------------+
|  [7d] [30d] [90d] [All]              [Export CSV] [Export PNG]    |
|                                                                    |
|  +---------------------------+  +-------------------------------+ |
|  | TASK VELOCITY             |  | COMPLETION RATE               | |
|  | [Line chart]              |  | [Line chart]                  | |
|  | tasks completed per day   |  | % done over time              | |
|  +---------------------------+  +-------------------------------+ |
|                                                                    |
|  +---------------------------+  +-------------------------------+ |
|  | CYCLE TIME BY PRIORITY    |  | CYCLE TIME BY SIZE            | |
|  | [Box plot / histogram]    |  | [Box plot / histogram]        | |
|  | median days to complete   |  | small vs medium vs large      | |
|  +---------------------------+  +-------------------------------+ |
|                                                                    |
|  +---------------------------+  +-------------------------------+ |
|  | TOKEN USAGE TREND         |  | SESSION EFFICIENCY            | |
|  | [Area chart]              |  | [Scatter plot]                | |
|  | tokens consumed over time |  | tokens vs tasks completed     | |
|  +---------------------------+  +-------------------------------+ |
|                                                                    |
|  +--------------------------------------------------------------+ |
|  | LABEL FREQUENCY                                                | |
|  | [Horizontal bar chart]                                        | |
|  | architecture (45) | bug (38) | release (22) | testing (19)   | |
|  +--------------------------------------------------------------+ |
+------------------------------------------------------------------+
```

**Chart library**: Chart.js for standard charts, D3.js for graph and custom visualizations.

**Time range selector**: Tabs for preset ranges. Updates all charts simultaneously.

**Export**: CSV for raw data, PNG for chart screenshots.

### 5.8 Brain View (/brain) -- Phase 2

```
+------------------------------------------------------------------+
|  BRAIN                                                            |
+------------------------------------------------------------------+
|                                                                    |
|  [Research] [Consensus] [RCSD] [Decisions]                        |
|                                                                    |
|  RESEARCH ARTIFACTS (43)                                          |
|  +--------------------------------------------------------------+ |
|  | Title                      | Task  | Status | Topics         | |
|  |----------------------------|-------|--------|----------------| |
|  | Version Bump Evaluation    | T2200 | done   | release, tools | |
|  | Changelog Automation       | T2201 | active | release, auto  | |
|  | MCP Agent Interaction      | T4357 | done   | mcp, agents    | |
|  +--------------------------------------------------------------+ |
|                                                                    |
|  RCSD PIPELINE                                                    |
|  +--------------------------------------------------------------+ |
|  | Task   | R | C | S | D | I | V | T | Rel                     | |
|  |--------|---|---|---|---|---|---|---|---                         | |
|  | T3080  | * | * | * | . | . | . | .                           | |
|  | T4431  | * | * | * | * | * | * | * | *                        | |
|  |                                                                | |
|  | Legend: * complete  . pending  x skipped  ! blocked           | |
|  +--------------------------------------------------------------+ |
+------------------------------------------------------------------+
```

**RCSD pipeline**: Compact grid showing lifecycle stages per task. Each cell is a small status indicator. Click a cell to see stage details.

### 5.9 Nexus View (/nexus) -- Phase 4

```
+------------------------------------------------------------------+
|  NEXUS                                     3 projects registered  |
+------------------------------------------------------------------+
|                                                                    |
|  +-------------------+  +-------------------+  +--------------+  |
|  | claude-todo       |  | project-alpha     |  | my-api       |  |
|  | 566 tasks         |  | 89 tasks          |  | 234 tasks    |  |
|  | Phase: core       |  | Phase: testing    |  | Phase: core  |  |
|  | Health: OK        |  | Health: OK        |  | Health: WARN |  |
|  | Active: 42        |  | Active: 12        |  | Active: 8    |  |
|  | [View Project ->] |  | [View Project ->] |  | [View ->]    |  |
|  +-------------------+  +-------------------+  +--------------+  |
|                                                                    |
|  AGGREGATE STATS                                                  |
|  +--------------------------------------------------------------+ |
|  | Total Tasks: 889 | Active: 62 | Blocked: 15 | Done: 5,230   | |
|  +--------------------------------------------------------------+ |
|                                                                    |
|  GLOBAL SEARCH                                                    |
|  [Search across all projects: _________________________________] |
+------------------------------------------------------------------+
```

**Project cards**: Click to switch context. Shows key metrics per project.

**Global search**: Searches tasks, research, and sessions across all registered projects.

---

## 6. Component Library

### 6.1 Metric Card

```
+-------------------+
| 566               |    number: text-3xl, mono, text-primary
| Total Tasks       |    label: text-xs, uppercase, text-muted
|                   |    left-border: 3px, semantic color
+-------------------+    background: bg-surface, rounded-lg
                         padding: 20px
                         min-width: 140px
```

Variants: default, success (green border), warning (amber border), danger (red border).

### 6.2 Status Badge

```
[RELEASED]     bg: green-900/30, text: green-400, border: green-800
[PLANNED]      bg: blue-900/30, text: blue-400, border: blue-800
[ACTIVE]       bg: cyan-900/30, text: cyan-400, border: cyan-800, pulse animation
[BLOCKED]      bg: red-900/30, text: red-400, border: red-800
[PENDING]      bg: gray-900/30, text: gray-400, border: gray-800
```

Font: mono, text-xs, uppercase, letter-spacing-wide, rounded-full, px-2 py-0.5.

### 6.3 Priority Indicator

```
Critical:  [!!]   Red filled circle, 8px, optional pulse
High:      [!]    Orange filled circle, 8px
Medium:    [.]    Blue filled circle, 6px
Low:       [o]    Gray outlined circle, 6px
```

### 6.4 Task Row

```
+----+--------+----------------------------------------------+------+-------+--------+
| St | ID     | Title                                        | Pri  | Phase | Labels |
+----+--------+----------------------------------------------+------+-------+--------+
| .  | T2200  | Research: Version Bump Tooling Evaluation     | [.]  | core  | release|
+----+--------+----------------------------------------------+------+-------+--------+

Height: 36px
Padding: 8px 12px
Hover: bg-elevated
Click: opens detail panel
ID: mono, cyan, clickable
Title: truncate with ellipsis at container width
Phase: badge style, phase color
Labels: comma-separated, text-muted
```

### 6.5 Progress Bar

```
[============               ] 45%

Track: bg-elevated, rounded-full, h-2
Fill: accent color, rounded-full, transition 300ms
Label: text-xs, mono, right-aligned
```

### 6.6 Activity Item

```
  2m ago   T2200 completed                 [done badge]
  ^        ^                               ^
  time     description with linked IDs     status indicator
  muted    text-secondary                  badge component
  mono     clickable task IDs in cyan
```

### 6.7 Filter Pill

```
[status: pending  x]

bg: bg-elevated, rounded-full
text: text-sm, text-secondary
x: text-muted, hover:text-primary, cursor-pointer
```

### 6.8 Panel (Card Container)

```
+--------------------------------------------------------------+
| SECTION TITLE                                    [action btn] |
|--------------------------------------------------------------|
|                                                                |
|  content area                                                  |
|                                                                |
+--------------------------------------------------------------+

Header: text-xs, uppercase, text-muted, letter-spacing, border-bottom
Background: bg-surface
Border: 1px border-default
Border-radius: 8px
Padding: header 12px 16px, body 16px
```

---

## 7. Interaction Patterns

### 7.1 Keyboard Navigation

```
/           Focus search bar
Escape      Close detail panel / modal / clear search
j/k         Navigate task list (down/up)
Enter       Open selected task detail
[           Previous page
]           Next page
g d         Go to Dashboard
g t         Go to Tasks
g g         Go to Graph
g s         Go to Sessions
g r         Go to Releases
g h         Go to Health
?           Show keyboard shortcut help
```

### 7.2 Search

Global search (top bar) searches across:
- Task IDs (exact match)
- Task titles (substring)
- Task descriptions (substring)
- Labels (exact match)
- Session names (substring)

Results grouped by type. Keyboard-navigable. Enter opens selected result.

### 7.3 Real-Time Updates

When WebSocket receives a change event:
1. Flash the affected row/card with a subtle highlight animation (200ms)
2. Update the data in-place (no full page reload)
3. Show a toast notification for significant events (release shipped, session started)
4. Update metric cards with counter animation

### 7.4 Responsive Behavior

- **>= 1280px**: Full layout, side panel for task detail
- **1024-1279px**: Compact nav (icons only), full content
- **768-1023px**: Nav collapses to hamburger, task detail as modal overlay
- **< 768px**: Single column, stacked panels. Not a primary target but functional.

### 7.5 Loading States

- Skeleton screens for initial load (pulsing gray rectangles matching layout)
- Spinner for in-flight requests (small, inline, near the action that triggered it)
- No full-page loaders

### 7.6 Empty States

When no data exists for a view:
- Centered icon + message + action suggestion
- Example: "No active sessions. Start one with `cleo session start`"
- Monospace command suggestions users can copy

---

## 8. Phase 3+ Interactive Elements

### 8.1 Task Creation (Phase 3)

Triggered by: "+" button in task list header or keyboard shortcut `n`.

```
+--------------------------------------------------------------+
| CREATE TASK                                           [Close] |
|--------------------------------------------------------------|
|                                                                |
| Title:    [________________________________________________]  |
| Priority: [Medium v]    Phase: [core v]    Size: [medium v]  |
| Parent:   [none v]      Labels: [tag input with autocomplete]|
|                                                                |
| Description:                                                   |
| [                                                             ]|
| [                                                             ]|
|                                                                |
| Dependencies: [T### autocomplete input                      ] |
|                                                                |
|                              [Cancel]  [Create Task]          |
+--------------------------------------------------------------+
```

Modal overlay. Auto-focus title field. Tab order follows visual order.

### 8.2 Status Transitions (Phase 3)

Click the status indicator in the task list to cycle: pending -> active -> done.

Or in detail panel, dropdown with all valid transitions.

Blocked status requires entering a reason.

### 8.3 Quick Actions (Phase 3)

Right-click context menu or `...` button on task rows:
- Complete task
- Set priority
- Add note
- Set as session focus
- Copy task ID
- View in graph

### 8.4 Drag-and-Drop (Phase 3)

Task list rows are draggable for reordering within the same parent/phase.

Visual feedback: ghost row follows cursor, drop target highlighted with cyan border.

---

## 9. Animations & Transitions

```
Navigation:        slide content left/right, 200ms ease-out
Detail panel:      slide in from right, 250ms ease-out
Modal:             fade bg + scale content 95%->100%, 200ms
Metric update:     counter rolls up/down to new value, 400ms
Status change:     row flashes with status color, 200ms
Hover effects:     bg-color transition, 150ms
Chart updates:     data point animation, 300ms
Toast:             slide in from top-right, auto-dismiss 4s
WebSocket connect: green dot pulse animation (2s loop)
```

---

## 10. Accessibility

- All interactive elements have focus rings (border-focus color)
- Color is never the only indicator (icons/shapes accompany status colors)
- ARIA labels on icon buttons
- Minimum contrast ratio 4.5:1 for text, 3:1 for UI elements
- Screen reader: main content landmark, navigation landmark, status updates via aria-live
- Keyboard-only navigation fully functional
- Reduced motion: respects `prefers-reduced-motion`, disables pulse/transition animations

---

## 11. Related Documents

- **Architecture & Features**: [CLEO-WEB-DASHBOARD-SPEC.md](./CLEO-WEB-DASHBOARD-SPEC.md)
- **Epic**: T4284 (CLEO Nexus Command Center WebUI)
