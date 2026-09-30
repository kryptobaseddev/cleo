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
import type {
  Task,
  TaskClaim,
  TaskKind,
  TaskPriority,
  TaskSeverity,
  TaskSize,
  TaskStatus,
  TaskType,
} from './task.js';

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
  /**
   * Severity axis filter (`P0`-`P3`). Orthogonal to {@link priority}.
   *
   * @remarks
   * T12120 (GH #1245): `severity` is a first-class ADR-066 axis that
   * `cleo add --severity` persists, but it had no read path at any layer —
   * so `cleo list --severity P0` returned every task with no signal that the
   * constraint had been dropped. A filter that is accepted and not applied
   * fails OPEN, which is the most dangerous possible answer to "show me only
   * the critical items".
   */
  severity?: TaskSeverity | TaskSeverity[];
  /**
   * Kind axis filter (`work`/`research`/`experiment`/`bug`/`spike`/`release`).
   * Orthogonal to {@link type}. Stored in the `role` DB column.
   *
   * @remarks
   * T12120 (GH #1245): missing from the read path for the same reason as
   * {@link severity}.
   */
  kind?: TaskKind | TaskKind[];
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

/** Query scope and enumeration facts shared by every task read rendering. */
export interface TaskPopulation {
  /** Rows satisfying all filters before pagination. */
  matched: number;
  /** Rows actually present in this response; also the count projection. */
  returned: number;
  /** Whether this response omits any matching rows. */
  truncated: boolean;
  /** Requested page size; null means all matches after offset. */
  limit: number | null;
  /** Matching rows skipped before this page. */
  offset: number;
  /** Archive eligibility, independent of how many archived rows matched. */
  archive: 'included' | 'excluded' | 'only';
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
  /**
   * Agent claim lease columns (T12502). Change them through
   * `DataAccessor.claimTask` / `unclaimTask`, which pair them with a
   * {@link TaskClaimGuard} so the write is a compare-and-set on the holder.
   */
  claimedBySession?: string | null;
  /** Agent identity of the lease holder (T12502). */
  claimedByAgent?: string | null;
  /** ISO-8601 UTC instant the lease was taken (T12502). */
  claimedAt?: string | null;
  /** ISO-8601 UTC instant the lease lapses unless renewed (T12502). */
  leaseExpiresAt?: string | null;
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
  /**
   * Row uid (T12341): the criterion's identity across devices and across edits
   * (`id` changes with the text; `uid` does not). `null` until the store fills
   * it; absent from accessors that predate it.
   */
  uid?: string | null;
  /** Birth fingerprint (T12341): write-once, carried with the uid across edits. */
  birthFp?: string | null;
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
  /**
   * The evidence was recorded against a different text of this criterion
   * (T12341): the criterion kept its identity through an edit, but no gate may
   * count this binding until the evidence is re-verified. Absent means valid.
   */
  stale?: boolean;
}

/** Query options for bounded reads from the append-only task audit log. @task T10594 */
export interface TaskAuditLogQuery {
  /** Exact audit row ids (T12693: revert one ranking change). */
  ids?: readonly string[];
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
  /** Session the mutation ran in, when recorded (T12693). */
  sessionId?: string | null;
}

/**
 * Optimistic-concurrency guard for a single-task write (T12503).
 *
 * A task's version is its `updatedAt` timestamp (falling back to `createdAt`
 * for a row that was never updated). The update, complete and field-update
 * paths advance it strictly, so a caller that read version `v` and passes
 * `expectedUpdatedAt: v` either writes against exactly the row it read or
 * fails with `E_CONFLICT` (`ExitCode.VERSION_CONFLICT`) carrying the current
 * version. Some other writers still stamp it from the clock, leaving a narrow
 * same-millisecond window (T12720). The comparison
 * runs inside the write transaction, after `BEGIN IMMEDIATE` holds the lock.
 * Omitting the guard keeps last-writer-wins semantics.
 */
export interface TaskWriteGuard {
  /** Version the caller read; the write fails with `E_CONFLICT` if the row moved on. */
  expectedUpdatedAt?: string;
  /**
   * The task as the caller read it. Used only to build the conflict summary:
   * on `E_CONFLICT`, the fields whose stored value differs from this snapshot
   * are reported in {@link TaskConflictDetails.changedFields}. @task T12503
   */
  baseline?: Task;
  /**
   * Compare-and-set on the claim lease columns (T12502). The write matches
   * only while the stored holder satisfies {@link TaskClaimGuard.mode}; when
   * it does not, the write fails with `E_TASK_CLAIMED`
   * ({@link TaskClaimedDetails}) instead of `E_CONFLICT`.
   */
  claim?: TaskClaimGuard;
  /**
   * Leave the task version (`updatedAt`) unchanged. For lease bookkeeping
   * (renew, release) that must not invalidate another writer's `--if-match`.
   * @task T12502
   */
  keepVersion?: boolean;
}

/**
 * How a claim write treats the lease already stored on the task (T12502).
 *
 * - `acquire`: succeeds when the task is unclaimed, already held by the
 *   caller's session, or held by `handoffFrom` (an orchestrator handing the
 *   task to the agent it spawns). An expired lease still blocks: taking it is
 *   explicit.
 * - `take-over`: `acquire`, or the stored lease has expired. Audited.
 * - `force`: unconditional, even over a live lease. Audited.
 * - `renew`: only the holder session may extend its lease.
 * - `release`: only the holder session may clear its lease.
 */
export type TaskClaimMode = 'acquire' | 'take-over' | 'force' | 'renew' | 'release';

/**
 * Claim predicate for a guarded task write (T12502). Evaluated in the
 * UPDATE's WHERE clause, inside the write transaction.
 */
export interface TaskClaimGuard {
  /** The caller's session, or `null` for an unbound caller (holds no lease). */
  sessionId: string | null;
  /** Which stored holders the write may replace. */
  mode: TaskClaimMode;
  /** ISO-8601 UTC "now" used for the lease-expiry comparison. */
  now: string;
  /** A session whose live lease `acquire` may take over (spawn hand-off). */
  handoffFrom?: string | null;
}

/**
 * A request to take, renew or override the claim lease on a task (T12502).
 */
export interface TaskClaimRequest {
  /** The claiming session; `null` checks the claim without taking a lease. */
  sessionId: string | null;
  /** Agent identity recorded with the lease, or `null`. */
  agentId: string | null;
  /** How to treat a stored lease (see {@link TaskClaimMode}); never `release`. */
  mode: Exclude<TaskClaimMode, 'release'>;
  /** Lease length in milliseconds; defaults to the core lease TTL. */
  leaseMs?: number;
  /** Clock override (ISO-8601 UTC) for tests. */
  now?: string;
  /** A session whose live lease `acquire` may take over (spawn hand-off). */
  handoffFrom?: string | null;
}

/**
 * `details` of an `E_TASK_CLAIMED` (`ExitCode.TASK_CLAIMED`) error: who holds
 * the task, until when, and which explicit, audited override applies.
 *
 * @task T12502
 */
export interface TaskClaimedDetails {
  /** Always `'claimedBySession'`: the lease-holder column the claim compared. */
  field: 'claimedBySession';
  /** The claimed task. */
  taskId: string;
  /** The lease currently stored on the task. */
  holder: TaskClaim;
  /** `true` when the holder's lease has lapsed (take it with `--take-over`). */
  expired: boolean;
  /** The refused caller. */
  requester: { sessionId: string | null; agentId: string | null };
  /** The flag that would override: `--take-over` (expired) or `--force-claim` (live). */
  override: '--take-over' | '--force-claim';
}

/**
 * One field that differs between the caller's read and the stored row, as
 * reported on an `E_CONFLICT` error. Values are JSON-serialised and truncated
 * so the envelope stays small; `null` means the field was absent.
 *
 * @task T12503
 */
export interface TaskConflictChange {
  /** Task field name (camelCase, as on {@link Task}). */
  field: string;
  /** JSON of the value in the caller's read, or `null` when absent. */
  was: string | null;
  /** JSON of the value currently stored, or `null` when absent. */
  now: string | null;
}

/**
 * `details` of an `E_CONFLICT` (`ExitCode.VERSION_CONFLICT`) task error: the
 * version the caller expected, the version now stored, and which fields moved
 * so an agent can re-read, merge and retry with `--if-match <currentVersion>`.
 *
 * `changedFields` is diffed against the caller's read when the write path
 * holds it (`cleo update`, `cleo complete`, or a guard with `baseline`). When
 * the caller's read was already older than the one this command made, the
 * summary covers only changes after that read; `current` always carries the
 * stored values to merge against.
 *
 * @task T12503
 */
export interface TaskConflictDetails {
  /** Always `'updatedAt'`: the version field. */
  field: 'updatedAt';
  /** The version the caller expected. */
  expected: string;
  /** The version currently stored (same as {@link currentVersion}). */
  actual: string;
  /** The version to pass as `--if-match` after merging. */
  currentVersion: string;
  /** Names of the fields that differ between the caller's read and the stored row. */
  changedFields: string[];
  /** Per-field before/after summary for {@link changedFields}. */
  changes: TaskConflictChange[];
  /**
   * Merge-relevant stored values of the task right now, bounded so the
   * envelope stays small: `title` is cut at 200 characters and `labels` /
   * `depends` hold at most the first 50 entries, with the full counts in
   * `labelsTotal` / `dependsTotal`.
   */
  current: {
    title: string;
    status: TaskStatus;
    priority: TaskPriority;
    labels: string[];
    labelsTotal: number;
    depends: string[];
    dependsTotal: number;
    parentId: string | null;
  } | null;
}

/**
 * Subset of DataAccessor methods available inside a transaction callback.
 * Write-only — reads use the outer accessor (snapshot isolation).
 */
export interface TransactionAccessor {
  upsertSingleTask(task: Task): Promise<void>;
  /**
   * Insert a NEW task; never overwrites. Throws `ID_COLLISION` when the id is
   * already stored (T12724).
   */
  insertNewTask(task: Task): Promise<void>;
  archiveSingleTask(taskId: string, fields: ArchiveFields): Promise<void>;
  removeSingleTask(taskId: string): Promise<void>;
  setMetaValue(key: string, value: unknown): Promise<void>;
  updateTaskFields(taskId: string, fields: TaskFieldUpdates, guard?: TaskWriteGuard): Promise<void>;
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
      /** Row uid to keep (T12341); omitted → a new uid is minted. */
      uid?: string | null;
      /** Birth fingerprint to keep with the uid (T12341). */
      birthFp?: string | null;
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
   * Delete only the named AC rows of `taskId` (rows of other tasks are never
   * touched). Used by the diff apply path so ACs that survive an edit keep
   * their row — and therefore their evidence bindings.
   * @task T12789
   */
  deleteAcRowsByIds(taskId: string, ids: readonly string[]): Promise<void>;
  /**
   * Update existing AC rows of their own task in place, keyed by `(id, taskId)`.
   * Every mutable column is rewritten from the supplied row; `id` and
   * `taskId` are never changed. A row that does not exist for that task is
   * an error, never an insert.
   * @task T12789
   */
  updateAcRows(
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
   * Append a history row to `task_acceptance_criteria_history` capturing the
   * AC text that is about to be superseded.
   * @task T10508
   */
  appendAcHistory(
    rows: Array<{ acId: string; previousText: string; reason: string; acUid?: string | null }>,
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

  /**
   * Insert a NEW task under a freshly allocated or computed id. Never
   * overwrites: throws `ID_COLLISION` when the id is already stored, and
   * writes nothing (T12724).
   */
  insertNewTask(task: Task): Promise<void>;

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

  /**
   * Update specific fields on a task without full load/save cycle.
   *
   * With `guard.expectedUpdatedAt`, the stored version is compared inside the
   * write transaction and a mismatch throws `E_CONFLICT` (T12503).
   */
  updateTaskFields(taskId: string, fields: TaskFieldUpdates, guard?: TaskWriteGuard): Promise<void>;

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

  // ---- Agent task claiming (leased, T12502) ----

  /**
   * Take, renew or override the claim lease on a task in one compare-and-set
   * write (`updateTaskFields` with a {@link TaskClaimGuard}). The human
   * `assignee` is never touched.
   *
   * With `sessionId: null` no lease is written; the call only verifies, in
   * the same way, that no other session holds the task.
   *
   * @param taskId - ID of the task to claim.
   * @param request - Claimant, mode and lease length.
   * @returns The lease now held, or `null` when `sessionId` is `null`.
   * @throws {Error} When the task is not found.
   * @throws CleoError `E_TASK_CLAIMED` with {@link TaskClaimedDetails} when
   *   another session holds the task and `mode` does not allow replacing it.
   */
  claimTask(taskId: string, request: TaskClaimRequest): Promise<TaskClaim | null>;

  /**
   * Release the claim lease on a task. Without `force`, only the holder
   * session's lease is cleared; with `force` any lease is cleared.
   *
   * @param taskId - ID of the task to release.
   * @param release - The releasing session and whether to force.
   * @returns `true` when a lease was cleared, `false` when there was none to clear.
   * @throws {Error} When the task is not found.
   * @throws CleoError `E_TASK_CLAIMED` when another session holds the lease and `force` is not set.
   */
  unclaimTask(
    taskId: string,
    release: { sessionId: string | null; force?: boolean },
  ): Promise<boolean>;

  /**
   * Heartbeat: extend every lease held by `sessionId` to `leaseExpiresAt`,
   * without changing any task version (T12502). A session holding no lease
   * costs one indexed read and takes no write lock.
   *
   * @param sessionId - The holder session.
   * @param leaseExpiresAt - New lease expiry (ISO-8601 UTC).
   * @returns Number of leases renewed.
   */
  renewSessionClaims(sessionId: string, leaseExpiresAt: string): Promise<number>;
}

// Factory functions (createDataAccessor, getTaskAccessor) live in @cleocode/core,
// not here. Contracts is types-only.
