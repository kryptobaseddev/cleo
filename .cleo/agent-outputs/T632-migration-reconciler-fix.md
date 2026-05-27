# T632 — Migration Reconciler Sub-case B Root-Cause Fix

**Date**: 2026-04-15
**Status**: complete
**Commit**: a4c1a0b85d8bf3a025387aef1c1dd98ff1b8b751

## Root Cause

`reconcileJournal` Scenario 2 Sub-case B had a broken implementation:

```
// OLD (broken):
nativeDb.exec('DELETE FROM "__drizzle_migrations"');
for (const m of localMigrations) {
  insertJournalEntry(nativeDb, m.hash, m.folderMillis, m.name ?? '');  // wholesale mark-applied
}
```

This deleted the journal and re-inserted ALL local migrations as applied WITHOUT running their SQL.
Any ALTER TABLE migration (T417 agent, T528 graph schema, T531 quality-score, T549 tiered-memory)
got marked applied but its columns were NEVER ADDED to the schema. The symptom was "no such column"
errors in production, patched with `ensureColumns` calls in `brain-sqlite.ts`.

## Root-Cause Fix (probeAndMarkApplied — wired v2026.4.54)

`probeAndMarkApplied` in `migration-manager.ts` replaced the wholesale-mark pattern.
It inspects each migration's DDL and marks it applied ONLY IF:
- `ALTER TABLE foo ADD COLUMN bar` → column `foo.bar` exists in the live schema
- `CREATE TABLE foo` → table `foo` exists in the live schema
- `CREATE INDEX idx` → index `idx` exists in the live schema

If any target is missing, the migration is left unjournaled so Drizzle's `migrate()` runs the DDL.

## Bandaids Removed (this commit)

`brain-sqlite.ts` had three redundant `ensureColumns` blocks that compensated for the broken
Sub-case B behavior. All three are now removed because their columns are fully covered by
Drizzle migration files and `probeAndMarkApplied`:

| Bandaid | Tables | Migration File |
|---------|--------|----------------|
| T528 | `brain_page_nodes` (quality_score, content_hash, last_activity_at, updated_at) | `20260411000001_t528-graph-schema-expansion` |
| T531 | 4 typed tables (quality_score) | `20260412000001_t531-quality-score-typed-tables` |
| T549 | 4 typed tables (memory_tier, memory_type, verified, valid_at, invalid_at, source_confidence, citation_count) | `20260413000001_t549-tiered-typed-memory` |

T673 `ensureColumns` calls are retained because `retrieval_order` and `delta_ms` on
`brain_retrieval_log` have NO Drizzle migration file (self-healing DDL only). A followup task
should add proper migration files for those columns.

## Tests Added

Four new Scenario 2 tests in `migration-reconcile.test.ts`:

1. **Sub-case A: DB ahead** — Journal untouched when all local hashes are present in DB.
   Regression guard for T571 (infinite reconcile cycle).

2. **Sub-case B: column absent** — Migration NOT marked applied when its DDL target column
   is missing from the schema. Drizzle will run it.

3. **Sub-case B: column present** — Migration IS marked applied when its DDL target column
   already exists. `probeAndMarkApplied` correctly skips it.

4. **Sub-case B: CREATE TABLE missing** — Migration NOT marked applied when the target table
   doesn't exist (e.g., T528 with `brain_page_nodes` absent).

Total reconciler tests: 8 (4 new + 4 existing Scenario 3 tests).

## Acceptance Criteria

- [x] Sub-case B no longer wholesale-marks-applied (probeAndMarkApplied wired v2026.4.54)
- [x] All ensureColumns bandaids for T528/T531/T549 removed (this commit)
- [x] Fresh upgrade produces correct schema (probeAndMarkApplied leaves missing columns for migrate())
- [x] Tests added for reconciler edge cases (4 new Scenario 2 Sub-case A/B tests)

## Files Changed

- `/mnt/projects/cleocode/packages/core/src/store/brain-sqlite.ts` — removed T528/T531/T549 ensureColumns bandaids
- `/mnt/projects/cleocode/packages/core/src/store/__tests__/migration-reconcile.test.ts` — 4 new Scenario 2 tests

## Quality Gates

- `pnpm biome check --write` — clean, no fixes applied
- `pnpm run build` — Build complete
- `pnpm --filter @cleocode/core run test` — 3943 passed, 0 failures
- `migration-reconcile.test.ts` — 8 tests, all passed
