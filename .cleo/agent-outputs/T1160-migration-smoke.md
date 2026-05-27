# T1160 — Migration Smoke Tests Output

## Summary

Created `packages/core/src/store/__tests__/migration-smoke.test.ts` with 16 passing tests covering all 4 acceptance criteria.

## Commit

SHA: `8164178542bf16b611a67b885494fccba071412f`
Message: `test(T1160): vitest smoke — 5-DB migrate clean + reconciler fixtures + runtime guard proof`

## Test Count

16 tests across 4 describe blocks, all passing.

## Test Breakdown

### Test 1: Fresh init — 5 DBs (5 tests)

- tasks.db via `getDb(tempDir)` — drizzle-tasks migrations, `tasks` table confirmed
- brain.db via `getBrainDb(tempDir)` — drizzle-brain migrations, `brain_decisions` table confirmed
- nexus.db via `getNexusDb()` with `vi.doMock` path override — drizzle-nexus migrations, `project_registry` table confirmed
- signaldock.db via `ensureGlobalSignaldockDb()` with `vi.doMock` path override — embedded runner, `agents` table confirmed
- telemetry.db via `getTelemetryDb()` with `vi.doMock` path override — drizzle-telemetry migrations, `telemetry_events` table confirmed

### Test 2: Null-name journal rows (5 tests)

- tasks.db, brain.db, nexus.db, telemetry.db: seed all migrations, NULL out all `name` columns, run `reconcileJournal`, assert names are backfilled and row count is unchanged.
- signaldock.db: documented as gap — its `_signaldock_migrations` table uses name-PK rows, not drizzle journal. Gap tracked under W2A-04.

### Test 3: Partial migration fixture (4 tests)

- tasks.db, brain.db, nexus.db, telemetry.db: run full migrations, delete one journal entry, run `reconcileJournal`, assert no duplicate-column error on re-run.

### Test 4: Runtime guard proof (2 tests)

- `migrateSanitized` succeeds on trailing-breakpoint migration and creates the table.
- Raw drizzle `migrate()` throws on the same malformed migration — guard is load-bearing.

## Signaldock Gap Note

signaldock.db uses an embedded migration runner (`_signaldock_migrations` + `applyGlobalSignaldockSchema`) rather than drizzle's `readMigrationFiles` / `migrate()` pipeline. The `drizzle-signaldock/` folder contains a reference SQL file (T897) that is inlined into `GLOBAL_EMBEDDED_MIGRATIONS` — it is NOT processed via drizzle `migrate()`. Tests 2/3/4 (which target the drizzle journal) are therefore N/A for signaldock. This gap is tracked under W2A-04.

## Evidence Gates

- `implemented`: commit `8164178542bf16b611a67b885494fccba071412f`, file `packages/core/src/store/__tests__/migration-smoke.test.ts`
- `testsPassed`: test-run `/tmp/vitest-core-out.json` — 5378 passed, 0 failed
- `qaPassed`: biome exit 0, tsc exit 0
