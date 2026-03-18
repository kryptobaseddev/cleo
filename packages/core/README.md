# @cleocode/core

CLEO's standalone business logic kernel. Provides task management, session tracking, brain memory, orchestration, lifecycle gates, release management, and admin operations as a self-contained npm package — usable independently of the full `@cleocode/cleo` product.

## Install

```bash
npm install @cleocode/core
```

**Requires Node >= 24**

## Quick Start

### Pattern 1: Facade (recommended)

Use `Cleo.init()` for project-bound access across all domains. A single `DataAccessor` is shared across all operations, which is the most efficient approach for multi-operation workflows.

```typescript
import { Cleo } from '@cleocode/core';

const cleo = await Cleo.init('/path/to/project');

// Tasks
await cleo.tasks.add({ title: 'Build API', description: 'REST endpoints' });
const task = await cleo.tasks.show('T1234');
await cleo.tasks.complete({ taskId: 'T1234' });

// Sessions
await cleo.sessions.start({ name: 'sprint-1', scope: 'global' });
await cleo.sessions.end({ note: 'Completed auth module' });

// Memory
await cleo.memory.observe({ text: 'JWT requires refresh tokens' });
const results = await cleo.memory.find({ query: 'authentication' });
```

### Pattern 2: Tree-shakeable individual functions

Import only what you need. Bundlers can eliminate unused code.

```typescript
import { addTask, startSession, observeBrain } from '@cleocode/core';

await addTask(
  { title: 'Build API', description: 'REST endpoints' },
  '/path/to/project',
);

await startSession(
  { name: 'sprint-1', scope: 'global' },
  '/path/to/project',
);

await observeBrain('/path/to/project', { text: 'JWT requires refresh tokens' });
```

### Pattern 3: Custom store backend

Provide your own `DataAccessor` implementation to swap the storage layer.

```typescript
import { Cleo } from '@cleocode/core';
import type { DataAccessor } from '@cleocode/core';

class MyCustomAccessor implements DataAccessor {
  // ... implement the DataAccessor interface
}

const cleo = await Cleo.init('/path/to/project', {
  store: new MyCustomAccessor(connectionString),
});

await cleo.tasks.add({ title: 'Build API', description: 'REST endpoints' });
```

## API Surface

All domains are accessible via `cleo.<domain>.*` after `Cleo.init()`.

### Tasks

| Method | Description |
|--------|-------------|
| `tasks.add(params)` | Create a new task with title, description, and optional metadata |
| `tasks.find(params)` | Search tasks by query, id, or status |
| `tasks.show(taskId)` | Retrieve full details for a single task |
| `tasks.list(params?)` | List tasks with optional filters (status, priority, phase) |
| `tasks.update(params)` | Update title, status, priority, description, or notes |
| `tasks.complete(params)` | Mark a task as done with optional completion notes |
| `tasks.delete(params)` | Delete a task (use `force: true` to skip confirmation) |
| `tasks.archive(params?)` | Archive completed tasks by age or explicit IDs |

### Sessions

| Method | Description |
|--------|-------------|
| `sessions.start(params)` | Start a new work session (requires name and scope) |
| `sessions.end(params?)` | End the active session with optional note |
| `sessions.status()` | Check whether a session is currently active |
| `sessions.resume(sessionId)` | Resume a previously suspended session |
| `sessions.suspend(sessionId, reason?)` | Suspend a session for later resumption |
| `sessions.list(params?)` | List sessions filtered by status or limit |
| `sessions.find(params?)` | Search sessions by status, scope, or query |
| `sessions.show(sessionId)` | Show full details for a specific session |
| `sessions.briefing(params?)` | Generate a session briefing with next tasks |
| `sessions.handoff(sessionId, options?)` | Compute a handoff document for a session |
| `sessions.recordDecision(params)` | Record an architectural or implementation decision |
| `sessions.recordAssumption(params)` | Record an assumption with confidence level |
| `sessions.contextDrift(params?)` | Detect context drift from session start |
| `sessions.decisionLog(params?)` | Retrieve the decision log for a session or task |
| `sessions.lastHandoff(scope?)` | Get the most recent handoff for a scope |
| `sessions.gc(maxAgeHours?)` | Garbage-collect stale sessions |

### Memory (Brain)

| Method | Description |
|--------|-------------|
| `memory.observe(params)` | Save an observation to the brain database |
| `memory.find(params)` | Compact search — returns IDs and titles only |
| `memory.fetch(params)` | Fetch full content for specific entry IDs |
| `memory.timeline(params)` | Get temporal context around an anchor entry |
| `memory.search(query, options?)` | Full-text search across brain entries |
| `memory.hybridSearch(query, options?)` | Combined semantic + keyword search |

The 3-step retrieval pattern for token-efficient access:
1. `memory.find({ query })` — cheap index search, returns IDs
2. `memory.timeline({ anchor })` — context window around an ID
3. `memory.fetch({ ids })` — full content for selected IDs only

### Orchestration

| Method | Description |
|--------|-------------|
| `orchestration.start(epicId)` | Initialize orchestration for an epic |
| `orchestration.analyze(epicId)` | Analyze an epic and its subtasks |
| `orchestration.readyTasks(epicId)` | Get tasks with no unresolved dependencies |
| `orchestration.nextTask(epicId)` | Get the recommended next task to work on |
| `orchestration.context(epicId)` | Get orchestrator context for an epic |
| `orchestration.dependencyGraph(tasks)` | Build a dependency graph from task list |
| `orchestration.epicStatus(epicId, title, children)` | Compute epic completion status |
| `orchestration.progress(tasks)` | Compute progress metrics for a task set |

### Lifecycle

CLEO implements the RCASD-IVTR+C pipeline with formal gate checks.

| Method | Description |
|--------|-------------|
| `lifecycle.status(epicId)` | Get current lifecycle stage and gate status |
| `lifecycle.startStage(epicId, stage)` | Begin a lifecycle stage |
| `lifecycle.completeStage(epicId, stage, artifacts?)` | Complete a stage with optional artifacts |
| `lifecycle.skipStage(epicId, stage, reason)` | Skip a stage with documented reason |
| `lifecycle.checkGate(epicId, targetStage)` | Verify gate prerequisites before advancing |
| `lifecycle.passGate(epicId, gateName, agent?)` | Record a gate pass |
| `lifecycle.failGate(epicId, gateName, reason?)` | Record a gate failure |
| `lifecycle.resetStage(epicId, stage, reason)` | Reset a stage to re-run it |
| `lifecycle.history(epicId)` | Get the full lifecycle event history |
| `lifecycle.stages` | Array of all pipeline stage names |

### Release

| Method | Description |
|--------|-------------|
| `release.prepare(params)` | Prepare a release (changelog, version bump) |
| `release.commit(params)` | Commit the release changes to git |
| `release.tag(params)` | Create the release git tag |
| `release.push(params)` | Push the release tag and commit |
| `release.rollback(params)` | Roll back a failed release |
| `release.calculateVersion(current, bumpType)` | Calculate new version from bump type |
| `release.bumpVersion()` | Apply version bump from project config |

### Admin

| Method | Description |
|--------|-------------|
| `admin.export(params?)` | Export all tasks to a portable format |
| `admin.import(params)` | Import tasks from an exported file |

## Architecture

`@cleocode/core` is the extracted business logic layer from `@cleocode/cleo`. The full product adds CLI parsing, MCP protocol handling, and a dispatch routing layer on top of this kernel.

```
@cleocode/cleo (assembled product)
├── src/cli/         — arg parse → dispatch → core
├── src/mcp/         — MCP protocol → dispatch → core
├── src/dispatch/    — thin routing layer
└── src/core/        ← this package
    ├── tasks/
    ├── sessions/
    ├── memory/
    ├── orchestration/
    ├── lifecycle/
    ├── release/
    └── admin/
```

The package ships as a pre-bundled `dist/index.js` (esbuild, ESM) with no monorepo dependencies required at runtime. All `src/core/` business logic is inlined at build time.

## Requirements

- **Node**: >= 24
- **Module format**: ESM (`"type": "module"`)

## License

MIT
