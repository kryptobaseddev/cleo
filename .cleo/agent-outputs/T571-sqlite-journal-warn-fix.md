# T571 — Fix SQLite Stale Migration Journal WARN

**Date**: 2026-04-14
**Status**: complete
**File changed**: `packages/core/src/store/migration-manager.ts`

## Root Cause

Every `cleo` command fired two WARN-level logs:

```
{"level":"WARN","subsystem":"sqlite","orphaned":6,"msg":"Detected stale migration journal entries from a previous CLEO version. Reconciling."}
{"level":"WARN","subsystem":"brain","orphaned":5,"msg":"Detected stale migration journal entries from a previous CLEO version. Reconciling."}
```

The cause was a **forward-compatibility gap** in `reconcileJournal` (Scenario 2). The globally-installed `cleo` binary only knows about the initial migration (1 file), but the live databases (`tasks.db`, `brain.db`) had journal entries for all 7 (tasks) and 6 (brain) migrations written by a newer version of cleo run from source.

The old Scenario 2 logic only distinguished "any DB entry not in local set = orphaned = delete all + re-seed". It could not tell the difference between:

- **Sub-case A**: DB is AHEAD (newer install wrote extra entries, this install is older) — safe to keep
- **Sub-case B**: DB has stale hashes from genuinely old cleo (hash algorithm changed) — must delete and re-seed

This caused an infinite reconciliation cycle for Sub-case A:
1. Global (old) install sees 7 DB entries, recognises only 1 → "6 orphaned" WARN → deletes all → re-inserts 1
2. Drizzle's `migrate()` sees 6 pending migrations → runs them → inserts 6 journal entries
3. DB now has 7 entries again
4. Next `cleo` command: cycle repeats from step 1

## Fix

Added a discriminating check inside the `hasOrphanedEntries` branch of Scenario 2 in `reconcileJournal`:

```typescript
const dbHashes = new Set(dbEntries.map((e) => e.hash));
const allLocalHashesPresentInDb = localMigrations.every((m) => dbHashes.has(m.hash));

if (allLocalHashesPresentInDb) {
  // Sub-case A: DB is ahead — do NOT modify journal, log at debug
  log.debug(...)
} else {
  // Sub-case B: Genuine stale hashes — delete and re-seed (original behaviour)
  log.warn(...)
  nativeDb.exec('DELETE FROM "__drizzle_migrations"');
  ...
}
```

**Distinguishing heuristic**: if ALL local migration hashes are already present in the DB, the DB is a superset of what this install knows — it is ahead, not behind. The extra entries are legitimate (written by a newer version) and must not be deleted.

## Verification

- `pnpm biome check` — clean, no fixes applied
- `pnpm run build` — Build complete
- `pnpm run test` — 7311 passed, 0 failures
- `cleo session status 2>&1 | grep -c WARN` → 0
- `cleo next 2>&1 | grep -c WARN` → 0
- `cleo current 2>&1 | grep -c WARN` → 0
- `cleo find "test" 2>&1 | grep -c WARN` → 0
- Global install updated: `npm install -g packages/cleo`
- tasks.db journal: 7 entries (all preserved)
- brain.db journal: 6 entries (all preserved)

## Files Changed

- `/mnt/projects/cleocode/packages/core/src/store/migration-manager.ts` — Scenario 2 sub-case discrimination
