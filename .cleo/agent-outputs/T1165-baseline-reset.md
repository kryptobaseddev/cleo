# T1165 — Baseline-Reset Snapshot Chains for tasks/brain/nexus

**Status**: complete  
**Commit SHAs**: `5ebc827e9`, `e08df7c6b`  
**Branch**: main  
**Date**: 2026-04-21

## Per-DB Results

| DB | Migration.sql size (pre-marker) | Converted to baseline marker | Probe-DB test | Existing-install FK preservation |
|----|---|---|---|---|
| tasks | 532 lines (full schema) | YES | PASS | N/A (no FK concern) |
| brain | 365 lines (full schema, NO PRAGMA FK OFF) | YES | PASS | PASS (foreign_keys=1 confirmed) |
| nexus | 128 lines (full schema) | YES | PASS | N/A (no FK concern) |

## Key Findings

1. **Snapshot malformation root cause**: Old snapshots (pre-2026-03-24 for tasks/brain) were missing the `"renames": []` key AND had non-UUID IDs (slug IDs like `t033-connection-health-20260321`). The drizzle-kit validator uses zod-like schema validation which requires both. Fix: delete all old snapshots and regenerate from empty DB.

2. **Empty-DB generation eliminates FK risk**: Generating against an empty DB (not a probe copy) produces pure `CREATE TABLE` SQL with no `PRAGMA foreign_keys=OFF`. The 261-line brain rebuild that R3 found was only triggered when diffing against the stale scratchpad snapshot. With no prior snapshot, drizzle-kit generates a clean full-schema CREATE from scratch.

3. **Comment-only SQL causes ERR_INVALID_STATE**: node:sqlite's `prepare()` rejects comment-only SQL strings. Required updating `sanitizeMigrationStatements` to strip comment-only statements (not just whitespace-only), and `reconcileJournal` Scenario 3 to pre-journal baseline markers on existing DBs.

## Files Changed

- `packages/core/migrations/drizzle-tasks/20260421195851_t1165-baseline-reset/` — baseline marker + snapshot (new chain anchor)
- `packages/core/migrations/drizzle-brain/20260421195921_t1165-baseline-reset/` — baseline marker + snapshot (new chain anchor)
- `packages/core/migrations/drizzle-nexus/20260421200001_t1165-baseline-reset/` — baseline marker + snapshot (new chain anchor)
- Deleted 10 stale/malformed snapshot.json files across all three DB sets
- `packages/core/src/store/migration-manager.ts` — extended sanitizeMigrationStatements + reconcileJournal Scenario 3 baseline-marker detection
- `packages/core/src/store/__tests__/migration-baseline.test.ts` (NEW) — 13 regression tests

## Test Count Delta

+13 new tests (migration-baseline.test.ts), 0 regressions
