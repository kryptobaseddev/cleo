# Inline Type Audit Results

**Date**: 2026-03-18
**Status**: IN PROGRESS

## Summary

58 CRITICAL violations found where inline object types bypass `@cleocode/contracts`.

## Top Priority Fixes

### Phase 1: Missing contracts types (BLOCKS all other phases)
- `BrainEntry` / `BrainEntryCompact` — used 5+ times inline in memory/engine-compat.ts
- `ReleaseEntry` / `GateCheckStatus` — used in release/release-manifest.ts
- `TaskAnalysisResult` — used in tasks/analyze.ts AND task-ops.ts (DRY violation)
- `TaskDepsResult` / `ExecutionWave` — used in phases/deps.ts

### Phase 2: Replace Pick<TaskRow> with Pick<Task>
- tasks/plan.ts — references internal TaskRow instead of public Task

### Phase 3: Extract inline types to contracts interfaces
- 50+ occurrences of `{ id: string; title: string; status: string }` inline
- tasks/complete.ts: unblockedTasks inline type
- orchestration/unblock.ts: remainingBlocker inline type

### Phase 4: Consolidate session types
- sessions/types.ts: SessionRecord and TaskFileExt shadow contracts

### Phase 5: Test fixtures
- Define TaskTestFixture, SessionTestFixture type aliases

## See full agent report for file-by-file details.
