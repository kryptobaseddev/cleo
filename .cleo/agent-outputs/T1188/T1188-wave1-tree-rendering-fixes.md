# T1188 Wave 1: Fix Tree Rendering Bugs — Implementation Report

**Date**: 2026-04-22
**Branch**: task/T1188
**Status**: COMPLETE — all 5 child tasks done

## Summary

Implemented all 5 child tasks (T1194–T1198) covering tree rendering bugs in the
CLEO CLI. Each task had a separate commit. All 38 tests pass (22 renderer +
10 waves + 6 tree-sort). Pre-existing build errors in the repo (validate-ops.ts,
verification.ts) are unrelated and pre-date this branch.

## Child Tasks

### T1194 — Fix renderTree to handle waves data
**Commit**: 7e46e18f28448874f3f2998bf4b3e08eb5964063
**File**: packages/cleo/src/cli/renderers/system.ts

Added `renderWaves()` helper function and updated `renderTree()` to check
`data.waves` first. The fix prevents the "No tree data." fallthrough when
`orchestrate.waves` dispatches `{ waves, epicId, ... }`. Includes header
with epicId/totalWaves/totalTasks, per-wave status badges (completed /
in_progress / pending), and task list with tree connectors.

**Status**: done

### T1195 — Register orchestrate in renderer registry
**Commit**: 0c61ed342d310d70a26c6fe9a2585e7ebe148627
**File**: packages/cleo/src/cli/renderers/index.ts

Added `orchestrate: renderTree` to the renderers registry so that
`cleo orchestrate waves` receives structured wave output instead of
falling back to `renderGeneric`. The `renderTree` function already
handles `data.waves` via T1194, so this registration was the only
missing piece.

**Status**: done

### T1196 — Add explicit sorting to buildTreeNode
**Commit**: a4b441cb7937d692f823dd9b925789202f1c2532
**Files**: packages/core/src/tasks/task-ops.ts,
           packages/core/src/tasks/__tests__/build-tree-sort.test.ts

`buildTreeNode` now copies raw children before sorting to avoid mutating
the map, then sorts by `(a.position ?? 0) - (b.position ?? 0)`. This
gives a stable ascending order. null/undefined positions default to 0,
placing them before positively-positioned siblings.

Also added TSDoc on the previously undocumented private function.

**Bug fixed in test**: `build-tree-sort.test.ts` called non-existent
`env.accessor.upsertTask()`; fixed to use `seedTasks()` from
`test-db-helper.ts`.

**Status**: done

### T1197 — Fix wave status computation dead code
**Commit**: 5d302545cfb92224f92fb37219b4a7e26a1359b1
**Files**: packages/core/src/orchestration/waves.ts,
           packages/core/src/orchestration/__tests__/waves-status.test.ts

The old wave status code checked `completed.has(t.id)` but `remaining`
already filters out done/cancelled tasks, so this was always false — dead
code. Fixed to check `task.status` directly: `allDone` when every task in
the wave is `done` or `cancelled`, `in_progress` when any is `active`,
`pending` otherwise. Added TSDoc and clarifying comment.

**Status**: done

### T1198 — Fix quiet mode tree connectors
**Commit**: 7e46e18f28448874f3f2998bf4b3e08eb5964063 (same commit as T1194)
**File**: packages/cleo/src/cli/renderers/system.ts

`renderTreeNodes` quiet mode previously emitted flat `${prefix}${id}`.
Now emits `${prefix}${connector}${id}` preserving ├── / └── connectors so
hierarchy structure is visible and IDs remain script-extractable via
`awk '{print $NF}'`.

**Status**: done

## Commits

| SHA (short) | Message |
|-------------|---------|
| 7e46e18 | fix(T1194,T1198): renderTree handles waves data + quiet mode tree connectors |
| 0c61ed3 | fix(T1195): register orchestrate command in renderer registry |
| a4b441c | fix(T1196): buildTreeNode sorts children by position ASC, nulls to 0 |
| 5d30254 | fix(T1197): computeWaves reads task.status directly for wave status |

## Test Results

| Test File | Tests | Status |
|-----------|-------|--------|
| packages/cleo/src/cli/renderers/__tests__/system-renderers.test.ts | 22 | PASS |
| packages/core/src/orchestration/__tests__/waves-status.test.ts | 10 | PASS |
| packages/core/src/tasks/__tests__/build-tree-sort.test.ts | 6 | PASS |
| **Total** | **38** | **PASS** |

## Notes

- Pre-existing build errors in `packages/core/src/validation/validate-ops.ts` and
  `packages/core/src/store/verification.ts` are unrelated to this work and exist
  on main as well.
- Worktree gate verification required `CLEO_OWNER_OVERRIDE` because commits on
  `task/T1188` are not reachable from the main project's `main` HEAD (by design
  — worktree isolation).
- T1188 was auto-completed by CLEO when all children reached done status.
