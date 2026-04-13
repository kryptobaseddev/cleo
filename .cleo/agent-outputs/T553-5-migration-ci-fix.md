# T553-5: Brain Migration + CI Fix

**Task**: Fix brain.db missing columns (T528/T531/T549) + GitHub CI failures
**Date**: 2026-04-13
**Status**: complete

## Root Cause Analysis

### Bug 1: brain.db missing columns

Two compounding issues:

1. **Migration files never committed to git** — The T528/T531/T549 migration SQL files were created locally but `.gitignore` contains `migrations/` which blocked them from being tracked. In CI (fresh clone), these files do not exist, so `readMigrationFiles` never finds them, and the new columns are never created.

2. **No `ensureColumns` safety net** — `brain-sqlite.ts` called `migrateWithRetry` but had no fallback for the case where migration files are absent.

### Bug 2: GitHub CI failures

All CI failures in the last 3 runs trace back to Bug 1:
- `table brain_observations has no column named quality_score` — T531 columns missing
- `table brain_observations has no column named memory_tier` — T549 columns missing  
- `brain-migration.test.ts:134` failures (patternsImported expected 1, got 0) — INSERT fails silently due to missing columns

The performance test failure (`should create 50 tasks within <10000ms`) passes in CI (893ms); local failure is system-load flakiness unrelated to our changes.

## Fix 1: Force-add migration SQL files to git

```
packages/core/migrations/drizzle-brain/20260411000001_t528-graph-schema-expansion/migration.sql
packages/core/migrations/drizzle-brain/20260412000001_t531-quality-score-typed-tables/migration.sql
packages/core/migrations/drizzle-brain/20260413000001_t549-tiered-typed-memory/migration.sql
```

Used `git add -f` to bypass the `migrations/` entry in `.gitignore`. The earlier migration files (initial, t033, t417) were already tracked because they predated the gitignore entry.

## Fix 2: ensureColumns safety net in brain-sqlite.ts

Added `ensureColumns` calls in `runBrainMigrations()` after `migrateWithRetry()`:

- **T528** (`brain_page_nodes`): `quality_score`, `content_hash`, `last_activity_at`, `updated_at`
- **T531** (all 4 typed tables): `quality_score`
- **T549** (all 4 typed tables): `memory_tier`, `memory_type`, `verified`, `valid_at`, `invalid_at`, `source_confidence`, `citation_count`

**Critical detail**: `valid_at` and `last_activity_at` use plain `text` DDL (no `datetime('now')` default) in `ensureColumns` because SQLite's `ALTER TABLE ADD COLUMN` rejects non-constant defaults on non-empty tables. The full migration SQL uses `DEFAULT (datetime('now'))` which works for fresh table creation; the `ensureColumns` fallback omits the default to stay safe.

## Files Modified

- `/mnt/projects/cleocode/packages/core/src/store/brain-sqlite.ts` — Added `ensureColumns` import and calls
- `/mnt/projects/cleocode/packages/core/migrations/drizzle-brain/20260411000001_t528-graph-schema-expansion/migration.sql` — Force-added to git
- `/mnt/projects/cleocode/packages/core/migrations/drizzle-brain/20260412000001_t531-quality-score-typed-tables/migration.sql` — Force-added to git
- `/mnt/projects/cleocode/packages/core/migrations/drizzle-brain/20260413000001_t549-tiered-typed-memory/migration.sql` — Force-added to git

## Verification

```
# Live brain.db: ensureColumns added all missing columns on first run
node packages/cleo/dist/cli/index.js memory observe "test" --title "T553 test" --json
# → {"success":true,"data":{"id":"O-mnxgps85-0",...}}

# Idempotency: second run produces no column warnings
node packages/cleo/dist/cli/index.js memory observe "test2" --title "second" --json
# → {"success":true,...} (no ALTER TABLE warnings)

# Build: passes
pnpm run build → Build complete

# Tests: 396/396 files pass
pnpm run test → Test Files 396 passed (396), Tests 7130 passed
```

## Dual Defense Strategy

The fix employs two layers:
1. **Primary**: Migration SQL files now in git → fresh CI clones run them via Drizzle
2. **Fallback**: `ensureColumns` in `brain-sqlite.ts` → handles edge cases where migration files are absent or journal is corrupt
