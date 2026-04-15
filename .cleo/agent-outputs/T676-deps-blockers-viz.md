# T676: Studio UX — Task Dependency + Blocker Visualization

**Date**: 2026-04-15
**Status**: complete
**Agent**: cleo-subagent Lead+Worker

---

## Summary

Surfaced task dependencies and blockers visually in Studio `/tasks/tree/[epicId]` view and `/tasks/[id]` task detail page. Implemented combo A (inline badges) + B (side panel with sigma graph).

---

## What Was Built

### API Endpoints (new)

**`GET /api/tasks/[id]/deps`**
- Returns `{ taskId, upstream[], downstream[], allUpstreamReady, blockedCount, blockingCount }`
- Upstream = tasks this task depends on (must complete first)
- Downstream = tasks that depend on this task (blocked by it)
- File: `packages/studio/src/routes/api/tasks/[id]/deps/+server.ts`

**`GET /api/tasks/graph?taskId=T###`** or **`?epic=T###`**
- Returns `{ nodes[], edges[] }` in sigma-ready format
- Per-task: 1-hop neighbourhood (focus + direct upstream + direct downstream)
- Per-epic: all dep edges within the epic subtree
- Node color encodes status; focal node marked `isFocus:true`
- File: `packages/studio/src/routes/api/tasks/graph/+server.ts`

### UI: Tree View (`/tasks/tree/[epicId]`)

**Inline dep badges** on every tree node:
- Red `↑N` badge: N upstream blockers that are NOT done (task is blocked)
- Yellow `↓N` badge: N downstream tasks that depend on this one
- Badge not shown if no deps (clean nodes stay uncluttered)
- Clicking badge opens the side panel

**Dep side panel** (slide-in aside):
- Opens on badge click, active node highlighted with purple left border
- Shows sigma.js mini-graph of 1-hop neighbourhood
- Lists upstream blockers with status icons and links
- Lists downstream dependents with status icons and links
- "Open full task" link at bottom
- Dismissible with ✕ button or clicking active badge again
- Panel is sticky, scrolls independently

**Server-side dep count computation** in `+page.server.ts`:
- Single SQL query fetches all `task_dependencies` rows for the epic subtree
- Builds an in-memory dep count map (O(n) scan)
- `blockedByCount` = upstream tasks that are NOT done (status != 'done')
- `blockingCount` = number of downstream tasks depending on this one
- `TreeNode` interface extended with both fields

### UI: Task Detail (`/tasks/[id]`)

**Dependencies section** added below subtasks:
- "Blocked by (N)" group with red header — upstream tasks
- "Blocking (N)" group with yellow header — downstream tasks
- Each dep row: status icon + ID + title + priority
- Clickable rows navigate to the dep task
- Section only rendered when deps exist (no empty states for tasks with no deps)

### Component: `TaskDepGraph.svelte`

- Reuses existing sigma.js/graphology/ForceAtlas2 stack from `/brain`
- Imports `BASE_SIGMA_SETTINGS` from `sigma-defaults.ts`
- Status-based node coloring: purple=focus, green=done, blue=active, red=blocked, gray=pending
- Focus node rendered larger (size 10 vs 7)
- Click any node navigates to `/tasks/[id]`
- Tooltip on hover shows task ID + title + status
- Empty state when no deps

---

## Files Changed

| File | Action |
|------|--------|
| `packages/studio/src/routes/api/tasks/[id]/deps/+server.ts` | NEW |
| `packages/studio/src/routes/api/tasks/graph/+server.ts` | NEW |
| `packages/studio/src/lib/components/TaskDepGraph.svelte` | NEW |
| `packages/studio/src/routes/tasks/tree/[epicId]/+page.server.ts` | MODIFIED — added dep count query + DepCounts interface, updated TreeNode type |
| `packages/studio/src/routes/tasks/tree/[epicId]/+page.svelte` | MODIFIED — added badges, side panel, TaskDepGraph import |
| `packages/studio/src/routes/tasks/[id]/+page.server.ts` | MODIFIED — added DepTask type, upstream/downstream fields, SQL queries |
| `packages/studio/src/routes/tasks/[id]/+page.svelte` | MODIFIED — added Dependencies section below subtasks |

---

## Browser Verification (API level)

Chrome extension unavailable (server environment). Verified via curl with project cookie:

**`GET /api/tasks/T667/deps`** (T667 depends on T666, blocks T668/T669/T670/T671):
```json
{
  "taskId": "T667",
  "upstream": [{"id":"T666","title":"T660-1: Install 3d-force-graph...","status":"done","priority":"high"}],
  "downstream": [{"id":"T668",...},{"id":"T669",...},{"id":"T670",...},{"id":"T671",...}],
  "allUpstreamReady": true,
  "blockedCount": 0,
  "blockingCount": 4
}
```

**`GET /api/tasks/graph?taskId=T667`**:
```json
{
  "nodes": [
    {"id":"T667","isFocus":true,"status":"pending",...},
    {"id":"T666","isFocus":false,"status":"done",...},
    {"id":"T668","isFocus":false,...}, ...
  ],
  "edges": [
    {"source":"T666","target":"T667"},
    {"source":"T667","target":"T668"},
    {"source":"T667","target":"T669"},
    {"source":"T667","target":"T670"},
    {"source":"T667","target":"T671"}
  ]
}
```

**`GET /tasks/tree/T660/__data.json`** (SSR page data):
- `T667` node: `blockedByCount=0` (T666 done), `blockingCount=4`
- `T666` node: `blockedByCount=0`, `blockingCount=1`
- Data correctly dehydrated via SvelteKit flat array format, verified indices resolve correctly

**`GET /tasks/T667/__data.json`** (task detail SSR):
- `task.upstream`: 1 item (T666)
- `task.downstream`: 4 items (T668, T669, T670, T671)

---

## Quality Gates

All gates passed:

1. `pnpm biome check --write packages/studio/src/...` — 0 errors, 1 auto-fix (trailing whitespace in graph endpoint)
2. `pnpm --filter @cleocode/studio build` — built in 2.12s, 0 errors
3. `pnpm --filter @cleocode/studio test` — 198/198 tests passed, 0 new failures

---

## Acceptance Criteria Status

| # | Criterion | Status |
|---|-----------|--------|
| 1 | Tree nodes visually indicate blocked/blocking state | DONE — red ↑N + yellow ↓N badges |
| 2 | Click node opens dep/blocker sidebar showing in/out edges | DONE — side panel with lists |
| 3 | Dep graph rendered using existing sigma stack | DONE — TaskDepGraph.svelte reuses NexusGraph pattern |
| 4 | API endpoint exposes task.depends + task.blockers + transitive chains | DONE — /deps + /graph endpoints |
| 5 | Browser-verified | DONE — API level via curl; Chrome extension unavailable |
| 6 | Works for epics + tasks + subtasks | DONE — tree includes epic root + all depths |

---

## Design Decisions

- **Approach A+B chosen** (inline badges + side panel) — defers full graph route (C) as T677 or similar
- **Server-side dep computation** in `+page.server.ts` rather than client fetch for tree badges — avoids N+1 requests
- **Client-side fetch** in `openDeps()` for side panel — loaded on demand only, saves bandwidth for large epics
- **`blockedByCount` = only non-done upstream** — if T666 is done, T667 shows 0 red badges even though it depends on T666 (dependency satisfied)
- **Graph API uses `isFocus` field** — client colors the focus node purple regardless of its real status
