# Changelog

## [2026.3.45] (2026-03-20)

### Added
- **Nexus Task Transfer** (T046): Cross-project task transfer with `nexus.transfer` (mutate) and `nexus.transfer.preview` (query) operations. Supports copy/move modes, subtree/single scope, bidirectional `external_task_links` with `'transferred'` link type, brain observation transfer, provenance tracking, and conflict resolution strategies.
- `importFromPackage()` — extracted from `importTasksPackage()` for in-memory ExportPackage import without file I/O.
- 19 new transfer test cases covering copy/move modes, ID remapping, hierarchy/dependency preservation, link creation, conflict resolution, and error handling.
- `transfer` verb added to VERB-STANDARDS.md deferred verbs table.

### Fixed
- **Migration path resolution**: `resolveMigrationsFolder()`, `resolveBrainMigrationsFolder()`, and `resolveNexusMigrationsFolder()` now correctly detect bundled (`dist/`) vs source (`src/store/`) context when resolving migration paths. Previously, esbuild-bundled builds would resolve to wrong directory (2 levels up from `dist/` instead of 1).

## [2026.3.44] (2026-03-20)

### Added
- **Agent Dimension** (100%): Agent registry, health monitoring (30s crash detection), self-healing with exponential backoff, capacity tracking and load balancing. New `agent_instances` and `agent_error_log` tables.
- **Intelligence Dimension** (100%): Quality prediction (4-factor risk scoring), pattern extraction from brain.db, impact analysis with BFS/DFS graph traversal and blast radius calculation.
- **Validation Contracts**: 36 canonical Zod enum schemas backed by `as const` constants. 13 table schemas with business logic refinements. 14 hook payload Zod schemas with `validatePayload()` dispatcher.
- **Nexus E2E Tests**: 89 integration tests covering registry, audit, health, permissions, cross-project refs, orphan detection, and discovery. Fixed `extractKeywords()` case handling bug.
- **Schema Integrity**: 3 hard foreign keys (warp_chain_instances CASCADE, sessions prev/next SET NULL), 16 indexes, 1 UNIQUE constraint on external_task_links.
- **Database ERDs**: Mermaid diagrams for all 3 databases (tasks.db, brain.db, nexus.db).
- **Type Contracts Documentation**: Full public API surface (43 namespaces) documented.

### Changed
- **BREAKING**: `TaskFile` interface removed from `@cleocode/contracts`. Use `Task[]` from `DataAccessor.queryTasks()` directly.
- **BREAKING**: `TaskFileExt`, `TaskFileTaskEntry`, `TaskFileMetaExt`, `toTaskFileExt()` removed from sessions module.
- **BREAKING**: `buildPrompt()`, `spawn()`, `spawnBatch()`, `canParallelize()`, `orchestratorSpawnSkill()`, `injectProtocol()`, `buildTaskContext()`, `validateOrchestratorCompliance()`, `validateContributionTask()` are now async. Add `await` at call sites.
- **BREAKING**: `buildExportPackage()`, `exportSingle()`, `exportSubtree()` signatures changed — pass `projectName` in options instead of `TaskFile`.
- Public barrel now exports 43 namespaces (added `agents`, `intelligence`).
- CORE-PACKAGE-SPEC updated to v3.0.0 with section 15.5 documenting all breaking changes.
- Facade API (`Cleo.init()`) is unchanged — no impact on facade consumers.

### Fixed
- **ADR-006 Compliance**: All task/session/focus JSON file reads replaced with DataAccessor → SQLite queries across 7 files (12 functions).
- **Focus Meta Key**: Unified from split `'focus'`/`'focus_state'` to `'focus_state'` everywhere.
- **Pipeline Stage Source**: `computePipelineStage` now queries `lifecycle_pipelines` table directly instead of `file_meta` KV store.
- **Inline Enum Drift**: 4 hardcoded Zod enum arrays extracted to `as const` constants (TASK_RELATION_TYPES, LIFECYCLE_TRANSITION_TYPES, EXTERNAL_LINK_TYPES, SYNC_DIRECTIONS).
- **Type Safety**: `as unknown as` casts reduced from 9 to 4 (remaining are node:sqlite and drizzle-orm library boundaries).
- **Agent Suppressions**: 5 underscore-prefixed params introduced by agents wired into real implementations.

### Removed
- `tasks/reparent.ts` — dead code; `task-ops.ts` has the DataAccessor-based implementation.
- `getSessionsPath()` — zero callers remaining (sessions are in SQLite).
- All `sessions.json`, `tasks.json`, `focus.json` file reads from non-migration code.

## [2026.3.43] (2026-03-19)

### Fixed
- **Build**: Generate `.d.ts` type declarations in `build.mjs` via `tsc --emitDeclarationOnly` after esbuild bundling. esbuild produces single-file `.js` bundles but doesn't emit TypeScript declarations, so consumers of `@cleocode/core` and `@cleocode/adapters` were getting packages with no type information.

## [2026.3.42] (2026-03-19)

### Fixed
- **npm Publish**: Add `.npmignore` to all publishable packages. Root `.gitignore` had `dist/` which caused pnpm publish to exclude the entire `dist/` directory (including all `.d.ts` type declarations and sub-module `.js` files) from published tarballs. Consumers got packages with `types` pointing to non-existent files. This was broken since the first publish.

## [2026.3.41] (2026-03-19)

### Fixed
- **Release Workflow**: Fix `cd` navigation bug in npm publish step that caused all packages after the first to fail. Use `pushd`/`popd` for reliable directory handling and tolerate "already published" errors.

## [2026.3.40] (2026-03-19)

### Added
- **Task Reconciliation Engine**: Provider-agnostic external task sync system in `@cleocode/core`. Consumers implement `ExternalTaskProvider` to sync any issue tracker (Linear, Jira, GitHub, GitLab) with CLEO as SSoT.
- **External Task Links**: New `external_task_links` table in tasks.db for DB-backed bidirectional traceability between CLEO tasks and external system tasks.
- **Link Store API**: `createLink`, `getLinksByProvider`, `getLinksByTaskId`, `getLinkByExternalId`, `touchLink`, `removeLinksByProvider` in `@cleocode/core`.
- **Cleo Facade SyncAPI**: `cleo.sync.reconcile()`, `cleo.sync.getLinks()`, `cleo.sync.getTaskLinks()`, `cleo.sync.removeProviderLinks()`.
- **Dispatch Operations**: `tasks.sync.reconcile` (mutate), `tasks.sync.links` (query), `tasks.sync.links.remove` (mutate) — wired through registry, capability matrix, task engine, and domain handler.

### Removed
- **TodoWrite System**: Completely removed all TodoWrite code, types, contracts, CLI commands, dispatch operations, and file-based sync state (`todowrite-session.json`, `todowrite-state.json`).
  - Deleted: `contracts/todowrite.ts`, `core/task-work/todowrite-merge.ts`, `core/admin/sync.ts`, `core/reconciliation/sync-state.ts`, CLI `extract` and `sync` commands, `tools.todowrite.*` dispatch ops and registry entries.
  - Removed `todowrite` export format from `admin/export.ts`.
- **Stale Compiled Artifacts**: Cleaned all `.js`, `.d.ts`, `.js.map`, `.d.ts.map` files for deleted source modules.

### Changed
- **Contracts**: `AdapterTaskSyncProvider` renamed to `ExternalTaskProvider`. `ExternalTask` enriched with `priority`, `type`, `url`, `parentExternalId`. `SyncSessionState` removed (replaced by DB-backed links). `ReconcileResult` gains `updated`, `linksAffected`, `total` counts.
- **DRY requiredParams**: Moved param validation from 13 inline handler checks to `requiredParams` declarations in the dispatch registry for the entire tasks domain.

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
