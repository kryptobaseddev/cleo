# T579: BRAIN Web Visualization — Design Spec

**Date**: 2026-04-14
**Status**: Design complete
**Live data**: 707 nodes, 484 edges, 275 observations, 12 decisions, 2 patterns, 3 learnings

---

## Architecture Decision: CLEO Studio — Unified Portal

T578 (NEXUS Portal) and T579 (BRAIN Viz) MUST share a single web infrastructure: one server, one SvelteKit app, multiple pages. Rationale:

- Both are read-only visualization layers over SQLite databases on the same host.
- Both require the same tech stack (SvelteKit + D3/force-graph + Hono API server).
- Splitting them doubles maintenance surface, port management, and deployment complexity.
- The existing `cleo web start` command on port 3456 already provides the `dist/cli/index.js` entry point — CLEO Studio plugs into this lifecycle.

**Decision: one package `packages/studio` — "CLEO Studio". Routes: `/nexus/*` (T578) and `/brain/*` (T579). Commands: `cleo web start` remains the entry point.**

---

## Data Layer

### Tables consumed (brain.db)

| Table | Key fields for viz |
|---|---|
| `brain_page_nodes` | id, node_type, label, quality_score, last_activity_at |
| `brain_page_edges` | from_id, to_id, edge_type, weight, created_at |
| `brain_observations` | id, type, title, memory_tier, quality_score, created_at, valid_at, invalid_at, prune_candidate |
| `brain_decisions` | id, decision, confidence, memory_tier, quality_score, created_at, valid_at, invalid_at |
| `brain_patterns` | id, pattern, type, frequency, quality_score, memory_tier |
| `brain_learnings` | id, insight, confidence, quality_score, memory_tier |

### API routes (new in `packages/studio/src/server/`)

All routes serve from `brain.db` via read-only SQLite access (`better-sqlite3`, same pattern as existing core data accessors):

```
GET /api/brain/graph          — nodes + edges for force graph (paginated, max 500 nodes)
GET /api/brain/nodes?tier=&type=&min_quality=  — filtered node list
GET /api/brain/edges?type=    — filtered edges
GET /api/brain/entry/:id      — full entry details (joins page_node to source table)
GET /api/brain/stats          — counts per type, tier, quality bucket
GET /api/brain/timeline?from=&to=  — nodes created in time window
```

---

## BRAIN-Specific Routes (SvelteKit pages)

| Route | Purpose |
|---|---|
| `/brain` | Overview dashboard: counts, tier distribution, quality histogram, recent activity |
| `/brain/graph` | Interactive force-directed neural network |
| `/brain/decisions` | Chronological decision timeline with confidence bars |
| `/brain/observations` | Paginated list; `?tier=short|medium|long` filter |
| `/brain/quality` | Quality score distribution, prune candidates flagged |

---

## Visual Design

### Node encoding

| Attribute | Encoding |
|---|---|
| Node type | Color: observation=`#3b82f6` (blue), decision=`#22c55e` (green), pattern=`#a855f7` (purple), learning=`#f97316` (orange), task=`#94a3b8` (grey), session=`#facc15` (yellow) |
| Memory tier | Ring: short=thin solid, medium=medium dashed, long=thick solid |
| Quality score | Node radius: `r = 4 + quality_score * 12` (range 4–16px) |
| Prune candidate | Opacity 0.35, dashed outline |
| Invalidated (`invalid_at` set) | Grey fill, strikethrough label |

### Edge encoding

| Edge type | Color |
|---|---|
| supersedes | `#ef4444` (red) — temporal replacement |
| applies_to | `#3b82f6` (blue) — semantic application |
| derived_from | `#8b5cf6` (violet) — provenance |
| produced_by | `#f59e0b` (amber) — authorship |
| part_of | `#10b981` (emerald) — containment |
| references | `#64748b` (slate) — weak link |

Edge weight maps to stroke width (1–4px).

### Time decay slider

- `/brain/graph` has a time range slider (min=earliest `created_at`, max=today).
- Nodes not yet created at slider position are hidden.
- Nodes with `invalid_at` before slider position render as invalidated (grey).
- Implemented client-side: all nodes fetched, filter applied in JS against pre-parsed timestamps.

### Memory tier legend panel (persistent sidebar)
Short / Medium / Long with live counts. Click filters the graph to that tier.

---

## Worker Tasks

### W1 — Studio package scaffold + API server
**File**: `packages/studio/` (new SvelteKit + Hono package)
**What**: Initialize SvelteKit project, configure Hono as API handler via SvelteKit hooks, set up `better-sqlite3` read-only connection helper for both `brain.db` and `nexus.db`. Wire into existing `cleo web start` entry point at port 3456.
**Acceptance**: `cleo web start` serves `/brain` and `/nexus` routes. `GET /api/brain/stats` returns JSON with live counts. `GET /api/health` responds 200.

### W2 — Brain data API endpoints
**File**: `packages/studio/src/server/brain-api.ts`
**What**: Implement all six `GET /api/brain/*` routes listed above. Read-only SQLite with prepared statements. Enforce 500-node cap on graph endpoint. Include pagination tokens on list endpoints.
**Acceptance**: All endpoints return valid JSON. Graph endpoint with 707 nodes returns first 500 ordered by quality_score DESC. Timeline query filters correctly by ISO date params.

### W3 — BRAIN overview dashboard (`/brain`)
**File**: `packages/studio/src/routes/brain/+page.svelte`
**What**: Dashboard showing: total node count by type (color-coded bar chart), memory tier distribution (donut), quality score histogram (10 buckets), 10 most recently active nodes, prune candidate count with link to quality page.
**Acceptance**: All charts render from live `/api/brain/stats`. Tier donut matches live DB counts (short=276 obs, medium=7 decisions at time of spec).

### W4 — Force-directed neural network graph (`/brain/graph`)
**File**: `packages/studio/src/routes/brain/graph/+page.svelte`
**What**: D3 force simulation with node color/size/opacity encoding from visual design spec. Edge color by type. Click node shows detail panel (title, type, tier, quality, timestamps). Time decay slider filters nodes. Tier filter sidebar. Zoom/pan.
**Acceptance**: Renders 500 nodes and all 484 edges without freezing. Time slider moving from oldest to newest animates nodes appearing. Clicking a decision node shows confidence value. Prune candidates visibly dimmed.

### W5 — Decision timeline + quality views (`/brain/decisions`, `/brain/quality`)
**File**: `packages/studio/src/routes/brain/decisions/+page.svelte`, `packages/studio/src/routes/brain/quality/+page.svelte`
**What**: Decisions: chronological list with confidence bar, memory tier badge, valid/invalid status, linked task/epic IDs. Quality: sortable table of all entries, quality score bar, prune_candidate flag, tier column. Filterable by type.
**Acceptance**: Decision timeline shows all 12 decisions ordered by created_at. Quality page lists all entries, allows sort by score, marks prune candidates with warning icon.

### W6 — T578/T579 shared infrastructure (coordinate with NEXUS Portal worker)
**File**: `packages/studio/src/lib/graph-engine.ts`, `packages/studio/src/lib/db.ts`
**What**: Extract shared D3 force simulation engine and SQLite connection helper into `src/lib/`. T578 (NEXUS graph) and T579 (BRAIN graph) both import from here. Shared nav component with NEXUS / BRAIN / Tasks tabs.
**Acceptance**: Removing either `/brain` or `/nexus` routes still leaves shared lib compiling. Nav shows active route. Both graph pages use same `GraphEngine` class with different data sources.

---

## Coordination Note for T578

T578 workers should claim W1 and W6 as shared foundation. T579 workers own W2–W5. If T578 and T579 run in parallel, W1 must be the first task completed by whichever worker starts first — it is the build blocker for all other tasks.
