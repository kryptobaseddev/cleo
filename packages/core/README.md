# @cleocode/core

CLEO core business logic kernel **and canonical SDK surface** — tasks, sessions, memory, orchestration, lifecycle, with bundled SQLite store.

> **`@cleocode/core` IS the CLEO SDK.** There is no separate `@cleocode/cleo-sdk` package. The facade (`Cleo`), domain namespaces (`tasks`, `sessions`, `memory`, …), and flat free functions are all exposed through per-subpath exports that follow a SemVer-within-CalVer stability contract. See [STABILITY.md](./STABILITY.md) for the full contract, `.dts-snapshots/` for the enforced baseline, and `scripts/generate-dts-snapshots.sh` for the regen tool.

## Overview

This package contains the complete business logic implementation for the CLEO ecosystem. It provides programmatic APIs for:

- **Task Management**: CRUD operations, dependencies, archival
- **Session Management**: Start, resume, end sessions with context
- **Memory Systems**: Brain storage, search, observation
- **Orchestration**: Multi-agent coordination, wave execution
- **Lifecycle Management**: Pipeline stages, gates, compliance
- **Compliance & Validation**: Protocol enforcement, rule checking

The package includes a bundled SQLite store via Drizzle ORM for persistence.
See [`migrations/README.md`](./migrations/README.md) for the complete guide to authoring,
maintaining, and recovering database migrations (Hybrid Path A+ workflow).

## Who consumes this package?

| Consumer | Recommended subpath | Why |
|---|---|---|
| **CLI** (`@cleocode/cleo`) | `@cleocode/core/internal` | Full flat free-function surface used by the dispatch engine. |
| **Studio UI panels** | `@cleocode/core/sdk` | `Cleo` facade — project-bound, domain-grouped. |
| **External agents & SDK consumers** (incl. OpenClaw, issue #97) | `@cleocode/core/sdk` | Stable facade with a minimal import cost. |
| **Type-only tools (validators, docs)** | `@cleocode/core/contracts` | Pure re-export of `@cleocode/contracts` types. |
| **Memory-only helpers** | `@cleocode/core/memory` | Narrow brain / timeline / STDP surface. |
| **Task-scoped scripts** | `@cleocode/core/tasks` | CRUD, hierarchy, graph-ops. |

## Subpath contract (`STABILITY.md`)

Every stable subpath is enforced by two CI gates:

1. **Type-baseline snapshots** under `.dts-snapshots/` — run `./scripts/generate-dts-snapshots.sh` to regenerate, `--check` to diff in CI.
2. **Contract test** at `src/__tests__/subpath-contract.test.ts` — verifies every declared subpath resolves, `import('@cleocode/core/sdk')` returns `Cleo`, and every stable subpath has a snapshot.

Breaking changes to a **stable** subpath require a **CalVer month bump** (e.g. `2026.5.x`) and a one-release-cycle deprecation notice in `STABILITY.md`. See [STABILITY.md](./STABILITY.md) for the full policy.

### Quick SDK example

```typescript
// Narrow — recommended for external consumers
import { Cleo } from '@cleocode/core/sdk';

const cleo = await Cleo.init('./my-project');
await cleo.tasks.add({ title: 'Ship subpath contract' });
```

## Installation

```bash
npm install @cleocode/core
```

```bash
pnpm add @cleocode/core
```

```bash
yarn add @cleocode/core
```

## API Overview

### Import Patterns

```typescript
// Pattern 1: Facade (recommended for most use cases)
import { Cleo } from '@cleocode/core';
const cleo = await Cleo.init('./project');

// Pattern 2: Namespace access
import { tasks, sessions, memory, orchestration } from '@cleocode/core';

// Pattern 3: Direct function imports (tree-shakeable)
import { addTask, startSession, observeBrain } from '@cleocode/core';
```

### The Cleo Facade

The `Cleo` class provides a unified interface to all CLEO functionality:

```typescript
import { Cleo } from '@cleocode/core';

// Initialize CLEO for a project
const cleo = await Cleo.init('./my-project', {
  configPath: './.cleo/config.yaml',
  logLevel: 'info'
});

// Task operations
await cleo.tasks.add({ title: 'New task', priority: 'high' });
const task = await cleo.tasks.show('T1234');
await cleo.tasks.complete('T1234');

// Session operations
const session = await cleo.sessions.start({ scope: 'feature-branch' });
await cleo.sessions.end(session.id);

// Memory operations
await cleo.memory.observe({ topic: 'architecture', content: '...' });
const entries = await cleo.memory.search('auth pattern');

// Cleanup
await cleo.destroy();
```

### Namespaces

All functionality is organized into namespaces:

| Namespace | Purpose |
|-----------|---------|
| `tasks` | Task CRUD, dependencies, archival |
| `sessions` | Session lifecycle, context, checkpoints |
| `memory` | Brain storage, search, observation |
| `orchestration` | Multi-agent coordination, waves, consensus |
| `lifecycle` | Pipeline stages, gates, compliance |
| `compliance` | Protocol enforcement, validation rules |
| `codebaseMap` | Project structure analysis |
| `phases` | Phase management and transitions |
| `release` | Release management, versioning |
| `research` | Research workflows, web extraction |
| `skills` | Skill management and execution |
| `sticky` | Ephemeral notes and context |
| `validation` | Task validation and verification |
| `nexus` | Multi-project sync and sharing |
| `adrs` | Architecture Decision Records |
| `admin` | Administrative operations |
| `caamp` | Context-aware agent memory protocol |
| `context` | Context management and injection |
| `inject` | Context injection utilities |
| `issue` | Issue tracking integration |
| `metrics` | Performance metrics and analytics |
| `migration` | Database migrations |
| `observability` | Logging, monitoring, tracing |
| `otel` | OpenTelemetry integration |
| `pipeline` | Pipeline execution |
| `reconciliation` | Task sync and reconciliation |
| `remote` | Remote operations |
| `roadmap` | Roadmap planning |
| `routing` | Request routing |
| `security` | Security utilities |
| `sequence` | Task sequencing |
| `signaldock` | Signal handling |
| `snapshot` | Project snapshots |
| `spawn` | Subagent spawning |
| `stats` | Statistics and reporting |
| `system` | System operations |
| `taskWork` | Active task tracking |
| `templates` | Template management |
| `ui` | UI utilities |

### Task Operations

```typescript
import { tasks, addTask, listTasks, completeTask, updateTask, deleteTask } from '@cleocode/core';

// Create a task
const task = await addTask({
  title: 'Implement user authentication',
  description: 'Add JWT-based auth',
  priority: 'high',
  type: 'feature',
  size: 'medium',
  labels: ['backend', 'security']
});

// List tasks
const allTasks = await listTasks({ status: ['pending', 'in_progress'] });

// Update a task
await updateTask('T1234', { priority: 'urgent', labels: ['backend', 'security', 'urgent'] });

// Complete a task
await completeTask('T1234', { notes: 'Implemented with bcrypt and JWT' });

// Delete a task
await deleteTask('T1234');

// Using namespace
await tasks.add({ title: 'Another task' });
await tasks.archive(['T1234', 'T1235']);
```

### Session Operations

```typescript
import { sessions, startSession, endSession, listSessions, resumeSession } from '@cleocode/core';

// Start a session
const session = await startSession({
  scope: 'feature/authentication',
  notes: 'Working on auth system'
});

// List active sessions
const activeSessions = await listSessions({ status: 'active' });

// Resume a session
await resumeSession(session.id);

// End a session
await endSession(session.id, { summary: 'Completed auth implementation' });
```

### Memory Operations

```typescript
import { memory, observeBrain, searchBrain, searchBrainCompact, timelineBrain, fetchBrainEntries } from '@cleocode/core';

// Observe (store) a memory
await observeBrain({
  topic: 'authentication-pattern',
  content: 'Using JWT with refresh tokens',
  tags: ['auth', 'pattern'],
  confidence: 0.95
});

// Search memories
const results = await searchBrain('authentication', { limit: 10 });

// Compact search (lightweight)
const compact = await searchBrainCompact('auth', { maxResults: 5 });

// Timeline view
const timeline = await timelineBrain({ from: '2026-01-01', to: '2026-03-01' });

// Fetch specific entries
const entries = await fetchBrainEntries(['entry-1', 'entry-2']);
```

### Orchestration

```typescript
import { orchestration } from '@cleocode/core';

// Analyze dependencies
const analysis = await orchestration.analyze({
  taskIds: ['T1234', 'T1235', 'T1236'],
  includeBlocked: true
});

// Execute in waves (parallel where possible)
const waves = await orchestration.waves({
  taskIds: ['T1234', 'T1235', 'T1236', 'T1237'],
  maxParallel: 3
});

// Bootstrap orchestration
await orchestration.bootstrap({
  projectPath: './my-project',
  config: { autoSpawn: true }
});

// Validate spawn context
const validation = await orchestration.validateSpawn({
  taskId: 'T1234',
  context: { memoryBudget: 100000 }
});
```

### Compliance & Validation

```typescript
import { compliance, validation } from '@cleocode/core';

// Check compliance
const report = await compliance.check({
  taskId: 'T1234',
  rules: ['has-description', 'has-acceptance-criteria']
});

// Validate task structure
const result = await validation.validateTask({
  taskId: 'T1234',
  schema: 'standard'
});
```

### Configuration

```typescript
import { loadConfig, getConfigValue, setConfigValue, getRawConfig } from '@cleocode/core';

// Load configuration
const config = await loadConfig();

// Get a config value
const logLevel = getConfigValue('logging.level');

// Set a config value
await setConfigValue('logging.level', 'debug');
```

### Paths & Project Info

```typescript
import { 
  getProjectRoot, 
  getCleoDir, 
  isProjectInitialized,
  getProjectInfo,
  resolveProjectPath
} from '@cleocode/core';

// Get project root
const root = getProjectRoot();

// Get .cleo directory
const cleoDir = getCleoDir();

// Check if initialized
if (isProjectInitialized()) {
  const info = await getProjectInfo();
  console.log(`Project: ${info.name}`);
}
```

### Logging

```typescript
import { getLogger, initLogger, closeLogger } from '@cleocode/core';

// Initialize logger
initLogger('./.cleo', {
  level: 'info',
  filePath: 'logs/cleo.log'
});

// Get logger instance
const logger = getLogger('my-module');
logger.info('Starting operation');
logger.debug({ taskId: 'T1234' }, 'Task details');

// Cleanup
closeLogger();
```

### Hooks

```typescript
import { hooks, HookRegistry } from '@cleocode/core';

// Register a hook
hooks.register('onTaskCreate', async (context) => {
  console.log(`Task created: ${context.taskId}`);
});

// Dispatch a hook
await hooks.dispatch('onTaskCreate', { taskId: 'T1234' });
```

### Output Formatting

```typescript
import { formatOutput, formatSuccess, formatError, pushWarning } from '@cleocode/core';

// Format successful response
const success = formatSuccess({ taskId: 'T1234', title: 'My Task' });

// Format error response
const error = formatError('E_TASK_NOT_FOUND', { taskId: 'T1234' });

// Add warning
pushWarning('Task is overdue');
```

### Pagination

```typescript
import { paginate, createPage } from '@cleocode/core';

// Paginate results
const page = paginate(allTasks, { page: 1, limit: 20 });

// Create a page object
const pageObj = createPage({
  items: tasks,
  total: 100,
  page: 1,
  limit: 20
});
```

### Error Handling

```typescript
import { CleoError, getErrorDefinition, ERROR_CATALOG } from '@cleocode/core';

// Throw CLEO error
throw new CleoError('E_TASK_NOT_FOUND', { taskId: 'T1234' });

// Get error definition
const def = getErrorDefinition('E_TASK_NOT_FOUND');
console.log(def.message); // "Task not found"
```

### Platform Utilities

```typescript
import { 
  getSystemInfo, 
  detectPlatform, 
  getIsoTimestamp,
  sha256,
  PLATFORM
} from '@cleocode/core';

// Get system information
const info = getSystemInfo();
console.log(info.platform, info.arch, info.nodeVersion);

// Current platform
const platform = detectPlatform();

// ISO timestamp
const timestamp = getIsoTimestamp();

// Hash
const hash = sha256('content to hash');
```

### Migration

```typescript
import { 
  runMigration, 
  runAllMigrations, 
  getMigrationStatus,
  compareSemver,
  detectVersion
} from '@cleocode/core';

// Run a specific migration
await runMigration('v2.0.0');

// Run all pending migrations
await runAllMigrations();

// Check migration status
const status = await getMigrationStatus();
```

### Store / Data Accessor

```typescript
import { createDataAccessor, getAccessor } from '@cleocode/core';

// Create data accessor for a project
const accessor = createDataAccessor('./my-project');

// Get global accessor
const globalAccessor = getAccessor();

// Use accessor
const tasks = await accessor.queryTasks({ status: ['pending'] });
await accessor.updateTask('T1234', { status: 'completed' });
```

## Usage Examples

### Complete Workflow Example

```typescript
import { Cleo } from '@cleocode/core';

async function main() {
  // Initialize CLEO
  const cleo = await Cleo.init('./my-project');
  
  try {
    // Create tasks for a feature
    const epic = await cleo.tasks.add({
      title: 'User Authentication System',
      type: 'epic',
      priority: 'high'
    });
    
    const task1 = await cleo.tasks.add({
      title: 'Implement login endpoint',
      parentId: epic.id,
      type: 'task',
      priority: 'high'
    });
    
    const task2 = await cleo.tasks.add({
      title: 'Add password hashing',
      parentId: epic.id,
      type: 'task',
      priority: 'high',
      dependsOn: [task1.id]
    });
    
    // Start a session
    const session = await cleo.sessions.start({
      scope: 'auth-feature',
      notes: 'Implementing authentication'
    });
    
    // Store architectural decision
    await cleo.memory.observe({
      topic: 'auth-architecture',
      content: 'Using bcrypt for password hashing with cost factor 12',
      tags: ['architecture', 'security', 'auth'],
      confidence: 0.95
    });
    
    // Complete work
    await cleo.tasks.start(task1.id);
    await cleo.tasks.complete(task1.id);
    
    // End session
    await cleo.sessions.end(session.id, {
      summary: 'Completed login endpoint'
    });
    
  } finally {
    await cleo.destroy();
  }
}

main().catch(console.error);
```

### Working with Dependencies

```typescript
import { tasks, orchestration } from '@cleocode/core';

async function manageDependencies() {
  // Add tasks with dependencies
  const backend = await tasks.add({ title: 'Backend API' });
  const frontend = await tasks.add({ 
    title: 'Frontend UI',
    dependsOn: [backend.id]
  });
  const tests = await tasks.add({
    title: 'Integration Tests',
    dependsOn: [backend.id, frontend.id]
  });
  
  // Analyze dependency tree
  const analysis = await orchestration.analyze({
    taskIds: [backend.id, frontend.id, tests.id]
  });
  
  // Get execution order
  console.log('Execution order:', analysis.sequence);
  
  // Find blocked tasks
  console.log('Blocked:', analysis.blocked);
}
```

### Memory Bridge Example

```typescript
import { memory } from '@cleocode/core';

async function buildKnowledge() {
  // Store observations
  await memory.observe({
    topic: 'database-choice',
    content: 'Selected PostgreSQL over MongoDB for ACID compliance',
    tags: ['database', 'decision'],
    confidence: 0.9
  });
  
  await memory.observe({
    topic: 'api-design',
    content: 'RESTful API with OpenAPI 3.0 spec',
    tags: ['api', 'design'],
    confidence: 0.95
  });
  
  // Search for patterns
  const results = await memory.search('database', { 
    tags: ['decision'],
    limit: 5 
  });
  
  // Build context for AI
  const context = results.map(r => ({
    topic: r.topic,
    content: r.content,
    confidence: r.confidence
  }));
}
```

## Dependencies

### Production Dependencies

- `@cleocode/contracts` - Type definitions
- `@cleocode/caamp` - Context-aware agent memory protocol
- `@cleocode/lafs` - Language-agnostic feedback schema
- `drizzle-orm` - Database ORM
- `zod` - Schema validation
- `pino` - Logging
- `yaml` - YAML parsing
- `ajv` - JSON Schema validation
- And more...

### Development Dependencies

- `typescript` - Type checking
- `vitest` - Testing framework
- `@types/*` - Type definitions

## License

MIT License - see [LICENSE](../LICENSE) for details.
