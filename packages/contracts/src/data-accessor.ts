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
  assignee?: string | null;
  pipelineStage?: string | null;
}

/**
 * A row of the `task_acceptance_criteria` table (T10502).
 *
 * @task T10508
 */
export interface AcRow {
  /** UUIDv4 stable identifier, immutable for the AC's lifetime. */
  id: string;
  /** Owning task ID. */
  taskId: string;
  /** 1-based ordinal — never reused per task (gaps remain on shrink). */
  ordinal: number;
  /** Typed completion criterion discriminator per ADR-088. */
  kind: 'text' | 'child_task' | 'evidence_bound';
  /** Stable per-task source key for idempotent criteria projection/upsert. */
  sourceKey: string;
  /** Optional child task target; only `kind='child_task'` may populate it. */
  targetTaskId: string | null;
  /** Compatibility projection owner (for example: legacy, direct, parent-child). */
  projection: string;
  /** The AC statement text. Structured gates are serialised as JSON. */
  text: string;
  /** ISO-8601 timestamp the row was created. */
  createdAt: string;
  /** ISO-8601 last-edit timestamp; null until first edit. */
  updatedAt: string | null;
  /** Optional sha256(text) snapshot; writers MAY populate, readers MUST treat null as "unknown". */
  contentHash: string | null;
}

/** Machine-readable AC child-projection drift codes for doctor/audit output. */
export type AcProjectionAuditFindingCode =
  | 'missing_child_task_row'
  | 'extra_child_task_row'
  | 'mismatched_child_task_row'
  | 'stale_child_task_projection';

/** Dirty/clean status for an AC projection audit scan. */
export type AcProjectionAuditStatus = 'clean' | 'dirty';

/** Field-level child projection mismatch surfaced by doctor/audit callers. */
export interface AcProjectionAuditFinding {
  /** Stable machine-readable finding code. */
  code: AcProjectionAuditFindingCode;
  /** Parent task whose AC rows were audited. */
  parentId: string;
  /** Direct child expected by WorkGraph containment, when applicable. */
  childId?: string;
  /** Existing AC row id involved in the finding, when applicable. */
  acId?: string;
  /** Compared row field, or `row` for whole-row missing/extra findings. */
  field: 'row' | 'kind' | 'sourceKey' | 'targetTaskId' | 'projection' | 'text' | 'contentHash';
  /** Expected canonical value. */
  expected: string | null;
  /** Actual observed value. */
  actual: string | null;
  /** True when this finding proves cached projection state is dirty/stale. */
  dirty: true;
}

/** Typed result returned by AC projection doctor/audit scanners. */
export interface AcProjectionAuditResult {
  /** Parent task whose child_task projection rows were audited. */
  parentId: string;
  /** Clean when no findings were emitted, dirty otherwise. */
  status: AcProjectionAuditStatus;
  /** Boolean convenience flag for CLIs that render dirty state. */
  dirty: boolean;
  /** Number of direct children WorkGraph says should be projected. */
  expectedRows: number;
  /** Number of existing child_task projection rows observed on the parent. */
  actualRows: number;
  /** Stable sha256 over the expected child projection state. */
  freshnessFingerprint: string;
  /** True when at least one finding indicates stale/missing/extra projection state. */
  staleProjection: boolean;
  /** Typed findings suitable for JSON doctor/audit output. */
  findings: readonly AcProjectionAuditFinding[];
}

/**
 * A row of the `evidence_ac_bindings` table (T10503) — the M:N join between
 * evidence atoms and acceptance criteria. Powers the AC-coverage gate
 * (T10509) — "what evidence has been recorded against this AC?".
 *
 * @task T10509
 * @saga T10377 (SG-IVTR-AC-BINDING)
 */
export interface AcBindingRow {
  /** UUIDv4 — set by the writer (T10505/T10506). */
  id: string;
  /** Stable hash / composite key of the evidence atom. NOT an FK. */
  evidenceAtomId: string;
  /** FK → `task_acceptance_criteria(id)`. */
  acId: string;
  /** One of {direct, satisfies, coverage}. */
  bindingType: 'direct' | 'satisfies' | 'coverage';
  /** ISO-8601 timestamp of binding creation. */
  createdAt: string;
}

/** Query options for bounded reads from the append-only task audit log. @task T10594 */
export interface TaskAuditLogQuery {
  taskIds?: readonly string[];
  actions?: readonly string[];
  since?: string;
  limit?: number;
}

/** DataAccessor-facing shape of audit_log rows used by completion context packs. @task T10594 */
export interface TaskAuditLogRow {
  id: string;
  timestamp: string;
  action: string;
  taskId: string;
  actor: string;
  detailsJson: string | null;
  beforeJson: string | null;
  afterJson: string | null;
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
  /** Get direct non-archived children inside the caller-owned transaction. @task T10590 */
  getChildren(parentId: string): Promise<Task[]>;
  appendLog(entry: Record<string, unknown>): Promise<void>;
  /** Persist a relation row to task_relations. @task T9514 */
  addRelation(
    taskId: string,
    relatedTo: string,
    relationType: string,
    reason?: string,
  ): Promise<void>;
  /** Remove a relation row from task_relations. @task T9514 */
  removeRelation(taskId: string, relatedTo: string, relationType?: string): Promise<void>;
  /** Remove all relations for a task (both directions) — used for set-replace. @task T9514 */
  clearRelations(taskId: string): Promise<void>;
  /**
   * Insert AC rows into `task_acceptance_criteria` with caller-supplied
   * UUIDs and ordinals. Ordinals MUST NOT collide with existing rows for
   * the same task — the UNIQUE (task_id, ordinal) index enforces this.
   * @task T10508
   */
  insertAcRows(
    rows: Array<{
      id: string;
      taskId: string;
      ordinal: number;
      text: string;
      kind?: 'text' | 'child_task' | 'evidence_bound';
      sourceKey?: string;
      targetTaskId?: string | null;
      projection?: string;
      contentHash?: string | null;
    }>,
  ): Promise<void>;
  /**
   * Read all AC rows for a task, ordered by ordinal ASC.
   * Available inside transactions for shrink/replace flows that need to
   * read the current state before deletion.
   * @task T10508
   */
  getAcRows(taskId: string): Promise<AcRow[]>;
  /**
   * Delete all AC rows for a task. Used by update-replace-all + update-shrink
   * flows AFTER the history rows have been appended.
   * @task T10508
   */
  deleteAcRowsForTask(taskId: string): Promise<void>;
  /**
   * Append a history row to `task_acceptance_criteria_history` capturing the
   * AC text that is about to be superseded.
   * @task T10508
   */
  appendAcHistory(
    rows: Array<{ acId: string; previousText: string; reason: string }>,
  ): Promise<void>;
  /**
   * Read all `evidence_ac_bindings` rows whose `ac_id` ∈ the given set.
   * Used by the AC-coverage gate (T10509) to compute which ACs are
   * satisfied vs unsatisfied inside the same transaction that flips the
   * task to `done`.
   *
   * Returns the empty array when `acIds` is empty.
   *
   * @task T10509
   */
  getAcBindings(acIds: readonly string[]): Promise<AcBindingRow[]>;
  /**
   * Insert rows into `evidence_ac_bindings`. Used by the Validator SDK
   * tools (T10511) to persist coverage bindings transactionally after a
   * Validator attestation. The UNIQUE (evidence_atom_id, ac_id, binding_type)
   * index collapses idempotent re-inserts via `ON CONFLICT DO NOTHING`.
   *
   * No-op when `rows` is empty.
   *
   * @task T10511
   * @saga T10377 (SG-IVTR-AC-BINDING)
   */
  insertAcBindings(
    rows: Array<{
      id: string;
      evidenceAtomId: string;
      acId: string;
      bindingType: 'direct' | 'satisfies' | 'coverage';
    }>,
  ): Promise<void>;
}

// Re-export AcRow at the module level for both transaction + outer accessor use.

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

  /** Query recent task audit rows by task id/action, newest first. @task T10594 */
  queryAuditLog(query: TaskAuditLogQuery): Promise<TaskAuditLogRow[]>;

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

  /** Remove a row from the task_relations table (T9240). */
  removeRelation(taskId: string, relatedTo: string, relationType?: string): Promise<void>;

  /**
   * Read AC rows for a task from `task_acceptance_criteria`, ordered by
   * ordinal ASC. Returns the empty array if no rows exist.
   * @task T10508
   */
  getAcRows(taskId: string): Promise<AcRow[]>;

  /**
   * Read `evidence_ac_bindings` rows whose `ac_id` ∈ the given set.
   * Powers the AC-coverage gate (T10509). Returns the empty array when
   * `acIds` is empty or no bindings exist for the supplied ids.
   * @task T10509
   */
  getAcBindings(acIds: readonly string[]): Promise<AcBindingRow[]>;

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

  /**
   * Get the currently active session (status='active', most recent).
   *
   * SCAN-meaning: answers "is there any active session?" — NOT "who am I".
   * Identity-meaning callers MUST use {@link DataAccessor.resolveCurrentSession}
   * (T11640), which resolves the caller's OWN session via the
   * connection-handle → `CLEO_SESSION_ID` → most-recent-active precedence.
   */
  getActiveSession(): Promise<Session | null>;

  /**
   * Resolve the CALLER's current session (T11640 · Epic T11638).
   *
   * Identity-meaning resolution for accessor-based consumers, mirroring the
   * standalone `resolveCurrentSession` in `@cleocode/core`. Precedence:
   *   1. daemon connection handle (the connection bound at accept-time),
   *   2. env-named session (`CLEO_SESSION_ID`),
   *   3. most-recent-active row (legacy single-process fallback).
   *
   * Use this — NOT {@link DataAccessor.getActiveSession} — anywhere the meaning
   * is "the session of whoever issued THIS request".
   */
  resolveCurrentSession(): Promise<Session | null>;

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

  // ---- Agent task claiming ----

  /**
   * Atomically claim a task for an agent.
   *
   * Uses `UPDATE ... WHERE assignee IS NULL OR assignee = agentId` to prevent
   * race conditions. Throws if the task is already claimed by a different agent.
   *
   * @param taskId - ID of the task to claim.
   * @param agentId - Agent identifier claiming the task.
   * @throws {Error} When the task is not found or is already claimed by another agent.
   */
  claimTask(taskId: string, agentId: string): Promise<void>;

  /**
   * Release a claimed task, clearing its assignee.
   *
   * No-op if the task is not currently claimed.
   *
   * @param taskId - ID of the task to unclaim.
   * @throws {Error} When the task is not found.
   */
  unclaimTask(taskId: string): Promise<void>;
}

// Factory functions (createDataAccessor, getTaskAccessor) live in @cleocode/core,
// not here. Contracts is types-only.
