# T5366 Complete: Registry SQLite Migration

## Files Modified
- `src/core/nexus/registry.ts` — Rewritten from JSON backend to Drizzle ORM (nexus.db)
- `src/core/nexus/permissions.ts` — Updated to use nexusSetPermission() instead of direct JSON writes
- `src/core/nexus/index.ts` — Added nexusSetPermission, resetNexusDbState exports
- `src/core/nexus/__tests__/registry.test.ts` — Updated for SQLite backend, reset nexus.db singleton per test

## Files Created
- `src/core/nexus/migrate-json-to-sqlite.ts` — JSON-to-SQLite migration with upsert, UUID fallback, and .migrated rename

## Validation Results
- npx tsc --noEmit: 0 errors (clean)
- npx vitest run registry.test.ts: 22 tests, all passing

## Key Design Decisions
- readRegistry()/readRegistryRequired() kept as compatibility wrappers returning NexusRegistryFile shape from SQLite
- nexusSetPermission() added to avoid permissions.ts needing direct JSON writes
- NexusProject type gained optional `projectId` field
- migrateJsonToSqlite() called lazily from nexusInit() when nexus.db is empty and JSON exists
- getRegistryPath() kept but marked @deprecated for migration use only
- resetNexusDbState re-exported from registry.ts for test convenience

## Status: COMPLETE
