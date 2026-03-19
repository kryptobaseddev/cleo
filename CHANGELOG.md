# Changelog

## [2026.3.39] (2026-03-19)

### Fixed
- **CI/CD Pipeline**: Fixed pnpm version conflict in release workflow, added agents and skills packages to version sync and npm publish
- **Error Handling**: Created central error utilities in contracts package with proper TypeScript types
- **CLI Type Safety**: Completely removed commander-shim, migrated to clean citty-based CLI with zero `any` types
- **CAAMP Integration**: Updated to @cleocode/caamp@1.7.1 with proper exports, removed mock files
- **Documentation**: Added comprehensive README files for root and all packages
- **Code Quality**: Fixed all lint warnings, updated biome.json schema

## [2026.3.38] (2026-03-19)

Auto-prepared by release.ship (T021)

### Chores
- **Migrate parallel-state.json to SQLite**: Move orchestration/parallel.ts state from .cleo/parallel-state.json into SQLite schema_meta or new table. Eliminates JSON clobbering when parallel ... (T022)

### Changes
- **Eliminate _meta.activeSession pointer — use SQL query**: Replace activeSession pointer in file_meta with dynamic SQL: SELECT FROM sessions WHERE status=active. Remove from FileMeta, session-switch, sessio... (T021)
- **Wrap add/update/complete/delete in transaction()**: Wrap full read-validate-write flow in add.ts, update.ts, complete.ts, delete.ts inside accessor.transaction() for TOCTOU safety under concurrent mu... (T023)
- **SQL-level position allocation in add.ts**: Replace JS position computation with SQL: INSERT SELECT COALESCE(MAX(position),0)+1. Eliminates TOCTOU where concurrent adds get same position. (T024)
- **Bulk SQL for task reorder operations**: Replace per-task upsertSingleTask loop with single UPDATE tasks SET position=position+1 WHERE parent_id=? AND position>=?. Eliminates N+1 pattern. (T025)
- **Replace saveSessions(array) with upsertSingleSession**: Make upsertSingleSession required on DataAccessor. Replace all saveSessions bulk writes with per-session targeted writes. Eliminates session array ... (T026)
- **Async background embedding for brain memory**: Make embedding generation in observeBrain fire-and-forget via async queue. Currently synchronous and blocks CLI/Agent during LLM embedding calls. (T027)
- **Memory decay — confidence decay for old memories**: Add decay factor so old unreferenced memory drops from context window. Implement as decay multiplier based on age and reference count. (T028)
---
