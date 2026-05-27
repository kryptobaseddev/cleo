# T1003 — Staged Backfill Runner

**Status**: complete
**Commit**: dfa83762b7c999c6c142db856b5a39e49a125ad2
**Date**: 2026-04-20

## Summary

Delivered staged backfill runner with approve/rollback CLI for T1003 (epic T1000).

## Files Changed

- `/mnt/projects/cleocode/packages/core/src/store/memory-schema.ts` — Added `brainBackfillRuns` Drizzle table declaration with `BrainBackfillRunRow`, `BrainBackfillRunInsert`, and `BRAIN_BACKFILL_RUN_STATUSES` type exports.
- `/mnt/projects/cleocode/packages/core/src/store/memory-sqlite.ts` — Added `CREATE TABLE IF NOT EXISTS brain_backfill_runs` with 3 indexes inside `runBrainMigrations()`.
- `/mnt/projects/cleocode/packages/core/src/memory/brain-backfill.ts` — Added `stagedBackfillRun`, `approveBackfillRun`, `rollbackBackfillRun`, `listBackfillRuns` functions; extended imports with `randomBytes` and `BrainBackfillRunRow`.
- `/mnt/projects/cleocode/packages/cleo/src/dispatch/domains/memory.ts` — Added `backfill.list` query op and `backfill.run`, `backfill.approve`, `backfill.rollback` mutate ops; registered in `getSupportedOperations()`.
- `/mnt/projects/cleocode/packages/core/package.json` — Added `./memory/brain-backfill.js` explicit export entry.
- `/mnt/projects/cleocode/packages/core/src/memory/__tests__/brain-backfill-staged.test.ts` — 11 tests covering all acceptance criteria.

## Schema

```sql
CREATE TABLE IF NOT EXISTS brain_backfill_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'staged',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at TEXT,
  rows_affected INTEGER NOT NULL DEFAULT 0,
  rollback_snapshot_json TEXT,
  source TEXT NOT NULL DEFAULT 'unknown',
  target_table TEXT NOT NULL DEFAULT 'brain_observations',
  approved_by TEXT
)
```

## Test Results

307 test files / 4724 tests passing in @cleocode/core. 11 new tests in brain-backfill-staged.test.ts all green.

## Gates

- implemented: commit dfa83762b + 6 files
- testsPassed: @cleocode/core 307/307 (studio Svelte5 pre-existing failure O-mo6bm8if-0, owner override applied)
- qaPassed: biome + tsc both exit 0
