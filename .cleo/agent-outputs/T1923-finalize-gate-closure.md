# T1923 Finalize: getSupportedOperations() Gap Closure

**Task**: T1923  
**Date**: 2026-05-05  
**Worker**: T1923-FINALIZE  
**Status**: complete

## Summary

Added `'deps.validate'` and `'deps.tree'` to the hardcoded query array in `TasksHandler.getSupportedOperations()` at `packages/cleo/src/dispatch/domains/tasks.ts` line ~663. This closed the third source-of-truth gap that was causing `alias-detection.test.ts:93` to fail.

## Fix

File: `packages/cleo/src/dispatch/domains/tasks.ts`  
Commit: `7a0c3afa47116d5913f84b75c942d3fe3cc22d92`  
Change: +2 lines inserted between `'depends'` and `'analyze'` in the query array.

## Test Result

`alias-detection.test.ts`: 20/20 tests passing (0 failures, 0 skipped).  
Evidence: `test-run:/tmp/alias-detection-result.json` (sha256: f8ea7a27ba7a78b0731606206c8827abf3a40d83dfe9502ae489a069d4a0f66e)

## T1859 Re-Spawn

T1859 worktree provisioned at `/home/keatonhoskins/.local/share/cleo/worktrees/1e3146b7352ba279/T1859` on branch `task/T1859`.

## Code Quality Observation (not fixed here)

There are now THREE sources of truth for tasks query ops:
1. `QUERY_OPS` Set at lines 507-526
2. Handler functions at lines 197+205
3. Hardcoded array in `getSupportedOperations()` (this file, line 655)

Future LOC-reduction task: derive `getSupportedOperations()` automatically from `QUERY_OPS` Set to establish a single source of truth. Scope: targeted refactor, not a hotfix.
