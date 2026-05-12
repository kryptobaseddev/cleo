# T9164: Nexus is_external Forward Migration

**Status**: complete  
**Task**: T9164  
**Epic**: T9163  
**Commit**: b3a5989e8c7dc347fa4ecd4eb42231da5ad72203 (branch task/T9164)

## Summary

Added the missing `is_external` INTEGER column to `nexus_nodes` via an explicit
Drizzle forward migration. Previously the column was only created by the
`ensureColumns()` safety net in `nexus-sqlite.ts`, causing a warning on every
fresh `cleo init`.

## Files Changed

- `packages/core/migrations/drizzle-nexus/20260507135519_t9163-nexus-is-external/migration.sql`
- `packages/core/migrations/drizzle-nexus/20260507135519_t9163-nexus-is-external/snapshot.json`

## Migration SQL

```sql
ALTER TABLE `nexus_nodes` ADD COLUMN `is_external` integer NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE INDEX `idx_nexus_nodes_is_external` ON `nexus_nodes` (`is_external`);
```

## Acceptance Criteria Verification

1. New migration.sql added under drizzle-nexus with ALTER TABLE statement.
2. Folder name follows convention: `20260507135519_t9163-nexus-is-external`.
3. snapshot.json updated (new id, prevIds pointing to sigils snapshot).
4. Fresh cleo init: migration creates column via Drizzle, no safety-net warning.
5. Existing tests pass: migration-smoke (19), migration-reconcile (11), t920 (4) = 34 total.
6. Legacy DBs: duplicate-column error handled by Scenario 3 Case A in reconcileJournal.
7. ensureColumns() safety-net for is_external retained in nexus-sqlite.ts (not removed).

## Hard Guardrails Respected

- Did NOT modify `20260412000001_t529-nexus-graph-tables/migration.sql`.
- Did NOT remove the `ensureColumns([{ name: 'is_external', ... }])` call.
- Did NOT use `IF NOT EXISTS` on ALTER TABLE (SQLite syntax error).
- Statement-breakpoint added between ALTER TABLE and CREATE INDEX.

## Quality Gates

- Biome CI: passed (0 errors, 0 warnings on modified files).
- Migration linter: 0 errors (47 pre-existing WARN-level inconsistent snapshot chain).
- Tests: 34 passed, 0 failed (migration-smoke, migration-reconcile, t920).
