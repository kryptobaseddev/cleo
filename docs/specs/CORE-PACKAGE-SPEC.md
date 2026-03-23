# @cleocode/core Package Specification

**Version**: 3.3.0
**Status**: APPROVED
**Date**: 2026-03-23
**Task**: T5714
**Epic**: T5701

---

## 1. Overview

This specification defines the public contract for `@cleocode/core`, the standalone business logic package within the CLEO monorepo.

`@cleocode/core` encapsulates all domain logic for task management, session lifecycle, memory persistence, multi-agent orchestration, lifecycle gate enforcement, release management, and related capabilities. It is designed to be consumed by adapter layers (CLI, MCP, custom integrations) without embedding any adapter-specific code itself.

### Design Goals

- **Standalone**: Importable without the `@cleocode/cleo` product package
- **Adapter-neutral**: No imports from `packages/cleo/` (CLI, MCP, or dispatch)
- **Two-tier barrel**: Public API (`index.ts`) for external consumers, internal API (`internal.ts`) for `@cleocode/cleo`
- **Bundled storage**: The default SQLite store ships inside `packages/core/src/store/`
- **Dependency-injected storage**: Core modules accept a `DataAccessor` parameter for custom backends
- **ESM-first**: Full ES module package (`"type": "module"`, `.js` import paths)
- **Node 24+**: Targets the CLEO minimum Node.js version

---

## 2. Package Identity

| Field | Value |
|-------|-------|
| Package name | `@cleocode/core` |
| Registry | npm (`@cleocode` scope) |
| Version scheme | Semver (v2.0.0 for restructured monorepo) |
| Public entry point | `dist/index.js` (compiled from `packages/core/src/index.ts`) |
| Internal entry point | `dist/internal.js` (compiled from `packages/core/src/internal.ts`) |
| Type declarations | `dist/index.d.ts`, `dist/internal.d.ts` |
| Module format | ES modules (`"type": "module"`) |
| Minimum Node.js | 24 |
| TypeScript | 6.0.1-rc targeting ES2025 |
| Package manager | pnpm (workspace protocol) |
| License | MIT |

### Package.json Shape

```json
{
  "name": "@cleocode/core",
  "version": "2.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    },
    "./internal": {
      "import": "./dist/internal.js",
      "types": "./dist/internal.d.ts"
    },
    "./*": {
      "import": "./dist/*.js",
      "types": "./dist/*.d.ts"
    }
  },
  "dependencies": {
    "@cleocode/adapters": "workspace:*",
    "@cleocode/agents": "workspace:*",
    "@cleocode/caamp": "^1.8.1",
    "@cleocode/contracts": "workspace:*",
    "@cleocode/lafs-protocol": "^1.8.0",
    "@cleocode/skills": "workspace:*",
    "ajv": "^8.18.0",
    "ajv-formats": "^3.0.1",
    "drizzle-orm": "1.0.0-beta.19-d95b7a4",
    "env-paths": "^4.0.0",
    "js-tiktoken": "^1.0.21",
    "pino": "^10.3.1",
    "pino-roll": "^4.0.0",
    "proper-lockfile": "^4.1.2",
    "write-file-atomic": "^6.0.0",
    "yaml": "^2.8.2",
    "zod": "^3.25.76"
  }
}
```

### Subpath Exports

The package exposes three export conditions:

| Subpath | Purpose | Audience |
|---------|---------|----------|
| `"."` | Public API -- stable contract for external consumers | Anyone installing `@cleocode/core` |
| `"./internal"` | Internal API -- superset of public, additional symbols for `@cleocode/cleo` | Only `@cleocode/cleo` |
| `"./*"` | Deep imports -- escape hatch for advanced consumers (no stability guarantees) | Power users, adapters |

External consumers MUST import from `@cleocode/core` (the `"."` entry). The `"./internal"` entry is explicitly for the `@cleocode/cleo` product package and carries no stability guarantees beyond what the public API provides.

---

## 3. Two-Tier Barrel Architecture

### 3.1 Public Barrel (`index.ts`, ~235 lines)

The public barrel re-exports all symbols intended for external consumers:

1. **All `@cleocode/contracts` types** via `export * from '@cleocode/contracts'`
2. **45 namespace re-exports** (one per domain/submodule, including `agents`, `intelligence`, and `lib`)
3. **36 canonical Zod enum schemas** (flat re-exports for Pattern 3 imports)
4. **Store factory functions** (`createDataAccessor`, `getAccessor`)
5. **Top-level utility exports** (errors, config, logger, paths, platform, output, pagination, init, scaffold, audit, validation, project info, constants)
6. **Flat function re-exports** for direct imports (Pattern 3 -- tree-shakeable)
7. **Cleo facade class** and domain API interfaces

### 3.2 Internal Barrel (`internal.ts`, ~622 lines)

The internal barrel is a strict superset of the public API:

```typescript
// Re-export the entire public API
export * from './index.js';

// Extended flat exports required by @cleocode/cleo
export { computeHelp } from './admin/help.js';
export { exportTasks } from './admin/export.js';
// ... ~600 additional symbols
```

The internal barrel provides:

- Fine-grained function exports from every domain (admin, ADRs, agents, compliance, intelligence, lifecycle, memory, metrics, nexus, orchestration, OTel, phases, pipeline, release, remote, routing, security, sessions, skills, snapshot, sticky, stats, system, tasks, task-work, templates, validation)
- Store internals (`getDb`, `getBrainDb`, schema tables, validation schemas)
- Test helpers (`closeAllDatabases`, `closeDb`, `resetDbState`, `createSqliteDataAccessor`)
- Type exports for domain-specific result shapes

---

## 4. Module Structure

The public barrel (`packages/core/src/index.ts`) re-exports all public modules as named namespaces. The table below documents all 45 namespaces, their role, and whether they require a `DataAccessor` at runtime.

### 4.1 Domain Namespace Modules

| Namespace | Source path | Role | Requires DataAccessor |
|-----------|------------|------|----------------------|
| `adapters` | `packages/core/src/adapters/` | Provider adapter discovery, detection, lifecycle | No |
| `admin` | `packages/core/src/admin/` | Dashboard, health check, configuration map | Yes |
| `adrs` | `packages/core/src/adrs/` | Architecture Decision Record management | No |
| `agents` | `packages/core/src/agents/` | Agent registry, health monitoring (`recordHeartbeat`, `checkAgentHealth`, `detectStaleAgents`, `detectCrashedAgents`), self-healing retry, capacity tracking (`getAgentCapacity`, `getAgentsByCapacity`, `getAgentSpecializations`), execution learning | Yes (SQLite agent tables) |
| `caamp` | `packages/core/src/caamp/` | CAAMP wrapper -- provider capability API, spawn, skill routing | No |
| `codebaseMap` | `packages/core/src/codebase-map/` | Codebase structure analysis and module graph | No |
| `compliance` | `packages/core/src/compliance/` | Protocol compliance recording and value reporting | No |
| `context` | `packages/core/src/context/` | Context window drift monitoring and alerts | No |
| `coreHooks` | `packages/core/src/hooks/` | Lifecycle hook dispatch registry | No |
| `coreMcp` | `packages/core/src/mcp/` | MCP resource and tool registration helpers | No |
| `inject` | `packages/core/src/inject/` | AGENTS.md / CLAUDE.md content injection | No |
| `intelligence` | `packages/core/src/intelligence/` | Quality prediction, pattern extraction, impact prediction (`predictImpact`, `analyzeChangeImpact`, `calculateBlastRadius`), adaptive validation | Yes (uses brain.db + DataAccessor) |
| `issue` | `packages/core/src/issue/` | Issue and bug tracking | Yes |
| `lib` | `packages/core/src/lib/` | General-purpose utilities: `withRetry` (exponential backoff), `computeDelay`. No database coupling. | No |
| `lifecycle` | `packages/core/src/lifecycle/` | RCASD-IVTR+C gate enforcement, stage transitions | Yes (SQLite lifecycle tables) |
| `memory` | `packages/core/src/memory/` | Brain.db observations, search, 3-layer retrieval | No (uses brain.db directly) |
| `metrics` | `packages/core/src/metrics/` | Telemetry, value tracking, provider detection | No |
| `migration` | `packages/core/src/migration/` | Schema version detection and migration execution | Yes (SQLite) |
| `nexus` | `packages/core/src/nexus/` | Cross-project registry operations (nexus.db) | No (uses nexus.db) |
| `observability` | `packages/core/src/observability/` | Structured observability reporting | No |
| `orchestration` | `packages/core/src/orchestration/` | Dependency graph, wave analysis, progress metrics | Yes |
| `otel` | `packages/core/src/otel/` | OpenTelemetry integration, token usage recording | No |
| `phases` | `packages/core/src/phases/` | Execution wave computation, dependency maps | Yes |
| `pipeline` | `packages/core/src/pipeline/` | RCASD pipeline coordination and status | Yes |
| `release` | `packages/core/src/release/` | Changelog computation, version bump, ship pipeline | Yes |
| `remote` | `packages/core/src/remote/` | Remote sync push/pull operations | No |
| `research` | `packages/core/src/research/` | Research manifest operations, contradiction detection | Partial |
| `roadmap` | `packages/core/src/roadmap/` | Roadmap and milestone tracking | Yes |
| `routing` | `packages/core/src/routing/` | Internal operation routing utilities | No |
| `security` | `packages/core/src/security/` | Permission checks and access audit | No |
| `sequence` | `packages/core/src/sequence/` | Ordered operation sequencing | No |
| `sessions` | `packages/core/src/sessions/` | Session lifecycle, handoff, debrief, decisions | Yes |
| `signaldock` | `packages/core/src/signaldock/` | Inter-agent messaging transport (provider-neutral) | No |
| `skills` | `packages/core/src/skills/` | Skill routing table, precedence integration | No |
| `snapshot` | `packages/core/src/snapshot/` | Project state snapshot creation and restore | Yes |
| `spawn` | `packages/core/src/spawn/` | Subagent spawn coordination, registry | No |
| `stats` | `packages/core/src/stats/` | Task and session statistics aggregation | Yes |
| `sticky` | `packages/core/src/sticky/` | Sticky notes (persistent context anchors) | No |
| `system` | `packages/core/src/system/` | System and environment checks | No |
| `taskWork` | `packages/core/src/task-work/` | Active task tracking (start, stop, current) | Yes |
| `tasks` | `packages/core/src/tasks/` | Task CRUD, hierarchy, dependency validation, search | Yes |
| `templates` | `packages/core/src/templates/` | Template file management and rendering | No |
| `ui` | `packages/core/src/ui/` | Output rendering helpers (tables, trees) | No |
| `reconciliation` | `packages/core/src/reconciliation/` | Provider-agnostic task sync, external task link store | Yes (SQLite external_task_links) |
| `validation` | `packages/core/src/validation/` | Anti-hallucination validators, schema checks | No |

### 4.2 Store Layer Exports

The following store functions are exported directly from the public barrel:

| Export | Source | Purpose |
|--------|--------|---------|
| `createDataAccessor` | `packages/core/src/store/data-accessor.ts` | Factory: create a `DataAccessor` for a given project path |
| `getAccessor` | `packages/core/src/store/data-accessor.ts` | Cached factory: get-or-create a `DataAccessor` |

### 4.3 Top-Level Utility Exports

The following symbols are exported directly from the barrel (no namespace required):

| Export | Source | Purpose |
|--------|--------|---------|
| `CleoError` | `errors.ts` | Error class with exit code and RFC 9457 details |
| `ProblemDetails` (type) | `errors.ts` | RFC 9457 Problem Details interface |
| `ERROR_CATALOG` | `error-catalog.ts` | Map of all registered error definitions |
| `getErrorDefinition` | `error-catalog.ts` | Look up an error definition by ExitCode |
| `getAllErrorDefinitions` | `error-catalog.ts` | Get all error definitions |
| `getErrorDefinitionByLafsCode` | `error-catalog.ts` | Look up by LAFS error code |
| `ErrorDefinition` (type) | `error-catalog.ts` | Shape of an error definition entry |
| `getCleoErrorRegistry` | `error-registry.ts` | Get the full error registry |
| `getRegistryEntry` | `error-registry.ts` | Look up a registry entry by code |
| `getRegistryEntryByLafsCode` | `error-registry.ts` | Look up by LAFS code |
| `isCleoRegisteredCode` | `error-registry.ts` | Check if an exit code is registered |
| `formatSuccess` | `output.ts` | Wrap a result in a LAFS success envelope |
| `formatError` | `output.ts` | Wrap an error in a LAFS error envelope |
| `formatOutput` | `output.ts` | Format-agnostic output (auto-selects JSON or text) |
| `pushWarning` | `output.ts` | Attach a warning to the next envelope |
| `FormatOptions` (type) | `output.ts` | Options for output formatting |
| `loadConfig` | `config.ts` | Load CLEO config from `.cleo/config.json`. Cascades: project config > global config > defaults. After T101 the live schema surface is ~113 fields (down from ~283 before vaporware removal). |
| `getConfigValue` | `config.ts` | Read a typed config key |
| `setConfigValue` | `config.ts` | Write a config key atomically |
| `getRawConfig` | `config.ts` | Read raw config without validation |
| `getRawConfigValue` | `config.ts` | Read a raw config key |
| `parseConfigValue` | `config.ts` | Parse a config value from string input |
| `getCleoDir` | `paths.ts` | Relative `.cleo` path for a project |
| `getCleoDirAbsolute` | `paths.ts` | Absolute `.cleo` path for a project |
| `getCleoHome` | `paths.ts` | Global CLEO data path (OS-aware via env-paths) |
| `getConfigPath` | `paths.ts` | Absolute path to project config.json |
| `getGlobalConfigPath` | `paths.ts` | Absolute path to global config.json |
| `getProjectRoot` | `paths.ts` | Resolve absolute project root |
| `isProjectInitialized` | `paths.ts` | Check whether `.cleo/` structure exists |
| `resolveProjectPath` | `paths.ts` | Resolve a path relative to project root |
| `getLogger` | `logger.ts` | Get the active logger instance |
| `initLogger` | `logger.ts` | Initialize logger with config |
| `closeLogger` | `logger.ts` | Close logger and flush |
| `getLogDir` | `logger.ts` | Get the log directory path |
| `LoggerConfig` (type) | `logger.ts` | Logger configuration shape |
| `validateAgainstSchema` | `json-schema-validator.ts` | Validate data against a JSON Schema |
| `checkSchema` | `json-schema-validator.ts` | Run schema check and return boolean |
| `getSystemInfo` | `platform.ts` | Collect Node, OS, and platform details |
| `sha256` | `platform.ts` | Hash a string or buffer with SHA-256 |
| `getIsoTimestamp` | `platform.ts` | Current time as ISO 8601 string |
| `detectPlatform` | `platform.ts` | Detect the current platform |
| `PLATFORM` | `platform.ts` | Platform constant |
| `MINIMUM_NODE_MAJOR` | `platform.ts` | Minimum Node.js major version constant |
| `Platform` (type) | `platform.ts` | Platform type definition |
| `SystemInfo` (type) | `platform.ts` | System info shape |
| `initProject` | `init.ts` | Full project initialization (scaffold + schema) |
| `ensureInitialized` | `init.ts` | Idempotent initialization check |
| `getVersion` | `init.ts` | Get CLEO version string |
| `InitOptions` (type) | `init.ts` | Initialization options shape |
| `InitResult` (type) | `init.ts` | Initialization result shape |
| `ensureCleoStructure` | `scaffold.ts` | Create `.cleo/` subdirectory structure |
| `ensureGlobalHome` | `scaffold.ts` | Create global `~/.cleo/` structure |
| `ensureGlobalScaffold` | `scaffold.ts` | Scaffold global templates and schemas |
| `ensureSqliteDb` | `scaffold.ts` | Ensure SQLite database exists |
| `fileExists` | `scaffold.ts` | Check if a file exists |
| `getCleoVersion` | `scaffold.ts` | Get CLEO version from package.json |
| `getPackageRoot` | `scaffold.ts` | Get the package root directory |
| `paginate` | `pagination.ts` | Slice an array into a paginated result |
| `createPage` | `pagination.ts` | Build a typed page object |
| `queryAudit` | `audit.ts` | Query the audit log |
| `pruneAuditLog` | `audit-prune.ts` | Prune old audit log entries |
| `getProjectInfo` | `project-info.ts` | Get project info asynchronously |
| `getProjectInfoSync` | `project-info.ts` | Get project info synchronously |
| `ProjectInfo` (type) | `project-info.ts` | Project info shape |
| `CORE_PROTECTED_FILES` | `constants.ts` | List of protected `.cleo/` files |
| `EngineResult` (type) | `engine-result.ts` | Engine result shape for dispatch layer |
| `bootstrapGlobalCleo` | `bootstrap.ts` | Global bootstrap for postinstall and self-update |
| `BootstrapContext` (type) | `bootstrap.ts` | Bootstrap result tracking arrays |
| `BootstrapOptions` (type) | `bootstrap.ts` | Bootstrap configuration options |
| `getCleoTemplatesTildePath` | `paths.ts` | OS-aware tilde-prefixed templates path for `@` references |
| `updateProjectName` | `project-info.ts` | Update project name in project-info.json |

### 4.4 Flat Function Re-exports (Pattern 3)

For tree-shakeable direct imports:

| Function | Source | Purpose |
|----------|--------|---------|
| `addTask` | `tasks/add.ts` | Create a new task |
| `archiveTasks` | `tasks/archive.ts` | Archive completed tasks |
| `completeTask` | `tasks/complete.ts` | Complete a task |
| `deleteTask` | `tasks/delete.ts` | Delete a task |
| `findTasks` | `tasks/find.ts` | Search tasks with filters |
| `listTasks` | `tasks/list.ts` | List tasks with pagination |
| `showTask` | `tasks/show.ts` | Show task details |
| `updateTask` | `tasks/update.ts` | Update task fields |
| `normalizeTaskId` | `tasks/id-generator.ts` | Normalize a task ID |
| `startSession` | `sessions/index.ts` | Start a new session |
| `endSession` | `sessions/index.ts` | End the active session |
| `sessionStatus` | `sessions/index.ts` | Get session status |
| `resumeSession` | `sessions/index.ts` | Resume a suspended session |
| `listSessions` | `sessions/index.ts` | List sessions |
| `observeBrain` | `memory/brain-retrieval.ts` | Save an observation to brain.db |
| `searchBrainCompact` | `memory/brain-retrieval.ts` | Compact brain search |
| `fetchBrainEntries` | `memory/brain-retrieval.ts` | Fetch full brain entries by ID |
| `timelineBrain` | `memory/brain-retrieval.ts` | Timeline view around an anchor |
| `searchBrain` | `memory/brain-search.ts` | Full-text brain search |
| `startTask` | `task-work/index.ts` | Start working on a task |
| `stopTask` | `task-work/index.ts` | Stop working on the current task |
| `currentTask` | `task-work/index.ts` | Get the current active task |
| `HookRegistry` | `hooks/registry.ts` | Hook registry class |
| `hooks` | `hooks/registry.ts` | Default hook registry instance |
| `AdapterManager` | `adapters/index.ts` | Adapter discovery and lifecycle manager |
| `reconcile` | `reconciliation/index.ts` | Reconcile external tasks with CLEO as SSoT |
| `Cleo` | `cleo.ts` | Facade class for project-bound API |
| `withRetry` | `lib/retry.ts` | General-purpose retry with exponential backoff (3 attempts, 2s/4s defaults) |
| `computeDelay` | `lib/retry.ts` | Preview exponential delay schedule without invoking retry |
| `recordHeartbeat` | `agents/health-monitor.ts` | Update `last_heartbeat` timestamp for a live agent |
| `checkAgentHealth` | `agents/health-monitor.ts` | Per-agent structured health status report |
| `detectStaleAgents` | `agents/health-monitor.ts` | List agents with heartbeat older than threshold (read-only) |
| `detectCrashedAgents` | `agents/health-monitor.ts` | Detect + mark active agents with no heartbeat for >3 min (mutating) |
| `getAgentCapacity` | `agents/agent-registry.ts` | Remaining task-count capacity for one agent |
| `getAgentsByCapacity` | `agents/agent-registry.ts` | All active agents sorted by remaining capacity (descending) |
| `predictImpact` | `intelligence/impact.ts` | Predict downstream task effects from a free-text change description |

---

## 5. Cleo Facade Class

The `Cleo` class provides a project-bound API covering all 12 canonical domains. It is the recommended entry point for external consumers.

### 5.1 Initialization

```typescript
// Standard initialization (uses bundled SQLite store)
const cleo = await Cleo.init('./my-project');

// Custom store backend
const cleo = await Cleo.init('./my-project', { store: myCustomAccessor });

// Synchronous construction (defers store creation to first call)
const cleo = Cleo.forProject('./my-project');
```

### 5.2 Domain APIs

The facade exposes 12 domain getter properties:

| Property | Interface | Methods |
|----------|-----------|---------|
| `cleo.tasks` | `TasksAPI` | `add`, `find`, `show`, `list`, `update`, `complete`, `delete`, `archive`, `start`, `stop`, `current` |
| `cleo.sessions` | `SessionsAPI` | `start` (accepts `startTask?: string`), `end`, `status`, `resume`, `list`, `find`, `show`, `suspend`, `briefing`, `handoff`, `gc`, `recordDecision`, `recordAssumption`, `contextDrift`, `decisionLog`, `lastHandoff` |
| `cleo.memory` | `MemoryAPI` | `observe`, `find`, `fetch`, `timeline`, `search`, `hybridSearch` |
| `cleo.orchestration` | `OrchestrationAPI` | `start`, `analyze`, `readyTasks`, `nextTask`, `context`, `dependencyGraph`, `epicStatus`, `progress` |
| `cleo.lifecycle` | `LifecycleAPI` | `status`, `startStage`, `completeStage`, `skipStage`, `checkGate`, `history`, `resetStage`, `passGate`, `failGate`, `stages` |
| `cleo.release` | `ReleaseAPI` | `prepare`, `commit`, `tag`, `push`, `rollback`, `calculateVersion`, `bumpVersion` |
| `cleo.admin` | `AdminAPI` | `export`, `import` |
| `cleo.sticky` | `StickyAPI` | `add`, `show`, `list`, `archive`, `purge`, `convert` |
| `cleo.nexus` | `NexusAPI` | `init`, `register`, `unregister`, `list`, `show`, `sync`, `discover`, `search`, `setPermission`, `sharingStatus` |
| `cleo.sync` | `SyncAPI` | `reconcile`, `getLinks`, `getTaskLinks`, `removeProviderLinks` |
| `cleo.agents` | `AgentsAPI` | `register`, `deregister`, `health`, `detectCrashed`, `recordHeartbeat`, `capacity`, `isOverloaded`, `list` |
| `cleo.intelligence` | `IntelligenceAPI` | `predictImpact`, `blastRadius` |

The `check` domain is represented through the `validation` namespace at the barrel level, not as a distinct facade property. The 12th domain in the canonical Circle of Ten (`check`) maps to validation operations accessible via `import { validation } from '@cleocode/core'`.

The `sync` property provides the provider-agnostic task reconciliation API. Consumers implement `ExternalTaskProvider` to normalize their issue tracker's data, then call `cleo.sync.reconcile()` to sync with CLEO as SSoT. External task links are tracked in the `external_task_links` table for bidirectional traceability.

---

## 6. Contract Types

### 6.1 Task Type

`Task` is defined in `@cleocode/contracts` (`packages/contracts/src/task.ts`). Key design decisions:

- **`description` is REQUIRED** (non-optional `string`) -- CLEO's anti-hallucination rules reject tasks without a description and require it to differ from the title
- **`title` is REQUIRED** (non-optional `string`, max 120 characters)
- **`status` is REQUIRED** (must be a valid `TaskStatus` enum value)
- **`priority` is REQUIRED** (defaults to `'medium'` on creation)
- **`createdAt` is REQUIRED** (ISO 8601, must not be in the future)

### 6.2 Discriminated Union Types

Status-narrowed types provide compile-time guarantees:

| Type | Status | Required Fields |
|------|--------|----------------|
| `CompletedTask` | `'done'` | `completedAt: string` |
| `CancelledTask` | `'cancelled'` | `cancelledAt: string`, `cancellationReason: string` |

### 6.3 TaskCreate Input Type

`TaskCreate` is the input type for `addTask()`. Only `title` and `description` are required. All other fields have sensible defaults (`status: 'pending'`, `priority: 'medium'`, `size: 'medium'`, `type` inferred from parent context).

### 6.4 Contract Types from @cleocode/contracts

The public barrel re-exports all types from `@cleocode/contracts` via `export * from '@cleocode/contracts'`. Key type categories:

| Category | Types |
|----------|-------|
| Task types | `Task`, `TaskCreate`, `CompletedTask`, `CancelledTask`, `TaskPriority`, `TaskType`, `TaskSize`, `TaskStatus`, `TaskRelation`, `TaskVerification`, `TaskProvenance`, `ProjectMeta`, `Phase`, `Release` |
| Session types | `Session`, `SessionScope`, `SessionStats`, `SessionView`, `SessionStartResult` |
| Brain/memory types | `BrainEntryRef`, `BrainEntrySummary`, `ContradictionDetail`, `SupersededEntry` |
| Archive types | `ArchivedTask`, `ArchiveMetadata`, `ArchiveFile`, `ArchiveFields`, `ArchiveSummaryReport`, `ArchiveCycleTimesReport`, `ArchiveTrendsReport` |
| Result types | `TaskRef`, `TaskAnalysisResult`, `TaskDepsResult`, `DashboardResult`, `StatsResult`, `SequenceResult`, `ContextResult`, `CompleteTaskUnblocked` |
| LAFS types | `LafsSuccess`, `LafsError`, `LafsEnvelope`, `LAFSMeta`, `LAFSPage`, `Warning`, `MVILevel`, `GatewayEnvelope` |
| DataAccessor | `DataAccessor`, `TaskQueryFilters`, `QueryTasksResult`, `TaskFieldUpdates`, `TransactionAccessor` |
| Exit codes | `ExitCode`, `isErrorCode`, `isSuccessCode`, `getExitCodeName` |
| Config types | `CleoConfig`, `HierarchyConfig`, `SessionConfig`, `LifecycleConfig`, `BackupConfig`. Note: `enforcement.*` and `verification.*` sections are live at runtime but not yet declared in `CleoConfig` — they are read via untyped dot-path. The T101 config audit reduced the declared schema from ~283 to ~113 fields. |
| Status registry | `TASK_STATUSES`, `SESSION_STATUSES`, `STATUS_REGISTRY`, `isValidStatus` |
| Adapter types | `CLEOProviderAdapter`, `AdapterManifest`, `DetectionPattern`, `AdapterCapabilities` |
| WarpChain types | `WarpChain`, `WarpChainInstance`, `WarpStage`, `ChainShape`, `GateContract` |
| Tessera types | `TesseraTemplate`, `TesseraVariable`, `TesseraInstantiationInput` |
| Task Sync types | `ExternalTask`, `ExternalTaskLink`, `ExternalTaskProvider`, `ExternalTaskStatus`, `ExternalLinkType`, `SyncDirection`, `ConflictPolicy`, `ReconcileOptions`, `ReconcileAction`, `ReconcileActionType`, `ReconcileResult` |
| Spawn types | `CLEOSpawnContext`, `CLEOSpawnResult`, `CLEOSpawnAdapter` |
| Operations types | `ops` namespace (wire-format types for dispatch/LAFS, namespaced to avoid collision with domain types) |

---

## 7. DataAccessor Contract

Core modules that persist data accept a `DataAccessor` parameter. This is the primary extension point for custom storage backends.

### 7.1 Interface

The `DataAccessor` interface is defined in `@cleocode/contracts` (`packages/contracts/src/data-accessor.ts`). Factory functions that construct the default SQLite-backed accessor live in `packages/core/src/store/`.

All methods are **required** (non-optional) unless explicitly noted:

```typescript
interface DataAccessor {
  readonly engine: 'sqlite';

  // ---- Archive data ----
  loadArchive(): Promise<ArchiveFile | null>;
  saveArchive(data: ArchiveFile): Promise<void>;

  // ---- Session data ----
  loadSessions(): Promise<Session[]>;
  saveSessions(sessions: Session[]): Promise<void>;

  // ---- Audit log ----
  appendLog(entry: Record<string, unknown>): Promise<void>;

  // ---- Lifecycle ----
  close(): Promise<void>;

  // ---- Task reads (targeted queries) ----
  loadSingleTask(taskId: string): Promise<Task | null>;
  queryTasks(filters: TaskQueryFilters): Promise<QueryTasksResult>;
  loadTasks(taskIds: string[]): Promise<Task[]>;
  taskExists(taskId: string): Promise<boolean>;
  countTasks(filters?: { status?: TaskStatus | TaskStatus[]; parentId?: string }): Promise<number>;
  getChildren(parentId: string): Promise<Task[]>;
  countChildren(parentId: string): Promise<number>;
  countActiveChildren(parentId: string): Promise<number>;
  getAncestorChain(taskId: string): Promise<Task[]>;
  getSubtree(rootId: string): Promise<Task[]>;
  getDependents(taskId: string): Promise<Task[]>;
  getDependencyChain(taskId: string): Promise<string[]>;

  // ---- Task writes (targeted mutations) ----
  upsertSingleTask(task: Task): Promise<void>;
  updateTaskFields(taskId: string, fields: TaskFieldUpdates): Promise<void>;
  archiveSingleTask(taskId: string, fields: ArchiveFields): Promise<void>;
  removeSingleTask(taskId: string): Promise<void>;
  addRelation(taskId: string, relatedTo: string, relationType: string, reason?: string): Promise<void>;
  getNextPosition(parentId: string | null): Promise<number>;
  shiftPositions(parentId: string | null, fromPosition: number, delta: number): Promise<void>;
  transaction<T>(fn: (tx: TransactionAccessor) => Promise<T>): Promise<T>;

  // ---- Metadata (schema_meta KV store) ----
  getMetaValue<T>(key: string): Promise<T | null>;
  setMetaValue(key: string, value: unknown): Promise<void>;
  getSchemaVersion(): Promise<string | null>;

  // ---- Session operations ----
  getActiveSession(): Promise<Session | null>;
  upsertSingleSession(session: Session): Promise<void>;
  removeSingleSession(sessionId: string): Promise<void>;
}
```

### 7.2 Usage Pattern

Core functions accept `accessor` as the last parameter:

```typescript
async function addTask(
  options: AddTaskOptions,
  cwd?: string,
  accessor?: DataAccessor,
): Promise<AddTaskResult>
```

When `accessor` is `undefined`, the function resolves via `getAccessor(cwd)` -- a function in `packages/core/src/store/data-accessor.ts` that constructs a `SqliteDataAccessor` from the bundled store layer.

### 7.3 TransactionAccessor

The `transaction()` method provides a write-only subset of `DataAccessor` methods within a SQLite transaction (`BEGIN IMMEDIATE / COMMIT / ROLLBACK`):

```typescript
interface TransactionAccessor {
  upsertSingleTask(task: Task): Promise<void>;
  archiveSingleTask(taskId: string, fields: ArchiveFields): Promise<void>;
  removeSingleTask(taskId: string): Promise<void>;
  setMetaValue(key: string, value: unknown): Promise<void>;
  updateTaskFields(taskId: string, fields: TaskFieldUpdates): Promise<void>;
  appendLog(entry: Record<string, unknown>): Promise<void>;
}
```

### 7.4 Implementing a Custom Backend

Consumers that want to use `@cleocode/core` with a non-SQLite store (e.g., in-memory, Postgres, remote API) MUST implement `DataAccessor` from `@cleocode/contracts` and inject it at every call site or via `Cleo.init('./project', { store: myAccessor })`. The `engine` discriminant is currently always `'sqlite'` in the reference implementation, but a custom implementation SHOULD set it to a unique identifier.

Note: The bundled SQLite store includes the agent schema tables (`agent_instances`, `agent_error_log`) in the same `tasks.db` database. These tables are defined in `packages/core/src/agents/agent-schema.ts` and re-exported from `tasks-schema.ts` for Drizzle migration discovery. The `agents` module accesses these tables directly via the Drizzle ORM connection rather than through the `DataAccessor` interface.

---

## 8. Export Contract

### 8.1 Public API

All symbols exported from `packages/core/src/index.ts` are public API. Consumers MUST import only from `@cleocode/core` (the package root). Imports from internal subpaths (e.g., `@cleocode/core/internal`) are not part of the public contract.

### 8.2 Stability Levels

| Stability | Meaning | Examples |
|-----------|---------|---------|
| **Stable** | No breaking changes without major version bump | `tasks.*`, `sessions.*`, `memory.*`, `CleoError`, `formatSuccess`, `Cleo` facade |
| **Beta** | May change between minor versions | `signaldock.*`, `orchestration.spawnWave`, `otel.*`, `spawn.*` |
| **Internal** | Not for external consumers; may be removed | `coreMcp.*`, `routing.*`, `coreHooks.*` |

### 8.3 What Is NOT Public API

The following are internal implementation details, not part of the public contract:

- Everything in `@cleocode/core/internal` (the internal barrel)
- Anything imported from `packages/core/src/store/` directly (use `DataAccessor` or the exported factory functions)
- Any `__tests__/` files or test utilities
- Files prefixed with `_` (internal convention)
- `packages/core/src/sessions/context-alert.ts` (session context singleton -- internal)

---

## 9. Dependencies

### 9.1 Runtime Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@cleocode/adapters` | `workspace:*` | Provider adapter runtime |
| `@cleocode/agents` | `workspace:*` | Agent protocol templates |
| `@cleocode/caamp` | `^1.8.1` | Provider capability API, spawn coordination, idempotent injection |
| `@cleocode/contracts` | `workspace:*` | Type-only adapter interfaces, `ExitCode` enum, config types |
| `@cleocode/lafs-protocol` | `^1.8.0` | LAFS envelope types, `LAFSMeta`, `Warning` |
| `@cleocode/skills` | `workspace:*` | Skill definitions |
| `ajv` | `^8.18.0` | JSON Schema validation |
| `ajv-formats` | `^3.0.1` | AJV format validators (date-time, uri, etc.) |
| `drizzle-orm` | `1.0.0-beta.19-d95b7a4` | ORM for lifecycle, brain, and nexus SQLite tables (beta, pinned) |
| `env-paths` | `^4.0.0` | Platform-appropriate config/data paths |
| `js-tiktoken` | `^1.0.21` | Token counting for context window management |
| `pino` | `^10.3.1` | Structured logger |
| `pino-roll` | `^4.0.0` | Rolling log file transport |
| `proper-lockfile` | `^4.1.2` | File locking for atomic writes |
| `write-file-atomic` | `^6.0.0` | Atomic file write operations |
| `yaml` | `^2.8.2` | YAML parsing and serialization |
| `zod` | `^3.25.76` | Runtime validation schemas (used via drizzle-orm Zod integration) |

### 9.2 Dev Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@types/proper-lockfile` | `^4.1.4` | Type definitions for proper-lockfile |
| `@types/write-file-atomic` | `^4.0.3` | Type definitions for write-file-atomic |

### 9.3 Dependency Notes

- `drizzle-orm` is at a beta version (`1.0.0-beta.18-*`) and must be pinned to the exact build hash used by `@cleocode/cleo`. Pre-release semver ranges (`^`) do not work correctly -- always pin to the exact version.
- SQLite is provided by Node.js built-in `node:sqlite` (requires Node 24+) via `drizzle-orm/node-sqlite`. This is zero-dependency -- no `sql.js` or `better-sqlite3` needed. It is used internally by `lifecycle`, `memory` (brain.db), and `nexus` modules. Consumers that only use task/session modules do not trigger SQLite connections unless they call those specific modules.
- `@cleocode/contracts` exports zero runtime code. It is safe to tree-shake entirely.
- `@cleocode/lafs-protocol` provides the `LAFSMeta`, `LAFSPage`, and `Warning` types consumed by `packages/core/src/output.ts`.
- `zod` is used for drizzle-orm Zod validation schemas (`createInsertSchema`/`createSelectSchema` from `drizzle-orm/zod`).
- `js-tiktoken` provides fast WASM-based token counting for context window drift monitoring and token budget management.

---

## 10. Core Purity Rules

`packages/core/src/` MUST NOT import from:

| Prohibited path | Reason |
|----------------|--------|
| `packages/cleo/src/cli/` | CLI adapter code (Commander.js, argument parsing) |
| `packages/cleo/src/mcp/` | MCP adapter code (MCP SDK tool definitions) |
| `packages/cleo/src/dispatch/` | Routing layer -- core should not know about dispatch |

### 10.1 Allowed Store Imports

The store is bundled inside `packages/core/src/store/`. Core modules MAY import from `./store/` (relative within the package) since the store ships as part of core. This is a key change from the prior architecture where the store was external.

The following store imports are permitted within `packages/core/src/`:

- `packages/core/src/store/atomic.ts` -- for modules that own files outside the main task/session store (e.g., research manifest, memory bridge)
- `packages/core/src/store/brain-*.ts` -- for `packages/core/src/memory/` modules that own brain.db
- `packages/core/src/store/sqlite.ts` -- for `packages/core/src/lifecycle/` (owns lifecycle tables in tasks.db)
- `packages/core/src/store/data-accessor.ts` -- the `DataAccessor` factory and `getAccessor()` fallback

These rules are enforced by a CI purity gate. Exceptions MUST be registered in the known-exceptions allowlist with justification.

---

## 11. Adapter System

Provider adapters are consolidated into a single `@cleocode/adapters` package:

| Package | Purpose |
|---------|---------|
| `@cleocode/adapters` | Unified provider adapters for Claude Code, OpenCode, Cursor |

The adapter system uses manifest-based discovery:

1. Each provider has a `manifest.json` declaring `detectionPatterns` (env vars, files, CLI availability)
2. `AdapterManager` in `packages/core/src/adapters/` scans manifests at startup
3. Detection runs the declared patterns to identify the active provider
4. The matching adapter is activated, providing hooks, spawn mechanics, and installation support

Adapter contracts are defined in `@cleocode/contracts`:

- `CLEOProviderAdapter` -- main adapter interface
- `AdapterHookProvider` -- lifecycle hook dispatch
- `AdapterSpawnProvider` -- subagent spawn mechanics
- `AdapterInstallProvider` -- provider installation
- `AdapterPathProvider` -- provider-specific paths
- `AdapterContextMonitorProvider` -- context window monitoring
- `AdapterTransportProvider` -- inter-agent transport

---

## 12. CAAMP Role

CAAMP (Central AI Agent Managed Packages) handles provider-level orchestration. Within `@cleocode/core`, the `caamp` namespace wraps the `@cleocode/caamp` API to provide:

| Capability | Function | Source |
|-----------|---------|--------|
| Provider detection | `detectRuntimeProviderContext()` | `packages/core/src/metrics/provider-detection.ts` |
| Capability check | `providerSupportsById(id, capability)` | `@cleocode/caamp` (re-exported) |
| Hook event query | `getProvidersByHookEvent(event)` | `@cleocode/caamp` (re-exported) |
| Skill paths | `getEffectiveSkillsPaths(provider)` | `@cleocode/caamp` (re-exported) |
| MCP server config | `caampBuildServerConfig(options)` | `packages/core/src/caamp/` |
| Dual-scope install | `dualScopeConfigure(config)` | `packages/core/src/caamp/` |
| Batch install | `batchInstallWithRollback(options)` | `packages/core/src/caamp/` |

---

## 13. SignalDock Role

SignalDock is the inter-agent messaging transport within `@cleocode/core`. It provides a provider-neutral channel for agents in multi-wave orchestration to exchange messages without coupling to a specific AI platform API.

| Component | Purpose |
|-----------|---------|
| `AgentTransport` (interface) | Transport contract: `register`, `send`, `onMessage` |
| `ClaudeCodeTransport` | Transport implementation for Claude Code inter-agent protocol |
| `SignalDockTransport` | Transport implementation via SignalDock relay service |
| `createTransport(config)` | Factory: selects the appropriate transport for the current provider |

SignalDock is used internally by the `spawn` and `orchestration` modules. External consumers typically interact with it only when implementing custom orchestration protocols.

---

## 14. LAFS Response Envelope

All MCP-facing and API-facing operations MUST return a LAFS-compliant envelope. LAFS (LLM-Agent-First Schema) is specified by `@cleocode/lafs-protocol`.

### 14.1 Envelope Variants

| Type | `success` | Contains |
|------|-----------|---------|
| `LafsSuccess<T>` | `true` | `data: T`, `_meta: LAFSMeta`, optional `page: LAFSPage` |
| `LafsError` | `false` | `error: LAFSError`, `_meta: LAFSMeta` |

### 14.2 _meta Fields

| Field | Type | Description |
|-------|------|-------------|
| `requestId` | `string` (UUID v4) | Unique per-request identifier |
| `timestamp` | `string` (ISO 8601) | Time of envelope creation |
| `sessionId` | `string \| null` | Active CLEO session ID if any |
| `warnings` | `Warning[]` | Deprecation or informational notices |

### 14.3 Core Output API

```typescript
formatSuccess<T>(data: T, options?: FormatOptions): LafsSuccess<T>
formatError(err: unknown, options?: FormatOptions): LafsError
formatOutput(data: unknown, options?: FormatOptions): string
pushWarning(warning: Warning): void
```

---

## 15. Versioning Policy

### 15.1 Version Scheme

`@cleocode/core` uses semver starting from v2.0.0 for the restructured monorepo. The prior CalVer scheme (`YYYY.MM.PATCH`) applied to the pre-extraction era.

### 15.2 Semver Promises

| Stability Level | Promise |
|----------------|---------|
| **Stable** exports | No removal or signature change without major version bump |
| **Beta** exports | May change in any minor release; changes noted in changelog |
| **Internal** exports (via `./internal`) | No guarantees; may be removed without notice |

### 15.3 Deprecation Process

1. Mark the symbol with a `@deprecated` JSDoc tag and a `pushWarning` call in the implementation
2. Add the deprecation to the changelog and release notes
3. Remove after one minor version cycle (minimum)

### 15.4 Relationship to @cleocode/cleo

`@cleocode/cleo` (`@latest`) depends on `@cleocode/core` and will always pin to a compatible version. Consumers upgrading `@cleocode/core` independently MUST ensure they use a version that `@cleocode/cleo` also supports, or accept that the versions may diverge.

### 15.5 Breaking Changes in Core Hardening (v2026.3.x)

The following breaking changes were introduced during the T029 Core Hardening initiative:

| Change | Migration |
|--------|-----------|
| `TaskFile` removed from `@cleocode/contracts` | Use `Task[]` from `DataAccessor.queryTasks()` directly |
| `TaskFileExt`, `TaskFileTaskEntry`, `TaskFileMetaExt`, `toTaskFileExt()` removed from sessions | Use `Task[]` and `TaskWorkState` from contracts directly |
| `tasks/reparent.ts` deleted | Use `tasks/task-ops.ts` reparent functions (already DataAccessor-based) |
| `buildPrompt()`, `spawn()`, `spawnBatch()`, `canParallelize()` now async | Add `await` at call sites |
| `orchestratorSpawnSkill()`, `injectProtocol()`, `buildTaskContext()` now async | Add `await` at call sites |
| `validateOrchestratorCompliance()` now async | Add `await` at call sites |
| `validateContributionTask()` (manifests) now async | Add `await` at call sites |
| `buildExportPackage()` signature changed | Pass `projectName` in options instead of `TaskFile` second arg |
| `exportSingle()`, `exportSubtree()` signatures changed | Pass `allTasks: Task[]` and `projectName` instead of `TaskFile` |
| `selectTasksForInjection()` (inject) signature changed | Pass `focusedTaskId` and `currentPhase` in options |

Consumers using the **Cleo facade** (`Cleo.init()`) are **NOT affected** -- the facade API is unchanged. These breaking changes only affect consumers that import internal functions directly from `@cleocode/core/internal` or submodule paths.

### 15.6 New Features in T029 + T056 Release

The following features were added during the T029 (Schema Architecture) and T056 (Task System Hardening) epics:

#### Contract Changes

| Change | Details |
|--------|---------|
| `Task.pipelineStage` added | Optional `string \| null` — RCASD-IVTR+C stage (T060) |
| `TaskVerification.initializedAt` added | Optional `string \| null` — auto-set on task creation (T061) |

#### New Internal Exports

| Export | Source | Purpose |
|--------|--------|---------|
| `backfillTasks` | `backfill/index.ts` | Retroactively add AC and verification to existing tasks (T066) |
| `generateAcFromDescription` | `backfill/index.ts` | Generate acceptance criteria from task descriptions (T066) |
| `buildDefaultVerification` | `tasks/add.ts` | Create default verification metadata (T061) |
| `applyStrictnessPreset` | `config.ts` | Apply strict/standard/minimal preset (T067) |
| `listStrictnessPresets` | `config.ts` | List available presets (T067) |
| `STRICTNESS_PRESETS` | `config.ts` | Preset definitions (T067) |
| `getWorkflowCompliance` | `stats/workflow-telemetry.ts` | Compute compliance metrics (T065) |
| `validateEpicCreation` | `tasks/epic-enforcement.ts` | Enforce epic creation rules (T062) |
| `validateChildStageCeiling` | `tasks/epic-enforcement.ts` | Prevent children from exceeding epic stage (T062) |
| `validateEpicStageAdvancement` | `tasks/epic-enforcement.ts` | Gate epic stage advancement (T062) |
| `PIPELINE_STAGES` | `tasks/pipeline-stage.ts` | Valid RCASD-IVTR+C stages (T060) |
| `assignPipelineStage` | `tasks/pipeline-stage.ts` | Auto-assign pipeline stage (T060) |
| `validateStageTransition` | `tasks/pipeline-stage.ts` | Forward-only stage transitions (T060) |
| `BackfillOptions`, `BackfillResult`, `BackfillTaskChange` (types) | `backfill/index.ts` | Backfill operation types (T066) |

#### New CLI Commands

| Command | Purpose |
|---------|---------|
| `cleo backfill [--dry-run]` | Backfill AC and verification for existing tasks (T066) |
| `cleo compliance` | Show workflow compliance metrics dashboard (T065) |
| `cleo config set-preset <preset>` | Apply strictness preset (strict/standard/minimal) (T067) |
| `cleo config presets` | List available presets (T067) |

#### New Dispatch Operations

| Gateway | Domain | Operation | Purpose |
|---------|--------|-----------|---------|
| `query` | `check` | `workflow.compliance` | Compliance telemetry metrics (T065) |
| `query` | `admin` | `config.presets` | List strictness presets (T067) |
| `mutate` | `admin` | `config.set-preset` | Apply a preset (T067) |

#### Schema Changes (Auto-Migration)

| Change | Migration |
|--------|-----------|
| `tasks.pipeline_stage` column added | Auto-migrated via Drizzle on DB init |
| `tasks.session_id` column added | Auto-migrated via Drizzle on DB init |
| 9 composite indexes added | Auto-migrated via Drizzle on DB init |
| 17 intra-DB soft FKs hardened | Auto-migrated via table rebuild pattern |
| `PRAGMA foreign_keys = ON` enforced | Set on every DB connection open |

### 15.7 New Features in T101 + T038 Release

#### T101 — Config Schema Audit (Config Surface Reduction)

The T101 epic audited all CLEO configuration fields and removed approximately 170 fields that existed in schema definitions and templates but were never read by any runtime code.

**Scale of reduction**: ~283 declared fields → ~113 live fields (approximately 60% reduction).

**Sections removed entirely**: `tools`, `testing`, `graphRag`, `cli`, `display`, `logging` (legacy block), `documentation`, `contextStates`, `multiSession`, `project`.

**Key corrections**:

- `validation.enforceAcceptance` removed — the authoritative gate is `enforcement.acceptance.mode`
- `hierarchy.requireAcceptanceCriteria` phantom write corrected — strictness presets now write `enforcement.acceptance.mode`
- `enforcement.*` and `verification.*` read via untyped dot-path — a type safety gap documented above in Section 6.4

**Consumer impact**: Consumers who read the CLEO config file and depended on removed sections will receive `undefined` for those paths instead of the previous default values. The `CleoConfig` contract type reflects the remaining live fields.

#### T038 — Agent Infrastructure (Health, Retry, Capacity, Impact)

The T038 epic shipped the agent health monitoring, retry utility, registry capacity, and impact prediction described in the kernel spec but not yet fully delivered. All additions are purely additive — no existing exports changed signatures.

**New `lib` namespace**: A new public namespace (`export * as lib`) ships a general-purpose, dependency-free retry utility. This is distinct from the agent-specific `agents/retry.ts` which is coupled to the DB registry layer.

| Module | Key Exports | Purpose |
|--------|-------------|---------|
| `lib/retry.ts` | `withRetry`, `computeDelay`, `RetryOptions`, `RetryContext` | Exponential backoff retry for any async operation |
| `agents/health-monitor.ts` | `recordHeartbeat`, `checkAgentHealth`, `detectStaleAgents`, `detectCrashedAgents`, `AgentHealthStatus`, `HEARTBEAT_INTERVAL_MS`, `STALE_THRESHOLD_MS` | Agent liveness monitoring via heartbeat protocol |
| `agents/agent-registry.ts` | `getAgentCapacity`, `getAgentsByCapacity`, `getAgentSpecializations`, `updateAgentSpecializations`, `recordAgentPerformance`, `MAX_TASKS_PER_AGENT` | Task-count capacity tracking and specialization management |
| `intelligence/impact.ts` | `predictImpact`, `analyzeChangeImpact`, `analyzeTaskImpact`, `calculateBlastRadius` | Downstream dependency impact prediction |

**Naming note**: The pre-existing `registry.checkAgentHealth(thresholdMs) -> AgentInstanceRow[]` was re-exported as `findStaleAgentRows` to avoid signature conflict with the new `health-monitor.checkAgentHealth(agentId) -> AgentHealthStatus | null`.

**Namespace count update**: The public barrel now exports 45 namespaces (up from 43) — `lib` and `reconciliation` were added during this release cycle.

### 15.8 New Features in T123 + Hotfix Batch (v2026.3.60–65)

#### T123 — Bootstrap Injection Chain + CleoOS Facade API Gaps (v2026.3.60)

The T123 epic addressed bootstrap injection reliability and closed four facade API gaps required by CleoOS.

**Bootstrap fixes:**

| Fix | Description |
|-----|-------------|
| Legacy template sync | `ensureGlobalTemplatesBootstrap()` now writes to both XDG and legacy `~/.cleo/templates/` paths |
| CAAMP sanitization | `sanitizeCaampFile()` cleans orphaned fragments before `inject()` |
| Health check Step 7 | `verifyBootstrapHealth()` validates injection chain after all bootstrap steps |
| Template version check | `checkGlobalTemplates()` verifies XDG and legacy templates match versions |

**Facade additions (Cleo class):**

| Addition | Interface | Methods |
|----------|-----------|---------|
| `sessions.start({ startTask })` | `SessionsAPI` | `startTask?: string` parameter added |
| `tasks.start/stop/current` | `TasksAPI` | `start(taskId)`, `stop()`, `current()` |
| `cleo.agents` getter | `AgentsAPI` | `register`, `deregister`, `health`, `detectCrashed`, `recordHeartbeat`, `capacity`, `isOverloaded`, `list` |
| `cleo.intelligence` getter | `IntelligenceAPI` | `predictImpact`, `blastRadius` |

The facade now exposes **12 domain getter properties** (up from 10).

#### Hotfix Batch (v2026.3.61–65)

Sixteen GitHub issues (#63–#78) resolved across five point releases:

| Fix | Version | Description |
|-----|---------|-------------|
| Migration journal reconciliation | v2026.3.61 | `runMigrations()` detects stale `__drizzle_migrations` entries and re-applies |
| `ensureRequiredColumns()` | v2026.3.61 | PRAGMA table_info safety net after every migration |
| `dryRun` threading | v2026.3.62 | Flag now passed through dispatch → engine → `addTask()` |
| `listSystemBackups()` | v2026.3.62 | Read-only backup list (moved from mutate to query gateway) |
| `session find` CLI | v2026.3.63 | CLI subcommand registered for existing MCP operation |
| `paginate()` null guard | v2026.3.64 | Handles undefined/null input arrays |
| `detect-drift` user projects | v2026.3.65 | Distinguishes CLEO source repo from user projects |

---

## 16. Build Architecture

### 16.1 TypeScript Configuration

| Setting | Value |
|---------|-------|
| `target` | ES2025 |
| `module` | NodeNext |
| `moduleResolution` | NodeNext |
| `strict` | true |
| `declaration` | true |
| `declarationMap` | true |
| `sourceMap` | true |
| `composite` | true |
| `isolatedModules` | true |

### 16.2 Build Pipeline

The monorepo root `build.mjs` uses a two-stage build for `@cleocode/core`:

1. **esbuild** bundles all source into a single `dist/index.js` (with `@cleocode/contracts` inlined, npm dependencies externalized)
2. **tsc --emitDeclarationOnly** generates `.d.ts` and `.d.ts.map` files alongside the bundle

This produces a single-file JS bundle for fast runtime loading while preserving full TypeScript declarations for consumer type-checking. The `tsBuildInfo` is cleared before declaration emit to prevent stale composite caching.

Individual packages can also be built standalone with `pnpm --filter @cleocode/core run build` (runs `tsc` directly, producing multi-file output). The esbuild pipeline is only used by the root `pnpm run build` and CI Release workflow.

### 16.3 Project References

`packages/core/tsconfig.json` declares a project reference to `packages/contracts`:

```json
{
  "references": [
    { "path": "../contracts" }
  ]
}
```

This ensures contracts are built before core in composite builds.

### 16.3 Published Files

The `files` field restricts what ships to npm:

```json
{
  "files": ["dist", "migrations", "schemas", "templates", "src"]
}
```

Both compiled output (`dist/`), database migrations (`migrations/`), and source (`src/`) are published. Source inclusion enables source-map navigation and IDE go-to-definition for consumers. A `.npmignore` file in each package overrides the root `.gitignore` (which excludes `dist/`) to ensure `dist/` is included in npm tarballs.

---

## 17. Examples

### Facade pattern (recommended)

```typescript
import { Cleo } from '@cleocode/core';

const cleo = await Cleo.init('./my-project');

// Tasks
await cleo.tasks.add({ title: 'Build API', description: 'REST endpoints for user service' });
const result = await cleo.tasks.find({ status: 'pending' });

// Sessions
await cleo.sessions.start({ name: 'sprint-1', scope: 'T100' });

// Memory
await cleo.memory.observe({ text: 'Auth uses JWT with RS256', title: 'Auth discovery' });
const hits = await cleo.memory.find({ query: 'authentication', limit: 5 });
```

### Namespace imports

```typescript
import { tasks, sessions, memory } from '@cleocode/core';

await tasks.addTask({ title: 'foo', description: 'bar' }, '/path/to/project');
```

### Direct function imports (tree-shakeable)

```typescript
import { addTask, startSession, observeBrain } from '@cleocode/core';

await addTask({ title: 'foo', description: 'bar' }, '/path/to/project');
```

### Zod enum schema imports (consumer validation)

```typescript
import {
  taskStatusSchema,
  taskPrioritySchema,
  agentTypeSchema,
  brainObservationTypeSchema,
  insertTaskSchema,
  selectSessionSchema,
} from '@cleocode/core';

// Validate a status value at runtime
const status = taskStatusSchema.parse('pending'); // OK
taskStatusSchema.parse('invalid'); // throws ZodError

// Validate an insert payload
const result = insertTaskSchema.safeParse({
  id: 'T100',
  title: 'Build API',
  status: 'pending',
});
```

### External task sync (reconciliation)

```typescript
import { Cleo } from '@cleocode/core';
import type { ExternalTask, ExternalTaskProvider } from '@cleocode/core';

// Implement provider adapter for your issue tracker
class LinearAdapter implements ExternalTaskProvider {
  async getExternalTasks(): Promise<ExternalTask[]> {
    const issues = await linearClient.issues();
    return issues.map(issue => ({
      externalId: issue.id,
      title: issue.title,
      status: mapStatus(issue.state),
      priority: mapPriority(issue.priority),
      url: issue.url,
      labels: issue.labels.map(l => l.name),
    }));
  }
}

const cleo = await Cleo.init('./my-project');
const adapter = new LinearAdapter();

// Reconcile — creates new CLEO tasks, updates existing, completes done ones
const result = await cleo.sync.reconcile({
  externalTasks: await adapter.getExternalTasks(),
  providerId: 'linear',
});

console.log(`Created: ${result.summary.created}, Updated: ${result.summary.updated}`);

// Query links between CLEO tasks and external tasks
const links = await cleo.sync.getLinks('linear');
const taskLinks = await cleo.sync.getTaskLinks('T123');
```

### Custom store backend

```typescript
import { Cleo } from '@cleocode/core';
import type { DataAccessor } from '@cleocode/core';

class MyPostgresAccessor implements DataAccessor {
  readonly engine = 'postgres' as any; // custom engine identifier
  // ... implement all required methods
}

const cleo = await Cleo.init('./my-project', { store: new MyPostgresAccessor() });
```

### Lifecycle gate check before completing a task

```typescript
import { lifecycle, tasks, CleoError, ExitCode } from '@cleocode/core';

const gate = await lifecycle.checkGate(taskId, 'ready', projectDir);

if (!gate.canProgress) {
  throw new CleoError(ExitCode.LIFECYCLE_GATE_FAILED, gate.reason);
}

await tasks.completeTask({ taskId }, projectDir, accessor);
```

---

## 18. References

- `packages/core/src/index.ts` -- public barrel export (~235 lines)
- `packages/core/src/internal.ts` -- internal barrel export (~622 lines)
- `packages/core/src/cleo.ts` -- Cleo facade class (12 domain APIs)
- `packages/core/src/store/data-accessor.ts` -- `DataAccessor` factory functions
- `packages/contracts/src/index.ts` -- `@cleocode/contracts` public API
- `packages/contracts/src/data-accessor.ts` -- `DataAccessor` interface definition
- `packages/contracts/src/task.ts` -- `Task`, `TaskCreate`, `CompletedTask`, `CancelledTask` types
- `packages/adapters/` -- `@cleocode/adapters` unified provider package
- `docs/guides/core-package-guide.md` -- consumer guide with code examples
- `docs/specs/CAAMP-INTEGRATION-SPEC.md` -- CAAMP integration details
- `docs/adrs/ADR-001-provider-adapter-architecture.md` -- adapter architecture rationale
- `docs/adrs/ADR-002-provider-agnostic-memory-bridge.md` -- memory bridge rationale
- Epic T5701 -- Core Extraction epic tracking all related tasks
