# T062 — Epic Lifecycle Pipeline Enforcement

**Status**: complete
**Date**: 2026-03-21
**Task**: T062
**Epic**: T056 (Task System Hardening)
**Depends**: T060 (pipeline stage binding)

---

## Summary

Implemented epic-specific lifecycle enforcement on top of T060's pipeline stage
infrastructure.  All three enforcement gates are active and conditional on the
`lifecycle.mode` config key (`strict` | `advisory` | `off`).

---

## Files Changed

### New file: `packages/core/src/tasks/epic-enforcement.ts`

Core enforcement module.  Exports:

| Export | Purpose |
|--------|---------|
| `EPIC_MIN_AC = 5` | Minimum AC count required for epics |
| `LifecycleMode` | Type alias for enforcement mode |
| `EpicEnforcementResult` | Return type for enforcement functions |
| `getLifecycleMode(cwd?)` | Reads `lifecycle.mode` from config |
| `validateEpicCreation(options, cwd?)` | Enforces min-5 AC + non-empty description |
| `validateChildStageCeiling(options, accessor, cwd?)` | Blocks child stage exceeding epic |
| `validateEpicStageAdvancement(options, accessor, cwd?)` | Blocks epic advancement with in-flight children |
| `findEpicAncestor(taskId, accessor)` | Walks ancestors to find nearest epic |

### Modified: `packages/core/src/tasks/add.ts`

Two enforcement hooks added:

1. **Epic creation check** — after general AC enforcement, calls `validateEpicCreation`
   when `options.type === 'epic'`.  In strict mode, throws if AC < 5 or description empty.

2. **Child stage ceiling** — after pipeline stage resolution, finds the nearest epic
   ancestor and calls `validateChildStageCeiling` if one exists.

### Modified: `packages/core/src/tasks/update.ts`

Two enforcement hooks added to the `pipelineStage` update branch:

1. **Epic stage advancement gate** — when task is an epic, calls
   `validateEpicStageAdvancement` before applying the new stage.  Blocked if any
   direct children are non-terminal and at the epic's current stage.

2. **Child stage ceiling** — when task is not an epic, finds the nearest epic ancestor
   and calls `validateChildStageCeiling` with the proposed new stage.

### Modified: `packages/core/src/tasks/__tests__/pipeline-stage.test.ts`

Added `lifecycle: { mode: 'off' }` to `NO_SESSION_CONFIG` so existing pipeline stage
tests that create bare epics are not affected by the new epic enforcement.

### New file: `packages/core/src/tasks/__tests__/epic-enforcement.test.ts`

33 unit tests + 10 integration tests (via `addTask` / `updateTask`).  All 43 pass.

---

## Enforcement Rules Implemented

### 1. Epic Creation (strict mode)

- Minimum **5 acceptance criteria** (regular tasks need 3).
- Non-empty **description** (serves as completion criteria).
- Gate: called in `addTask` when `type === 'epic'`.
- Config path: `lifecycle.mode`.

### 2. Child Stage Ceiling

- A child task's `pipelineStage` cannot exceed the nearest epic ancestor's stage.
- Gate: called in `addTask` (on creation) and `updateTask` (on stage update).
- Works for both direct children of epics and deeper subtask descendants.

### 3. Epic Stage Advancement Gate

- An epic cannot advance its `pipelineStage` while it has **non-terminal children
  at the current stage** (status is not done/cancelled/archived).
- Gate: called in `updateTask` when updating `pipelineStage` on an epic.

---

## Strictness Preset Integration

All three gates respect `lifecycle.mode`:

| Mode | Behavior |
|------|----------|
| `strict` | Throws `CleoError(VALIDATION_ERROR)` — blocks the operation |
| `advisory` | Returns `{ valid: true, warning: "..." }` — logs but allows |
| `off` | Returns `{ valid: true }` — all checks skipped |

Default (when not set in config): `strict` (matches config.ts DEFAULTS).

The `strict` strictness preset (T067) sets `lifecycle.mode: 'strict'`, so epic
enforcement is active by default.  Users on `minimal` preset get `lifecycle.mode: 'off'`
and are exempt.

---

## Test Results

```
Test Files: 2 passed (2)
     Tests: 66 passed (66)
  Duration: ~2s
```

Files:
- `packages/core/src/tasks/__tests__/epic-enforcement.test.ts` — 33 tests
- `packages/core/src/tasks/__tests__/pipeline-stage.test.ts` — 33 tests (0 regressions)

---

## Acceptance Criteria Verification

| AC | Status |
|----|--------|
| Epic creation enforces minimum 5 AC in strict mode | PASS — `validateEpicCreation`, tested |
| Epic children cannot exceed parent epic's pipeline stage | PASS — `validateChildStageCeiling`, tested in addTask + updateTask |
| Epic stage advancement blocked by incomplete children | PASS — `validateEpicStageAdvancement`, tested in updateTask |
| Enforcement respects strictness preset (strict/standard/minimal) | PASS — `getLifecycleMode` reads `lifecycle.mode`, tested for all three modes |
