# Wave 0 Completion Report: Schema Hardening - Data Integrity

**Date**: 2026-03-20
**Phase**: Wave 0 - Data Integrity
**Status**: COMPLETE
**Migration**: `20260320013731_wave0-schema-hardening`

---

## Summary

All schema hardening changes for Wave 0 have been applied to the CLEO tasks.db schema
(tasks-schema.ts and chain-schema.ts). Build and all 4386 tests pass with zero regressions.

---

## Foreign Keys Added

| Table | Column | Target | Cascade Behavior | Notes |
|-------|--------|--------|-------------------|-------|
| `warp_chain_instances` | `chain_id` | `warp_chains.id` | ON DELETE CASCADE | Was missing cascade; orphaned instances would remain after chain deletion |
| `sessions` | `previous_session_id` | `sessions.id` | ON DELETE SET NULL | Self-referential FK; preserves session when linked predecessor is deleted |
| `sessions` | `next_session_id` | `sessions.id` | ON DELETE SET NULL | Self-referential FK; preserves session when linked successor is deleted |

---

## Indexes Added

### HIGH PRIORITY

| Table | Column(s) | Index Name | Rationale |
|-------|-----------|------------|-----------|
| `tasks` | `session_id` | `idx_tasks_session_id` | Session-scoped task queries (provenance lookups) |
| `task_relations` | `related_to` | `idx_task_relations_related_to` | Reverse relationship lookups ("what relates TO this task?") |
| `architecture_decisions` | `amends_id` | `idx_arch_decisions_amends_id` | ADR amendment chain traversal |

### MEDIUM PRIORITY

| Table | Column(s) | Index Name | Rationale |
|-------|-----------|------------|-----------|
| `audit_log` | `actor` | `idx_audit_log_actor` | Filter audit entries by actor/agent identity |
| `sessions` | `started_at` | `idx_sessions_started_at` | Temporal session queries, ordering by start time |
| `lifecycle_stages` | `validated_by` | `idx_lifecycle_stages_validated_by` | RCASD provenance: find stages validated by a specific agent |
| `token_usage` | `gateway` | `idx_token_usage_gateway` | Token telemetry filtering by gateway type |

---

## Constraints Added

| Table | Constraint Name | Type | Columns | Rationale |
|-------|----------------|------|---------|-----------|
| `external_task_links` | `uq_ext_links_task_provider_external` | UNIQUE | `(task_id, provider_id, external_id)` | Prevents duplicate sync entries; one CLEO task can link to one external task per provider |

---

## TODOs Completed

No TODO/FIXME/HACK/XXX comments were found in any of the three schema files
(`tasks-schema.ts`, `brain-schema.ts`, `nexus-schema.ts`) or `chain-schema.ts`.

---

## Files Modified

| File | Changes |
|------|---------|
| `packages/core/src/store/tasks-schema.ts` | Added `unique` import; added 7 indexes, 2 self-referential FKs on sessions, 1 UNIQUE constraint on external_task_links |
| `packages/core/src/store/chain-schema.ts` | Added `{ onDelete: 'cascade' }` to `warp_chain_instances.chain_id` FK |

## Files Created

| File | Description |
|------|-------------|
| `drizzle/migrations/drizzle-tasks/20260320013731_wave0-schema-hardening/migration.sql` | Generated migration SQL (drizzle-kit) |
| `drizzle/migrations/drizzle-tasks/20260320013731_wave0-schema-hardening/snapshot.json` | Generated migration snapshot (drizzle-kit) |
| `packages/core/migrations/drizzle-tasks/20260320013731_wave0-schema-hardening/migration.sql` | Runtime copy of migration SQL |
| `packages/core/migrations/drizzle-tasks/20260320013731_wave0-schema-hardening/snapshot.json` | Runtime copy of migration snapshot |

---

## Validation Results

- **Build**: PASS (all packages compile successfully)
- **Tests**: 4386 passed, 5 skipped (260 test files passed, 1 skipped)
- **Regressions**: None (identical test counts to pre-change baseline)

---

## Migration Strategy

The migration (`20260320013731_wave0-schema-hardening`) uses SQLite's table-rebuild pattern
for FK additions (sessions, warp_chain_instances) since SQLite does not support `ALTER TABLE
ADD CONSTRAINT`. The drizzle-kit-generated migration:

1. Creates `__new_<table>` with the correct FK constraints
2. Copies all data via INSERT...SELECT
3. Drops the original table
4. Renames the new table

Index additions and the UNIQUE constraint use standard `CREATE INDEX` / `UNIQUE` DDL.

---

## Notes

- The `external_task_links` composite index on `(provider_id, external_id)` already existed
  as `idx_ext_links_provider_external`. The new UNIQUE constraint
  `uq_ext_links_task_provider_external` adds `task_id` to enforce uniqueness across the
  three-column combination.
- `brain-schema.ts` and `nexus-schema.ts` were reviewed but required no changes. All FKs in
  brain.db are soft (cross-database references to tasks.db), which is the correct pattern
  for separate SQLite databases.
- No existing columns, tables, or constraints were removed.
