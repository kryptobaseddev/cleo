# T585: Epic Auto-Complete Bug Fix

**Task**: BUG: Epic auto-completes when any direct subtask completes
**Date**: 2026-04-14
**Status**: complete

## Root Cause Analysis

### Primary Bug: Vacuous Truth in `completeTask`

File: `packages/core/src/tasks/complete.ts` lines 237-248

The auto-complete check used `Array.every()` on the siblings list from `getChildren(parent.id)`:

```typescript
// OLD (buggy):
const allDone = siblings.every(
  (c) => c.id === task.id || c.status === 'done' || c.status === 'cancelled',
);
```

When `getChildren` returns an empty array (`[]`), `[].every(...)` is vacuously `true` in JavaScript, causing the epic to auto-complete even though no children are actually done.

### Contributing Cause: Silent parentId Loss in `upsertTask`

File: `packages/core/src/store/db-helpers.ts` lines 38-49

The T5034 defensive code silently nulled out `parentId` when the parent didn't exist in the DB:

```typescript
// OLD: Silently corrupted parentId in ALL contexts
if (parent.length === 0) {
  row = { ...row, parentId: null };
}
```

In production, when multiple agents wrote subtasks concurrently, some subtasks got `parent_id: null` in the DB due to timing issues (parent not yet visible in the DB connection at write time, or concurrent WAL-mode reads). This left `getChildren(epicId)` returning fewer results than expected.

### How the Bug Manifested (T569 incident)

1. Epic T569 was created with multiple subtasks via parallel agent writes
2. Some subtasks got `parent_id: null` due to concurrent write timing
3. `getChildren(T569)` returned only tasks that had proper `parent_id` set
4. When T584 was completed, it was the only task `getChildren` returned for T569
5. `siblings.every(c => c.id === task.id || ...)` was vacuously true (1 sibling = the one being completed)
6. Epic T569 auto-completed at the same second as T584

## Fix Applied

### Change 1: Vacuous Truth Guard (primary fix)

`packages/core/src/tasks/complete.ts`

```typescript
// NEW: Guard against empty siblings list
const allDone =
  siblings.length > 0 &&
  siblings.every((c) => c.id === task.id || c.status === 'done' || c.status === 'cancelled');
```

An epic with zero registered children in the DB will NOT auto-complete, even if `task.parentId` points to it.

### Change 2: `upsertTask` orphan handling made explicit

`packages/core/src/store/db-helpers.ts`

Added `allowOrphanParent: boolean = false` parameter. When `false` (default, normal writes), logs a warning instead of silently nulling. When `true` (bulk/archive operations, T5034 use case), silently nulls as before.

The `saveArchive` bulk path in `sqlite-data-accessor.ts` now passes `allowOrphanParent: true` explicitly.

## Tests Added / Updated

### New: `packages/core/src/tasks/__tests__/epic-auto-complete.test.ts`

6 tests covering:
1. Does NOT auto-complete with 2 subtasks and only 1 completed (primary scenario)
2. DOES auto-complete when the last pending subtask completes
3. Does NOT auto-complete when a remaining subtask is `blocked`
4. DOES auto-complete when all remaining subtasks are `cancelled`
5. Does NOT auto-complete when `getChildren` returns `[]` (vacuous truth guard)
6. Does NOT auto-complete with 5 subtasks and only 1 completed

### Updated: `packages/core/src/store/__tests__/db-helpers.test.ts`

Updated existing tests to match new `allowOrphanParent` contract:
- `allowOrphanParent=true` → silently nulls out orphan parent (bulk mode)
- `allowOrphanParent=false` (default) → preserves parentId, logs warning
- Parent exists → always preserved

## Quality Gates

- `pnpm biome check --write` — no issues
- `pnpm run build` — success
- `pnpm run test` — 7313 passed, 406 test files, 0 failures

## Files Changed

- `packages/core/src/tasks/complete.ts` — vacuous truth guard
- `packages/core/src/store/db-helpers.ts` — allowOrphanParent parameter + logger
- `packages/core/src/store/sqlite-data-accessor.ts` — pass `allowOrphanParent: true` in saveArchive
- `packages/core/src/tasks/__tests__/epic-auto-complete.test.ts` — new test file
- `packages/core/src/store/__tests__/db-helpers.test.ts` — updated tests
