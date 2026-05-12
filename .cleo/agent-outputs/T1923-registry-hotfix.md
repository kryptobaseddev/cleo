# T1923 — Registry Hotfix: tasks.deps.validate + tasks.deps.tree

**Task**: T1923 (P0 hotfix for T1857 production gap)
**Date**: 2026-05-05
**Status**: complete
**Commit**: d1c03b19755e856e873bf4f419e8cedde2828768 (branch: task/T1923)

## Problem

T1857 shipped handler implementations in `packages/cleo/src/dispatch/domains/tasks.ts` (registered in `QUERY_OPS`) but both `deps.validate` and `deps.tree` were absent from `packages/cleo/src/dispatch/registry.ts`. The dispatcher's `resolve()` function short-circuits on a registry miss and returns `E_INVALID_OPERATION` before the domain handler is ever reached.

## Fix

Added two registry entries to `packages/cleo/src/dispatch/registry.ts` after `tasks.depends` (line 172+):

- `tasks.deps.validate`: `gateway=query, tier=1, idempotent=true, sessionRequired=false, requiredParams=[]` with `epicId` (optional) and `scope` (optional) params matching `TasksDepsValidateParams` from contracts.
- `tasks.deps.tree`: `gateway=query, tier=1, idempotent=true, sessionRequired=false, requiredParams=['epicId']` with `epicId` (required) and `format` (optional) params matching `TasksDepsTreeParams` from contracts.

## Test

Added `packages/cleo/src/cli/__tests__/deps-registry.test.ts` (15 tests) exercising the full dispatch pipeline `resolve()` path. Named `deps-registry.test.ts` (not `*-integration.test.ts`) to avoid the vitest exclusion pattern in `vitest.config.ts`.

The test class catches the exact regression: a handler in `domains/tasks.ts` that is absent from `registry.ts` — handler unit-tests cannot catch this because they bypass `resolve()`.

## Test Results

- 15/15 new tests pass
- 11/11 existing registry.test.ts tests pass
- biome check: 0 errors on changed files
- typecheck: pre-existing worktree env issues only (ES2025 target not supported by local tsc); main project typecheck passes cleanly (verified from /mnt/projects/cleocode)

## Files Changed

- `packages/cleo/src/dispatch/registry.ts` — added 2 registry entries
- `packages/cleo/src/cli/__tests__/deps-registry.test.ts` — new regression test (15 tests)

## SSoT Observation (for future epic)

The dual-location pattern (handler in `domains/tasks.ts` + manual entry in `registry.ts`) is a fragile wiring contract that caused T1857's gap and T1923's P0 fix. A single-source-of-truth approach — generating registry entries from domain handler exports or a decorators/metadata system — would eliminate this class of bug entirely. Recommend filing a separate epic for registry generation from domain exports.
