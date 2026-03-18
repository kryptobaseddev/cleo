# @cleocode/core Package Specification

**Version**: 2026.3.17
**Status**: APPROVED
**Date**: 2026-03-17
**Task**: T5714
**Epic**: T5701

---

## 1. Overview

This specification defines the public contract for `@cleocode/core`, the standalone business logic package extracted from the CLEO monorepo as part of Epic T5701.

`@cleocode/core` encapsulates all domain logic for task management, session lifecycle, memory persistence, multi-agent orchestration, lifecycle gate enforcement, release management, and related capabilities. It is designed to be consumed by adapter layers (CLI, MCP, custom integrations) without embedding any adapter-specific code itself.

### Design Goals

- **Standalone**: Importable without the `@cleocode/cleo` product package
- **Adapter-neutral**: No imports from `src/cli/`, `src/mcp/`, or `src/dispatch/`
- **Dependency-injected storage**: Core modules accept a `DataAccessor` parameter rather than constructing one internally
- **ESM-first**: Full ES module package (`"type": "module"`, `.js` import paths)
- **Node 24+**: Targets the CLEO minimum Node.js version

---

## 2. Package Identity

| Field | Value |
|-------|-------|
| Package name | `@cleocode/core` |
| Registry | npm (`@cleocode` scope) |
| Version scheme | CalVer (`YYYY.MM.PATCH`) |
| Entry point | `dist/core/index.js` (compiled from `src/core/index.ts`) |
| Type declarations | `dist/core/index.d.ts` |
| Module format | ES modules (`"type": "module"`) |
| Minimum Node.js | 24 |
| License | MIT |

### Package.json Shape (Target)

```json
{
  "name": "@cleocode/core",
  "version": "2026.3.0",
  "type": "module",
  "main": "dist/core/index.js",
  "types": "dist/core/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/core/index.js",
      "types": "./dist/core/index.d.ts"
    }
  },
  "peerDependencies": {
    "@cleocode/contracts": ">=2026.3.0",
    "@cleocode/caamp": ">=1.6.0",
    "@cleocode/lafs-protocol": ">=1.0.0"
  },
  "dependencies": {
    "drizzle-orm": ">=1.0.0",
    "better-sqlite3": ">=9.0.0"
  }
}
```

---

## 3. Module Structure

The barrel export (`src/core/index.ts`) re-exports all public modules as named namespaces. The table below documents all 40 modules, their role, and whether they require a `DataAccessor` at runtime.

### 3.1 Domain Namespace Modules

| Namespace | Source path | Role | Requires DataAccessor |
|-----------|------------|------|----------------------|
| `tasks` | `src/core/tasks/` | Task CRUD, hierarchy, dependency validation, search | Yes |
| `sessions` | `src/core/sessions/` | Session lifecycle, handoff, debrief, decisions | Yes |
| `memory` | `src/core/memory/` | Brain.db observations, search, 3-layer retrieval | No (uses brain.db directly) |
| `orchestration` | `src/core/orchestration/` | Dependency graph, wave analysis, progress metrics | Yes |
| `lifecycle` | `src/core/lifecycle/` | RCASD-IVTR+C gate enforcement, stage transitions | Yes (SQLite lifecycle tables) |
| `release` | `src/core/release/` | Changelog computation, version bump, ship pipeline | Yes |
| `admin` | `src/core/admin/` | Dashboard, health check, configuration map | Yes |
| `compliance` | `src/core/compliance/` | Protocol compliance recording and value reporting | No |
| `adapters` | `src/core/adapters/` | Provider adapter discovery, detection, lifecycle | No |
| `caamp` | `src/core/caamp/` | CAAMP wrapper — provider capability API, spawn, skill routing | No |
| `signaldock` | `src/core/signaldock/` | Inter-agent messaging transport (provider-neutral) | No |
| `spawn` | `src/core/spawn/` | Subagent spawn coordination, registry | No |
| `skills` | `src/core/skills/` | Skill routing table, precedence integration | No |
| `context` | `src/core/context/` | Context window drift monitoring and alerts | No |
| `coreHooks` | `src/core/hooks/` | Lifecycle hook dispatch registry | No |
| `pipeline` | `src/core/pipeline/` | RCASD pipeline coordination and status | Yes |
| `phases` | `src/core/phases/` | Execution wave computation, dependency maps | Yes |
| `taskWork` | `src/core/task-work/` | Active task tracking (start, stop, current) | Yes |
| `research` | `src/core/research/` | Research manifest operations, contradiction detection | Partial |
| `nexus` | `src/core/nexus/` | Cross-project registry operations (nexus.db) | No (uses nexus.db) |
| `metrics` | `src/core/metrics/` | Telemetry, value tracking, provider detection | No |
| `observability` | `src/core/observability/` | Structured observability reporting | No |
| `otel` | `src/core/otel/` | OpenTelemetry integration, token usage recording | No |
| `migration` | `src/core/migration/` | Schema version detection and migration execution | Yes (SQLite) |
| `validation` | `src/core/validation/` | Anti-hallucination validators, schema checks | No |
| `roadmap` | `src/core/roadmap/` | Roadmap and milestone tracking | Yes |
| `security` | `src/core/security/` | Permission checks and access audit | No |
| `sequence` | `src/core/sequence/` | Ordered operation sequencing | No |
| `snapshot` | `src/core/snapshot/` | Project state snapshot creation and restore | Yes |
| `stats` | `src/core/stats/` | Task and session statistics aggregation | Yes |
| `sticky` | `src/core/sticky/` | Sticky notes (persistent context anchors) | No |
| `inject` | `src/core/inject/` | AGENTS.md / CLAUDE.md content injection | No |
| `issue` | `src/core/issue/` | Issue and bug tracking | Yes |
| `remote` | `src/core/remote/` | Remote sync push/pull operations | No |
| `codebaseMap` | `src/core/codebase-map/` | Codebase structure analysis and module graph | No |
| `adrs` | `src/core/adrs/` | Architecture Decision Record management | No |
| `coreMcp` | `src/core/mcp/` | MCP resource and tool registration helpers | No |
| `routing` | `src/core/routing/` | Internal operation routing utilities | No |
| `templates` | `src/core/templates/` | Template file management and rendering | No |
| `ui` | `src/core/ui/` | Output rendering helpers (tables, trees) | No |
| `system` | `src/core/system/` | System and environment checks | No |

### 3.2 Top-Level Utility Exports

The following symbols are exported directly from the barrel (no namespace required):

| Export | Source | Purpose |
|--------|--------|---------|
| `CleoError` | `src/core/errors.ts` | Error class with exit code and RFC 9457 details |
| `ProblemDetails` (type) | `src/core/errors.ts` | RFC 9457 Problem Details interface |
| `ERROR_CATALOG` | `src/core/error-catalog.ts` | Map of all registered error definitions |
| `getErrorDefinition` | `src/core/error-catalog.ts` | Look up an error definition by ExitCode |
| `formatSuccess` | `src/core/output.ts` | Wrap a result in a LAFS success envelope |
| `formatError` | `src/core/output.ts` | Wrap an error in a LAFS error envelope |
| `formatOutput` | `src/core/output.ts` | Format-agnostic output (auto-selects JSON or text) |
| `pushWarning` | `src/core/output.ts` | Attach a warning to the next envelope |
| `LafsEnvelope` (type) | `src/core/output.ts` | Union of `LafsSuccess` and `LafsError` |
| `loadConfig` | `src/core/config.ts` | Load CLEO config from `.cleo/config.json` |
| `getConfigValue` | `src/core/config.ts` | Read a typed config key |
| `setConfigValue` | `src/core/config.ts` | Write a config key atomically |
| `getCleoDir` | `src/core/paths.ts` | Relative `.cleo` path for a project |
| `getCleoDirAbsolute` | `src/core/paths.ts` | Absolute `.cleo` path for a project |
| `getProjectRoot` | `src/core/paths.ts` | Resolve absolute project root |
| `getTaskPath` | `src/core/paths.ts` | Absolute path to `tasks.db` |
| `isProjectInitialized` | `src/core/paths.ts` | Check whether `.cleo/` structure exists |
| `getLogger` | `src/core/logger.ts` | Get the active logger instance |
| `initLogger` | `src/core/logger.ts` | Initialize logger with config |
| `validateAgainstSchema` | `src/core/json-schema-validator.ts` | Validate data against a JSON Schema |
| `checkSchema` | `src/core/json-schema-validator.ts` | Run schema check and return boolean |
| `getSystemInfo` | `src/core/platform.ts` | Collect Node, OS, and platform details |
| `sha256` | `src/core/platform.ts` | Hash a string or buffer with SHA-256 |
| `getIsoTimestamp` | `src/core/platform.ts` | Current time as ISO 8601 string |
| `initProject` | `src/core/init.ts` | Full project initialization (scaffold + schema) |
| `ensureInitialized` | `src/core/init.ts` | Idempotent initialization check |
| `ensureCleoStructure` | `src/core/scaffold.ts` | Create `.cleo/` subdirectory structure |
| `paginate` | `src/core/pagination.ts` | Slice an array into a paginated result |
| `createPage` | `src/core/pagination.ts` | Build a typed page object |
| `ExitCode` | `src/types/exit-codes.ts` | Numeric exit code enum (re-exported from contracts) |
| `bootstrapCaamp` | `src/core/caamp-init.ts` | Initialize CAAMP with provider detection |

---

## 4. Dependencies

### 4.1 Peer Dependencies

Peer dependencies are required at runtime but not bundled with `@cleocode/core`.

| Package | Version | Purpose |
|---------|---------|---------|
| `@cleocode/contracts` | `>=2026.3.0` | Type-only adapter interfaces, `ExitCode` enum, config types |
| `@cleocode/caamp` | `>=1.6.0` | Provider capability API, spawn coordination |
| `@cleocode/lafs-protocol` | `>=1.0.0` | LAFS envelope types, `LAFSMeta`, `Warning` |

### 4.2 Runtime Dependencies

These are bundled or declared as dependencies (not peers).

| Package | Purpose |
|---------|---------|
| `drizzle-orm` | ORM for lifecycle and brain SQLite tables |
| `better-sqlite3` | SQLite driver (used by lifecycle, brain, nexus modules) |

### 4.3 Dependency Notes

- `drizzle-orm` and `better-sqlite3` are used internally by `lifecycle`, `memory` (brain.db), and `nexus` modules. Consumers that only use task/session modules do not trigger SQLite connections unless they call those specific modules.
- `@cleocode/contracts` exports zero runtime code. It is safe to tree-shake entirely.
- `@cleocode/lafs-protocol` provides the `LAFSMeta`, `LAFSPage`, and `Warning` types consumed by `src/core/output.ts`.

---

## 5. Export Contract

### 5.1 Public API

All symbols exported from `src/core/index.ts` are public API. Consumers MUST import only from `@cleocode/core` (the package root). Imports from internal subpaths (e.g., `@cleocode/core/tasks/add`) are not part of the public contract and may change without notice.

### 5.2 Stability Levels

| Stability | Meaning | Examples |
|-----------|---------|---------|
| **Stable** | No breaking changes without major version bump | `tasks.*`, `sessions.*`, `CleoError`, `formatSuccess` |
| **Beta** | May change between minor versions | `signaldock.*`, `orchestration.spawnWave`, `otel.*` |
| **Internal** | Not for external consumers; may be removed | `coreMcp.*`, `routing.*`, `coreHooks.*` |

### 5.3 What Is NOT Public API

The following are internal implementation details, not part of the public contract:

- Anything imported from `src/store/` directly (use `DataAccessor` instead)
- Any `__tests__/` files or test utilities
- Files prefixed with `_` (internal convention)
- `src/core/sessions/context-alert.ts` (session context singleton — internal)

---

## 6. DataAccessor Contract

Core modules that persist data accept an optional `DataAccessor` parameter. This is the primary extension point for custom storage backends.

### 6.1 Interface

```typescript
interface DataAccessor {
  readonly engine: 'sqlite';

  // Task file (read-modify-write pattern)
  loadTaskFile(): Promise<TaskFile>;
  saveTaskFile(data: TaskFile): Promise<void>;

  // Archive file
  loadArchive(): Promise<ArchiveFile | null>;
  saveArchive(data: ArchiveFile): Promise<void>;

  // Session collection
  loadSessions(): Promise<Session[]>;
  saveSessions(sessions: Session[]): Promise<void>;

  // Append-only audit log
  appendLog(entry: Record<string, unknown>): Promise<void>;

  // Resource cleanup
  close(): Promise<void>;

  // Optional fine-grained operations (T5034)
  upsertSingleTask?(task: Task): Promise<void>;
  archiveSingleTask?(taskId: string, fields: ArchiveFields): Promise<void>;
}
```

### 6.2 Usage Pattern

Core functions accept `accessor` as the last parameter:

```typescript
async function addTask(
  options: AddTaskOptions,
  cwd?: string,
  accessor?: DataAccessor,
): Promise<AddTaskResult>
```

When `accessor` is `undefined`, the function resolves via `getAccessor(cwd)` — a function in `src/store/data-accessor.ts` that constructs a `SqliteDataAccessor`. This factory is only available when `@cleocode/cleo` (which ships the store layer) is in scope.

### 6.3 Implementing a Custom Backend

Consumers that want to use `@cleocode/core` with a non-SQLite store (e.g., in-memory, Postgres, remote API) MUST implement `DataAccessor` and inject it at every call site. The `engine` discriminant is currently always `'sqlite'` in the reference implementation, but a custom implementation SHOULD set it to a unique identifier.

---

## 7. Core Purity Rules

`src/core/` MUST NOT import from:

| Prohibited path | Reason |
|----------------|--------|
| `src/cli/` | CLI adapter code (Commander.js, argument parsing) |
| `src/mcp/` | MCP adapter code (MCP SDK tool definitions) |
| `src/dispatch/` | Routing layer — core should not know about dispatch |
| `src/store/json.ts` (direct) | Use `DataAccessor` methods instead |
| `src/store/atomic.ts` (direct) | Only allowed for modules that directly own a file (e.g., MANIFEST.jsonl) |

These rules are enforced by a CI purity gate (`scripts/check-core-purity.sh` or equivalent). Exceptions MUST be registered in the known-exceptions allowlist with justification.

### 7.1 Allowed Store Imports

The following store imports are permitted within `src/core/` where the module is the direct file owner:

- `src/store/atomic.ts` — for modules that own files outside the main task/session store (e.g., research manifest, memory bridge)
- `src/store/brain-*.ts` — for `src/core/memory/` modules that own brain.db
- `src/store/sqlite.ts` — for `src/core/lifecycle/` (owns lifecycle tables in tasks.db)
- `src/store/data-accessor.ts` — only the `DataAccessor` interface and `getAccessor()` fallback

---

## 8. CAAMP Role

CAAMP (Central AI Agent Managed Packages) handles provider-level orchestration. Within `@cleocode/core`, the `caamp` namespace wraps the `@cleocode/caamp` API to provide:

| Capability | Function | Source |
|-----------|---------|--------|
| Provider detection | `detectRuntimeProviderContext()` | `src/core/metrics/provider-detection.ts` |
| Capability check | `providerSupportsById(id, capability)` | `@cleocode/caamp` (re-exported) |
| Hook event query | `getProvidersByHookEvent(event)` | `@cleocode/caamp` (re-exported) |
| Skill paths | `getEffectiveSkillsPaths(provider)` | `@cleocode/caamp` (re-exported) |
| MCP server config | `caampBuildServerConfig(options)` | `src/core/caamp/` |
| Dual-scope install | `dualScopeConfigure(config)` | `src/core/caamp/` |
| Batch install | `batchInstallWithRollback(options)` | `src/core/caamp/` |

CAAMP is initialized via `bootstrapCaamp(projectDir)`, which detects the active provider, activates the matching adapter, and wires skill routing. This is called automatically by `initProject()` and `startSession()`.

---

## 9. SignalDock Role

SignalDock is the inter-agent messaging transport within `@cleocode/core`. It provides a provider-neutral channel for agents in multi-wave orchestration to exchange messages without coupling to a specific AI platform API.

| Component | Purpose |
|-----------|---------|
| `AgentTransport` (interface) | Transport contract: `register`, `send`, `onMessage` |
| `ClaudeCodeTransport` | Transport implementation for Claude Code inter-agent protocol |
| `SignalDockTransport` | Transport implementation via SignalDock relay service |
| `createTransport(config)` | Factory: selects the appropriate transport for the current provider |

SignalDock is used internally by the `spawn` and `orchestration` modules. External consumers typically interact with it only when implementing custom orchestration protocols.

---

## 10. LAFS Response Envelope

All MCP-facing and API-facing operations MUST return a LAFS-compliant envelope. LAFS (LLM-Agent-First Schema) is specified by `@cleocode/lafs-protocol`.

### 10.1 Envelope Variants

| Type | `success` | Contains |
|------|-----------|---------|
| `LafsSuccess<T>` | `true` | `data: T`, `_meta: LAFSMeta`, optional `page: LAFSPage` |
| `LafsError` | `false` | `error: LAFSError`, `_meta: LAFSMeta` |

### 10.2 _meta Fields

| Field | Type | Description |
|-------|------|-------------|
| `requestId` | `string` (UUID v4) | Unique per-request identifier |
| `timestamp` | `string` (ISO 8601) | Time of envelope creation |
| `sessionId` | `string \| null` | Active CLEO session ID if any |
| `warnings` | `Warning[]` | Deprecation or informational notices |

### 10.3 Core Output API

```typescript
// Successful result
formatSuccess<T>(data: T, options?: FormatOptions): LafsSuccess<T>

// Error result (accepts Error, CleoError, or unknown)
formatError(err: unknown, options?: FormatOptions): LafsError

// Format-agnostic (selects JSON or text based on options)
formatOutput(data: unknown, options?: FormatOptions): string

// Attach a warning to the next envelope
pushWarning(warning: Warning): void
```

---

## 11. Versioning Policy

### 11.1 Version Scheme

`@cleocode/core` uses CalVer: `YYYY.MM.PATCH`.

- `YYYY.MM` segment advances each calendar month
- `PATCH` increments for any release within the month (bug fixes, features, breaking changes)
- Breaking changes MUST increment the patch and MUST be documented in the changelog

### 11.2 Semver Promises

`@cleocode/core` does not use semver but makes the following stability promises:

| Stability Level | Promise |
|----------------|---------|
| **Stable** exports | No removal or signature change without 30-day deprecation notice |
| **Beta** exports | May change in any release; changes noted in changelog |
| **Internal** exports | No guarantees; may be removed without notice |

### 11.3 Deprecation Process

1. Mark the symbol with a `@deprecated` JSDoc tag and a `pushWarning` call in the implementation
2. Add the deprecation to the changelog and release notes
3. Remove after one monthly cycle (minimum)

### 11.4 Relationship to @cleocode/cleo

`@cleocode/cleo` (`@latest`) depends on `@cleocode/core` and will always pin to a compatible version. Consumers upgrading `@cleocode/core` independently MUST ensure they use a version that `@cleocode/cleo` also supports, or accept that the versions may diverge.

---

## 12. Examples

### Initialization check before calling core operations

```typescript
import { isProjectInitialized, ensureInitialized } from '@cleocode/core';

const projectDir = '/path/to/project';

if (!isProjectInitialized(projectDir)) {
  await ensureInitialized(projectDir);
}
```

### Reading config values

```typescript
import { loadConfig, getConfigValue } from '@cleocode/core';

const config = await loadConfig(projectDir);
const mode = getConfigValue(config, 'lifecycle.enforcement', 'advisory');
```

### Lifecycle gate check before completing a task

```typescript
import { lifecycle, tasks } from '@cleocode/core';

// Check the current lifecycle gate
const gate = await lifecycle.checkGate(taskId, 'ready', projectDir, accessor);

if (!gate.canProgress) {
  throw new CleoError(ExitCode.LIFECYCLE_GATE_FAILED, gate.reason);
}

// Gate passed — safe to complete
await tasks.completeTask({ taskId }, projectDir, accessor);
```

---

## 13. References

- `src/core/index.ts` — barrel export (canonical module list)
- `src/store/data-accessor.ts` — `DataAccessor` interface definition
- `packages/contracts/src/index.ts` — `@cleocode/contracts` public API
- `docs/guides/core-package-guide.md` — consumer guide with code examples
- `docs/specs/CAAMP-INTEGRATION-SPEC.md` — CAAMP integration details
- `docs/adrs/ADR-001-provider-adapter-architecture.md` — adapter architecture rationale
- `docs/adrs/ADR-002-provider-agnostic-memory-bridge.md` — memory bridge rationale
- Epic T5701 — Core Extraction epic tracking all related tasks
