# T943 — computeTaskView() State SSoT Unification

**Status**: complete
**Date**: 2026-04-20
**Decision**: Option B — cached projection

## Summary

Created `computeTaskView()` as the single canonical derivation function for task
state. All surfaces (SDK, CLI engine, Studio REST) now consume the same
projection so `/tasks` and `/tasks/pipeline` cannot diverge.

## Files Created

- `packages/core/src/tasks/compute-task-view.ts` — canonical function + types
- `packages/core/src/tasks/__tests__/compute-task-view.test.ts` — 23 regression tests

## Files Modified

- `packages/core/src/tasks/index.ts` — barrel export for `@cleocode/core/tasks`
- `packages/core/src/internal.ts` — export for `@cleocode/core/internal` (CLI engine)
- `packages/cleo/src/dispatch/engines/task-engine.ts` — `taskShow` enriched with `view: TaskView | null`
- `packages/studio/src/routes/api/tasks/[id]/+server.ts` — includes `view` field in GET response
- `packages/studio/src/routes/api/tasks/+server.ts` — includes `views: TaskView[]` in list response

## TaskView Fields

- `id`, `title`, `status`, `pipelineStage` — direct from tasks row
- `lifecycleProgress` — derived from lifecycle_pipelines + lifecycle_stages
- `childRollup` — `{ total, done, blocked, active }` — non-archived direct children
- `gatesStatus` — `{ implemented, testsPassed, qaPassed, documented? }`
- `readyToComplete` — true when gates green + no blocking deps + non-terminal
- `nextAction` — priority-ladder token for agent guidance

## nextAction Priority Ladder

1. `already-complete` — terminal status
2. `blocked-on-deps` — unresolved depends entries
3. `awaiting-children` — non-done non-archived children
4. `verify` — a required gate is false
5. `advance-lifecycle` — gates green but lifecycle not at contribution (epics only)
6. `spawn-worker` — ready to dispatch
7. `no-action` — fallback

## Test Results

- 23 tests, all passing
- Parity assertion: `computeTaskView` and `computeTaskViews` return identical
  `status` + `pipelineStage` + full structural equality for same task

## Follow-up

- Drop `tasks.pipelineStage` column in follow-up epic (deferred per T943 scope)
