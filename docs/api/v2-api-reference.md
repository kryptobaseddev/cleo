# CLEO V2 API Reference

**Task**: T4472
**Epic**: T4454
**Date**: 2026-02-14
**Status**: complete

---

## Summary

API reference for the CLEO V2 TypeScript core modules. All modules are exported from `src/core/index.ts` and organized into focused submodules.

---

## Module Architecture

```
src/
  core/               # Core business logic
    index.ts          # Barrel export for top-level modules
    errors.ts         # CleoError class
    output.ts         # LAFS output formatting
    paths.ts          # XDG-compliant path resolution
    config.ts         # Configuration engine
    schema.ts         # JSON Schema validation (ajv)
    tasks/            # Task CRUD operations
    sessions/         # Session lifecycle management
    focus/            # Focus management
    phases/           # Phase tracking
    lifecycle/        # RCSD lifecycle enforcement
    migration/        # Schema migration engine
    orchestration/    # Multi-agent orchestration
    release/          # Release lifecycle
    research/         # Research manifests
  types/              # Type definitions
    config.ts         # Configuration types
    task.ts           # Task/TodoFile types
    session.ts        # Session types
    exit-codes.ts     # Exit code enum
    lafs.ts           # LAFS envelope types
  store/              # Data persistence
    json.ts           # Atomic JSON read/write
  validation/         # Input validation
  cli/                # CLI command handlers
    commands/         # Individual command files
```

---

## Core Exports (`src/core/index.ts`)

### CleoError

Structured error class carrying exit codes and fix suggestions.

```typescript
import { CleoError } from './errors.js';

class CleoError extends Error {
  readonly code: ExitCode;
  readonly fix?: string;
  readonly alternatives?: Array<{ action: string; command: string }>;

  constructor(code: ExitCode, message: string, options?: {
    fix?: string;
    alternatives?: Array<{ action: string; command: string }>;
    cause?: unknown;
  });

  toJSON(): Record<string, unknown>;
}
```

### Output Formatting

LAFS-compliant output functions.

```typescript
import { formatOutput, formatSuccess, formatError } from './output.js';

// Types
interface LafsSuccess<T = unknown> {
  success: true;
  data: T;
  message?: string;
  noChange?: boolean;
}

interface LafsError {
  success: false;
  error: {
    code: number;
    name: string;
    message: string;
    fix?: string;
    alternatives?: Array<{ action: string; command: string }>;
  };
}

type LafsEnvelope<T = unknown> = LafsSuccess<T> | LafsError;

// Functions
function formatSuccess<T>(data: T, message?: string): string;
function formatError(error: CleoError): string;
function formatOutput<T>(result: T | CleoError): string;
```

### Path Resolution

XDG-compliant path resolution. Respects `CLEO_HOME` and `CLEO_DIR` environment variables.

```typescript
import {
  getCleoHome,         // Global CLEO home (~/.cleo)
  getCleoDir,          // Project CLEO dir (.cleo)
  getCleoDirAbsolute,  // Absolute path to project .cleo
  getProjectRoot,      // Project root directory
  resolveProjectPath,  // Resolve project-relative path
  getTodoPath,         // .cleo/todo.json
  getConfigPath,       // .cleo/config.json
  getSessionsPath,     // .cleo/sessions.json
  getArchivePath,      // .cleo/todo-archive.json
  getLogPath,          // .cleo/todo-log.jsonl
  getBackupDir,        // .cleo/backups/operational
  getGlobalConfigPath, // ~/.cleo/config.json
  isAbsolutePath,      // Check if path is absolute
} from './paths.js';
```

All path functions accept an optional `cwd?: string` parameter.

### Configuration Engine

Cascading configuration with source tracking.

```typescript
import { loadConfig, getConfigValue } from './config.js';

// Load merged config from all sources
async function loadConfig(cwd?: string): Promise<CleoConfig>;

// Get single value with source tracking
async function getConfigValue<T>(
  path: string,
  cwd?: string,
): Promise<ResolvedValue<T>>;
```

**Resolution priority**: CLI flags > Environment variables > Project config > Global config > Defaults

**Configuration interface:**

```typescript
interface CleoConfig {
  version: string;
  output: {
    defaultFormat: 'json' | 'text' | 'jsonl' | 'markdown' | 'table';
    showColor: boolean;
    showUnicode: boolean;
    showProgressBars: boolean;
    dateFormat: 'relative' | 'iso' | 'short' | 'long';
  };
  backup: {
    maxOperationalBackups: number;
    maxSafetyBackups: number;
    compressionEnabled: boolean;
  };
  hierarchy: {
    maxDepth: number;      // default: 3
    maxSiblings: number;   // default: 7
    cascadeDelete: boolean;
  };
  session: {
    autoStart: boolean;
    requireNotes: boolean;
    multiSession: boolean;
  };
  lifecycle: {
    mode: 'strict' | 'advisory' | 'off';
  };
}
```

### Schema Validation

JSON Schema validation powered by ajv with format support.

```typescript
import { validateAgainstSchema, validateAgainstSchemaFile, checkSchema } from './schema.js';

// Validate data against inline schema (throws CleoError on failure)
function validateAgainstSchema(
  data: unknown,
  schema: Record<string, unknown>,
  schemaId?: string,
): void;

// Validate data against a schema file (throws CleoError on failure)
async function validateAgainstSchemaFile(
  data: unknown,
  schemaPath: string,
): Promise<void>;

// Non-throwing validation, returns error messages
function checkSchema(
  data: unknown,
  schema: Record<string, unknown>,
): string[];
```

---

## Task Operations (`src/core/tasks/`)

### addTask

```typescript
import { addTask } from './tasks/index.js';

interface AddTaskOptions {
  title: string;
  description?: string;
  priority?: 'critical' | 'high' | 'medium' | 'low';
  parentId?: string;
  depends?: string[];
  labels?: string[];
  phase?: string;
  size?: 'small' | 'medium' | 'large';
  type?: 'epic' | 'task' | 'subtask' | 'bug' | 'feature';
}

interface AddTaskResult {
  taskId: string;
  title: string;
  status: string;
  parentId?: string;
}

async function addTask(options: AddTaskOptions, cwd?: string): Promise<AddTaskResult>;
```

### listTasks

```typescript
import { listTasks } from './tasks/index.js';

interface ListTasksOptions {
  status?: string;
  priority?: string;
  parentId?: string;
  phase?: string;
  limit?: number;
  offset?: number;
}

interface ListTasksResult {
  tasks: Task[];
  total: number;
  pagination: { limit: number; offset: number; hasMore: boolean };
}

async function listTasks(options?: ListTasksOptions, cwd?: string): Promise<ListTasksResult>;
```

### showTask

```typescript
import { showTask } from './tasks/index.js';

interface TaskDetail {
  task: Task;
  hierarchy: { parent?: Task; children: Task[]; depth: number };
  dependsOn: Task[];
  dependents: Task[];
}

async function showTask(taskId: string, cwd?: string): Promise<TaskDetail>;
```

### findTasks

```typescript
import { findTasks } from './tasks/index.js';

interface FindTasksOptions {
  query: string;
  status?: string;
  limit?: number;
}

interface FindResult {
  id: string;
  title: string;
  status: string;
  score: number;
}

interface FindTasksResult {
  results: FindResult[];
  total: number;
}

async function findTasks(options: FindTasksOptions, cwd?: string): Promise<FindTasksResult>;
```

### completeTask

```typescript
import { completeTask } from './tasks/index.js';

interface CompleteTaskOptions {
  taskId: string;
  notes?: string;
  skipNotes?: boolean;
}

interface CompleteTaskResult {
  taskId: string;
  completedAt: string;
  archived: boolean;
}

async function completeTask(options: CompleteTaskOptions, cwd?: string): Promise<CompleteTaskResult>;
```

### updateTask

```typescript
import { updateTask } from './tasks/index.js';

interface UpdateTaskOptions {
  taskId: string;
  status?: string;
  priority?: string;
  title?: string;
  description?: string;
  labels?: string[];
  notes?: string;
  phase?: string;
  depends?: string[];
  blockedBy?: string[];
}

interface UpdateTaskResult {
  taskId: string;
  updated: string[];
}

async function updateTask(options: UpdateTaskOptions, cwd?: string): Promise<UpdateTaskResult>;
```

### deleteTask

```typescript
import { deleteTask } from './tasks/index.js';

interface DeleteTaskOptions {
  taskId: string;
  force?: boolean;
}

interface DeleteTaskResult {
  taskId: string;
  deleted: boolean;
  childrenDeleted: string[];
}

async function deleteTask(options: DeleteTaskOptions, cwd?: string): Promise<DeleteTaskResult>;
```

### archiveTasks

```typescript
import { archiveTasks } from './tasks/index.js';

interface ArchiveTasksOptions {
  status?: string;
  olderThan?: number; // days
}

interface ArchiveTasksResult {
  archived: string[];
  count: number;
}

async function archiveTasks(options?: ArchiveTasksOptions, cwd?: string): Promise<ArchiveTasksResult>;
```

### Validation Helpers

```typescript
import {
  validateTitle,
  validateStatus,
  validatePriority,
  validateTaskType,
  validateSize,
  validateLabels,
  validatePhaseFormat,
  validateDepends,
  validateParent,
  generateTaskId,
  getTaskDepth,
  inferTaskType,
  getNextPosition,
  findRecentDuplicate,
  logOperation,
} from './tasks/index.js';
```

---

## Session Operations (`src/core/sessions/`)

```typescript
import {
  startSession,
  endSession,
  sessionStatus,
  resumeSession,
  listSessions,
  gcSessions,
  parseScope,
} from './sessions/index.js';

interface StartSessionOptions {
  name: string;
  scope: string;        // "epic:T001" or "global"
  autoStart?: boolean;
  focus?: string;
  agent?: string;
}

interface EndSessionOptions {
  sessionId?: string;
  note?: string;
}

interface ListSessionsOptions {
  status?: string;
  limit?: number;
}

async function startSession(options: StartSessionOptions, cwd?: string): Promise<Session>;
async function endSession(options?: EndSessionOptions, cwd?: string): Promise<Session>;
async function sessionStatus(cwd?: string): Promise<Session | null>;
async function resumeSession(sessionId: string, cwd?: string): Promise<Session>;
async function listSessions(options?: ListSessionsOptions, cwd?: string): Promise<Session[]>;
async function gcSessions(maxAgeHours?: number, cwd?: string): Promise<{ orphaned: string[]; removed: string[] }>;
function parseScope(scopeStr: string): SessionScope;
```

---

## Focus Operations (`src/core/focus/`)

```typescript
import {
  showFocus,
  setFocus,
  clearFocus,
  getFocusHistory,
} from './focus/index.js';

interface FocusShowResult {
  currentTask: string | null;
  currentPhase: string | null;
  sessionNote: string | null;
  nextAction: string | null;
}

interface FocusSetResult {
  taskId: string;
  taskTitle: string;
  previousTask: string | null;
}

interface FocusHistoryEntry {
  taskId: string;
  timestamp: string;
}

async function showFocus(cwd?: string): Promise<FocusShowResult>;
async function setFocus(taskId: string, cwd?: string): Promise<FocusSetResult>;
async function clearFocus(cwd?: string): Promise<{ previousTask: string | null }>;
async function getFocusHistory(cwd?: string): Promise<FocusHistoryEntry[]>;
```

---

## Additional Core Modules

### Phases (`src/core/phases/`)

Phase tracking and lifecycle management for project phases. Handles phase transitions, phase listing, and phase status tracking.

### Lifecycle (`src/core/lifecycle/`)

RCSD lifecycle gate enforcement. Validates that tasks progress through Research > Consensus > Specification > Decomposition before entering implementation.

### Migration (`src/core/migration/`)

Schema migration engine. Handles upgrades of `.cleo/todo.json` and other data files across schema versions using versioned migration functions.

### Orchestration (`src/core/orchestration/`)

Multi-agent orchestration operations. Provides analyze, ready, next, and spawn operations for coordinating work across agent subprocesses.

### Release (`src/core/release/`)

Release lifecycle management. Create, plan, ship, and track releases with automatic changelog generation and version bumping.

### Research (`src/core/research/`)

Research manifest operations. Link research outputs to tasks, list research entries, and manage the research knowledge base.

---

## Type Definitions (`src/types/`)

### Exit Codes (`src/types/exit-codes.ts`)

```typescript
enum ExitCode {
  SUCCESS = 0,
  GENERAL_ERROR = 1,
  INVALID_INPUT = 2,
  IO_ERROR = 3,
  NOT_FOUND = 4,
  DUPLICATE = 5,
  VALIDATION_ERROR = 6,
  // ... additional codes
}
```

### Task Types (`src/types/task.ts`)

Core task and file types used across all operations.

### Session Types (`src/types/session.ts`)

Session, SessionScope, and SessionsFile interfaces.

### LAFS Types (`src/types/lafs.ts`)

LAFS envelope type definitions for structured output.

---

## Store Layer (`src/store/json.ts`)

Atomic JSON file operations with backup support.

```typescript
import { readJson, readJsonRequired, saveJson, computeChecksum } from './store/json.js';

// Read JSON file, returns null if not found
async function readJson<T>(path: string): Promise<T | null>;

// Read JSON file, throws if not found
async function readJsonRequired<T>(path: string): Promise<T>;

// Atomic write with backup
async function saveJson(
  path: string,
  data: unknown,
  options?: { backupDir?: string },
): Promise<void>;

// Compute checksum for data integrity
function computeChecksum(tasks: unknown[]): string;
```
