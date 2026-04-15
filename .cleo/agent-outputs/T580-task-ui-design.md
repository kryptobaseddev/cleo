# T580 — Task System Web UI Design

**Date**: 2026-04-14
**Agent**: Team Lead / Spec
**Status**: complete

---

## 1. Unified Portal Decision: CLEO Studio

T578 (Nexus), T579 (Brain), and T580 (Tasks) MUST share one portal:

- **Package**: `packages/studio` — new SvelteKit app
- **Server**: single Hono HTTP server (already precedented; Express is in `lafs` but Hono is lighter for static serving + SSE)
- **Routes**: `/nexus/*`, `/brain/*`, `/tasks/*` — three view domains, one deployment
- **Build**: one `pnpm build` target, one `PORT` env var
- **Data access**: read-only SQLite via better-sqlite3 (already in project via drizzle). Tasks reads `tasks.db`, Brain reads `brain.db`, Nexus reads `nexus.db`

**Rationale**: Three separate web servers would require three ports, three build pipelines, and three deploy targets. One portal costs the same as one view and is what a real observability tool looks like (Linear, Grafana, etc.).

---

## 2. Tasks-Specific Views

### `/tasks` — Dashboard

Panels:
- **Active epics** (type=epic, status=pending|active): title, priority badge, subtask progress bar (done/total), pipeline_stage
- **Pending tasks** (parent_id=non-null, status=pending): grouped by epic, sorted by position
- **Active session**: current session name, started_at, current_task, tasks completed this session
- **Stats strip**: total pending, in-progress, completed today, blocked

Data queries:
```sql
-- Epics
SELECT id, title, priority, pipeline_stage, status FROM tasks WHERE type='epic' AND status NOT IN ('archived','done');

-- Subtask counts per epic
SELECT parent_id, status, COUNT(*) FROM tasks WHERE parent_id IS NOT NULL GROUP BY parent_id, status;

-- Active session
SELECT id, name, current_task, started_at FROM sessions WHERE status='active' LIMIT 1;
```

### `/tasks/:id` — Task Detail

Sections:
- Header: id, title, status chip, priority badge, size, type
- Description + acceptance criteria checklist (acceptance_json)
- Verification gates: implemented / testsPassed / qaPassed (from verification_json)
- Pipeline stage progress: current stage highlighted in RCASD-IVTR+C sequence
- Lifecycle stages table: stage_name, status, started_at, completed_at, validated_by
- Gate results: gate_name, result (pass/fail/skip), checked_by, checked_at
- Subtasks list (if epic): child tasks with status chips, links to detail
- Audit log tail: last 10 audit_log entries for this task

### `/tasks/pipeline` — RCASD-IVTR+C Kanban

Columns (fixed sequence):
```
Research | Consensus | Architecture Decision | Specification | Decomposition | Implementation | Validation | Testing | Release | Contribution
```

Each column shows task cards with:
- Task ID + truncated title
- Priority color-coding: critical=red, high=orange, medium=yellow, low=gray, none=slate
- Verification gate icons: I (implemented) T (testsPassed) Q (qaPassed) — green checkmark or empty circle
- Click to `/tasks/:id`

Data source: `tasks.pipeline_stage` column + `lifecycle_stages.stage_name` join.

Tasks with null pipeline_stage appear in a "Backlog" overflow column on the left.

### `/tasks/sessions` — Session History Timeline

Vertical timeline, newest-first:
- Session name, agent, started_at → ended_at (or "active")
- Tasks completed count, tasks created count
- Expand: show tasks_completed_json as linked chips
- Color: green=ended, blue=active, gray=other

Data: `sessions` table, `tasks_completed_json` parsed as array.

### `/tasks/tree/:epicId` — Epic Hierarchy Tree

Collapsible tree: epic root → subtasks → nested subtasks.

Each node shows: id, title, status chip, priority dot, verification gate summary (0/3, 1/3, 2/3, 3/3).

Keyboard nav: arrow keys expand/collapse, Enter navigates to detail.

Data: recursive CTE or app-level tree build from `tasks` with `parent_id`.

---

## 3. Visual Language

| Element | Spec |
|---------|------|
| Priority: critical | `bg-red-100 text-red-800 border-red-300` |
| Priority: high | `bg-orange-100 text-orange-800` |
| Priority: medium | `bg-yellow-100 text-yellow-800` |
| Priority: low | `bg-slate-100 text-slate-600` |
| Status: pending | gray pill |
| Status: active | blue pill |
| Status: done | green pill |
| Status: archived | slate pill, opacity-50 |
| Gate: passed | green checkmark SVG |
| Gate: pending | empty circle SVG |
| Gate: failed | red X SVG |
| Pipeline stage: current | blue highlight |
| Pipeline stage: done | green, opacity-70 |
| Pipeline stage: not_started | gray |

Real-time updates: SSE endpoint `/api/tasks/events` watches tasks.db WAL via a 2-second poll interval on the server. Client EventSource reconnects on drop. Tasks dashboard and pipeline view re-query on each event.

---

## 4. Worker Subtasks

### ST1 — Studio package scaffold
**File**: `packages/studio/` — SvelteKit app with Hono API server, pnpm workspace entry, vitest config, biome config
**AC**: `pnpm --filter @cleocode/studio dev` starts on port 4200; `/tasks`, `/nexus`, `/brain` routes return 200

### ST2 — Tasks data layer
**File**: `packages/studio/src/lib/server/tasks-db.ts`
AC: exported functions — `getEpics()`, `getTaskById(id)`, `getSubtasks(parentId)`, `getPipelineBoard()`, `getSessionHistory()`, `getLifecycleStages(taskId)` — all typed via contracts, zero `any`

### ST3 — Dashboard + Pipeline views
**Files**: `packages/studio/src/routes/tasks/+page.svelte`, `packages/studio/src/routes/tasks/pipeline/+page.svelte`
AC: epics render with subtask progress bars; pipeline kanban shows correct stage columns; priority color-coding applied

### ST4 — Task detail + session timeline views
**Files**: `packages/studio/src/routes/tasks/[id]/+page.svelte`, `packages/studio/src/routes/tasks/sessions/+page.svelte`
AC: verification gates render as three icons with pass/fail state; session timeline shows completed task chips

### ST5 — Epic tree view + SSE
**Files**: `packages/studio/src/routes/tasks/tree/[epicId]/+page.svelte`, `packages/studio/src/routes/api/tasks/events/+server.ts`
AC: tree expands/collapses; SSE endpoint emits `task-updated` events; dashboard auto-refreshes within 3 seconds of a tasks.db write

### ST6 — Studio integration test
**File**: `packages/studio/src/lib/server/__tests__/tasks-db.test.ts`
AC: all data layer functions tested against a seeded in-memory SQLite; zero test failures on `pnpm run test`

---

## 5. Architecture Notes

- SvelteKit load functions run server-side (no CORS issues with SQLite)
- better-sqlite3 used synchronously in server load functions (SvelteKit runs these in Node)
- tasks.db path resolved from `CLEO_ROOT` env var or `process.cwd()/.cleo/tasks.db` fallback
- Read-only connection flag on SQLite open (`{ readonly: true }`)
- No writes through the UI — all mutations remain CLI-only per CLEO protocol

---

## 6. Decisions to Store in BRAIN

1. CLEO Studio is the unified portal for Nexus + Brain + Tasks (T578/T579/T580)
2. SvelteKit + Hono in `packages/studio` — one server, one deployment
3. SSE 2-second poll for live updates (no websocket needed for this data rate)
4. Tasks UI is read-only; CLI owns all writes
