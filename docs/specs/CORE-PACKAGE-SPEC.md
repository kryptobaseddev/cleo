# @cleocode/core Package Specification

**Version**: 2.0.0
**Status**: APPROVED
**Date**: 2026-03-18
**Task**: T5714
**Epic**: T5701

---

## 1. Overview

This specification defines the public contract for `@cleocode/core`, the standalone business logic package within the CLEO monorepo.

`@cleocode/core` encapsulates all domain logic for task management, session lifecycle, memory persistence, multi-agent orchestration, lifecycle gate enforcement, release management, and related capabilities. It is designed to be consumed by adapter layers (CLI, MCP, custom integrations) without embedding any adapter-specific code itself.

### Design Goals

- **Standalone**: Importable without the `@cleocode/cleoctl` product package
- **Adapter-neutral**: No imports from `packages/cleoctl/` (CLI, MCP, or dispatch)
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
| Entry point | `dist/index.js` (compiled from `packages/core/src/index.ts`) |
| Type declarations | `dist/index.d.ts` |
| Module format | ES modules (`"type": "module"`) |
| Minimum Node.js | 24 |
| TypeScript | 6.0.1-rc targeting ES2025 |
| License | MIT |

### Package.json Shape (Target)

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
    }
  },
  "dependencies": {
    "@cleocode/caamp": "^1.7.0",
    "@cleocode/contracts": "workspace:*",
    "@cleocode/lafs-protocol": "^1.7.0",
    "ajv": "^8.18.0",
    "ajv-formats": "^3.0.1",
    "drizzle-orm": "1.0.0-beta.18-7eb39f0",
    "env-paths": "^4.0.0",
    "pino": "^10.3.1",
    "pino-roll": "^4.0.0",
    "proper-lockfile": "^4.1.2",
    "write-file-atomic": "^6.0.0",
    "yaml": "^2.8.2",
    "zod": "^3.24.0"
  }
}
```

---

## 3. Module Structure

The barrel export (`packages/core/src/index.ts`) re-exports all public modules as named namespaces. The table below documents all 40 modules, their role, and whether they require a `DataAccessor` at runtime.

### 3.1 Domain Namespace Modules

| Namespace | Source path | Role | Requires DataAccessor |
|-----------|------------|------|----------------------|
| `tasks` | `packages/core/src/tasks/` | Task CRUD, hierarchy, dependency validation, search | Yes |
| `sessions` | `packages/core/src/sessions/` | Session lifecycle, handoff, debrief, decisions | Yes |
| `memory` | `packages/core/src/memory/` | Brain.db observations, search, 3-layer retrieval | No (uses brain.db directly) |
| `orchestration` | `packages/core/src/orchestration/` | Dependency graph, wave analysis, progress metrics | Yes |
| `lifecycle` | `packages/core/src/lifecycle/` | RCASD-IVTR+C gate enforcement, stage transitions | Yes (SQLite lifecycle tables) |
| `release` | `packages/core/src/release/` | Changelog computation, version bump, ship pipeline | Yes |
| `admin` | `packages/core/src/admin/` | Dashboard, health check, configuration map | Yes |
| `compliance` | `packages/core/src/compliance/` | Protocol compliance recording and value reporting | No |
| `adapters` | `packages/core/src/adapters/` | Provider adapter discovery, detection, lifecycle | No |
| `caamp` | `packages/core/src/caamp/` | CAAMP wrapper -- provider capability API, spawn, skill routing | No |
| `signaldock` | `packages/core/src/signaldock/` | Inter-agent messaging transport (provider-neutral) | No |
| `spawn` | `packages/core/src/spawn/` | Subagent spawn coordination, registry | No |
| `skills` | `packages/core/src/skills/` | Skill routing table, precedence integration | No |
| `context` | `packages/core/src/context/` | Context window drift monitoring and alerts | No |
| `coreHooks` | `packages/core/src/hooks/` | Lifecycle hook dispatch registry | No |
| `pipeline` | `packages/core/src/pipeline/` | RCASD pipeline coordination and status | Yes |
| `phases` | `packages/core/src/phases/` | Execution wave computation, dependency maps | Yes |
| `taskWork` | `packages/core/src/task-work/` | Active task tracking (start, stop, current) | Yes |
| `research` | `packages/core/src/research/` | Research manifest operations, contradiction detection | Partial |
| `nexus` | `packages/core/src/nexus/` | Cross-project registry operations (nexus.db) | No (uses nexus.db) |
| `metrics` | `packages/core/src/metrics/` | Telemetry, value tracking, provider detection | No |
| `observability` | `packages/core/src/observability/` | Structured observability reporting | No |
| `otel` | `packages/core/src/otel/` | OpenTelemetry integration, token usage recording | No |
| `migration` | `packages/core/src/migration/` | Schema version detection and migration execution | Yes (SQLite) |
| `validation` | `packages/core/src/validation/` | Anti-hallucination validators, schema checks | No |
| `roadmap` | `packages/core/src/roadmap/` | Roadmap and milestone tracking | Yes |
| `security` | `packages/core/src/security/` | Permission checks and access audit | No |
| `sequence` | `packages/core/src/sequence/` | Ordered operation sequencing | No |
| `snapshot` | `packages/core/src/snapshot/` | Project state snapshot creation and restore | Yes |
| `stats` | `packages/core/src/stats/` | Task and session statistics aggregation | Yes |
| `sticky` | `packages/core/src/sticky/` | Sticky notes (persistent context anchors) | No |
| `inject` | `packages/core/src/inject/` | AGENTS.md / CLAUDE.md content injection | No |
| `issue` | `packages/core/src/issue/` | Issue and bug tracking | Yes |
| `remote` | `packages/core/src/remote/` | Remote sync push/pull operations | No |
| `codebaseMap` | `packages/core/src/codebase-map/` | Codebase structure analysis and module graph | No |
| `adrs` | `packages/core/src/adrs/` | Architecture Decision Record management | No |
| `coreMcp` | `packages/core/src/mcp/` | MCP resource and tool registration helpers | No |
| `routing` | `packages/core/src/routing/` | Internal operation routing utilities | No |
| `templates` | `packages/core/src/templates/` | Template file management and rendering | No |
| `ui` | `packages/core/src/ui/` | Output rendering helpers (tables, trees) | No |
| `system` | `packages/core/src/system/` | System and environment checks | No |

### 3.2 Top-Level Utility Exports

The following symbols are exported directly from the barrel (no namespace required):

| Export | Source | Purpose |
|--------|--------|---------|
| `CleoError` | `packages/core/src/errors.ts` | Error class with exit code and RFC 9457 details |
| `ProblemDetails` (type) | `packages/core/src/errors.ts` | RFC 9457 Problem Details interface |
| `ERROR_CATALOG` | `packages/core/src/error-catalog.ts` | Map of all registered error definitions |
| `getErrorDefinition` | `packages/core/src/error-catalog.ts` | Look up an error definition by ExitCode |
| `formatSuccess` | `packages/core/src/output.ts` | Wrap a result in a LAFS success envelope |
| `formatError` | `packages/core/src/output.ts` | Wrap an error in a LAFS error envelope |
| `formatOutput` | `packages/core/src/output.ts` | Format-agnostic output (auto-selects JSON or text) |
| `pushWarning` | `packages/core/src/output.ts` | Attach a warning to the next envelope |
| `LafsEnvelope` (type) | `packages/core/src/output.ts` | Union of `LafsSuccess` and `LafsError` |
| `loadConfig` | `packages/core/src/config.ts` | Load CLEO config from `.cleo/config.json` |
| `getConfigValue` | `packages/core/src/config.ts` | Read a typed config key |
| `setConfigValue` | `packages/core/src/config.ts` | Write a config key atomically |
| `getCleoDir` | `packages/core/src/paths.ts` | Relative `.cleo` path for a project |
| `getCleoDirAbsolute` | `packages/core/src/paths.ts` | Absolute `.cleo` path for a project |
| `getProjectRoot` | `packages/core/src/paths.ts` | Resolve absolute project root |
| `getTaskPath` | `packages/core/src/paths.ts` | Absolute path to `tasks.db` |
| `isProjectInitialized` | `packages/core/src/paths.ts` | Check whether `.cleo/` structure exists |
| `getLogger` | `packages/core/src/logger.ts` | Get the active logger instance |
| `initLogger` | `packages/core/src/logger.ts` | Initialize logger with config |
| `validateAgainstSchema` | `packages/core/src/json-schema-validator.ts` | Validate data against a JSON Schema |
| `checkSchema` | `packages/core/src/json-schema-validator.ts` | Run schema check and return boolean |
| `getSystemInfo` | `packages/core/src/platform.ts` | Collect Node, OS, and platform details |
| `sha256` | `packages/core/src/platform.ts` | Hash a string or buffer with SHA-256 |
| `getIsoTimestamp` | `packages/core/src/platform.ts` | Current time as ISO 8601 string |
| `initProject` | `packages/core/src/init.ts` | Full project initialization (scaffold + schema) |
| `ensureInitialized` | `packages/core/src/init.ts` | Idempotent initialization check |
| `ensureCleoStructure` | `packages/core/src/scaffold.ts` | Create `.cleo/` subdirectory structure |
| `paginate` | `packages/core/src/pagination.ts` | Slice an array into a paginated result |
| `createPage` | `packages/core/src/pagination.ts` | Build a typed page object |
| `ExitCode` | `packages/core/src/types/exit-codes.ts` | Numeric exit code enum (re-exported from contracts) |
| `bootstrapCaamp` | `packages/core/src/caamp-init.ts` | Initialize CAAMP with provider detection |

---

## 4. Dependencies

### 4.1 Dependencies

`@cleocode/contracts` uses `workspace:*` within the pnpm monorepo. `@cleocode/caamp` and `@cleocode/lafs-protocol` are bundled as direct dependencies (not peers) for simplicity. Consumers installing `@cleocode/core` from npm receive all three automatically.

### 4.2 Runtime Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@cleocode/caamp` | `^1.7.0` | Provider capability API, spawn coordination |
| `@cleocode/contracts` | `workspace:*` | Type-only adapter interfaces, `ExitCode` enum, config types |
| `@cleocode/lafs-protocol` | `^1.7.0` | LAFS envelope types, `LAFSMeta`, `Warning` |
| `ajv` | `^8.18.0` | JSON Schema validation |
| `ajv-formats` | `^3.0.1` | AJV format validators (date-time, uri, etc.) |
| `drizzle-orm` | `1.0.0-beta.18-7eb39f0` | ORM for lifecycle, brain, and nexus SQLite tables (beta version) |
| `env-paths` | `^4.0.0` | Platform-appropriate config/data paths |
| `pino` | `^10.3.1` | Structured logger |
| `pino-roll` | `^4.0.0` | Rolling log file transport |
| `proper-lockfile` | `^4.1.2` | File locking for atomic writes |
| `write-file-atomic` | `^6.0.0` | Atomic file write operations |
| `yaml` | `^2.8.2` | YAML parsing and serialization |
| `zod` | `^3.24.0` | Runtime validation schemas (used via drizzle-orm Zod integration) |

### 4.3 Dependency Notes

- `drizzle-orm` is at a beta version (`1.0.0-beta.18-*`) and must be pinned to the exact build hash used by `@cleocode/cleoctl`. Pre-release semver ranges (`^`) do not work correctly -- always pin to the exact version.
- SQLite is provided by Node.js built-in `node:sqlite` (requires Node 24+) via `drizzle-orm/sqlite-proxy`. This is zero-dependency -- no `sql.js` or `better-sqlite3` needed. It is used internally by `lifecycle`, `memory` (brain.db), and `nexus` modules. Consumers that only use task/session modules do not trigger SQLite connections unless they call those specific modules.
- `@cleocode/contracts` exports zero runtime code. It is safe to tree-shake entirely.
- `@cleocode/lafs-protocol` provides the `LAFSMeta`, `LAFSPage`, and `Warning` types consumed by `packages/core/src/output.ts`.
- `zod` is used for drizzle-orm Zod validation schemas (`createInsertSchema`/`createSelectSchema` from `drizzle-orm/zod`).

---

## 5. Export Contract

### 5.1 Public API

All symbols exported from `packages/core/src/index.ts` are public API. Consumers MUST import only from `@cleocode/core` (the package root). Imports from internal subpaths (e.g., `@cleocode/core/tasks/add`) are not part of the public contract and may change without notice.

### 5.2 Stability Levels

| Stability | Meaning | Examples |
|-----------|---------|---------|
| **Stable** | No breaking changes without major version bump | `tasks.*`, `sessions.*`, `CleoError`, `formatSuccess` |
| **Beta** | May change between minor versions | `signaldock.*`, `orchestration.spawnWave`, `otel.*` |
| **Internal** | Not for external consumers; may be removed | `coreMcp.*`, `routing.*`, `coreHooks.*` |

### 5.3 What Is NOT Public API

The following are internal implementation details, not part of the public contract:

- Anything imported from `packages/core/src/store/` directly (use `DataAccessor` instead)
- Any `__tests__/` files or test utilities
- Files prefixed with `_` (internal convention)
- `packages/core/src/sessions/context-alert.ts` (session context singleton -- internal)

---

## 6. DataAccessor Contract

Core modules that persist data accept an optional `DataAccessor` parameter. This is the primary extension point for custom storage backends.

### 6.1 Interface

The `DataAccessor` interface is defined in `@cleocode/contracts` (`packages/contracts/`). Factory functions that construct the default SQLite-backed accessor live in `packages/core/src/store/`.

```typescript
// From @cleocode/contracts
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

When `accessor` is `undefined`, the function resolves via `getAccessor(cwd)` -- a function in `packages/core/src/store/data-accessor.ts` that constructs a `SqliteDataAccessor` from the bundled store layer.

### 6.3 Implementing a Custom Backend

Consumers that want to use `@cleocode/core` with a non-SQLite store (e.g., in-memory, Postgres, remote API) MUST implement `DataAccessor` from `@cleocode/contracts` and inject it at every call site. The `engine` discriminant is currently always `'sqlite'` in the reference implementation, but a custom implementation SHOULD set it to a unique identifier.

---

## 7. Core Purity Rules

`packages/core/src/` MUST NOT import from:

| Prohibited path | Reason |
|----------------|--------|
| `packages/cleoctl/src/cli/` | CLI adapter code (Commander.js, argument parsing) |
| `packages/cleoctl/src/mcp/` | MCP adapter code (MCP SDK tool definitions) |
| `packages/cleoctl/src/dispatch/` | Routing layer -- core should not know about dispatch |

### 7.1 Allowed Store Imports

The store is bundled inside `packages/core/src/store/`. Core modules MAY import from `./store/` (relative within the package) since the store ships as part of core. This is a key change from the prior architecture where the store was external.

The following store imports are permitted within `packages/core/src/`:

- `packages/core/src/store/atomic.ts` -- for modules that own files outside the main task/session store (e.g., research manifest, memory bridge)
- `packages/core/src/store/brain-*.ts` -- for `packages/core/src/memory/` modules that own brain.db
- `packages/core/src/store/sqlite.ts` -- for `packages/core/src/lifecycle/` (owns lifecycle tables in tasks.db)
- `packages/core/src/store/data-accessor.ts` -- the `DataAccessor` interface re-export and `getAccessor()` fallback

These rules are enforced by a CI purity gate. Exceptions MUST be registered in the known-exceptions allowlist with justification.

---

## 8. CAAMP Role

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

`@cleocode/core` uses semver starting from v2.0.0 for the restructured monorepo. The prior CalVer scheme (`YYYY.MM.PATCH`) applied to the pre-extraction era.

### 11.2 Semver Promises

| Stability Level | Promise |
|----------------|---------|
| **Stable** exports | No removal or signature change without major version bump |
| **Beta** exports | May change in any minor release; changes noted in changelog |
| **Internal** exports | No guarantees; may be removed without notice |

### 11.3 Deprecation Process

1. Mark the symbol with a `@deprecated` JSDoc tag and a `pushWarning` call in the implementation
2. Add the deprecation to the changelog and release notes
3. Remove after one minor version cycle (minimum)

### 11.4 Relationship to @cleocode/cleoctl

`@cleocode/cleoctl` (`@latest`) depends on `@cleocode/core` and will always pin to a compatible version. Consumers upgrading `@cleocode/core` independently MUST ensure they use a version that `@cleocode/cleoctl` also supports, or accept that the versions may diverge.

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

// Gate passed -- safe to complete
await tasks.completeTask({ taskId }, projectDir, accessor);
```

---

## 13. References

- `packages/core/src/index.ts` -- barrel export (canonical module list)
- `packages/core/src/store/data-accessor.ts` -- `DataAccessor` factory functions
- `packages/contracts/src/index.ts` -- `@cleocode/contracts` public API (`DataAccessor` interface)
- `docs/guides/core-package-guide.md` -- consumer guide with code examples
- `docs/specs/CAAMP-INTEGRATION-SPEC.md` -- CAAMP integration details
- `docs/adrs/ADR-001-provider-adapter-architecture.md` -- adapter architecture rationale
- `docs/adrs/ADR-002-provider-agnostic-memory-bridge.md` -- memory bridge rationale
- Epic T5701 -- Core Extraction epic tracking all related tasks
