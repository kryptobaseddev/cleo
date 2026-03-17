# @cleocode/core Consumer Guide

**Task**: T5714
**Epic**: T5701

---

## Overview

`@cleocode/core` is the standalone business logic package for CLEO. It contains all 40+ domain modules that implement task management, session lifecycle, memory persistence, orchestration, and more — without binding to any specific runtime adapter (CLI, MCP, or SQLite).

The package is the single source of truth for CLEO's business rules. Both `@cleocode/cleo` (the product package with MCP and CLI adapters) and any third-party integrations delegate to `@cleocode/core` for all meaningful work.

### Dependency Stack

```
@cleocode/cleo          (product — CLI + MCP + SQLite)
       |
@cleocode/core          (this package — all business logic)
       |
@cleocode/contracts     (type-only adapter interfaces, ExitCode, config types)
@cleocode/caamp         (provider capability API and spawn coordination)
@cleocode/lafs-protocol (LLM-Agent-First Schema envelope types)
drizzle-orm / better-sqlite3  (used internally by lifecycle and brain modules)
```

### What Is Included

- All 40+ business logic modules (tasks, sessions, memory, orchestration, etc.)
- `caamp/` — wrapper bridging `@cleocode/caamp` for provider/skill integration
- `signaldock/` — internal agent transport for inter-agent messaging
- LAFS output formatting (`output.ts`) and RFC 9457 error shaping (`error-catalog.ts`)
- Path utilities, logger, config loader, scaffold checks, audit log, and schema management

### What Is Not Included

`@cleocode/core` does not contain a CLI adapter, MCP server, dispatch routing layer, or SQLite `DataAccessor` implementation. Those live in `@cleocode/cleo`:

```
@cleocode/cleo
  src/cli/        -- Commander.js adapter
  src/mcp/        -- MCP SDK adapter
  src/dispatch/   -- routing layer
  src/store/      -- SqliteDataAccessor implementation
```

---

## Installation

```bash
npm install @cleocode/core
```

Peer dependencies must also be available:

```bash
npm install @cleocode/contracts @cleocode/caamp @cleocode/lafs-protocol
```

`@cleocode/core` requires Node.js 24 or later and is an ES module package (`"type": "module"`). All import paths use the `.js` extension convention.

---

## Quick Start

### Adding and Querying Tasks

```typescript
import { tasks, formatSuccess } from '@cleocode/core';

// Add a task — requires a DataAccessor (provided by @cleocode/cleo or a custom backend)
const result = await tasks.addTask(
  {
    title: 'Implement auth module',
    description: 'Add JWT-based authentication to the API layer',
    status: 'pending',
    priority: 'high',
    size: 'medium',
  },
  '/path/to/project',
  accessor, // DataAccessor implementation
);

console.log(result.task.id); // e.g. "T0042"

// Find tasks by status
const found = await tasks.findTasks(
  { status: 'pending', limit: 10 },
  '/path/to/project',
  accessor,
);

// Format as a LAFS-compliant envelope for MCP or API consumers
const envelope = formatSuccess({ tasks: found.tasks });
```

### Starting and Ending a Session

```typescript
import { sessions } from '@cleocode/core';

// Start a session scoped to an epic
const session = await sessions.startSession(
  {
    name: 'Auth implementation sprint',
    scope: 'epic:T0040',
    agent: 'claude-code',
  },
  '/path/to/project',
  accessor,
);

console.log(session.id); // e.g. "session-1741234567-abc123"

// End the session with a closing note
const ended = await sessions.endSession(
  { note: 'Completed auth module, ready for review' },
  '/path/to/project',
  accessor,
);
```

### Storing a Brain Observation

`@cleocode/core` ships a brain memory system backed by `brain.db`. The 3-layer retrieval pattern (search -> timeline -> fetch) keeps token usage low.

```typescript
import { memory } from '@cleocode/core';

// Save an observation to brain.db
await memory.observeBrain(
  {
    type: 'learning',
    title: 'JWT refresh tokens require separate rotation key',
    text: 'Using the same key for access and refresh tokens is an anti-pattern. Rotate the refresh key independently.',
    tags: ['auth', 'jwt', 'security'],
    confidence: 0.85,
    source: 'task-completion',
    linkedTaskId: 'T0042',
  },
  '/path/to/project',
);

// Search the brain index (cheap — returns IDs + titles only)
const hits = await memory.searchBrainCompact('JWT rotation', '/path/to/project');

// Fetch full details for specific entries
const entries = await memory.fetchBrainEntries(
  hits.map((h) => h.id),
  '/path/to/project',
);
```

### Spawning an Orchestration Wave

```typescript
import { orchestration, spawn } from '@cleocode/core';

// Analyze task dependencies before scheduling a wave
const analysis = await orchestration.analyzeDependencies(
  tasks,
  '/path/to/project',
  accessor,
);

// Build execution waves from the dependency graph
const waves = await orchestration.getExecutionWaves(
  analysis.graph,
  '/path/to/project',
);

// Spawn a subagent wave (requires a spawn-capable provider via CAAMP)
const result = await spawn.spawnWave(
  {
    waveId: 'wave-1',
    tasks: waves[0],
    protocol: 'cleo-subagent',
    providerId: 'claude-code',
  },
  '/path/to/project',
);
```

---

## API Surface

`@cleocode/core` uses namespace re-exports. Import the namespace you need:

```typescript
import { tasks, sessions, memory, lifecycle } from '@cleocode/core';
```

Or import top-level utilities directly:

```typescript
import { CleoError, formatSuccess, getCleoDir, loadConfig } from '@cleocode/core';
```

### Domain Namespaces

| Namespace | Purpose | Key exports |
|-----------|---------|-------------|
| `tasks` | Task CRUD, hierarchy, dependencies | `addTask`, `findTasks`, `listTasks`, `updateTask`, `completeTask`, `deleteTask`, `archiveTasks`, `showTask` |
| `sessions` | Session lifecycle | `startSession`, `endSession`, `sessionStatus`, `listSessions`, `resumeSession`, `computeHandoff`, `computeDebrief` |
| `memory` | Brain.db — observations, patterns, learnings | `observeBrain`, `searchBrainCompact`, `fetchBrainEntries`, `timelineBrain`, `addDecision`, `addLearning` |
| `orchestration` | Multi-agent coordination | `analyzeDependencies`, `buildDependencyGraph`, `detectCircularDependencies`, `computeProgress`, `computeEpicStatus` |
| `lifecycle` | RCASD-IVTR+C pipeline gates | `lifecycleProgress`, `checkGate`, `getStageStatus`, `linkEvidence` |
| `release` | Changelog, versioning, shipping | `computeChangelog`, `bumpVersion`, `shipRelease` |
| `admin` | Dashboard, health, configuration | `getAdminDash`, `getDoctorStatus`, `getAdminMap` |
| `compliance` | Protocol compliance tracking | `recordCompliance`, `getComplianceValue` |
| `adapters` | Provider adapter discovery and lifecycle | `AdapterManager`, `detectActiveAdapter` |
| `caamp` | CAAMP provider/skill integration | `caampBuildServerConfig`, `batchInstallWithRollback`, `dualScopeConfigure` |
| `signaldock` | Inter-agent messaging transport | `createTransport`, `ClaudeCodeTransport`, `SignalDockTransport` |
| `spawn` | Subagent spawn coordination | `spawnWave`, `spawnSubagent` |
| `skills` | Skill routing and precedence | `buildSkillsMap`, `getEffectiveSkillsPaths`, `getRoutingTable` |
| `context` | Context window monitoring | `getContextDrift`, `computeContextAlert` |
| `research` | Research manifest operations | `addResearch`, `queryManifest`, `searchManifest`, `appendExtendedManifest` |
| `nexus` | Cross-project registry (nexus.db) | `registerProject`, `listProjects`, `syncNexus` |
| `metrics` | Telemetry and value tracking | `recordMetric`, `getMetricsSummary`, `detectRuntimeProviderContext` |
| `pipeline` | RCASD pipeline coordination | `getPipelineStatus`, `advancePipeline` |
| `phases` | Execution wave and dependency analysis | `getExecutionWaves`, `buildPhaseMap` |
| `roadmap` | Roadmap and milestone tracking | `getRoadmap`, `addMilestone` |
| `security` | Security checks and audit | `checkPermissions`, `auditAccess` |
| `migration` | Schema migration management | `detectMigrationVersion`, `runMigration` |
| `observability` | Structured logging and tracing | `getObservabilityReport` |
| `otel` | OpenTelemetry integration | `initOtel`, `recordTokenUsage` |
| `sticky` | Sticky notes (persistent context anchors) | `addSticky`, `listStickies`, `resolveSticky` |
| `snapshot` | Project state snapshots | `createSnapshot`, `restoreSnapshot` |
| `stats` | Task and session statistics | `getTaskStats`, `getSessionStats` |
| `taskWork` | Active task tracking (start/stop/current) | `startWork`, `stopWork`, `getCurrentTask` |
| `validation` | Anti-hallucination validators | `validateTask`, `checkDuplicates` |
| `ui` | Output rendering helpers | `renderTable`, `renderTree` |
| `templates` | Template file management | `renderTemplate`, `listTemplates` |
| `system` | System and environment checks | `getSystemInfo`, `checkNodeVersion` |
| `routing` | Internal operation routing utilities | `resolveRoute`, `buildRouteMap` |
| `sequence` | Ordered operation sequencing | `buildSequence`, `executeSequence` |
| `inject` | AGENTS.md / CLAUDE.md injection | `ensureInjection`, `checkInjection` |
| `issue` | Issue and bug tracking | `addIssue`, `listIssues` |
| `remote` | Remote sync operations | `pushRemote`, `pullRemote` |
| `codebaseMap` | Codebase structure analysis | `buildCodebaseMap`, `getModuleGraph` |
| `adrs` | Architecture Decision Record management | `addAdr`, `listAdrs`, `linkPipelineAdr` |
| `coreMcp` | MCP resource and tool registration helpers | `registerResource`, `buildMcpManifest` |
| `hooks` | Lifecycle hook dispatch registry | `dispatchHook`, `registerHook` |

### Top-Level Utilities

These are exported directly from `@cleocode/core` without a namespace:

```typescript
// Errors
import { CleoError, ERROR_CATALOG, getErrorDefinition } from '@cleocode/core';

// LAFS output formatting
import { formatSuccess, formatError, formatOutput, pushWarning } from '@cleocode/core';

// Config
import { loadConfig, getConfigValue, setConfigValue } from '@cleocode/core';

// Paths
import { getCleoDir, getCleoDirAbsolute, getTaskPath, getProjectRoot } from '@cleocode/core';

// Logger
import { getLogger, initLogger } from '@cleocode/core';

// Validation
import { validateAgainstSchema, checkSchema } from '@cleocode/core';

// Platform
import { getSystemInfo, sha256, getIsoTimestamp } from '@cleocode/core';

// Init / Scaffold
import { initProject, ensureInitialized, ensureCleoStructure } from '@cleocode/core';

// Pagination
import { paginate, createPage } from '@cleocode/core';

// ExitCode (re-exported from @cleocode/contracts for convenience)
import { ExitCode } from '@cleocode/core';
```

---

## DataAccessor

Most task, session, and audit operations require a `DataAccessor`. This interface abstracts the storage backend — core modules do not care whether data lives in SQLite or another store.

```typescript
import type { DataAccessor } from '@cleocode/core'; // re-exported from store layer
```

The interface contract:

```typescript
interface DataAccessor {
  readonly engine: 'sqlite';

  // Task data
  loadTaskFile(): Promise<TaskFile>;
  saveTaskFile(data: TaskFile): Promise<void>;

  // Archive
  loadArchive(): Promise<ArchiveFile | null>;
  saveArchive(data: ArchiveFile): Promise<void>;

  // Sessions
  loadSessions(): Promise<Session[]>;
  saveSessions(sessions: Session[]): Promise<void>;

  // Audit log
  appendLog(entry: Record<string, unknown>): Promise<void>;

  // Lifecycle
  close(): Promise<void>;

  // Optional fine-grained ops (skip full-file reload when available)
  upsertSingleTask?(task: Task): Promise<void>;
  archiveSingleTask?(taskId: string, fields: ArchiveFields): Promise<void>;
}
```

### Providing an Accessor

When using `@cleocode/cleo`, the dispatch layer creates and injects a `SqliteDataAccessor` automatically. When calling `@cleocode/core` directly, you must provide your own implementation or use the built-in factory:

```typescript
import { getAccessor } from '@cleocode/cleo/store'; // SqliteDataAccessor factory

const accessor = await getAccessor('/path/to/project');

// Pass to core operations
const session = await sessions.startSession(options, '/path/to/project', accessor);

// Always close when done
await accessor.close();
```

Core functions also accept `undefined` for the accessor parameter. When omitted, they fall back to resolving the project working directory and constructing a default accessor internally — but this only works inside `@cleocode/cleo` where the SQLite implementation is present.

---

## CAAMP Integration

CAAMP (Central AI Agent Managed Packages) is the provider capability API. `@cleocode/core` wraps CAAMP via the `caamp` namespace to provide:

- **Provider detection**: Which AI coding tool is currently running (Claude Code, OpenCode, Cursor, etc.)
- **Capability queries**: Does the active provider support spawning subagents? Hooks?
- **Skill routing**: Which skill paths are active for the current provider?
- **MCP profile installation**: Write provider-specific config files

```typescript
import { caamp } from '@cleocode/core';
import { providerSupportsById, getProvidersByHookEvent } from '@cleocode/caamp';

// Check if the active provider can spawn subagents
if (providerSupportsById('claude-code', 'spawn.supportsSubagents')) {
  await spawn.spawnWave(waveConfig, projectDir);
}

// Find all providers that support a given hook event
const providers = getProvidersByHookEvent('onToolComplete');

// Install CLEO's MCP server config for a provider
const config = caamp.caampBuildServerConfig({
  providerId: 'claude-code',
  channel: 'stable',
  projectDir: '/path/to/project',
});
await caamp.dualScopeConfigure(config);
```

### CAAMP Bootstrap

`bootstrapCaamp()` is the recommended entry point when initializing a new CLEO session. It wires together provider detection, adapter activation, and skill routing in one call:

```typescript
import { bootstrapCaamp } from '@cleocode/core';

await bootstrapCaamp('/path/to/project');
```

---

## SignalDock Transport

SignalDock is the internal agent-to-agent messaging transport. It provides a provider-neutral channel for inter-agent communication in multi-wave orchestration scenarios.

```typescript
import { signaldock } from '@cleocode/core';

// Create a transport for the active provider
const transport = signaldock.createTransport({
  provider: 'claude-code',
  projectDir: '/path/to/project',
});

// Register this agent
await transport.register({ agentId: 'wave-2-agent', role: 'implementer' });

// Receive messages from the orchestrator
transport.onMessage((msg) => {
  console.log('Received:', msg);
});
```

For Claude Code specifically, `ClaudeCodeTransport` uses the Claude Code inter-agent protocol directly. For other environments, `SignalDockTransport` communicates via the SignalDock relay service.

---

## LAFS Response Shape

All `@cleocode/core` operations that produce output for MCP or API consumers should be wrapped in a LAFS (LLM-Agent-First Schema) envelope using `formatSuccess` or `formatError`.

### Success envelope

```typescript
import { formatSuccess } from '@cleocode/core';

const envelope = formatSuccess({ tasks: result.tasks, total: result.total });
```

The envelope shape:

```json
{
  "$schema": "https://cleocode.dev/schemas/lafs/v1/success.json",
  "success": true,
  "data": {
    "tasks": [...],
    "total": 5
  },
  "_meta": {
    "requestId": "uuid-v4",
    "timestamp": "2026-03-17T12:00:00.000Z",
    "sessionId": "session-...",
    "warnings": []
  }
}
```

### Error envelope

```typescript
import { formatError, CleoError } from '@cleocode/core';
import { ExitCode } from '@cleocode/contracts';

try {
  await tasks.addTask(options, cwd, accessor);
} catch (err) {
  const envelope = formatError(err);
  // Returns a LAFS error envelope with RFC 9457 ProblemDetails
}
```

The error envelope shape:

```json
{
  "$schema": "https://cleocode.dev/schemas/lafs/v1/error.json",
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Title and description must be different",
    "exitCode": 3,
    "fix": "Provide a description that elaborates on the title",
    "category": "VALIDATION"
  },
  "_meta": {
    "requestId": "uuid-v4",
    "timestamp": "2026-03-17T12:00:00.000Z"
  }
}
```

### Warnings

Use `pushWarning` to attach deprecation or informational notices to the next envelope:

```typescript
import { pushWarning, formatSuccess } from '@cleocode/core';

pushWarning({ code: 'DEPRECATED_FIELD', message: 'The `phase` field is deprecated; use `labels`.' });
const envelope = formatSuccess(data); // warnings included in _meta.warnings
```

---

## Error Handling

All errors from `@cleocode/core` are instances of `CleoError`, which extends `Error` with a structured payload.

```typescript
import { CleoError } from '@cleocode/core';
import { ExitCode } from '@cleocode/contracts';

try {
  await sessions.startSession(options, cwd, accessor);
} catch (err) {
  if (err instanceof CleoError) {
    console.error(`Exit code: ${err.exitCode}`);       // numeric exit code
    console.error(`Message: ${err.message}`);
    console.error(`Fix: ${err.details?.fix}`);         // suggested remediation
    console.error(`Alternatives:`, err.details?.alternatives);
  }
}
```

### Exit Code Ranges

| Range | Domain |
|-------|--------|
| 0 | Success |
| 1-9 | General (input, file, validation, config) |
| 10-19 | Hierarchy (parent, depth, siblings, circular) |
| 20-29 | Concurrency (checksum, concurrent modification) |
| 30-39 | Session (scope, claimed, required) |
| 40-47 | Verification (gate, agent, rounds) |
| 50-54 | Context safeguard |
| 60-67 | Orchestrator (protocol missing, spawn validation, handoff) |
| 70-79 | Nexus (not initialized, project not found, sync) |
| 80-84 | Lifecycle enforcement (gate failed, audit missing, transition invalid) |
| 85-89 | Artifact publish |
| 90-94 | Provenance |
| 100+ | Special (not errors) |

### Checking error codes

```typescript
import { isErrorCode, isRecoverableCode, ExitCode } from '@cleocode/contracts';

if (err instanceof CleoError) {
  if (isRecoverableCode(err.exitCode)) {
    // Safe to retry with adjusted parameters
  }
  if (err.exitCode === ExitCode.SCOPE_CONFLICT) {
    // Resume existing session instead
  }
}
```

---

## Troubleshooting

### "No active session found"

Session operations require an active session. Start one first:

```typescript
await sessions.startSession({ name: 'My session', scope: 'global' }, cwd, accessor);
```

### "DataAccessor not available"

If you call a core function that needs an accessor without providing one and outside `@cleocode/cleo`, it will fail. Always inject an accessor when calling core functions directly.

### Brain.db not initialized

The brain database must be scaffolded before use. `ensureCleoStructure` (called during `initProject`) handles this automatically. If you are working outside a fully initialized CLEO project, call it explicitly:

```typescript
import { ensureCleoStructure } from '@cleocode/core';
await ensureCleoStructure('/path/to/project');
```

---

## References

- `@cleocode/contracts` — type-only adapter interfaces and `ExitCode` enum
- `@cleocode/caamp` — provider capability API
- `@cleocode/lafs-protocol` — LAFS envelope type definitions
- `docs/specs/CORE-PACKAGE-SPEC.md` — formal package specification
- `docs/specs/CAAMP-INTEGRATION-SPEC.md` — CAAMP integration details
- `docs/guides/adapter-development.md` — building provider adapters
- `AGENTS.md` — architecture overview
