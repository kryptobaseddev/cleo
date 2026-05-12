# T785 REDO — LOOM-01: orchestrate start auto-calls lifecycle start research

**Date**: 2026-04-16
**Task**: T785
**Status**: complete
**Wave**: T760 Wave 1

## Summary

`orchestrateStartup` in `orchestrate-engine.ts` now auto-initializes the
RCASD-IVTR lifecycle at the `research` stage when first called for an epic.
The implementation is idempotent: a second call detects the existing pipeline
via `getLifecycleStatus` and skips re-initialization.

## Changes

### packages/cleo/src/dispatch/engines/orchestrate-engine.ts

- Added `getLifecycleStatus` and `recordStageProgress` to imports from
  `@cleocode/core/internal` (both already exported there).
- Updated `orchestrateStartup`: after computing the startup summary, calls
  `getLifecycleStatus(epicId, root)`. If `initialized === false`, calls
  `recordStageProgress(epicId, 'research', 'in_progress', undefined, root)`
  to create the pipeline and mark research as in-progress. Result data now
  includes `autoInitialized: boolean` and `currentStage: string`.

### packages/cleo/src/dispatch/engines/__tests__/orchestrate-engine.test.ts

Added 2 test cases inside the existing `orchestrateStartup` describe block:

1. `auto-initializes lifecycle on first orchestrate start` — verifies
   `autoInitialized === true` and `currentStage === 'research'` on first call.
2. `idempotent — second call does not re-init` — verifies first call sets
   `autoInitialized === true`, second call sets `autoInitialized === false`
   and `currentStage === 'already-initialized'`.

## Proof

```
$ grep -c "autoInit\|recordStageProgress\|getLifecycleStatus" packages/cleo/src/dispatch/engines/orchestrate-engine.ts
10

$ grep -n "auto-initializes lifecycle\|idempotent.*re-init" packages/cleo/src/dispatch/engines/__tests__/orchestrate-engine.test.ts
232:    it('auto-initializes lifecycle on first orchestrate start', async () => {
241:    it('idempotent — second call does not re-init', async () => {

$ pnpm --filter @cleocode/cleo run build 2>&1 | grep "orchestrate-engine"
(no output = no errors in orchestrate-engine.ts)

$ pnpm exec vitest run packages/cleo/src/dispatch/engines/__tests__/orchestrate-engine.test.ts ... | tail
 Test Files  1 passed (1)
      Tests  18 passed (18)
```

Build errors exist in OTHER files (ivtr.ts, docs.ts, task-engine.ts) that were
already broken before this task. Zero errors in `orchestrate-engine.ts`.

## Pre-existing vs New

- Previous T785 worker claimed completion but code was absent from tree (grep
  confirmed). This redo implements the feature from scratch.
- 2 new tests bring total orchestrate-engine tests from 16 to 18.
