# @cleocode/core Consumer Guide

**Task**: T5714
**Epic**: T5701

---

## Overview

`@cleocode/core` is the standalone business logic kernel for CLEO. It packages all domain logic — task management, session lifecycle, brain memory, multi-agent orchestration, lifecycle gate enforcement, release management, and more — as a self-contained npm package that works independently of the full `@cleocode/cleo` product.

### Who this package is for

- **App developers** who want CLEO's task/session/memory system embedded in their own tool without installing the full CLI or MCP server.
- **Custom integration builders** who need to swap the SQLite storage layer for a different backend (Postgres, in-memory, remote API).
- **Contributors** who want to understand what lives in core versus what lives in the product adapter layer.

### When to use `@cleocode/core` vs `@cleocode/cleo`

| You want | Use |
|----------|-----|
| An AI coding agent that uses CLEO's full MCP toolset | `@cleocode/cleo` (CLI + MCP) |
| CLEO's task/session/memory API in your Node.js app | `@cleocode/core` |
| A custom storage backend (non-SQLite) | `@cleocode/core` + your `DataAccessor` |
| Human CLI access to tasks and sessions | `@cleocode/cleo` |

### What `@cleocode/core` contains

`@cleocode/core` is the `src/core/` directory from the CLEO monorepo, published as a standalone package. It includes:

- All 40+ business logic modules across 10 canonical domains
- The `Cleo` facade class for project-bound API access
- LAFS output formatting (`formatSuccess`, `formatError`) and RFC 9457 error types
- CAAMP wrapper for provider capability detection and skill routing
- SignalDock transport for inter-agent messaging
- Path utilities, config loader, logger, scaffold checks, and schema management

### What it does not contain

The CLI adapter (Commander.js), MCP server, dispatch routing layer, and `SqliteDataAccessor` implementation all live in `@cleocode/cleo`, not in core:

```
@cleocode/cleo
  src/cli/        -- Commander.js argument parsing
  src/mcp/        -- MCP SDK tool definitions
  src/dispatch/   -- string-addressed routing layer
  src/store/      -- SqliteDataAccessor + atomic write helpers
```

### The four CLEO systems

`@cleocode/core` implements all four canonical CLEO systems:

- **BRAIN** — Persistent memory and cognition via `brain.db`. Stores observations, patterns, learnings, and decisions with a 3-layer retrieval API (find → timeline → fetch) that minimizes token usage.
- **LOOM** — The RCASD-IVTR+C lifecycle pipeline. Structured gate enforcement for Research → Consensus → Architecture Decision → Specification → Decomposition → Implementation → Validation → Testing → Release.
- **NEXUS** — Cross-project registry and federated task discovery via `~/.cleo/nexus.db`.
- **LAFS** — The LLM-Agent-First Schema communication contract. All outputs are structured JSON envelopes with metadata, warnings, and deterministic exit codes.

---

## Prerequisites

- Node.js >= 24
- An ES module project (`"type": "module"` in `package.json`)

---

## Installation

```bash
npm install @cleocode/core
```

All runtime dependencies (`@cleocode/contracts`, `@cleocode/caamp`, `@cleocode/lafs-protocol`, `drizzle-orm`, etc.) are included as direct dependencies and install automatically. SQLite is provided by Node.js built-in `node:sqlite` (requires Node 24+) — no native modules needed.

---

## Quick Start

### Pattern 1: Facade (Recommended)

`Cleo.init()` creates a project-bound instance that shares a single `DataAccessor` across all operations. This is the most efficient approach when you need to call multiple operations in sequence.

```typescript
import { Cleo } from '@cleocode/core';

const cleo = await Cleo.init('/path/to/project');

// Tasks
await cleo.tasks.add({
  title: 'Build authentication module',
  description: 'Implement JWT-based auth for the REST API layer',
});

const task = await cleo.tasks.show('T1234');
await cleo.tasks.complete({ taskId: 'T1234', notes: 'Done — all tests passing' });

// Sessions
await cleo.sessions.start({ name: 'auth-sprint', scope: 'global' });
await cleo.sessions.end({ note: 'Completed auth module' });

// Memory
await cleo.memory.observe({ text: 'JWT refresh tokens require a separate rotation key' });
const results = await cleo.memory.find({ query: 'authentication' });
```

If you need a synchronous construction path (e.g., in module initializers), use `Cleo.forProject()`. This creates the instance without pre-opening the DataAccessor — each operation will open and close its own connection.

```typescript
const cleo = Cleo.forProject('/path/to/project');
await cleo.tasks.list({ status: 'pending' });
```

### Pattern 2: Tree-Shakeable Functions

Import individual functions for minimal bundle size. Bundlers can eliminate the modules you do not use.

```typescript
import { addTask, startSession, observeBrain } from '@cleocode/core';

await addTask(
  { title: 'Build API', description: 'REST endpoints for user management' },
  '/path/to/project',
);

await startSession(
  { name: 'api-sprint', scope: 'global' },
  '/path/to/project',
);

await observeBrain('/path/to/project', {
  text: 'REST resource naming should match entity names in the domain model',
});
```

The full list of tree-shakeable individual function exports is in `packages/core/src/index.ts`. Common exports: `addTask`, `findTasks`, `listTasks`, `showTask`, `updateTask`, `completeTask`, `deleteTask`, `archiveTasks`, `startSession`, `endSession`, `sessionStatus`, `resumeSession`, `listSessions`, `observeBrain`, `searchBrainCompact`, `fetchBrainEntries`, `timelineBrain`, `searchBrain`.

### Pattern 3: Custom Store Backend

Provide a `DataAccessor` implementation to replace the default SQLite store with any backend you choose. This is the extension point for non-SQLite storage.

```typescript
import { Cleo } from '@cleocode/core';
import type { DataAccessor } from '@cleocode/core';

class MyPostgresAccessor implements DataAccessor {
  readonly engine = 'sqlite' as const; // discriminant — keep as 'sqlite'

  async loadTaskFile() { /* ... */ }
  async saveTaskFile(data) { /* ... */ }
  async loadArchive() { /* ... */ }
  async saveArchive(data) { /* ... */ }
  async loadSessions() { /* ... */ }
  async saveSessions(sessions) { /* ... */ }
  async appendLog(entry) { /* ... */ }
  async close() { /* ... */ }
}

const cleo = await Cleo.init('/path/to/project', {
  store: new MyPostgresAccessor(connectionString),
});

await cleo.tasks.add({ title: 'Build API', description: 'REST endpoints' });
```

See the [DataAccessor Interface](#dataaccessor-interface) section for the full method contract.

---

## Project Initialization

Before calling most operations, the project directory must have a `.cleo/` structure. The `initProject` function handles the complete setup:

```typescript
import { initProject, isProjectInitialized, ensureInitialized } from '@cleocode/core';

const projectDir = '/path/to/project';

// Full initialization (first-time setup)
// Creates .cleo/ directories, tasks.db, brain.db, config.json,
// project-info.json, and project-context.json.
await initProject({ cwd: projectDir });

// Idempotent: only runs if not already initialized
await ensureInitialized(projectDir);

// Check without initializing
if (!isProjectInitialized(projectDir)) {
  await ensureInitialized(projectDir);
}
```

After initialization, the `.cleo/` directory looks like:

```
.cleo/
  tasks.db           -- Tasks, sessions, lifecycle, ADRs, audit log
  brain.db           -- Observations, patterns, learnings, decisions (BRAIN)
  config.json        -- Runtime behavior settings
  project-info.json  -- Project identity and projectHash
  project-context.json -- LLM agent guidance (language, framework, conventions)
  .backups/          -- Operational backup files (last 10 per write)
  logs/              -- Structured pino logs
```

If you want only the directory structure without full init logic, use `ensureCleoStructure`:

```typescript
import { ensureCleoStructure } from '@cleocode/core';
await ensureCleoStructure('/path/to/project');
```

---

## Domain API Reference

All 10 domains are accessible via `cleo.<domain>.*` after `Cleo.init()`. Each method is async and returns a plain result object (or a LAFS envelope when called through the MCP layer).

### Tasks

| Method | Description |
|--------|-------------|
| `tasks.add(params)` | Create a task. Requires `title` and `description` (must differ). Optional: `parent`, `priority`, `type`, `size`, `phase`, `labels`, `depends`, `notes`. |
| `tasks.find(params)` | Search tasks by `query`, `id`, or `status`. Returns a compact result with minimal fields. |
| `tasks.show(taskId)` | Retrieve full details for a single task by ID (e.g., `'T1234'`). |
| `tasks.list(params?)` | List tasks with optional filters: `status`, `priority`, `parentId`, `phase`, `limit`. |
| `tasks.update(params)` | Update `title`, `status`, `priority`, `description`, or `notes` for a task. Requires `taskId`. |
| `tasks.complete(params)` | Mark a task `done`. Requires `taskId`. Optional `notes`. Runs lifecycle gate checks. |
| `tasks.delete(params)` | Delete a task permanently. Requires `taskId`. Pass `force: true` to skip the dependency check. |
| `tasks.archive(params?)` | Archive done tasks by age (`before`) or explicit `taskIds`. Pass `dryRun: true` to preview. |

```typescript
// Add with all optional fields
await cleo.tasks.add({
  title: 'Add rate limiting',
  description: 'Implement per-IP rate limiting on all public API endpoints',
  parent: 'T0040',
  priority: 'high',
  size: 'medium',
  phase: 'implementation',
  labels: ['security', 'api'],
  depends: ['T0041'],
});

// Find by status
const pending = await cleo.tasks.find({ status: 'pending', limit: 5 });

// Update status
await cleo.tasks.update({ taskId: 'T1234', status: 'active' });

// Complete with notes
await cleo.tasks.complete({ taskId: 'T1234', notes: 'Rate limiting active at 100 req/min' });

// Archive tasks older than 30 days
await cleo.tasks.archive({ before: '2026-02-01' });
```

Valid `status` values: `pending`, `active`, `blocked`, `done`.
Valid `priority` values: `low`, `medium`, `high`, `critical`.
Valid `size` values: `small`, `medium`, `large`.

### Sessions

| Method | Description |
|--------|-------------|
| `sessions.start(params)` | Start a new work session. Requires `name` and `scope` (`'global'`, `'epic:T###'`, etc.). Optional `agent`. |
| `sessions.end(params?)` | End the active session. Optional closing `note`. |
| `sessions.status()` | Check whether a session is currently active and which task it covers. |
| `sessions.resume(sessionId)` | Resume a previously suspended session. |
| `sessions.suspend(sessionId, reason?)` | Suspend a session for later resumption. |
| `sessions.list(params?)` | List sessions filtered by `status` (`active`, `suspended`, `ended`) and/or `limit`. |
| `sessions.find(params?)` | Search sessions by `status`, `scope`, `query`, or `limit`. |
| `sessions.show(sessionId)` | Show full details for a specific session. |
| `sessions.briefing(params?)` | Generate a session briefing with next recommended tasks. |
| `sessions.handoff(sessionId, options?)` | Compute a handoff document (for agent context transfer). Optional `note` and `nextAction`. |
| `sessions.recordDecision(params)` | Record an architectural or implementation decision. Requires `sessionId`, `taskId`, `decision`, `rationale`. |
| `sessions.recordAssumption(params)` | Record an assumption with a `confidence` level (`'high'`, `'medium'`, `'low'`). |
| `sessions.contextDrift(params?)` | Detect how far context has drifted from session start. |
| `sessions.decisionLog(params?)` | Retrieve the decision log for a session or task. |
| `sessions.lastHandoff(scope?)` | Get the most recent handoff document for a given scope. |
| `sessions.gc(maxAgeHours?)` | Garbage-collect stale sessions older than `maxAgeHours` (default: 48). |

```typescript
// Start a session scoped to an epic
await cleo.sessions.start({ name: 'auth-sprint', scope: 'epic:T0040' });

// Record a decision during the session
await cleo.sessions.recordDecision({
  sessionId: 'session-1741234567-abc123',
  taskId: 'T0042',
  decision: 'Use RS256 (asymmetric) for JWT signing',
  rationale: 'Allows token verification without distributing the signing key',
  alternatives: ['HS256 (symmetric)', 'ES256 (elliptic curve)'],
});

// Get a handoff document for context transfer
const handoff = await cleo.sessions.handoff('session-1741234567-abc123', {
  note: 'Completed token issuance, next: refresh token rotation',
  nextAction: 'Implement refresh token endpoint',
});

// End session
await cleo.sessions.end({ note: 'Auth module complete, all tests green' });
```

### Memory (Brain)

The memory domain exposes CLEO's BRAIN system — a persistent cognitive store backed by `brain.db`. It is separate from `tasks.db` so that memory operations never impact task CRUD performance.

| Method | Description |
|--------|-------------|
| `memory.observe(params)` | Save an observation to the brain database. Requires `text`. Optional `title` and `type`. |
| `memory.find(params)` | Compact search — returns IDs and titles only (cheap). Requires `query`. Optional `limit` and `tables`. |
| `memory.fetch(params)` | Fetch full content for specific entry IDs. Requires `ids` array. |
| `memory.timeline(params)` | Get temporal context around an anchor entry. Requires `anchor` ID. Optional `depthBefore` and `depthAfter`. |
| `memory.search(query, options?)` | Full-text search across brain entries. Returns richer results than `find`. |
| `memory.hybridSearch(query, options?)` | Combined semantic + keyword search (requires vector embeddings). |

#### The 3-Layer Retrieval Pattern

BRAIN is designed for token-efficient access. Use this three-step pattern to minimize token usage:

```
Step 1: memory.find({ query })     → cheap index search, returns IDs + titles (~50 tokens/result)
Step 2: memory.timeline({ anchor }) → context around an interesting ID (~200-500 tokens)
Step 3: memory.fetch({ ids })       → full details for only the IDs you selected (~500 tokens each)
```

```typescript
// Step 1: Search the index cheaply
const index = await cleo.memory.find({ query: 'JWT authentication', limit: 10 });
// Returns: [{ id: 'O-abc123', title: 'JWT refresh token rotation key' }, ...]

// Step 2: Get temporal context around the most relevant entry
const context = await cleo.memory.timeline({
  anchor: 'O-abc123',
  depthBefore: 3,
  depthAfter: 2,
});

// Step 3: Fetch full details only for the entries that matter
const entries = await cleo.memory.fetch({ ids: ['O-abc123', 'D-def456'] });

// Save a new observation
await cleo.memory.observe({
  text: 'Refresh tokens must use a separate signing key to enable independent rotation',
  title: 'JWT key rotation policy',
  type: 'learning',
});
```

Memory `type` values correspond to BRAIN's cognitive categories: `observation`, `learning`, `pattern`, `decision`.

### Orchestration

| Method | Description |
|--------|-------------|
| `orchestration.start(epicId)` | Initialize orchestration state for an epic. |
| `orchestration.analyze(epicId)` | Analyze an epic and its subtasks: dependency graph, blockers, ready tasks. |
| `orchestration.readyTasks(epicId)` | Get tasks with no unresolved dependencies — safe to start now. |
| `orchestration.nextTask(epicId)` | Get the single recommended next task to work on. |
| `orchestration.context(epicId)` | Get full orchestrator context for an epic (status, wave, agent assignments). |
| `orchestration.dependencyGraph(tasks)` | Build a dependency graph from a task array. Returns adjacency structure. |
| `orchestration.epicStatus(epicId, title, children)` | Compute completion status for an epic from its child tasks. |
| `orchestration.progress(tasks)` | Compute progress metrics (done/total ratio, blocked count) for a task set. |

```typescript
// Analyze an epic before starting work
const analysis = await cleo.orchestration.analyze('T0040');
console.log(analysis.readyCount); // tasks with no blockers

// Get the next task to work on
const next = await cleo.orchestration.nextTask('T0040');
console.log(next.taskId, next.reason);

// Check progress on an epic
const tasks = await cleo.tasks.list({ parentId: 'T0040' });
const progress = cleo.orchestration.progress(tasks.tasks);
console.log(`${progress.done}/${progress.total} tasks complete`);
```

### Lifecycle (RCASD-IVTR+C / LOOM)

The lifecycle domain enforces the RCASD-IVTR+C pipeline. Each epic progresses through formal stages, and gate checks prevent advancing until prerequisites are met.

Pipeline stages (in order): `research`, `consensus`, `architecture`, `specification`, `decomposition`, `implementation`, `validation`, `testing`, `release`.

| Method | Description |
|--------|-------------|
| `lifecycle.status(epicId)` | Get the current lifecycle stage and gate status for an epic. |
| `lifecycle.startStage(epicId, stage)` | Begin a lifecycle stage. Records a start event in the audit log. |
| `lifecycle.completeStage(epicId, stage, artifacts?)` | Complete a stage. Optional array of artifact file paths. |
| `lifecycle.skipStage(epicId, stage, reason)` | Skip a stage with a documented reason. |
| `lifecycle.checkGate(epicId, targetStage)` | Verify that all prerequisites for advancing to `targetStage` are met. |
| `lifecycle.passGate(epicId, gateName, agent?)` | Record a gate pass for a named gate. |
| `lifecycle.failGate(epicId, gateName, reason?)` | Record a gate failure with an optional reason. |
| `lifecycle.resetStage(epicId, stage, reason)` | Reset a stage to re-run it (e.g., after a failed gate). |
| `lifecycle.history(epicId)` | Get the full lifecycle event history for an epic. |
| `lifecycle.stages` | Array of all pipeline stage names in order. |

```typescript
// Check whether it's safe to advance to implementation
const gate = await cleo.lifecycle.checkGate('T0040', 'implementation');

if (!gate.canProgress) {
  console.log('Blocked:', gate.reason);
  // e.g., "specification stage not complete"
} else {
  await cleo.lifecycle.startStage('T0040', 'implementation');
}

// Complete a stage with artifact paths
await cleo.lifecycle.completeStage('T0040', 'specification', [
  'docs/specs/AUTH-SPEC.md',
  'schemas/auth.schema.json',
]);

// View full history
const history = await cleo.lifecycle.history('T0040');
```

Lifecycle enforcement mode is configured in `.cleo/config.json` under `lifecycle.mode`:
- `strict` — blocks progression (exit code 80) when gates fail
- `advisory` — warns but allows progression
- `off` — skips gate checks entirely

### Release

| Method | Description |
|--------|-------------|
| `release.prepare(params)` | Prepare a release: generate changelog, compute version bump. |
| `release.commit(params)` | Commit the release changes to git. |
| `release.tag(params)` | Create the release git tag. |
| `release.push(params)` | Push the release tag and commit to the remote. |
| `release.rollback(params)` | Roll back a failed release (reverts tag and commit). |
| `release.calculateVersion(current, bumpType)` | Calculate the new version string from a bump type (`'patch'`, `'minor'`, `'major'`, `'calver'`). |
| `release.bumpVersion()` | Apply the version bump defined in project config. |

```typescript
// Calculate what the new version would be
const next = cleo.release.calculateVersion('2026.3.10', 'calver');
// e.g., '2026.3.11'

// Run the full release pipeline
await cleo.release.prepare({ version: '2026.3.11', channel: 'stable' });
await cleo.release.commit({ message: 'chore(release): v2026.3.11' });
await cleo.release.tag({ version: '2026.3.11' });
await cleo.release.push({});
```

### Admin

| Method | Description |
|--------|-------------|
| `admin.export(params?)` | Export all tasks to a portable JSON format. Optional `outputPath`. |
| `admin.import(params)` | Import tasks from a previously exported file. Requires `inputPath`. |

```typescript
// Export all tasks to a file
await cleo.admin.export({ outputPath: './backup/tasks-export.json' });

// Import from a file (e.g., migrating from another project)
await cleo.admin.import({ inputPath: './backup/tasks-export.json' });
```

### Check

The check domain provides validation and compliance utilities — the "immune system" that catches problems before they propagate.

| Method | Description |
|--------|-------------|
| `check.schema(params?)` | Run a validation report. Pass `type` and `data` to validate a specific schema. |
| `check.protocol(params?)` | Validate a task against protocol compliance rules. |
| `check.task(params?)` | Validate a single task against anti-hallucination rules (title ≠ description, unique ID, valid status, etc.). |
| `check.manifest()` | Validate manifest JSONL entries for structural integrity. |
| `check.coherence()` | Cross-validate the task graph for consistency (dangling references, circular dependencies). |
| `check.complianceSummary()` | Get aggregated compliance metrics across the project. |
| `check.complianceRecord(params)` | Record a compliance check result. Requires `taskId` and `result`. |
| `check.test()` | Check whether the test suite is configured and available. |
| `check.testRun(params?)` | Execute the test suite via subprocess. Optional `scope`, `pattern`, `parallel`. |
| `check.archiveStats(params?)` | Get archive statistics for a recent period. |

```typescript
// Validate a task before completing it
const validation = await cleo.check.task({ taskId: 'T1234' });
if (!validation.valid) {
  console.error('Validation failures:', validation.issues);
}

// Run a full coherence check across the task graph
const coherence = await cleo.check.coherence();
if (coherence.issues.length > 0) {
  console.warn('Graph issues:', coherence.issues);
}
```

### Nexus

The nexus domain manages the cross-project registry. Projects register themselves in a global `~/.cleo/nexus.db` to enable federated discovery.

| Method | Description |
|--------|-------------|
| `nexus.init()` | Initialize the NEXUS directory structure and database. |
| `nexus.register(params)` | Register a project. Requires `path`. Optional `name` and `permissions`. |
| `nexus.unregister(params)` | Unregister a project. Requires `name`. |
| `nexus.list()` | List all registered projects. |
| `nexus.show(params)` | Get a project by `name` or hash. |
| `nexus.sync(params?)` | Sync a single project's metadata (by `name`), or all projects if no name given. |
| `nexus.resolve(params)` | Resolve a cross-project task reference (e.g., `'project-b:T0015'`). |
| `nexus.discover(params)` | Discover related tasks across registered projects. Requires `query`. |
| `nexus.search(params)` | Search for tasks across all registered projects by `pattern`. |
| `nexus.setPermission(params)` | Set the permission level for a project. Levels: `'read'`, `'write'`, `'execute'`. |
| `nexus.sharingStatus()` | Get sharing status for `.cleo/` files (what is committed, what is gitignored). |

```typescript
// Register this project in NEXUS
await cleo.nexus.register({
  path: '/path/to/project',
  name: 'my-api',
  permissions: 'read',
});

// Find related work across all projects
const related = await cleo.nexus.discover({
  query: 'authentication JWT',
  limit: 10,
});

// Resolve a cross-project task reference
const externalTask = await cleo.nexus.resolve({ query: 'my-api:T0042' });
```

### Sticky

Sticky notes are ephemeral capture units — quick thoughts that exist before they become formal tasks or memory entries.

| Method | Description |
|--------|-------------|
| `sticky.add(params)` | Create a sticky note. Requires `content`. Optional `tags`, `priority`, `color`. |
| `sticky.show(stickyId)` | Get a sticky note by ID (e.g., `'SN-001'`). |
| `sticky.list(params?)` | List stickies. Optional filters: `status`, `color`, `priority`, `limit`. |
| `sticky.archive(stickyId)` | Archive a sticky (soft delete — still retrievable). |
| `sticky.purge(stickyId)` | Permanently delete a sticky. |
| `sticky.convert(params)` | Convert a sticky to a task or memory entry. Requires `stickyId` and `targetType` (`'task'`, `'memory'`, `'task_note'`, `'session_note'`). |

```typescript
// Capture a quick thought
await cleo.sticky.add({
  content: 'Consider adding idempotency keys to the payment endpoint',
  tags: ['payments', 'api'],
  priority: 'medium',
  color: 'yellow',
});

// When the thought matures, promote it to a task
const stickies = await cleo.sticky.list({ status: 'active' });
await cleo.sticky.convert({
  stickyId: 'SN-001',
  targetType: 'task',
  title: 'Add idempotency key support to payment endpoint',
});
```

---

## DataAccessor Interface

`DataAccessor` is the storage abstraction that decouples core business logic from any specific database. All task, session, and audit operations accept an optional `DataAccessor`. When omitted, core functions fall back to `getAccessor(cwd)` which constructs a `SqliteDataAccessor` — available only when `@cleocode/cleo` (which ships the store layer) is present.

### Interface definition

```typescript
interface DataAccessor {
  /** The storage engine backing this accessor. Always 'sqlite' in the reference implementation. */
  readonly engine: 'sqlite';

  // Task data (read-modify-write pattern)
  loadTaskFile(): Promise<TaskFile>;
  saveTaskFile(data: TaskFile): Promise<void>;

  // Archive data
  loadArchive(): Promise<ArchiveFile | null>;
  saveArchive(data: ArchiveFile): Promise<void>;

  // Session data
  loadSessions(): Promise<Session[]>;
  saveSessions(sessions: Session[]): Promise<void>;

  // Append-only audit log
  appendLog(entry: Record<string, unknown>): Promise<void>;

  // Resource cleanup
  close(): Promise<void>;

  // Fine-grained task operations (optional — falls back to full-file if absent)
  upsertSingleTask?(task: Task): Promise<void>;
  archiveSingleTask?(taskId: string, fields: ArchiveFields): Promise<void>;
  removeSingleTask?(taskId: string): Promise<void>;

  // Relation tracking (optional)
  addRelation?(taskId: string, relatedTo: string, relationType: string, reason?: string): Promise<void>;

  // Metadata KV store (optional)
  getMetaValue?<T>(key: string): Promise<T | null>;
  setMetaValue?(key: string, value: unknown): Promise<void>;
  getSchemaVersion?(): Promise<string | null>;
}
```

### Getting a default accessor

When using `@cleocode/core` alongside `@cleocode/cleo`, use `createDataAccessor` or `getAccessor` to get the built-in SQLite implementation:

```typescript
import { createDataAccessor, getAccessor } from '@cleocode/core';

// Preferred: getAccessor is a thin convenience wrapper
const accessor = await getAccessor('/path/to/project');

try {
  const result = await cleo.tasks.add(
    { title: 'Build API', description: 'REST endpoints' },
    '/path/to/project',
    accessor,
  );
} finally {
  await accessor.close();
}
```

When using `Cleo.init()`, the accessor is managed automatically — you do not need to call `close()` yourself during normal operation.

### Implementing a custom backend

A minimal custom accessor needs to implement all non-optional methods. The `engine` discriminant should be set to `'sqlite'` even if the backing store is different (it is currently treated as a constant, not a runtime dispatch key).

```typescript
import type { DataAccessor } from '@cleocode/core';

export class InMemoryAccessor implements DataAccessor {
  readonly engine = 'sqlite' as const;

  private tasks = { tasks: [], workState: {}, projectMeta: {} };
  private archive = null;
  private sessions: Session[] = [];
  private log: Record<string, unknown>[] = [];

  async loadTaskFile() { return structuredClone(this.tasks); }
  async saveTaskFile(data) { this.tasks = structuredClone(data); }

  async loadArchive() { return this.archive; }
  async saveArchive(data) { this.archive = structuredClone(data); }

  async loadSessions() { return [...this.sessions]; }
  async saveSessions(sessions) { this.sessions = [...sessions]; }

  async appendLog(entry) { this.log.push(entry); }
  async close() { /* nothing to close */ }
}

// Use it
const cleo = await Cleo.init('/path/to/project', {
  store: new InMemoryAccessor(),
});
```

---

## Error Handling

All errors from `@cleocode/core` are instances of `CleoError`, which extends `Error` with a structured payload following RFC 9457 Problem Details.

```typescript
import { CleoError } from '@cleocode/core';
import { ExitCode } from '@cleocode/core';

try {
  await cleo.tasks.add({ title: 'My task', description: 'My task' }); // title === description
} catch (err) {
  if (err instanceof CleoError) {
    console.error(`Exit code: ${err.exitCode}`);        // e.g., 3 (VALIDATION)
    console.error(`Message:   ${err.message}`);
    console.error(`Fix:       ${err.details?.fix}`);    // suggested remediation
    console.error(`Category:  ${err.details?.category}`);
  }
}
```

### Exit code ranges

| Range | Domain |
|-------|--------|
| `0` | Success |
| `1-9` | General (input validation, file, config) |
| `10-19` | Hierarchy (parent not found, max depth, circular) |
| `20-29` | Concurrency (checksum conflict, concurrent modification) |
| `30-39` | Session (scope conflict, session required) |
| `40-47` | Verification (gate, agent, rounds) |
| `50-54` | Context safeguard (warning through emergency) |
| `60-67` | Orchestrator (protocol missing, spawn validation, handoff) |
| `70-79` | Nexus (not initialized, project not found, sync failure) |
| `80-84` | Lifecycle enforcement (gate failed, audit missing, invalid transition) |
| `85-89` | Artifact publish |
| `90-94` | Provenance |
| `100+` | Special conditions (not errors) |

`ExitCode` is a numeric enum exported from `@cleocode/core`. Common values:

```typescript
ExitCode.SUCCESS         // 0
ExitCode.VALIDATION      // 3
ExitCode.SESSION_SCOPE   // 30
ExitCode.SCOPE_CONFLICT  // 31
ExitCode.LIFECYCLE_GATE_FAILED // 80
```

### Error catalog

The error catalog is a static map of all registered error definitions, keyed by exit code:

```typescript
import { ERROR_CATALOG, getErrorDefinition } from '@cleocode/core';

const def = getErrorDefinition(ExitCode.LIFECYCLE_GATE_FAILED);
console.log(def.code);     // 'LIFECYCLE_GATE_FAILED'
console.log(def.message);  // human-readable description
console.log(def.fix);      // suggested remediation
```

---

## LAFS Response Envelopes

Operations that produce output for MCP consumers or API clients use LAFS (LLM-Agent-First Schema) envelopes. When calling `@cleocode/core` directly from application code, you can wrap your own results with the same envelope format for consistency.

### Success envelope

```typescript
import { formatSuccess } from '@cleocode/core';

const result = await cleo.tasks.list({ status: 'pending' });
const envelope = formatSuccess(result);
```

The envelope shape:

```json
{
  "success": true,
  "data": {
    "tasks": [...],
    "total": 5
  },
  "_meta": {
    "requestId": "a1b2c3d4-...",
    "timestamp": "2026-03-18T12:00:00.000Z",
    "sessionId": "session-1741234567-abc123",
    "warnings": []
  }
}
```

### Error envelope

```typescript
import { formatError, CleoError } from '@cleocode/core';

try {
  await cleo.tasks.add({ title: 'foo', description: 'foo' });
} catch (err) {
  const envelope = formatError(err);
  // Returns LAFS error envelope with RFC 9457 ProblemDetails
}
```

The error envelope shape:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Title and description must be different",
    "exitCode": 3,
    "fix": "Provide a description that elaborates on the title",
    "category": "VALIDATION"
  },
  "_meta": {
    "requestId": "a1b2c3d4-...",
    "timestamp": "2026-03-18T12:00:00.000Z"
  }
}
```

### Attaching warnings

Use `pushWarning` to attach deprecation or informational notices to the next envelope that `formatSuccess` or `formatError` produces:

```typescript
import { pushWarning, formatSuccess } from '@cleocode/core';

pushWarning({
  code: 'DEPRECATED_FIELD',
  message: "The 'phase' field is deprecated — use 'labels' instead.",
});
const envelope = formatSuccess(data); // warning included in _meta.warnings
```

---

## Configuration

CLEO reads runtime configuration from `.cleo/config.json`. The `loadConfig`, `getConfigValue`, and `setConfigValue` functions give you typed access.

```typescript
import { loadConfig, getConfigValue, setConfigValue } from '@cleocode/core';

const projectDir = '/path/to/project';

// Load the full config object
const config = await loadConfig(projectDir);

// Read a typed value (with a fallback default)
const lifecycleMode = getConfigValue(config, 'lifecycle.mode', 'strict');
// 'strict' | 'advisory' | 'off'

const maxDepth = getConfigValue(config, 'hierarchy.maxDepth', 3);

// Write a value atomically
await setConfigValue(projectDir, 'lifecycle.mode', 'advisory');
```

### Config structure

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `lifecycle.mode` | `'strict' \| 'advisory' \| 'off'` | `'strict'` | How lifecycle gate failures are enforced |
| `hierarchy.maxDepth` | `number` | `3` | Maximum task nesting depth (Epic → Task → Subtask) |
| `hierarchy.maxSiblings` | `number` | `0` (unlimited) | Maximum siblings per parent |
| `session.requireNotes` | `boolean` | `false` | Whether `session.end` requires a closing note |
| `session.autoStart` | `boolean` | `false` | Automatically start a session on first task operation |
| `output.defaultFormat` | `'json' \| 'human'` | `'json'` | Default output format |
| `backup.maxOperationalBackups` | `number` | `10` | How many atomic write backups to keep per file |
| `logging.level` | `string` | `'info'` | Log level for pino |
| `signaldock.enabled` | `boolean` | `false` | Whether to enable SignalDock inter-agent transport |

The config resolution order is: CLI flags → environment variables → `.cleo/config.json` → `~/.cleo/config.json` → built-in defaults.

---

## Versioning and Stability

### CalVer scheme

`@cleocode/core` uses CalVer: `YYYY.MM.PATCH`.

- `YYYY.MM` advances each calendar month.
- `PATCH` increments for any release within the month — bug fixes, new features, and breaking changes all increment the patch counter.
- Breaking changes are documented in the changelog with a `BREAKING` label.

### Stability levels

Not all exports carry the same stability promise:

| Stability | Promise | Examples |
|-----------|---------|---------|
| **Stable** | No removal or signature change without a 30-day deprecation notice | `tasks.*`, `sessions.*`, `memory.*`, `CleoError`, `formatSuccess`, `ExitCode` |
| **Beta** | May change between minor versions; changes noted in changelog | `signaldock.*`, `orchestration.*`, `otel.*` |
| **Internal** | No guarantees; may be removed without notice | `coreMcp.*`, `routing.*`, `coreHooks.*` |

When a stable export is deprecated, the implementation emits a `pushWarning` and the symbol is tagged `@deprecated` in JSDoc. It is then removed after one monthly release cycle.

### What is not public API

- Anything imported directly from `src/store/` subpaths (use `DataAccessor` instead)
- `__tests__/` files and test utilities
- Files prefixed with `_` (internal convention)
- `src/core/sessions/context-alert.ts` (session context singleton)

---

## Troubleshooting

### "No active session found"

Session-scoped operations (decisions, assumptions, context drift) require an active session. Start one before calling them:

```typescript
await cleo.sessions.start({ name: 'my-session', scope: 'global' });
```

### Task add fails with "title and description must be different"

CLEO's anti-hallucination rules require that `title` and `description` contain different text. The title should be a short label; the description should expand on it:

```typescript
// Wrong
await cleo.tasks.add({ title: 'Fix bug', description: 'Fix bug' });

// Correct
await cleo.tasks.add({
  title: 'Fix null pointer in auth middleware',
  description: 'The auth middleware crashes when the Authorization header is missing. Add a null check before parsing.',
});
```

### `.cleo/` structure not found

If you call core operations on a directory that has not been initialized, you will get a file-not-found error. Call `ensureInitialized` first:

```typescript
import { ensureInitialized } from '@cleocode/core';
await ensureInitialized('/path/to/project');
```

### `brain.db` operations fail

The brain database must be scaffolded before use. `ensureCleoStructure` creates it:

```typescript
import { ensureCleoStructure } from '@cleocode/core';
await ensureCleoStructure('/path/to/project');
```

If the database exists but migrations are needed, `initProject` or `ensureInitialized` will run them automatically.

### Lifecycle gate blocks task completion (exit 80)

By default, lifecycle enforcement is `strict`. If you are completing tasks that are not part of a formal RCASD-IVTR+C epic, switch enforcement to `advisory` in `.cleo/config.json`:

```typescript
await setConfigValue('/path/to/project', 'lifecycle.mode', 'advisory');
```

Or check the gate before completing and skip the blocked stage:

```typescript
const gate = await cleo.lifecycle.checkGate('T0040', 'validation');
if (!gate.canProgress) {
  await cleo.lifecycle.skipStage('T0040', 'validation', 'Skipped: internal tool, no formal test suite required');
}
await cleo.tasks.complete({ taskId: 'T1234' });
```

### Custom DataAccessor: operations fail silently

If `loadTaskFile()` returns an object without the required `tasks` array, CLEO will treat the project as empty. Make sure your implementation returns a valid `TaskFile`:

```typescript
async loadTaskFile() {
  return {
    tasks: [],        // required
    workState: {},    // required
    projectMeta: {},  // required
  };
}
```

---

## References

- `packages/core/README.md` — quick-start reference with API surface overview
- `docs/specs/CORE-PACKAGE-SPEC.md` — formal package specification (stability levels, DataAccessor contract, purity rules)
- `docs/concepts/CLEO-VISION.md` — BRAIN, LOOM, NEXUS, and LAFS system architecture
- `src/store/data-accessor.ts` — `DataAccessor` interface source of truth
- `packages/core/src/cleo.ts` — `Cleo` facade class implementation
- `packages/core/src/index.ts` — barrel exports for tree-shaking
- `docs/specs/CLEO-OPERATION-CONSTITUTION.md` — all 209 MCP operations mapped to CLI equivalents
- `docs/guides/adapter-development.md` — building provider adapters (CAAMP)
- Epic T5701 — core extraction epic that produced this package
