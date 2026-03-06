# T5365 Complete: nexus.db Schema + SQLite Init

## Files Created
- `src/store/nexus-schema.ts` — 3 tables (project_registry, nexus_audit_log, nexus_schema_meta) with indexes and type exports
- `src/store/nexus-sqlite.ts` — singleton init pattern matching brain-sqlite.ts, global ~/.cleo/ path
- `drizzle-nexus.config.ts` — drizzle-kit config for nexus schema
- `drizzle-nexus/20260305070805_quick_ted_forrester/` — migration directory

## Migration files
- `drizzle-nexus/20260305070805_quick_ted_forrester/migration.sql` — CREATE TABLE for all 3 tables + 8 indexes
- `drizzle-nexus/20260305070805_quick_ted_forrester/snapshot.json` — drizzle-kit snapshot

## Validation Results
- npx tsc --noEmit: 0 errors in new files (1 pre-existing error in src/core/nexus/permissions.ts unrelated to this task)
- drizzle-nexus/ contents: migration.sql (1875 bytes) + snapshot.json (10324 bytes)

## Exported functions from nexus-sqlite.ts
- `getNexusDbPath()` — returns path to ~/.cleo/nexus.db
- `resolveNexusMigrationsFolder()` — returns path to drizzle-nexus/ migrations
- `getNexusDb()` — async singleton initializer, returns Drizzle ORM instance
- `closeNexusDb()` — close connection and release resources
- `resetNexusDbState()` — reset singleton for tests
- `getNexusNativeDb()` — get underlying DatabaseSync instance
- `NEXUS_SCHEMA_VERSION` — '1.0.0' constant
- `nexusSchema` — re-exported schema namespace
- `SqliteRemoteDatabase` — re-exported type

## Key Design Decisions
- nexus.db lives in `~/.cleo/` (global home via `getCleoHome()`) not per-project `.cleo/`
- No `allowExtension: true` (no sqlite-vec needed for nexus)
- Bootstrap logic checks for `project_registry` table (primary table)
- Indexes on audit log: timestamp, action, project_hash, project_id, session_id
- Indexes on registry: project_hash, health_status, name

## Status: COMPLETE
