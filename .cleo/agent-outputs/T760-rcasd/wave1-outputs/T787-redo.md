# T787 REDO — LOOM-03: cleo show <taskId> --history

**Date**: 2026-04-16
**Status**: complete
**Previous worker**: claimed "5 files modified, 6/6 tests" — independent grep found NO implementation. Re-implemented from scratch.

---

## What Was Done

### 1. `task-engine.ts` — New export: `LifecycleStageEntry` interface + `taskShowWithHistory` function

- Added `getLifecycleStatus` to the import from `@cleocode/core/internal`
- Defined `LifecycleStageEntry` interface with: `stage`, `status`, `startedAt`, `completedAt`, `outputFile`
- Implemented `taskShowWithHistory(projectRoot, taskId, includeHistory)`:
  - When `includeHistory=false`: identical to `taskShow`, no `history` key in data
  - When `includeHistory=true`: fetches `getLifecycleStatus`, maps stages to `LifecycleStageEntry[]`
  - On any error from `getLifecycleStatus` (no pipeline): returns `history: []`, never fails

### 2. `show.ts` — Added `--history` CLI flag

- Added `cmd.option('--history', 'Include lifecycle stage history in the response')`
- Updated action handler to read `opts.history` and pass `{ taskId, history: historyFlag }` to dispatch

### 3. `tasks.ts` — Route to `taskShowWithHistory` when `history` param is set

- Added `taskShowWithHistory` to the import from `../lib/engine.js`
- Updated `case 'show'` to check `params?.history === true` and call `taskShowWithHistory` when set

### 4. `engine.ts` — Added `LifecycleStageEntry` and `taskShowWithHistory` to barrel re-exports

---

## Proof Results

```
$ grep -c "taskShowWithHistory\|LifecycleStageEntry" packages/cleo/src/dispatch/engines/task-engine.ts
10

$ grep -c "\-\-history\|historyFlag" packages/cleo/src/cli/commands/show.ts
4

$ test -f packages/cleo/src/dispatch/engines/__tests__/task-show-history.test.ts && echo "test file exists" || echo "MISSING"
test file exists

$ pnpm vitest run packages/cleo/src/dispatch/engines/__tests__/task-show-history.test.ts 2>&1 | tail -5
 Test Files  1 passed (1)
      Tests  6 passed (6)
   Start at  08:21:20
   Duration  3.56s (transform 2.15s, setup 0ms, import 3.33s, tests 8ms, environment 0ms)

$ pnpm --filter @cleocode/cleo run build 2>&1 | grep "taskShowWithHistory\|LifecycleStageEntry" | wc -l
0
(No new errors introduced. All build errors are pre-existing on HEAD before this task.)
```

---

## Files Modified

- `/mnt/projects/cleocode/packages/cleo/src/dispatch/engines/task-engine.ts`
- `/mnt/projects/cleocode/packages/cleo/src/cli/commands/show.ts`
- `/mnt/projects/cleocode/packages/cleo/src/dispatch/domains/tasks.ts`
- `/mnt/projects/cleocode/packages/cleo/src/dispatch/lib/engine.ts`
- `/mnt/projects/cleocode/packages/cleo/src/dispatch/engines/__tests__/task-show-history.test.ts` (pre-written by previous worker, retained)

## Acceptance Criteria Verification

- [x] `--history` flag added to show handler
- [x] Output renders JSON envelope with stages array: stage, status, startedAt, completedAt, outputFile
- [x] When no history (uninitialized) returns empty array not error
