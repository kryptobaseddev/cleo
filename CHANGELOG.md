# Changelog

## [Unreleased]

## [2026.3.59] - 2026-03-22

### Added
- **Agent health monitoring**: `cleo agents health` — heartbeat, stale/crash detection (T039, 25 tests)
- **Retry utility**: `withRetry()` exponential backoff in `lib/retry.ts` (T040, 16 tests)
- **Agent registry**: Capacity tracking, specializations, performance recording (T041, 21 tests)
- **Impact prediction**: `cleo reason impact --change <text>` — dependency analysis (T043)
- **Reasoning CLI**: `cleo reason why|similar|impact|timeline` — CLI parity (T044)
- **SharingStatus**: Git sync fields for Nexus visibility (T110)

### Changed
- **Config vaporware audit (T101)**: Removed ~170 dead config fields across schema/templates/presets
- **Strictness presets**: Fixed phantom `hierarchy.requireAcceptanceCriteria` key (T107)

### Assessed
- **Nexus**: Zero production usage — deferred to Phase 3 (T045)

## [2026.3.58] - 2026-03-22

### Added
- **Enforcement gates**: Session required for mutations, AC required on creation (min 3), verification gates required for completion, orphan tasks blocked (must have parent epic) — all in strict mode
- **Pipeline stage binding**: RCASD-IVTR+C auto-assignment, forward-only transitions (T060)
- **Verification gate auto-init**: Tasks get verification metadata on creation (T061)
- **Epic lifecycle enforcement**: Min 5 AC, child stage ceiling, advancement gates (T062)
- **Workflow compliance telemetry**: `cleo stats compliance` dashboard (T065)
- **Task backfill**: `cleo backfill [--dry-run]` for existing tasks (T066)
- **Strictness presets**: `cleo config set-preset strict|standard|minimal` (T067)
- **Agent dimension**: Execution learning, self-healing patterns (T034)
- **Intelligence dimension**: Adaptive validation, confidence scoring (T035)
- **ERD diagrams**: Mermaid ERDs for all 3 databases (T036)
- **Skills updated**: Mandatory workflow rules WF-001 through WF-005 (T063)
- **ct-validator skill**: Gate enforcement skill (T064)
- **Agent code quality rules**: Added to AGENTS.md for all subagents

### Fixed
- CTE column mismatch (#61): Rewritten to column-independent ID-only pattern
- Table constraint loss (#62): Migration uses proper CREATE TABLE with constraints
- Session FK ordering: Insert new session before updating predecessor.nextSessionId
- `closeDb()` production bug: Now resets `_initPromise` to prevent stale connections
- `tasks.add` dispatch: acceptance, phase, size, notes, files params now passed through
- `--acceptance` delimiter: Changed from comma to pipe for AC items with commas
- Config templates: enforcement/verification/lifecycle fields added with strict defaults
- `complete.ts` defaults: Corrected from warn→block, off→strict
- Test infrastructure: 141→0 test failures via centralized VITEST enforcement bypass
- Schema hardening: 9 composite indexes, 17 soft FKs hardened, PRAGMA foreign_keys=ON

### Changed
- Config templates ship with 100% strict enforcement defaults
- `loadCompletionEnforcement` honors explicit config values in test mode

## [2026.3.57] (2026-03-21)

### Fixed
- Remove install-global hints from self-update (postinstall handles bootstrap)
- Template version bumped to 2.2.0 for refresh verification
- Remove packageRoot override from install-global and postinstall

## [2026.3.56] (2026-03-21)

### Fixed
- **Template refresh on install**: install-global and postinstall were passing packageRoot pointing to @cleocode/cleo, but templates live in @cleocode/core. Bootstrap now resolves from core getPackageRoot() without override.

## [2026.3.55] (2026-03-21)

### Fixed
- **CRITICAL: CLEO-INJECTION.md template was stale in npm package** — agents received old MCP-first template with deprecated `memory brain.search` operations. Template now correctly shows CLI-first, `memory find`, Runtime Environment section, and actual CLI command syntax.
- **CLI command syntax in template** — changed from wrong `cleo <domain> <operation>` to actual flat commands (`cleo find`, `cleo current`, `cleo dash`, etc.)
- **Session quick reference** — now shows CLI as primary with MCP fallback
- **Memory examples** — CLI-first (`cleo memory find "auth"` not MCP query)

## [2026.3.54] (2026-03-21)

### Changed
- **Dynamic template paths**: All `@` references in AGENTS.md now use `getCleoTemplatesTildePath()` — resolves to OS-appropriate XDG path (`~/.local/share/cleo/templates` on Linux, `~/Library/Application Support/cleo/templates` on macOS). No more hardcoded `~/.cleo/templates/`.
- **`getCleoTemplatesTildePath()`**: New path function that returns the templates dir as a `~`-prefixed string for cross-platform `@` references.

### Fixed
- **Template path mismatch**: AGENTS.md referenced `~/.cleo/templates/` but templates live at XDG path (`~/.local/share/cleo/templates/`). Now both reference and storage use the same dynamic path.

## [2026.3.53] (2026-03-21)

### Fixed
- **Global config.json**: Created from `global-config.template.json` during `ensureGlobalHome()` if missing.
- **Stale `templates/templates` symlink**: Added to STALE_GLOBAL_ENTRIES — was pointing to dev source in old installs.
- **Stale `.install-state/`**: Added to cleanup list.

## [2026.3.52] (2026-03-21)

### Fixed
- **Global scaffold cleanup works**: Was cleaning XDG path (`~/.local/share/cleo/`) but stale dirs were at legacy `~/.cleo/` path. Now cleans both locations.
- **CAAMP ^1.8.1**: Consolidates pre-existing duplicate blocks natively. Removed workaround that stripped all CAAMP blocks before inject.

## [2026.3.51] (2026-03-21)

### Fixed
- **Postinstall bootstrap import**: Fall back from `@cleocode/core/internal` (multi-file) to `@cleocode/core` (esbuild bundle) — `dist/internal.js` doesn't exist in published package.
- **bootstrapGlobalCleo exported from public barrel**: Now available via `@cleocode/core` import, not just `@cleocode/core/internal`.

## [2026.3.50] (2026-03-21)

### Fixed
- **Postinstall detection**: Replaced broken `process.argv[1]` check with `npm_config_global`, `lib/node_modules` path check, and pnpm workspace marker detection.
- **Postinstall import path**: Changed from broken `../dist/core/bootstrap.js` to `@cleocode/core/internal` which resolves correctly in published package.
- **esbuild bundle dynamic import**: Changed `ensureGlobalHome()` from dynamic import to static import so esbuild includes it in the single-file bundle.
- **Global scaffold cleanup**: Now actually runs during bootstrap — removes stale project-level dirs from `~/.cleo/`.

## [2026.3.49] (2026-03-20)

### Fixed
- **CAAMP block duplication**: Strip ALL existing CAAMP blocks before inject() — workaround for CAAMP not consolidating pre-existing duplicates (CAAMP issue #48)
- **Global scaffold cleanup**: Bootstrap now calls `ensureGlobalHome()` which removes stale project-level dirs from `~/.cleo/`
- **Stale cleo-subagent symlink**: Now detects symlinks pointing to wrong target and recreates them pointing to the npm package path

## [2026.3.48] (2026-03-20)

### Added
- **`cleo detect` command**: Standalone lightweight re-detection of project type. Updates project-context.json without full init or upgrade.
- **`cleo upgrade --detect`**: Force re-detection ignoring staleness schedule.
- **`cleo upgrade --map-codebase`**: Run full codebase analysis and store findings to brain.db.
- **`cleo upgrade --name <name>`**: Programmatically update project name in project-info.json and nexus registry.
- **`updateProjectName()`**: Core function in project-info.ts (SSoT for project name updates).

### Changed
- **init/upgrade boundary**: `--update-docs` removed from init. All maintenance goes through `cleo upgrade`.
- **`--refresh` alias removed** from init (keep flags simple, `--detect` only).
- **Fix hints** across injection.ts and doctor/checks.ts now say `cleo upgrade` instead of `cleo init --update-docs`.

### Fixed
- **CLI version**: Now reads from package.json at runtime instead of build-time constant.
- **stripCLEOBlocks**: Handles versioned legacy markers (`<!-- CLEO:START v0.53.4 -->`).
- **Global scaffold cleanup**: Removes stale project-level dirs from `~/.cleo/` on bootstrap.
- **cleo-subagent symlink**: Installed via `bootstrapGlobalCleo` using `require.resolve` for npm package path.

## [2026.3.47] (2026-03-20)

### Fixed
- **CLI version** reports runtime package.json version instead of build-time constant
- **stripCLEOBlocks** handles versioned legacy markers (`<!-- CLEO:START v0.53.4 -->`)
- **Global scaffold cleanup** removes stale project-level dirs from `~/.cleo/` on bootstrap (adrs, rcasd, agent-outputs, backups, sandbox, tasks.db, schemas, bin)
- **cleo-subagent symlink** installed via `bootstrapGlobalCleo` using `require.resolve` for npm package path
- **Bootstrap regex** fixed in both inline copies in bootstrap.ts

## [2026.3.46] (2026-03-20)

### Fixed
- **MCP `tasks.find` E_NOT_INITIALIZED** (T073): All 10 domain handlers deferred `getProjectRoot()` from constructor to request time, fixing initialization failures in MCP transport.
- **MCP `session.start --scope global` rejected** (T074): Fixed broken regex in `operation-gate-validators.ts` that required `global:` (with colon) instead of accepting bare `"global"`.
- **Bare catch blocks in task-engine.ts** (T073): `taskFind` and `taskList` now properly distinguish `E_NOT_FOUND`, `E_INVALID_INPUT`, and `E_NOT_INITIALIZED` errors instead of masking all as initialization failure.
- **681 duplicate CAAMP blocks in `~/.agents/AGENTS.md`** (T084): Upgraded to CAAMP v1.8.0 with native idempotent `inject()`. Removed workaround guards.
- **skill-paths.ts CAAMP path bug** (T085): Was using `getAgentsHome()` instead of `getCanonicalSkillsDir()`, causing skill resolution to look in wrong directory.
- **Broken cleo-subagent symlink**: Fixed stale symlink pointing to dev source path.

### Changed
- **CLI-First Pivot** (T078): All skills (ct-cleo, ct-orchestrator, ct-memory) now show CLI as primary channel, MCP as fallback.
- **Dependency Consolidation**: `@cleocode/core` now bundles adapters, skills, and agents as workspace deps. `@cleocode/cleo` slimmed to core + MCP SDK + citty only.
- **CAAMP ^1.8.0**: Idempotent `inject()`, `ensureProviderInstructionFile()` API, skill lock file support.
- **LAFS ^1.8.0**: Updated protocol dependency.
- **Templates/schemas moved into `packages/core/`**: No longer symlinked from root. Shipped in npm package via `getPackageRoot()`.
- **Global scaffold cleanup**: Removed project-level dirs (`adrs/`, `rcasd/`, `agent-outputs/`, `backups/`, `tasks.db`) from `~/.cleo/`. Schemas read from npm binary at runtime.
- **Skills install global-only**: Skills installation moved from project `init` to global bootstrap only.
- **Windows symlink support**: Directory symlinks use `junction` type on Windows.
- **Injection chain**: Project AGENTS.md now references `@~/.agents/AGENTS.md` (global hub) instead of template directly.
- **CleoOS detection**: CLEO-INJECTION.md includes `${CLEO_RUNTIME:-standalone}` mode with channel routing table.

### Added
- **Skills-registry validator** (T079): `packages/skills/scripts/validate-operations.ts` — automated drift detection between skills and canonical registry.
- **Capability matrix SSoT** (T076): Merged `capability-matrix.ts` + `routing-table.ts` into single source with 211 operations, required `preferredChannel` field.

### Removed
- `cleoctl` binary alias (stale separation-era artifact).
- `injection-legacy.ts` and its test (mapped CLAUDE.md/GEMINI.md — no longer valid).
- Root `templates/` and `schemas/` directories (moved into `packages/core/`).
- 30+ deprecated operation references across skills (`research` domain, `memory.brain.*`, `system` domain, `tasks.exists`, `admin.grade`).

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

[Unreleased]: https://github.com/kryptobaseddev/cleo/compare/v2026.3.59...HEAD
[2026.3.59]: https://github.com/kryptobaseddev/cleo/compare/v2026.3.58...v2026.3.59
[2026.3.58]: https://github.com/kryptobaseddev/cleo/compare/v2026.3.57...v2026.3.58
