# T720 — Studio Session Task Association

**Status**: complete
**Commit**: a2f34af8
**Date**: 2026-04-15

## Root Cause

Studio `/tasks/sessions` page server load never queried the `current_task` column on the `sessions` table or the `task_work_history` join table. Sessions with an active task showed "no tasks" chip. The column and table existed but were never surfaced in the UI.

## Changes

### `packages/studio/src/routes/tasks/sessions/+page.server.ts`
- Added `current_task` to the SELECT query
- Added `WorkedTaskEntry` interface and `workedTasks: WorkedTaskEntry[]` to `SessionEntry`
- Added `currentTask: { id, title, status } | null` to `SessionEntry`
- Batch-fetch all `task_work_history` rows for returned sessions in one JOIN query (no N+1)
- Resolve `current_task` task title/status via single-row lookup per session

### `packages/studio/src/routes/tasks/sessions/+page.svelte`
- Sessions list card: shows `active: TX` chip (purple `count-active`) when `currentTask` is set
- Sessions list card: shows `N worked` chip (amber) when `workedTasks.length > 0`
- "no tasks" condition tightened: only shown when no current, no worked, no completed, no created
- Expanded view: **Active Task** section with purple left-border row + "in progress" status label
- Expanded view: **Task Work History** section showing task_work_history rows with timestamps
- Expanded view: **Completed Tasks** section (pre-existing, preserved)

### `packages/studio/src/routes/api/tasks/sessions/+server.ts`
- Same enrichment: `currentTask` object + `workedTasks` array in JSON response
- Batch pre-fetch of `task_work_history` via single JOIN query

### `packages/contracts/src/data-accessor.ts`
- Added missing `pipelineStage?: string | null` to `TaskFieldUpdates` interface
- Unblocked T719 build error in `sqlite-data-accessor.ts` and `task-work/index.ts`

### `packages/core/src/task-work/index.ts`
- Removed unused `EXECUTION_STAGES` const (TS6133 from T719 leftover)

## Browser Verification

Server: `http://127.0.0.1:3456/tasks/sessions`

API response for session `ses_20260415175058_9b8607`:
```json
{
  "id": "ses_20260415175058_9b8607",
  "name": "T667 Worker",
  "status": "active",
  "currentTask": {
    "id": "T660",
    "title": "EPIC: Phase 6 — 3D Synapse Brain (3d-force-graph + UnrealBloomPass)",
    "status": "done"
  },
  "workedTasks": []
}
```

Rendered HTML contains:
```html
<span class="count-chip count-active">active: <a href="/tasks/T660" class="active-task-link">T660</a></span>
```

Evidence files: `.cleo/agent-outputs/T720-evidence/api-response.json`, `.cleo/agent-outputs/T720-evidence/html-evidence.txt`

## Architecture Note

`task_work_history` table exists and has the right schema but `cleo start TXXX` writes to `focus_state.sessionNotes` meta-key (not to `task_work_history`). The `session-store.ts:startTask()` function that writes to `task_work_history` is not called by the dispatch layer — this is a separate gap worth tracking. Current fix surfaces `current_task` (always populated) and `task_work_history` (populated for future sessions that use the `session-store.ts` path).

## Quality Gates

- biome check: no issues
- build: green (Build complete)
- tests: task-work tests 6/6 passed; studio tests passing except pre-existing `cli-action.js` import issue (31 failures pre-existing, not caused by this PR)
