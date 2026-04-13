# T553-1: Identity & Task State Fix

**Date**: 2026-04-13
**Status**: complete
**Task**: T553

## Summary

Fixed two P0/P1 bugs found by fresh-agent-test:

1. `cleo dash` showed "Unknown Project" instead of the real project name
2. `cleo next` recommended T234, a task with `cancelledAt` set but `status: pending`

---

## Bug 1: Project name "Unknown Project" in cleo dash

### Root Cause

`getDashboard` in `packages/core/src/stats/index.ts` read project name from the
`project_meta` key in `schema_meta`. That key was never written for this project —
the DB only had `file_meta`, `focus_state`, `schemaVersion`, and `task_id_sequence`.

Other functions (export, inject) read from the `project` key, which was also absent.

### Fix

`packages/core/src/stats/index.ts`:

- Added import for `getProjectInfoSync` from `../project-info.js`
- Changed project name resolution to a 3-level fallback chain:
  1. `project_meta.name` (DB key, preferred)
  2. `legacyMeta.name` (reads `project` key as fallback)
  3. `getProjectInfoSync(opts.cwd)?.projectName` (derives name from the last path
     segment of the project root via `project-info.json`)
- Updated `currentPhase` to also merge from `legacyMeta` if `project_meta` is absent

**Result**: `cleo dash` now returns `"project":"cleocode"`.

---

## Bug 2: Cancelled task T234 recommended by cleo next

### Root Cause

T234 had `cancelledAt: "2026-03-31T15:13:19.029Z"` set in the DB but `status: "pending"`.
This is a soft-cancel pattern where the status field was not updated to `"cancelled"`.

`coreTaskNext` in `packages/core/src/tasks/task-ops.ts` filtered candidates with
`t.status === 'pending'` only — it did not check `t.cancelledAt`, so T234 passed
the filter and was scored 111 (critical priority + age bonus + deps satisfied).

The `getNextTask` function in `packages/core/src/tasks/graph-ops.ts` had the same gap.

The `highPriority` list in `getDashboard` also had this gap, causing T234 to appear
at the top of the dashboard's high-priority section.

### Fix

Three call sites updated:

1. **`packages/core/src/tasks/task-ops.ts`** — `coreTaskNext` candidate filter:
   ```
   t.status === 'pending' && !t.cancelledAt && depsReady(...)
   ```

2. **`packages/core/src/tasks/graph-ops.ts`** — `getNextTask` ready filter:
   ```
   if (t.cancelledAt) return false; // Exclude soft-cancelled tasks regardless of status
   ```

3. **`packages/core/src/stats/index.ts`** — `highPriority` filter in `getDashboard`:
   ```
   t.status !== 'cancelled' && !t.cancelledAt
   ```

**Result**: `cleo next` recommends T514 (score 110). T234 is excluded. `highPriority`
count dropped from 42 to 41 (T234 removed).

---

## Quality Gates

- `pnpm biome check --write` — passed (2 pre-existing warnings, no errors)
- `pnpm run build` — passed
- `pnpm run test` — 396 test files passed, 7130 tests passed, 0 new failures

## Files Changed

- `packages/core/src/stats/index.ts` — Bug 1 project name fallback + Bug 2 highPriority filter
- `packages/core/src/tasks/task-ops.ts` — Bug 2 coreTaskNext candidate filter
- `packages/core/src/tasks/graph-ops.ts` — Bug 2 getNextTask ready filter
