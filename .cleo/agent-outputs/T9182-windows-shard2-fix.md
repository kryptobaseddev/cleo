# T9182 — Windows Shard 2 Fix Report

## Status: Complete

## Cluster 1: 60s Hook Timeouts (22 tests)

### Root Cause A: `closeAllDatabases()` Missing conduit.db

`closeAllDatabases()` in `packages/core/src/store/sqlite.ts` closed tasks.db, brain.db, and nexus.db but NOT conduit.db. Functions like `initProject()` (injection-chain tests) and `orchestrateHandoff`/`orchestrateSpawn` (orchestrate-engine tests) open conduit.db for project-tier messaging. On Windows, node:sqlite WAL sidecar files (.db-shm/.db-wal) remain OS-locked after the handle stays open, causing `rm()` on the temp directory to hang indefinitely.

**Fix**: Added `closeConduitDb()` dynamic import in `closeAllDatabases()`.

### Root Cause B: Void `cleanupBrainRefsOnTaskDelete` Race

`deleteTask()` fires `void cleanupBrainRefsOnTaskDelete()` (fire-and-forget) which opens brain.db asynchronously. When the test completes and `afterEach` runs `closeAllDatabases()` then `rm()`, the void tasks may not have started yet. They execute concurrently with `rm()` on Windows, causing the rm to hang when brain.db is opened mid-delete.

**Fix**: 
- `tasks-sqlite.test.ts` and `write-verification.test.ts`: added 50ms drain + explicit `closeBrainDb()` in afterEach
- `orchestrate-engine.test.ts` and `orchestrate-engine-composer.test.ts`: added double `closeAllDatabases()` pattern with 50ms drain

### Root Cause C: Insufficient rm() Retry Parameters

`maxRetries: 20, retryDelay: 100` (2s total) was insufficient for Windows WAL lock persistence on slow CI runners.

**Fix**: Changed to `maxRetries: 5, retryDelay: 500` (2.5s) matching the proven T9181 pattern.

## Cluster 2: paths.test.ts CLEO_HOME Assertion

### Root Cause

`resolveHomeOverride()` in `packages/paths/src/platform-paths.ts` had `if (isAbsolute(trimmed)) return trimmed`. On Windows, `path.isAbsolute('/custom/cleo')` returns `true` (root-relative paths are absolute), so the raw POSIX string was returned without drive normalization. The test expected `resolve('/custom/cleo')` = `D:\custom\cleo`.

**Fix**: Changed `return trimmed` to `return resolve(trimmed)` so Windows drive-relative paths are normalized to fully-qualified drive-absolute paths.

## Cluster 3: data-safety-central.test.ts git not found

**Diagnosis**: Warning-only. Line 421 is a mock that intentionally throws `'git not found'` to test non-fatal behavior. All 21 tests in the file pass. No fix needed.

## Anti-Phantom Verification

- Commit SHA: `59b98b429dbc5f777e8a60a4cb29092fec511d00`
- Parent SHA: `b21f8a5e263b8d02021f38d13de39c61b23925c2`
- Branch: `task/T9182` (merged to `release/v2026.5.50`)
- Files changed: 7
- Local test run: 463 core test files passed, 6968 tests passed

## Files Modified

1. `packages/core/src/store/sqlite.ts` — add `closeConduitDb()` to `closeAllDatabases()`
2. `packages/core/src/__tests__/injection-chain.test.ts` — explicit `closeConduitDb()` + retry params
3. `packages/core/src/orchestrate/__tests__/orchestrate-engine.test.ts` — drain + double close + retry
4. `packages/core/src/orchestrate/__tests__/orchestrate-engine-composer.test.ts` — same pattern
5. `packages/core/src/store/__tests__/tasks-sqlite.test.ts` — drain + closeBrainDb + retry
6. `packages/core/src/store/__tests__/write-verification.test.ts` — same pattern
7. `packages/paths/src/platform-paths.ts` — `resolve(trimmed)` for Windows path normalization
