/**
 * DataAccessor: Storage abstraction for core modules.
 *
 * The DataAccessor abstracts WHERE data is stored (SQLite via Drizzle ORM)
 * and provides typed query/mutation methods for tasks, sessions, archives,
 * and metadata.
 *
 * This is the DRY/SOLID injection point: core modules accept a DataAccessor parameter
 * instead of calling readJson/saveJson directly.
 *
 * Implementation: SqliteDataAccessor (materializes/dematerializes from SQLite tables)
 *
 * @epic T4454
 */

import type { ArchivedTask } from './archive.js';
import type { Session } from './session.js';
import type { Task, TaskPriority, TaskSize, TaskStatus, TaskType } from './task.js';

/**
 * Agent instance row shape for DataAccessor methods.
 * Mirrors the agent_instances Drizzle table in core but avoids Drizzle dependency.
 */
export interface DataAccessorAgentInstance {
  id: string;
  agentType: string;
  status: string;
  sessionId: string | null;
  taskId: string | null;
  startedAt: string;
  lastHeartbeat: string;
  stoppedAt: string | null;
  errorCount: number;
  totalTasksCompleted: number;
  capacity: string;
  metadataJson: string | null;
  parentAgentId: string | null;
}

/** Archive-specific fields for task upsert. */
export interface ArchiveFields {
  archivedAt?: string;
  archiveReason?: string;
  cycleTimeDays?: number | null;
}

/** Archive file structure. */
export interface ArchiveFile {
  archivedTasks: ArchivedTask[];
  version?: string;
}

// ---------------------------------------------------------------------------
// Targeted query/mutation types (Phase 2 modernization)
// ---------------------------------------------------------------------------

/** Filter bag for queryTasks(). Covers ~90% of task query patterns. */
export interface TaskQueryFilters {
  status?: TaskStatus | TaskStatus[];
  priority?: TaskPriority;
  type?: TaskType;
  parentId?: string | null; // null = root tasks only
  phase?: string;
  label?: string;
  search?: string; // SQL LIKE on title+description
  excludeStatus?: TaskStatus | TaskStatus[];
  limit?: number;
  offset?: number;
  orderBy?: 'position' | 'createdAt' | 'updatedAt' | 'priority';
}

/** Result from queryTasks() with pagination support. */
export interface QueryTasksResult {
  tasks: Task[];
  total: number;
}

/** Partial task row fields for updateTaskFields(). */
export interface TaskFieldUpdates {
  title?: string;
  description?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  type?: TaskType | null;
  parentId?: string | null;
  phase?: string | null;
  size?: TaskSize | null;
  position?: number | null;
  positionVersion?: number;
  labelsJson?: string;
  notesJson?: string;
  acceptanceJson?: string;
  filesJson?: string;
  origin?: string | null;
  blockedBy?: string | null;
  epicLifecycle?: string | null;
  noAutoComplete?: boolean | null;
  completedAt?: string | null;
  cancelledAt?: string | null;
  cancellationReason?: string | null;
  verificationJson?: string | null;
  createdBy?: string | null;
  modifiedBy?: string | null;
  sessionId?: string | null;
  updatedAt?: string | null;
}

/**
 * Subset of DataAccessor methods available inside a transaction callback.
 * Write-only — reads use the outer accessor (snapshot isolation).
 */
export interface TransactionAccessor {
  upsertSingleTask(task: Task): Promise<void>;
  archiveSingleTask(taskId: string, fields: ArchiveFields): Promise<void>;
  removeSingleTask(taskId: string): Promise<void>;
  setMetaValue(key: string, value: unknown): Promise<void>;
  updateTaskFields(taskId: string, fields: TaskFieldUpdates): Promise<void>;
  appendLog(entry: Record<string, unknown>): Promise<void>;
}

/**
 * DataAccessor interface.
 *
 * Core modules call these methods instead of readJson/saveJson.
 * Each method maps directly to the file-level operations that
 * core modules already perform.
 */
export interface DataAccessor {
  /** The storage engine backing this accessor. */
  readonly engine: 'sqlite';

  // ---- Archive data ----

  /** Load the archive file. Returns null if archive doesn't exist. */
  loadArchive(): Promise<ArchiveFile | null>;

  /** Save the archive file atomically. Creates backup before write. */
  saveArchive(data: ArchiveFile): Promise<void>;

  // ---- Session data ----

  /** Load all sessions from the store. Returns empty array if none exist. */
  loadSessions(): Promise<Session[]>;

  /** Save all sessions to the store atomically. */
  saveSessions(sessions: Session[]): Promise<void>;

  // ---- Audit log ----

  /** Append an entry to the audit log. */
  appendLog(entry: Record<string, unknown>): Promise<void>;

  // ---- Lifecycle ----

  /** Release any resources (close DB connections, etc.). */
  close(): Promise<void>;

  // ---- Fine-grained task operations (T5034) ----

  /** Upsert a single task (targeted write, no full-file reload). */
  upsertSingleTask(task: Task): Promise<void>;

  /** Archive a single task by ID (sets status='archived' + archive metadata). */
  archiveSingleTask(taskId: string, fields: ArchiveFields): Promise<void>;

  /** Delete a single task permanently from the tasks table. */
  removeSingleTask(taskId: string): Promise<void>;

  /** Load a single task by ID with its dependencies and relations. Returns null if not found. */
  loadSingleTask(taskId: string): Promise<Task | null>;

  /** Insert a row into the task_relations table (T5168). */
  addRelation(
    taskId: string,
    relatedTo: string,
    relationType: string,
    reason?: string,
  ): Promise<void>;

  // ---- Metadata (schema_meta KV store) ----

  /** Read a typed value from the metadata store. Returns null if not found. */
  getMetaValue<T>(key: string): Promise<T | null>;

  /** Write a typed value to the metadata store. */
  setMetaValue(key: string, value: unknown): Promise<void>;

  /** Read the schema version from metadata. Convenience for getMetaValue('schema_version'). */
  getSchemaVersion(): Promise<string | null>;

  // ---- Targeted query methods (Phase 2 modernization) ----

  /** Query tasks with filters, pagination, and ordering. Returns matching tasks + total count. */
  queryTasks(filters: TaskQueryFilters): Promise<QueryTasksResult>;

  /** Count tasks matching optional filters. Excludes archived by default. */
  countTasks(filters?: { status?: TaskStatus | TaskStatus[]; parentId?: string }): Promise<number>;

  /** Get direct children of a parent task. */
  getChildren(parentId: string): Promise<Task[]>;

  /** Count direct children of a parent task (all statuses except archived). */
  countChildren(parentId: string): Promise<number>;

  /** Count active (non-terminal) children of a parent task. */
  countActiveChildren(parentId: string): Promise<number>;

  /** Get ancestor chain from task to root via WITH RECURSIVE CTE. Ordered root-first. */
  getAncestorChain(taskId: string): Promise<Task[]>;

  /** Get full subtree rooted at taskId via WITH RECURSIVE CTE. Includes root. */
  getSubtree(rootId: string): Promise<Task[]>;

  /** Get tasks that depend on (are blocked by) the given task. Reverse dep lookup. */
  getDependents(taskId: string): Promise<Task[]>;

  /** Get transitive dependency chain via WITH RECURSIVE CTE. Returns task IDs. */
  getDependencyChain(taskId: string): Promise<string[]>;

  /** Check if a task exists (any status including archived). */
  taskExists(taskId: string): Promise<boolean>;

  /** Load multiple tasks by ID in a single batch query. */
  loadTasks(taskIds: string[]): Promise<Task[]>;

  // ---- Targeted write methods (Phase 2 modernization) ----

  /** Update specific fields on a task without full load/save cycle. */
  updateTaskFields(taskId: string, fields: TaskFieldUpdates): Promise<void>;

  /** Get next available position for a task within a parent scope (SQL-level, race-safe). */
  getNextPosition(parentId: string | null): Promise<number>;

  /** Shift positions of siblings >= fromPosition by delta (bulk SQL update). */
  shiftPositions(parentId: string | null, fromPosition: number, delta: number): Promise<void>;

  /** Execute a function inside a SQLite transaction (BEGIN IMMEDIATE / COMMIT / ROLLBACK). */
  transaction<T>(fn: (tx: TransactionAccessor) => Promise<T>): Promise<T>;

  // ---- Fine-grained session operations ----

  /** Get the currently active session (status='active', most recent). */
  getActiveSession(): Promise<Session | null>;

  /** Upsert a single session (targeted write). */
  upsertSingleSession(session: Session): Promise<void>;

  /** Remove a single session by ID. */
  removeSingleSession(sessionId: string): Promise<void>;

  // ---- Agent instances ----

  /** List agent instances with optional filters. Returns rows from agent_instances table. */
  listAgentInstances(filters?: {
    status?: string | string[];
    agentType?: string | string[];
  }): Promise<DataAccessorAgentInstance[]>;

  /** Get a single agent instance by ID. Returns null if not found. */
  getAgentInstance(agentId: string): Promise<DataAccessorAgentInstance | null>;
}

// Factory functions (createDataAccessor, getAccessor) live in @cleocode/core,
// not here. Contracts is types-only.
