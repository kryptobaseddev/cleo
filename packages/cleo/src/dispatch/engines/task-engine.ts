/**
 * Task Engine
 *
 * Native TypeScript implementation of core task CRUD operations.
 * Uses StoreProvider (via getStore()) for task/session data access,
 * falling back to direct JSON for config and specialized operations.
 *
 * CRUD operations (show, list, find, exists, create, update, complete, delete, archive)
 * delegate to src/core/tasks/*.
 *
 * Non-CRUD operations delegate to src/core/tasks/task-ops.ts.
 *
 * @task T4657
 * @task T4790
 * @epic T4654
 */

import type { MinimalTaskRecord, Task, TaskRecord, TaskRecordRelation } from '@cleocode/contracts';
// validation-rules.js still used by other engines; core modules handle their own validation
// Core module imports for accessor-based operations
import {
  type CompactTask,
  // Non-CRUD core operations
  type ComplexityFactor,
  computeTaskView,
  addTask as coreAddTask,
  archiveTasks as coreArchiveTasks,
  completeTask as coreCompleteTask,
  deleteTask as coreDeleteTask,
  findTasks as coreFindTasks,
  listTasks as coreListTasks,
  showTask as coreShowTask,
  coreTaskAnalyze,
  coreTaskBatchValidate,
  coreTaskBlockers,
  coreTaskCancel,
  coreTaskComplexityEstimate,
  coreTaskDepends,
  coreTaskDeps,
  coreTaskDepsCycles,
  coreTaskDepsOverview,
  coreTaskExport,
  coreTaskHistory,
  coreTaskImport,
  coreTaskLint,
  coreTaskNext,
  coreTaskPromote,
  coreTaskRelates,
  coreTaskRelatesAdd,
  coreTaskReopen,
  coreTaskReorder,
  coreTaskReparent,
  coreTaskRestore,
  coreTaskStats,
  coreTaskTree,
  coreTaskUnarchive,
  updateTask as coreUpdateTask,
  getAccessor,
  getActiveSession,
  getIvtrState,
  getLifecycleStatus,
  getLogger,
  type ImpactReport,
  type IvtrPhase,
  type IvtrPhaseEntry,
  loadConfig,
  predictImpact,
  type TaskView,
  toCompact,
} from '@cleocode/core/internal';
import { cleoErrorToEngineError, type EngineResult, engineError } from './_error.js';

/**
 * Convert a core Task to a TaskRecord for backward compatibility.
 * TaskRecord has string-typed status/priority; Task has union types.
 *
 * @task T4657
 * @epic T4654
 */
function taskToRecord(task: Task): TaskRecord {
  // Task union-typed fields (status, priority, origin, etc.) widen to string in TaskRecord.
  // Some fields have structural mismatches (blockedBy: string vs string[], etc.)
  // so we explicitly map each field rather than relying on spread.
  const relates: TaskRecordRelation[] | undefined = task.relates?.map((r) => ({
    taskId: r.taskId,
    type: r.type,
    ...(r.reason && { reason: r.reason }),
  }));
  return {
    id: task.id,
    title: task.title,
    description: task.description ?? '',
    status: task.status,
    priority: task.priority,
    type: task.type,
    phase: task.phase,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt ?? null,
    completedAt: task.completedAt ?? null,
    cancelledAt: task.cancelledAt ?? null,
    parentId: task.parentId,
    position: task.position,
    positionVersion: task.positionVersion,
    depends: task.depends,
    relates,
    files: task.files,
    acceptance: task.acceptance?.filter((a): a is string => typeof a === 'string'),
    notes: task.notes,
    labels: task.labels,
    size: task.size ?? null,
    epicLifecycle: task.epicLifecycle ?? null,
    noAutoComplete: task.noAutoComplete ?? null,
    verification: task.verification ? { ...task.verification } : null,
    origin: task.origin ?? null,
    cancellationReason: task.cancellationReason,
    blockedBy: task.blockedBy ? [task.blockedBy] : undefined,
    pipelineStage: task.pipelineStage ?? null,
    // T944: orthogonal axes
    role: task.role ?? null,
    scope: task.scope ?? null,
    severity: task.severity ?? null,
  };
}

/**
 * Convert an array of core Tasks to TaskRecords.
 *
 * @task T4657
 * @epic T4654
 */
function tasksToRecords(tasks: Task[]): TaskRecord[] {
  return tasks.map(taskToRecord);
}

// TaskRecord, MinimalTaskRecord imported from @cleocode/contracts (canonical source).
// Re-export for consumers that import from the engine module.
export type { MinimalTaskRecord, TaskRecord } from '@cleocode/contracts';

// Re-export CompactTask from core for consumers
export type { CompactTask } from '@cleocode/core/internal';

// EngineResult imported from ./_error.js (canonical source)
export type { EngineResult } from './_error.js';

// loadTaskFile and saveTaskFile removed — all operations now use DataAccessor.
// Config reads (hierarchy limits, phase meta) still use readJsonFile directly
// since they are NOT domain data (they don't go through the accessor).

// Priority normalization moved to core/tasks/add.ts (normalizePriority)

// ===== Query Operations =====

/**
 * Get a single task by ID.
 *
 * @remarks
 * Fetches the full task record from the data accessor and converts it
 * to the backward-compatible TaskRecord format. Also computes the
 * canonical {@link TaskView} via `computeTaskView` so the `view` field
 * in the response includes `readyToComplete`, `nextAction`, and
 * `lifecycleProgress` without a second round-trip.
 *
 * The `view` field is `null` when `computeTaskView` cannot load the
 * task (e.g. freshly created task not yet visible to the native DB
 * handle). Callers MUST check `result.data.task` for the primary record.
 *
 * @param projectRoot - Absolute path to the project root
 * @param taskId - Task identifier (e.g. "T001")
 * @returns EngineResult containing the task record and canonical view
 *
 * @example
 * ```typescript
 * const result = await taskShow('/project', 'T42');
 * if (result.success) {
 *   console.log(result.data.task.title);
 *   console.log(result.data.view?.nextAction); // 'verify' | 'spawn-worker' | …
 * }
 * ```
 *
 * @task T4657
 * @task T943
 * @epic T4654
 */
export async function taskShow(
  projectRoot: string,
  taskId: string,
): Promise<EngineResult<{ task: TaskRecord; view: TaskView | null }>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const detail = await coreShowTask(taskId, projectRoot, accessor);
    // Compute the canonical view in parallel with record conversion.
    const view = await computeTaskView(taskId, accessor);
    return { success: true, data: { task: taskToRecord(detail), view } };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

// ===== History Support =====

/**
 * A single lifecycle stage transition entry returned by taskShowWithHistory.
 * Maps the `getLifecycleStatus` stage shape into a stable, typed record.
 *
 * @task T787
 * @epic T769
 */
export interface LifecycleStageEntry {
  /** Canonical stage name (e.g. "research", "implementation"). */
  stage: string;
  /** Current status of this stage. */
  status: 'not_started' | 'in_progress' | 'completed' | 'skipped' | 'failed';
  /** ISO timestamp when the stage was started, or null. */
  startedAt: string | null;
  /** ISO timestamp when the stage was completed, or null. */
  completedAt: string | null;
  /** Output file path recorded for this stage, or null. */
  outputFile: string | null;
}

/**
 * Get a single task by ID, optionally including its lifecycle stage history.
 *
 * @remarks
 * When `includeHistory` is `true`, appends a `history` array containing one
 * {@link LifecycleStageEntry} per RCASD pipeline stage. If the task has no
 * pipeline record the call never fails — it returns `history: []` instead.
 *
 * When `includeHistory` is `false` (or omitted) the return value is identical
 * to {@link taskShow} and the `history` key is absent from `data`.
 *
 * @param projectRoot - Absolute path to the project root
 * @param taskId - Task identifier (e.g. "T042")
 * @param includeHistory - When true, append lifecycle stage array
 * @returns EngineResult containing the task record and optional history
 *
 * @example
 * ```typescript
 * const result = await taskShowWithHistory('/project', 'T42', true);
 * if (result.success) {
 *   console.log(result.data.task.title);
 *   console.log(result.data.history); // LifecycleStageEntry[]
 * }
 * ```
 *
 * @task T787
 * @epic T769
 */
export async function taskShowWithHistory(
  projectRoot: string,
  taskId: string,
  includeHistory: boolean,
): Promise<EngineResult<{ task: TaskRecord; history?: LifecycleStageEntry[] }>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const detail = await coreShowTask(taskId, projectRoot, accessor);
    const task = taskToRecord(detail);

    if (!includeHistory) {
      return { success: true, data: { task } };
    }

    // Fetch lifecycle stages — empty array on any failure (task may have no pipeline).
    let history: LifecycleStageEntry[] = [];
    try {
      const status = await getLifecycleStatus(projectRoot ?? process.cwd(), { taskId });
      history = status.stages.map(
        (s): LifecycleStageEntry => ({
          stage: s.stage,
          status: (s.status as LifecycleStageEntry['status']) ?? 'not_started',
          startedAt: null,
          completedAt: s.completedAt ?? null,
          outputFile: s.outputFile ?? null,
        }),
      );
    } catch {
      // No pipeline for this task — return empty history (not an error).
      history = [];
    }

    return { success: true, data: { task, history } };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * List tasks with optional filters.
 *
 * @remarks
 * Supports filtering by parent, status, priority, type, phase, and label.
 * When `compact` is true, returns lightweight CompactTask records.
 * Results are paginated via `limit` and `offset` parameters.
 *
 * @param projectRoot - Absolute path to the project root
 * @param params - Optional filter, pagination, and format parameters
 * @returns EngineResult with task array, total count, and filtered count
 *
 * @example
 * ```typescript
 * const result = await taskList('/project', { status: 'active', limit: 10 });
 * ```
 *
 * @task T4657
 * @epic T4654
 */
export async function taskList(
  projectRoot: string,
  params?: {
    parent?: string;
    status?: string;
    priority?: string;
    type?: string;
    phase?: string;
    label?: string;
    children?: boolean;
    limit?: number;
    offset?: number;
    compact?: boolean;
  },
): Promise<EngineResult<{ tasks: TaskRecord[] | CompactTask[]; total: number; filtered: number }>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const result = await coreListTasks(
      {
        parentId: params?.parent ?? undefined,
        status: params?.status as import('@cleocode/contracts').TaskStatus | undefined,
        priority: params?.priority as import('@cleocode/contracts').TaskPriority | undefined,
        type: params?.type as import('@cleocode/contracts').TaskType | undefined,
        phase: params?.phase,
        label: params?.label,
        children: params?.children,
        limit: params?.limit,
        offset: params?.offset,
      },
      projectRoot,
      accessor,
    );
    const tasks = params?.compact
      ? result.tasks.map((t) => toCompact(t))
      : tasksToRecords(result.tasks);
    if (params?.compact) {
      return {
        success: true,
        data: { tasks, total: result.total, filtered: result.filtered },
        page: result.page,
      };
    }
    return {
      success: true,
      data: { tasks, total: result.total, filtered: result.filtered },
      page: result.page,
    };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * Fuzzy search tasks by title/description/ID.
 *
 * @remarks
 * Returns minimal task records to keep context consumption low.
 * Supports exact matching, status filtering, and archive inclusion.
 *
 * @param projectRoot - Absolute path to the project root
 * @param query - Search string to match against title, description, or ID
 * @param limit - Maximum number of results (defaults to 20)
 * @param options - Additional search options
 * @returns EngineResult with matching tasks and total count
 *
 * @example
 * ```typescript
 * const result = await taskFind('/project', 'authentication', 10);
 * ```
 *
 * @task T4657
 * @epic T4654
 */
export async function taskFind(
  projectRoot: string,
  query: string,
  limit?: number,
  options?: {
    id?: string;
    exact?: boolean;
    status?: string;
    includeArchive?: boolean;
    offset?: number;
    /** Comma-separated extra fields to include (e.g. "labels,acceptance,notes"). @task T092 */
    fields?: string;
    /** Return all task fields (same as cleo list output). @task T092 */
    verbose?: boolean;
    /** Filter by role axis (T944). */
    role?: string;
  },
): Promise<EngineResult<{ results: (MinimalTaskRecord | TaskRecord)[]; total: number }>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const findResult = await coreFindTasks(
      {
        query,
        id: options?.id,
        exact: options?.exact,
        status: options?.status as import('@cleocode/contracts').TaskStatus | undefined,
        includeArchive: options?.includeArchive,
        limit: limit ?? 20,
        offset: options?.offset,
        // T944: role filter
        role: options?.role as import('@cleocode/contracts').TaskRole | undefined,
      },
      projectRoot,
      accessor,
    );

    // --verbose: return full task records for each result
    if (options?.verbose) {
      const fullResults: TaskRecord[] = [];
      for (const r of findResult.results) {
        const task = await accessor.loadSingleTask(r.id);
        if (task) fullResults.push(taskToRecord(task));
      }
      return { success: true, data: { results: fullResults, total: findResult.total } };
    }

    // --fields: return full task records (loading full data to include requested fields).
    // Since loadSingleTask is required anyway, returning the complete TaskRecord avoids
    // an unsafe Record<string, unknown> cast while giving agents the extra fields they need.
    if (options?.fields) {
      const fullResults: TaskRecord[] = [];
      for (const r of findResult.results) {
        const task = await accessor.loadSingleTask(r.id);
        if (task) fullResults.push(taskToRecord(task));
      }
      return { success: true, data: { results: fullResults, total: findResult.total } };
    }

    // Default: return minimal records with depends/type/size for agent readiness checks
    const results: MinimalTaskRecord[] = findResult.results.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      priority: r.priority,
      parentId: r.parentId,
      depends: r.depends,
      type: r.type,
      size: r.size,
    }));

    return { success: true, data: { results, total: findResult.total } };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * Check if a task exists.
 *
 * @remarks
 * Returns `{ exists: true }` if the task is found, `{ exists: false }` otherwise.
 * Never fails -- catches all errors and returns false.
 *
 * @param projectRoot - Absolute path to the project root
 * @param taskId - Task identifier to check
 * @returns EngineResult with exists flag and the queried taskId
 *
 * @example
 * ```typescript
 * const result = await taskExists('/project', 'T42');
 * if (result.success && result.data.exists) { console.log('exists'); }
 * ```
 *
 *
@task
T4657
 * @epic T4654
 */
export async function taskExists(
  projectRoot: string,
  taskId: string,
): Promise<EngineResult<{ exists: boolean; taskId: string }>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const exists = await accessor.taskExists(taskId);
    return { success: true, data: { exists, taskId } };
  } catch {
    return { success: true, data: { exists: false, taskId } };
  }
}

// ===== Mutate Operations =====

/**
 * Create a new task.
 *
 * @remarks
 * Validates hierarchy depth, sibling limits, parent type, and circular
 * references before creating the task. Supports dry-run mode for preview.
 *
 * @param projectRoot - Absolute path to the project root
 * @param params - Task creation parameters
 * @returns EngineResult with the created task record and duplicate flag
 *
 * @example
 * ```typescript
 * const result = await taskCreate('/project', {
 *   title: 'Implement auth',
 *   description: 'Add JWT-based authentication',
 *   priority: 'high',
 * });
 * ```
 */
export async function taskCreate(
  projectRoot: string,
  params: {
    title: string;
    description?: string;
    parent?: string;
    depends?: string[];
    priority?: string;
    labels?: string[];
    type?: string;
    phase?: string;
    size?: string;
    acceptance?: string[];
    notes?: string;
    files?: string[];
    dryRun?: boolean;
    /** Resolve parent by title substring instead of exact ID. @task T090 */
    parentSearch?: string;
    /** Task role axis — intent of work (T944). Alias: `kind`. */
    role?: string;
    /** Task scope axis — granularity of work (T944). */
    scope?: string;
    /** Bug severity (T944). OWNER-WRITE-ONLY. Only valid with role='bug'. */
    severity?: string;
  },
): Promise<
  EngineResult<{ task: TaskRecord; duplicate: boolean; dryRun?: boolean; warnings?: string[] }>
> {
  try {
    const accessor = await getAccessor(projectRoot);

    // Resolve parent through 3 mechanisms in priority order (T090):
    // 1. Explicit --parent flag
    // 2. --parent-search fuzzy title match
    // 3. Session-scoped epic inheritance (when session scope is epic:T###)
    let resolvedParent = params.parent || null;

    // --parent-search: resolve by title substring
    if (!resolvedParent && params.parentSearch) {
      const searchResult = await coreFindTasks(
        { query: params.parentSearch, limit: 1 },
        projectRoot,
        accessor,
      );
      if (searchResult.results.length > 0) {
        resolvedParent = searchResult.results[0].id;
      } else {
        return cleoErrorToEngineError(
          new Error(`No task found matching --parent-search "${params.parentSearch}"`),
          'E_NOT_FOUND',
          `No task found matching "${params.parentSearch}"`,
        );
      }
    }

    // Session-scoped parent: auto-inherit from epic scope when no parent specified
    if (!resolvedParent && params.type !== 'epic') {
      try {
        const session = await getActiveSession(projectRoot);
        if (session?.scope?.type === 'epic' && session.scope.epicId) {
          resolvedParent = session.scope.epicId;
        }
      } catch {
        // Session lookup failure is non-fatal — proceed without parent
      }
    }

    const result = await coreAddTask(
      {
        title: params.title,
        description: params.description,
        parentId: resolvedParent,
        depends: params.depends,
        priority: (params.priority as import('@cleocode/contracts').TaskPriority) || 'medium',
        labels: params.labels,
        type: (params.type as import('@cleocode/contracts').TaskType) || undefined,
        phase: params.phase,
        size: params.size as import('@cleocode/contracts').TaskSize | undefined,
        acceptance: params.acceptance,
        notes: params.notes,
        files: params.files,
        dryRun: params.dryRun,
        // T944: orthogonal axes
        role: params.role as import('@cleocode/contracts').TaskRole | undefined,
        scope: params.scope as import('@cleocode/contracts').TaskScope | undefined,
        severity: params.severity as import('@cleocode/contracts').TaskSeverity | undefined,
      },
      projectRoot,
      accessor,
    );

    return {
      success: true,
      data: {
        task: taskToRecord(result.task),
        duplicate: result.duplicate ?? false,
        dryRun: params.dryRun,
        ...(result.warnings?.length && { warnings: result.warnings }),
      },
    };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * Update a task's fields.
 *
 * @remarks
 * Supports atomic label and dependency operations via addLabels/removeLabels
 * and addDepends/removeDepends. Returns the updated task and a list of
 * changed fields.
 *
 * @param projectRoot - Absolute path to the project root
 * @param taskId - Task identifier to update
 * @param updates - Fields to update (only provided fields are changed)
 * @returns EngineResult with the updated task record and list of changes
 *
 * @example
 * ```typescript
 * const result = await taskUpdate('/project', 'T42', { status: 'active' });
 * ```
 */
export async function taskUpdate(
  projectRoot: string,
  taskId: string,
  updates: {
    title?: string;
    description?: string;
    status?: string;
    priority?: string;
    notes?: string;
    labels?: string[];
    addLabels?: string[];
    removeLabels?: string[];
    depends?: string[];
    addDepends?: string[];
    removeDepends?: string[];
    acceptance?: string[];
    parent?: string | null;
    type?: string;
    size?: string;
    /** File paths associated with this task (AC.files). T1014 — parity with add. */
    files?: string[];
    /** Pipeline stage transition target (T834 / ADR-051 Decision 4). */
    pipelineStage?: string;
    /** Task role axis — intent of work (T944). */
    role?: string;
    /** Task scope axis — granularity of work (T944). */
    scope?: string;
    /**
     * Operator-supplied justification required to override the
     * acceptance-criteria immutability guard at locked pipeline stages.
     *
     * @task T1590
     */
    reason?: string;
  },
): Promise<EngineResult<{ task: TaskRecord; changes?: string[] }>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const result = await coreUpdateTask(
      {
        taskId,
        title: updates.title,
        description: updates.description,
        status: updates.status as import('@cleocode/contracts').TaskStatus | undefined,
        priority: updates.priority as import('@cleocode/contracts').TaskPriority | undefined,
        notes: updates.notes,
        labels: updates.labels,
        addLabels: updates.addLabels,
        removeLabels: updates.removeLabels,
        depends: updates.depends,
        addDepends: updates.addDepends,
        removeDepends: updates.removeDepends,
        acceptance: updates.acceptance,
        parentId: updates.parent,
        type: updates.type as import('@cleocode/contracts').TaskType | undefined,
        size: updates.size as import('@cleocode/contracts').TaskSize | undefined,
        // T1014: wire --files through to core update (parity with task add).
        files: updates.files,
        // T834 / ADR-051 Decision 4: forward pipelineStage to core update.
        pipelineStage: updates.pipelineStage,
        // T944: orthogonal axes
        role: updates.role as import('@cleocode/contracts').TaskRole | undefined,
        scope: updates.scope as import('@cleocode/contracts').TaskScope | undefined,
        // T1590: forward operator override reason to AC-immutability guard.
        reason: updates.reason,
      },
      projectRoot,
      accessor,
    );

    return { success: true, data: { task: taskToRecord(result.task), changes: result.changes } };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * Complete a task (set status to done).
 *
 * @remarks
 * May trigger auto-completion of parent tasks and unblocking of dependent
 * tasks. Maps core exit codes to engine error codes for structured error reporting.
 *
 * After a successful completion, `modified_by` and `session_id` are written back
 * to the task row via `updateTaskFields` so every completed task carries auditable
 * provenance (T1222 / CLEO-VALID-27). `modified_by` is sourced from the
 * `CLEO_AGENT_ID` environment variable (falls back to `"cleo"`). `session_id` is
 * sourced from the currently-active session returned by `getActiveSession`, falling
 * back to the `CLEO_SESSION_ID` environment variable, and finally `null`.
 *
 * @param projectRoot - Absolute path to the project root
 * @param taskId - Task identifier to complete
 * @param notes - Optional completion notes
 * @returns EngineResult with the completed task, auto-completed parents, and unblocked tasks
 *
 * @example
 * ```typescript
 * const result = await taskComplete('/project', 'T42', 'All tests passing');
 * ```
 *
 * @task T1222
 */
export async function taskComplete(
  projectRoot: string,
  taskId: string,
  notes?: string,
): Promise<
  EngineResult<{
    task: TaskRecord;
    autoCompleted?: string[];
    unblockedTasks?: Array<{ id: string; title: string }>;
  }>
> {
  try {
    const accessor = await getAccessor(projectRoot);
    const result = await coreCompleteTask({ taskId, notes }, projectRoot, accessor);

    // T1222 / CLEO-VALID-27: stamp modified_by + session_id on every successful
    // completion so the audit trail is complete. Best-effort — a failure here must
    // not roll back the completion that already landed in the DB.
    try {
      const agentId = process.env['CLEO_AGENT_ID'] ?? 'cleo';
      let sessionId: string | null =
        typeof process.env['CLEO_SESSION_ID'] === 'string' &&
        process.env['CLEO_SESSION_ID'].length > 0
          ? process.env['CLEO_SESSION_ID']
          : null;

      // Prefer the live session record over the env fallback.
      const activeSession = await getActiveSession(projectRoot);
      if (activeSession?.id) {
        sessionId = activeSession.id;
      }

      await accessor.updateTaskFields(taskId, { modifiedBy: agentId, sessionId });
    } catch {
      // Provenance write failure is non-fatal; the task is already completed.
    }

    return {
      success: true,
      data: {
        task: result.task as TaskRecord,
        ...(result.autoCompleted && { autoCompleted: result.autoCompleted }),
        ...(result.unblockedTasks && { unblockedTasks: result.unblockedTasks }),
      },
    };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_INTERNAL', 'Failed to complete task');
  }
}

/**
 * A single IVTR phase entry returned by taskCompleteStrict and taskShowIvtrHistory.
 * Surface-safe projection of IvtrPhaseEntry with renamed agentIdentity → agent.
 *
 * @task T815
 * @task T817
 * @epic T810
 */
export interface IvtrHistoryEntry {
  /** Phase name (implement | validate | test | released). */
  phase: IvtrPhase;
  /** Agent identity string, or null if unknown. */
  agent: string | null;
  /** ISO timestamp when this phase was started. */
  startedAt: string;
  /** ISO timestamp when this phase was completed, or null if still active. */
  completedAt: string | null;
  /** Whether this phase passed. null = in-progress. */
  passed: boolean | null;
  /** sha256 hashes of evidence attachments for this phase. */
  evidenceRefs: string[];
}

/**
 * Project IvtrPhaseEntry to the surface-safe IvtrHistoryEntry shape.
 */
function toHistoryEntry(e: IvtrPhaseEntry): IvtrHistoryEntry {
  return {
    phase: e.phase,
    agent: e.agentIdentity,
    startedAt: e.startedAt,
    completedAt: e.completedAt,
    passed: e.passed,
    evidenceRefs: e.evidenceRefs,
  };
}

/**
 * Complete a task with strict IVTR + evidence-staleness enforcement.
 *
 * @remarks
 * Enforcement path (T832 / ADR-051 Decision 3+8):
 * 1. **Evidence staleness re-check**: every verification.evidence record is
 *    re-validated.  Hard atoms (commit, files, test-run) must still match
 *    their recorded sha256 / reachability; tampering after verify → reject
 *    with {@link E_EVIDENCE_STALE}.
 * 2. **IVTR enforcement** in strict mode: `ivtr_state.currentPhase` MUST be
 *    `released`; otherwise reject with {@link E_IVTR_INCOMPLETE}.
 * 3. **Parent-epic lifecycle gate**: child task completion is blocked while
 *    the parent epic is still in a planning stage (research/consensus/
 *    architecture_decision/specification/decomposition).  Rejects with
 *    {@link E_LIFECYCLE_GATE_FAILED}.
 *
 * Unlike v2026.4.77 and earlier, `--force` is no longer accepted.  The
 * dispatch layer rejects `force` with `E_FLAG_REMOVED` before we reach
 * here. Emergency bypass lives in `cleo verify` via `CLEO_OWNER_OVERRIDE`.
 *
 * @param projectRoot - Absolute path to the project root
 * @param taskId - Task identifier to complete
 * @param notes - Optional completion notes
 * @returns EngineResult with the completed task, auto-completed parents, and unblocked tasks
 *
 * @task T815
 * @task T832
 * @adr ADR-051
 * @epic T810
 */
export async function taskCompleteStrict(
  projectRoot: string,
  taskId: string,
  notes?: string,
): Promise<
  EngineResult<{
    task: TaskRecord;
    autoCompleted?: string[];
    unblockedTasks?: Array<{ id: string; title: string }>;
  }>
> {
  try {
    // Load config to check lifecycle enforcement mode.
    const config = await loadConfig(projectRoot);
    const lifecycleMode = config.lifecycle?.mode ?? 'strict';

    // 1. Evidence staleness re-check (T832 / ADR-051 Decision 8).
    // When verification.evidence is populated, re-validate each hard atom
    // to catch post-verify tampering. Best-effort import to avoid cycles
    // during dispatch tests — core module is lazily loaded.
    if (lifecycleMode === 'strict') {
      const accessor = await getAccessor(projectRoot);
      const task = await accessor.loadSingleTask(taskId);
      if (task?.verification?.evidence) {
        const { revalidateEvidence } = await import('@cleocode/core/internal');
        const evidenceEntries = Object.entries(task.verification.evidence);
        const staleGates: Array<{ gate: string; failures: string[] }> = [];
        for (const [gate, ev] of evidenceEntries) {
          if (!ev) continue;
          const check = await revalidateEvidence(ev, projectRoot);
          if (!check.stillValid) {
            staleGates.push({
              gate,
              failures: check.failedAtoms.map((f: { reason: string }) => f.reason),
            });
          }
        }
        if (staleGates.length > 0) {
          const message =
            `Task ${taskId} evidence is stale. ` +
            staleGates.map((sg) => `Gate '${sg.gate}': ${sg.failures.join('; ')}`).join(' | ');
          return engineError<{
            task: TaskRecord;
            autoCompleted?: string[];
            unblockedTasks?: Array<{ id: string; title: string }>;
          }>('E_EVIDENCE_STALE', message, {
            details: { taskId, staleGates },
            fix:
              `Re-capture evidence for the stale gates via ` +
              `'cleo verify ${taskId} --gate <gate> --evidence <updated>' ` +
              `then retry 'cleo complete ${taskId}'. See ADR-051.`,
          });
        }
      }
    }

    // 2. IVTR enforcement only applies in strict mode.
    if (lifecycleMode === 'strict') {
      const ivtrState = await getIvtrState(taskId, { cwd: projectRoot });

      if (ivtrState !== null && ivtrState.currentPhase !== 'released') {
        // Identify which phases have not passed at all.
        const requiredPhases: Array<Exclude<IvtrPhase, 'released'>> = [
          'implement',
          'validate',
          'test',
        ];
        const failedPhases: string[] = [];
        for (const phase of requiredPhases) {
          const hasPassed = ivtrState.phaseHistory.some(
            (e) => e.phase === phase && e.passed === true,
          );
          if (!hasPassed) {
            failedPhases.push(`Phase '${phase}' has no passing entry`);
          }
        }

        // Also note if a phase is currently active (in-progress).
        const activeEntry = ivtrState.phaseHistory.findLast((e) => e.completedAt === null);
        if (activeEntry) {
          failedPhases.push(
            `Phase '${activeEntry.phase}' is currently in-progress (not completed)`,
          );
        }

        return engineError<{
          task: TaskRecord;
          autoCompleted?: string[];
          unblockedTasks?: Array<{ id: string; title: string }>;
        }>(
          'E_IVTR_INCOMPLETE',
          `Task ${taskId} IVTR loop is not complete — currentPhase='${ivtrState.currentPhase}', not 'released'`,
          {
            details: {
              taskId,
              currentPhase: ivtrState.currentPhase,
              failedPhases,
            },
            fix: `Advance the IVTR loop to 'released' via 'cleo orchestrate ivtr ${taskId} --next'. Evidence-based bypass: CLEO_OWNER_OVERRIDE=1 on 'cleo verify' (audited, see ADR-051).`,
          },
        );
      }
    }

    // 3. Parent-epic lifecycle gate check on child complete (T788 LOOM-04).
    // When child task has an epic parent whose pipelineStage is still in early
    // planning stages, reject completion. Advisory mode logs but allows.
    if (lifecycleMode === 'strict' || lifecycleMode === 'advisory') {
      const accessor = await getAccessor(projectRoot);
      const task = await accessor.loadSingleTask(taskId);
      if (task?.parentId) {
        const parent = await accessor.loadSingleTask(task.parentId);
        if (parent?.type === 'epic') {
          const earlyStages = new Set([
            'research',
            'consensus',
            'architecture_decision',
            'specification',
            'decomposition',
          ]);
          const epicStage = parent.pipelineStage ?? null;
          if (epicStage && earlyStages.has(epicStage)) {
            const msg =
              `Task ${taskId} cannot complete: parent epic ${task.parentId} is still in ` +
              `'${epicStage}' stage. Advance the epic past decomposition before completing children.`;
            if (lifecycleMode === 'strict') {
              return engineError<{
                task: TaskRecord;
                autoCompleted?: string[];
                unblockedTasks?: Array<{ id: string; title: string }>;
              }>('E_LIFECYCLE_GATE_FAILED', msg, {
                details: {
                  taskId,
                  parentEpicId: task.parentId,
                  epicStage,
                  requiredStages: ['implementation', 'validation', 'testing', 'release'],
                },
                fix:
                  `Advance the parent epic via 'cleo lifecycle complete ${task.parentId} ${epicStage}' ` +
                  `and then the next stages. Lifecycle advancement automatically updates the parent epic's pipelineStage (ADR-051 Decision 5).`,
              });
            }
            // Advisory mode: log warning but continue.
            getLogger('engine:lifecycle').warn(
              {
                taskId,
                parentEpicId: task.parentId,
                epicStage,
                mode: lifecycleMode,
              },
              `[ADVISORY] parent-epic lifecycle gate: ${msg}`,
            );
          }
        }
      }
    }

    // 4. T1222 / CLEO-VALID-26: verify verification_json is not NULL before
    // delegating. Only applies in strict mode — advisory/off modes let core's
    // completeTask surface its own VERIFICATION_INIT_FAILED error. Epics are
    // exempted (auto-completed, no verify step required).
    if (lifecycleMode === 'strict') {
      const accessor = await getAccessor(projectRoot);
      const task = await accessor.loadSingleTask(taskId);
      if (task && task.type !== 'epic' && !task.verification) {
        return engineError<{
          task: TaskRecord;
          autoCompleted?: string[];
          unblockedTasks?: Array<{ id: string; title: string }>;
        }>(
          'E_EVIDENCE_MISSING',
          `Task ${taskId} has no verification record (verification_json IS NULL). ` +
            `Run 'cleo verify' with programmatic evidence before completing. See ADR-051.`,
          {
            details: { taskId, verificationStatus: 'null' },
            fix:
              `Initialize and populate verification gates: ` +
              `'cleo verify ${taskId} --gate implemented --evidence "commit:<sha>;files:<list>"' ` +
              `and other required gates, then retry 'cleo complete ${taskId}'.`,
          },
        );
      }
    }

    // No IVTR state, or lifecycle not strict, or already released — delegate normally.
    return taskComplete(projectRoot, taskId, notes) as Promise<
      EngineResult<{
        task: TaskRecord;
        autoCompleted?: string[];
        unblockedTasks?: Array<{ id: string; title: string }>;
      }>
    >;
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_INTERNAL', 'Failed to complete task (strict mode)');
  }
}

/**
 * Retrieve the IVTR phase history for a task.
 *
 * @remarks
 * Reads `tasks.ivtr_state` JSON and extracts the `phaseHistory` array.
 * Returns an empty `ivtrHistory` array when the task has no IVTR state —
 * this is not an error condition.
 *
 * @param projectRoot - Absolute path to the project root
 * @param taskId - Task identifier (e.g. "T042")
 * @returns EngineResult with ivtrHistory array
 *
 * @example
 * ```typescript
 * const result = await taskShowIvtrHistory('/project', 'T42');
 * if (result.success) console.log(result.data.ivtrHistory);
 * ```
 *
 * @task T817
 * @epic T810
 */
export async function taskShowIvtrHistory(
  projectRoot: string,
  taskId: string,
): Promise<EngineResult<{ ivtrHistory: IvtrHistoryEntry[] }>> {
  try {
    const ivtrState = await getIvtrState(taskId, { cwd: projectRoot });
    if (!ivtrState) {
      return { success: true, data: { ivtrHistory: [] } };
    }
    const ivtrHistory: IvtrHistoryEntry[] = ivtrState.phaseHistory.map(toHistoryEntry);
    return { success: true, data: { ivtrHistory } };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_NOT_INITIALIZED', 'Failed to read IVTR state');
  }
}

/**
 * Delete a task.
 *
 * @remarks
 * When `force` is true, cascade-deletes child tasks. Otherwise, returns
 * E_HAS_CHILDREN if the task has children.
 *
 * @param projectRoot - Absolute path to the project root
 * @param taskId - Task identifier to delete
 * @param force - When true, enables cascade deletion of children
 * @returns EngineResult with the deleted task and optional cascade info
 *
 * @example
 * ```typescript
 * const result = await taskDelete('/project', 'T42', true);
 * ```
 */
export async function taskDelete(
  projectRoot: string,
  taskId: string,
  force?: boolean,
): Promise<EngineResult<{ deletedTask: TaskRecord; deleted: boolean; cascadeDeleted?: string[] }>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const result = await coreDeleteTask(
      {
        taskId,
        force: force ?? false,
        cascade: force ?? false,
      },
      projectRoot,
      accessor,
    );

    return {
      success: true,
      data: {
        deletedTask: taskToRecord(result.deletedTask),
        deleted: true,
        cascadeDeleted: result.cascadeDeleted,
      },
    };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * Archive completed tasks.
 * Moves done/cancelled tasks from active task data to archive.
 *
 * @remarks
 * Archives a specific task by ID, or all tasks completed before a given date.
 * Archived tasks are no longer returned by default queries.
 *
 * @param projectRoot - Absolute path to the project root
 * @param taskId - Optional specific task ID to archive
 * @param before - Optional ISO date string; archives tasks completed before this date
 * @returns EngineResult with count and list of archived task IDs
 *
 * @example
 * ```typescript
 * const result = await taskArchive('/project', undefined, '2026-01-01');
 * ```
 */
export async function taskArchive(
  projectRoot: string,
  taskId?: string,
  before?: string,
  opts?: { taskIds?: string[]; includeCancelled?: boolean; dryRun?: boolean },
): Promise<EngineResult<{ archivedCount: number; archivedTasks: Array<{ id: string }> }>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const taskIds = opts?.taskIds ?? (taskId ? [taskId] : undefined);
    const result = await coreArchiveTasks(
      {
        taskIds,
        before,
        includeCancelled: opts?.includeCancelled,
        dryRun: opts?.dryRun,
      },
      projectRoot,
      accessor,
    );

    return {
      success: true,
      data: {
        archivedCount: result.archived.length,
        archivedTasks: result.archived.map((id: string) => ({ id })),
      },
    };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

// ===== Non-CRUD Operations (delegated to core/tasks/task-ops.ts) =====

/**
 * Suggest next task to work on based on priority, phase alignment, age, and dependency readiness.
 *
 * @remarks
 * Scores all pending tasks and returns ranked suggestions. When `explain`
 * is true, includes per-task scoring reasons in the response.
 *
 * @param projectRoot - Absolute path to the project root
 * @param params - Optional count limit and explain flag
 * @returns EngineResult with scored suggestions and total candidate count
 *
 * @example
 * ```typescript
 * const result = await taskNext('/project', { count: 3, explain: true });
 * ```
 *
 * @task T4657
 * @task T4790
 * @epic T4654
 */
export async function taskNext(
  projectRoot: string,
  params?: {
    count?: number;
    explain?: boolean;
  },
): Promise<
  EngineResult<{
    suggestions: Array<{
      id: string;
      title: string;
      priority: string;
      phase: string | null;
      score: number;
      reasons?: string[];
    }>;
    totalCandidates: number;
  }>
> {
  try {
    const result = await coreTaskNext(projectRoot, params);
    return { success: true, data: result };
  } catch {
    return engineError('E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * Show blocked tasks and analyze blocking chains.
 *
 * @remarks
 * Identifies all blocked tasks, traces their blocking chains, and highlights
 * critical blockers (tasks that block the most other tasks).
 *
 * @param projectRoot - Absolute path to the project root
 * @param params - Optional analysis and limit parameters
 * @returns EngineResult with blocked tasks, critical blockers, and summary
 *
 * @example
 * ```typescript
 * const result = await taskBlockers('/project', { analyze: true });
 * ```
 *
 * @task T4657
 * @task T4790
 * @epic T4654
 */
export async function taskBlockers(
  projectRoot: string,
  params?: { analyze?: boolean; limit?: number },
): Promise<
  EngineResult<{
    blockedTasks: Array<{
      id: string;
      title: string;
      status: string;
      depends?: string[];
      blockingChain: string[];
    }>;
    criticalBlockers: Array<{
      id: string;
      title: string;
      blocksCount: number;
    }>;
    summary: string;
    total: number;
    limit: number;
  }>
> {
  try {
    const result = await coreTaskBlockers(projectRoot, params);
    return { success: true, data: result };
  } catch {
    return engineError('E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * Build hierarchy tree.
 *
 * @remarks
 * Returns a tree structure of tasks rooted at the given task ID, or
 * the full project tree when no task ID is specified.
 *
 * When `withBlockers` is `true` each node is annotated with `blockerChain`
 * and `leafBlockers` so the formatter can render transitive chain information.
 *
 * @param projectRoot  - Absolute path to the project root.
 * @param taskId       - Optional root task ID for subtree.
 * @param withBlockers - When `true`, annotate each node with blocker chain data.
 * @returns EngineResult with the hierarchical tree data.
 *
 * @example
 * ```typescript
 * const result = await taskTree('/project', 'T1');
 * ```
 *
 * @example
 * ```typescript
 * // With blocker chain annotations
 * const result = await taskTree('/project', undefined, true);
 * ```
 *
 * @task T4657
 * @task T4790
 * @task T1206
 * @epic T4654
 */
export async function taskTree(
  projectRoot: string,
  taskId?: string,
  withBlockers?: boolean,
): Promise<EngineResult> {
  try {
    const result = await coreTaskTree(projectRoot, taskId, withBlockers);
    return { success: true, data: result };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_NOT_FOUND', 'Task not found');
  }
}

/**
 * Show dependencies for a task - both what it depends on and what depends on it.
 *
 * @remarks
 * Returns bidirectional dependency information including unresolved deps
 * and a ready flag indicating whether all dependencies are satisfied.
 *
 * @param projectRoot - Absolute path to the project root
 * @param taskId - Task identifier to inspect
 * @returns EngineResult with dependency information in both directions
 *
 * @example
 * ```typescript
 * const result = await taskDeps('/project', 'T42');
 * ```
 *
 * @task T4657
 * @task T4790
 * @epic T4654
 */
export async function taskDeps(
  projectRoot: string,
  taskId: string,
): Promise<
  EngineResult<{
    taskId: string;
    dependsOn: Array<{ id: string; title: string; status: string }>;
    dependedOnBy: Array<{ id: string; title: string; status: string }>;
    unresolvedDeps: string[];
    allDepsReady: boolean;
  }>
> {
  try {
    const result = await coreTaskDeps(projectRoot, taskId);
    return { success: true, data: result };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * Show task relations (existing relates entries).
 *
 * @remarks
 * Lists all `relates` entries for a given task, including the relationship
 * type and optional reason.
 *
 * @param projectRoot - Absolute path to the project root
 * @param taskId - Task identifier to inspect
 * @returns EngineResult with relations array and count
 *
 * @example
 * ```typescript
 * const result = await taskRelates('/project', 'T42');
 * ```
 *
 * @task T4657
 * @task T4790
 * @epic T4654
 */
export async function taskRelates(
  projectRoot: string,
  taskId: string,
): Promise<
  EngineResult<{
    taskId: string;
    relations: Array<{
      taskId: string;
      type: string;
      reason?: string;
    }>;
    count: number;
  }>
> {
  try {
    const result = await coreTaskRelates(projectRoot, taskId);
    return { success: true, data: result };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_GENERAL', 'Failed to read task relations');
  }
}

/**
 * Add a relation between two tasks.
 *
 * @remarks
 * Valid relation types: related, blocks, duplicates, absorbs, fixes, extends, supersedes.
 *
 * @param projectRoot - Absolute path to the project root
 * @param taskId - Source task identifier
 * @param relatedId - Target task identifier
 * @param type - Relation type (e.g. "blocks", "related")
 * @param reason - Optional explanation for the relation
 * @returns EngineResult confirming the relation was added
 *
 * @example
 * ```typescript
 * const result = await taskRelatesAdd('/project', 'T42', 'T43', 'blocks', 'Needs auth first');
 * ```
 *
 * @task T4790
 */
export async function taskRelatesAdd(
  projectRoot: string,
  taskId: string,
  relatedId: string,
  type: string,
  reason?: string,
): Promise<EngineResult<{ from: string; to: string; type: string; added: boolean }>> {
  try {
    const result = await coreTaskRelatesAdd(projectRoot, taskId, relatedId, type, reason);
    return { success: true, data: result };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_GENERAL', 'Failed to update task relations');
  }
}

/**
 * Analyze a task for description quality, missing fields, and dependency health.
 *
 * @remarks
 * When no task ID is provided, analyzes all tasks to identify bottlenecks,
 * leverage opportunities, and overall project health metrics.
 *
 * @param projectRoot - Absolute path to the project root
 * @param taskId - Optional specific task to analyze
 * @param params - Optional analysis parameters
 * @returns EngineResult with recommended task, bottlenecks, tiers, and metrics
 *
 * @example
 * ```typescript
 * const result = await taskAnalyze('/project');
 * ```
 *
 * @task T4657
 * @task T4790
 * @epic T4654
 */
export async function taskAnalyze(
  projectRoot: string,
  taskId?: string,
  params?: { tierLimit?: number },
): Promise<
  EngineResult<{
    recommended: { id: string; title: string; leverage: number; reason: string } | null;
    bottlenecks: Array<{ id: string; title: string; blocksCount: number }>;
    tiers: {
      critical: Array<{ id: string; title: string; leverage: number }>;
      high: Array<{ id: string; title: string; leverage: number }>;
      normal: Array<{ id: string; title: string; leverage: number }>;
    };
    metrics: {
      totalTasks: number;
      actionable: number;
      blocked: number;
      avgLeverage: number;
    };
    tierLimit: number;
  }>
> {
  try {
    const result = await coreTaskAnalyze(projectRoot, taskId, params);
    return { success: true, data: result };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_GENERAL', 'Task analysis failed');
  }
}

/**
 * Predict downstream impact of a free-text change description.
 *
 * Delegates to {@link predictImpact} from the intelligence module.
 * Uses keyword matching against task titles/descriptions, then traces
 * the reverse dependency graph for transitive effects.
 *
 * @remarks
 * The impact report includes directly affected tasks, transitively
 * affected tasks (through the dependency graph), and a severity assessment.
 *
 * @param projectRoot - Project root directory
 * @param change - Free-text description of the proposed change
 * @param matchLimit - Maximum seed tasks to match (default: 5)
 * @returns Impact prediction report
 *
 * @example
 * ```typescript
 * const result = await taskImpact('/project', 'Refactor authentication module');
 * ```
 *
 * @task T043
 */
export async function taskImpact(
  projectRoot: string,
  change: string,
  matchLimit?: number,
): Promise<EngineResult<ImpactReport>> {
  try {
    const result = await predictImpact(change, projectRoot, undefined, matchLimit);
    return { success: true, data: result };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_GENERAL', 'Impact prediction failed');
  }
}

/**
 * Restore a cancelled task back to pending.
 *
 * @remarks
 * When cascade is true, also restores cancelled children.
 *
 * @param projectRoot - Absolute path to the project root
 * @param taskId - Task identifier to restore
 * @param params - Optional cascade and notes options
 * @returns EngineResult with restored task IDs and count
 *
 * @example
 * ```typescript
 * const result = await taskRestore('/project', 'T42', { cascade: true });
 * ```
 *
 * @task T4790
 */
export async function taskRestore(
  projectRoot: string,
  taskId: string,
  params?: { cascade?: boolean; notes?: string },
): Promise<EngineResult<{ task: string; restored: string[]; count: number }>> {
  try {
    const result = await coreTaskRestore(projectRoot, taskId, params);
    return { success: true, data: result };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_NOT_INITIALIZED', 'Failed to restore task');
  }
}

/**
 * Move an archived task back to active task data with status 'done' (or specified status).
 *
 * @remarks
 * By default restores with status 'done'. Use `preserveStatus` to keep
 * the original status, or `status` to set a specific status.
 *
 * @param projectRoot - Absolute path to the project root
 * @param taskId - Archived task identifier to restore
 * @param params - Optional status override parameters
 * @returns EngineResult with the unarchived task info
 *
 * @example
 * ```typescript
 * const result = await taskUnarchive('/project', 'T42', { status: 'pending' });
 * ```
 *
 * @task T4790
 */
export async function taskUnarchive(
  projectRoot: string,
  taskId: string,
  params?: { status?: string; preserveStatus?: boolean },
): Promise<EngineResult<{ task: string; unarchived: boolean; title: string; status: string }>> {
  try {
    const result = await coreTaskUnarchive(projectRoot, taskId, params);
    return { success: true, data: result };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_NOT_INITIALIZED', 'Failed to unarchive task');
  }
}

/**
 * Change task position within its sibling group.
 *
 * @remarks
 * Reorders a task to the specified zero-based position among its siblings.
 *
 * @param projectRoot - Absolute path to the project root
 * @param taskId - Task identifier to reorder
 * @param position - Target zero-based position
 * @returns EngineResult with new position and total siblings
 *
 * @example
 * ```typescript
 * const result = await taskReorder('/project', 'T42', 0); // move to first
 * ```
 *
 * @task T4790
 */
export async function taskReorder(
  projectRoot: string,
  taskId: string,
  position: number,
): Promise<
  EngineResult<{ task: string; reordered: boolean; newPosition: number; totalSiblings: number }>
> {
  try {
    const result = await coreTaskReorder(projectRoot, taskId, position);
    return { success: true, data: result };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_NOT_INITIALIZED', 'Failed to reorder task');
  }
}

/**
 * Move task under a different parent.
 *
 * @remarks
 * Pass null as `newParentId` to promote the task to a root-level task.
 * Validates hierarchy depth and circular reference constraints.
 *
 * @param projectRoot - Absolute path to the project root
 * @param taskId - Task identifier to move
 * @param newParentId - New parent task ID, or null for root
 * @returns EngineResult with old and new parent information
 *
 * @example
 * ```typescript
 * const result = await taskReparent('/project', 'T42', 'T1');
 * ```
 *
 * @task T4790
 */
export async function taskReparent(
  projectRoot: string,
  taskId: string,
  newParentId: string | null,
): Promise<
  EngineResult<{
    task: string;
    reparented: boolean;
    oldParent: string | null;
    newParent: string | null;
    newType?: string;
  }>
> {
  try {
    const result = await coreTaskReparent(projectRoot, taskId, newParentId);
    return { success: true, data: result };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_NOT_INITIALIZED', 'Failed to reparent task');
  }
}

/**
 * Promote a subtask to task or task to root (remove parent).
 *
 * @remarks
 * Removes the parent reference and may change the task type from subtask to task.
 *
 * @param projectRoot - Absolute path to the project root
 * @param taskId - Task identifier to promote
 * @returns EngineResult with promotion details
 *
 * @example
 * ```typescript
 * const result = await taskPromote('/project', 'T42');
 * ```
 *
 * @task T4790
 */
export async function taskPromote(
  projectRoot: string,
  taskId: string,
): Promise<
  EngineResult<{
    task: string;
    promoted: boolean;
    previousParent: string | null;
    typeChanged: boolean;
  }>
> {
  try {
    const result = await coreTaskPromote(projectRoot, taskId);
    return { success: true, data: result };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_NOT_INITIALIZED', 'Failed to promote task');
  }
}

/**
 * Reopen a completed task (set status back to pending).
 *
 * @remarks
 * Only works on tasks with status 'done'. Optionally sets a different
 * target status and records a reason for reopening.
 *
 * @param projectRoot - Absolute path to the project root
 * @param taskId - Task identifier to reopen
 * @param params - Optional target status and reason
 * @returns EngineResult with reopen details including previous and new status
 *
 * @example
 * ```typescript
 * const result = await taskReopen('/project', 'T42', { reason: 'Tests regressed' });
 * ```
 *
 * @task T4790
 */
export async function taskReopen(
  projectRoot: string,
  taskId: string,
  params?: { status?: string; reason?: string },
): Promise<
  EngineResult<{ task: string; reopened: boolean; previousStatus: string; newStatus: string }>
> {
  try {
    const result = await coreTaskReopen(projectRoot, taskId, params);
    return { success: true, data: result };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_NOT_INITIALIZED', 'Failed to reopen task');
  }
}

/**
 * Cancel a task (soft terminal state -- reversible via restore).
 *
 * @remarks
 * Sets the task status to cancelled with an optional reason. The task can
 * be restored later via {@link taskRestore}.
 *
 * @param projectRoot - Absolute path to the project root
 * @param taskId - Task identifier to cancel
 * @param reason - Optional cancellation reason
 * @returns EngineResult with cancellation details
 *
 * @example
 * ```typescript
 * const result = await taskCancel('/project', 'T42', 'No longer needed');
 * ```
 *
 * @task T4529
 */
export async function taskCancel(
  projectRoot: string,
  taskId: string,
  reason?: string,
): Promise<
  EngineResult<{ task: string; cancelled: boolean; reason?: string; cancelledAt: string }>
> {
  try {
    const result = await coreTaskCancel(projectRoot, taskId, { reason });
    return { success: true, data: result };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_NOT_FOUND', 'Failed to cancel task');
  }
}

/**
 * Deterministic complexity scoring from task metadata.
 *
 * @remarks
 * Produces a size estimate (small/medium/large) based on dependency depth,
 * subtask count, file count, and other structural factors.
 *
 * @param projectRoot - Absolute path to the project root
 * @param params - Parameters including the task ID to estimate
 * @returns EngineResult with size, score, factors, and structural metrics
 *
 * @example
 * ```typescript
 * const result = await taskComplexityEstimate('/project', { taskId: 'T42' });
 * ```
 *
 * @task T4657
 * @task T4790
 * @epic T4654
 */
export async function taskComplexityEstimate(
  projectRoot: string,
  params: { taskId: string },
): Promise<
  EngineResult<{
    size: 'small' | 'medium' | 'large';
    score: number;
    factors: ComplexityFactor[];
    dependencyDepth: number;
    subtaskCount: number;
    fileCount: number;
  }>
> {
  try {
    const result = await coreTaskComplexityEstimate(projectRoot, params);
    return { success: true, data: result };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * List dependencies for a task in a given direction.
 * @task T4657
 * @task T4790
 * @epic T4654
 */
export async function taskDepends(
  projectRoot: string,
  taskId: string,
  direction: 'upstream' | 'downstream' | 'both' = 'both',
  tree?: boolean,
): Promise<EngineResult> {
  try {
    const result = await coreTaskDepends(
      projectRoot,
      taskId,
      direction,
      tree ? { tree } : undefined,
    );
    return { success: true, data: result };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * Overview of all dependencies across the project.
 * @task T5157
 */
export async function taskDepsOverview(projectRoot: string): Promise<
  EngineResult<{
    totalTasks: number;
    tasksWithDeps: number;
    blockedTasks: Array<{ id: string; title: string; status: string; unblockedBy: string[] }>;
    readyTasks: Array<{ id: string; title: string; status: string }>;
    validation: { valid: boolean; errorCount: number; warningCount: number };
  }>
> {
  try {
    const result = await coreTaskDepsOverview(projectRoot);
    return { success: true, data: result };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_NOT_INITIALIZED', 'Failed to load deps overview');
  }
}

/**
 * Detect circular dependencies across the project.
 * @task T5157
 */
export async function taskDepsCycles(projectRoot: string): Promise<
  EngineResult<{
    hasCycles: boolean;
    cycles: Array<{ path: string[]; tasks: Array<{ id: string; title: string }> }>;
  }>
> {
  try {
    const result = await coreTaskDepsCycles(projectRoot);
    return { success: true, data: result };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_NOT_INITIALIZED', 'Failed to detect cycles');
  }
}

/**
 * Compute task statistics, optionally scoped to an epic.
 * @task T4657
 * @task T4790
 * @epic T4654
 */
export async function taskStats(
  projectRoot: string,
  epicId?: string,
): Promise<
  EngineResult<{
    total: number;
    pending: number;
    active: number;
    blocked: number;
    done: number;
    cancelled: number;
    byPriority: Record<string, number>;
    byType: Record<string, number>;
  }>
> {
  try {
    const result = await coreTaskStats(projectRoot, epicId);
    return { success: true, data: result };
  } catch {
    return engineError('E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * Export tasks as JSON or CSV.
 * @task T4657
 * @task T4790
 * @epic T4654
 */
export async function taskExport(
  projectRoot: string,
  params?: {
    format?: 'json' | 'csv';
    status?: string;
    parent?: string;
  },
): Promise<EngineResult<unknown>> {
  try {
    const result = await coreTaskExport(projectRoot, params);
    return { success: true, data: result };
  } catch {
    return engineError('E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * Get task history from the log file.
 * @task T4657
 * @task T4790
 * @epic T4654
 */
export async function taskHistory(
  projectRoot: string,
  taskId: string,
  limit?: number,
): Promise<EngineResult<Array<Record<string, unknown>>>> {
  try {
    const result = await coreTaskHistory(projectRoot, taskId, limit);
    return { success: true, data: result };
  } catch {
    return engineError('E_NOT_INITIALIZED', 'Failed to read task history');
  }
}

/**
 * Lint tasks for common issues.
 * @task T4657
 * @task T4790
 * @epic T4654
 */
export async function taskLint(
  projectRoot: string,
  taskId?: string,
): Promise<
  EngineResult<
    Array<{
      taskId: string;
      severity: 'error' | 'warning';
      rule: string;
      message: string;
    }>
  >
> {
  try {
    const result = await coreTaskLint(projectRoot, taskId);
    return { success: true, data: result };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * Validate multiple tasks at once.
 * @task T4657
 * @task T4790
 * @epic T4654
 */
export async function taskBatchValidate(
  projectRoot: string,
  taskIds: string[],
  checkMode: 'full' | 'quick' = 'full',
): Promise<
  EngineResult<{
    results: Record<
      string,
      Array<{
        severity: 'error' | 'warning';
        rule: string;
        message: string;
      }>
    >;
    summary: {
      totalTasks: number;
      validTasks: number;
      invalidTasks: number;
      totalIssues: number;
      errors: number;
      warnings: number;
    };
  }>
> {
  try {
    const result = await coreTaskBatchValidate(projectRoot, taskIds, checkMode);
    return { success: true, data: result };
  } catch {
    return engineError('E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * Import tasks from a JSON source string or export package.
 * @task T4790
 */
export async function taskImport(
  projectRoot: string,
  source: string,
  overwrite?: boolean,
): Promise<
  EngineResult<{
    imported: number;
    skipped: number;
    errors: string[];
    remapTable?: Record<string, string>;
  }>
> {
  try {
    const result = await coreTaskImport(projectRoot, source, overwrite);
    return { success: true, data: result };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_NOT_INITIALIZED', 'Failed to import tasks');
  }
}

/**
 * Compute a ranked plan: in-progress epics, ready tasks, blockers, bugs.
 * @task T4815
 */

export async function taskPlan(projectRoot: string): Promise<EngineResult> {
  const { coreTaskPlan } = await import('@cleocode/core/internal');
  try {
    const result = await coreTaskPlan(projectRoot);
    return { success: true, data: result };
  } catch {
    return engineError('E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * Find related tasks using semantic search or keyword matching.
 * @task T5672
 */
export async function taskRelatesFind(
  projectRoot: string,
  taskId: string,
  params?: {
    mode?: 'suggest' | 'discover';
    threshold?: number;
  },
): Promise<EngineResult<Record<string, unknown>>> {
  try {
    const { suggestRelated, discoverRelated } = await import('@cleocode/core/internal');
    const accessor = await getAccessor(projectRoot);
    const mode = params?.mode ?? 'suggest';

    let result: Record<string, unknown>;
    if (mode === 'discover') {
      result = await discoverRelated(taskId, undefined, accessor);
    } else {
      const threshold = params?.threshold ?? 50;
      result = await suggestRelated(taskId, { threshold }, accessor);
    }

    return { success: true, data: result };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_INTERNAL', 'Task plan failed');
  }
}

/**
 * List all labels used in tasks.
 * @task T5672
 */
export async function taskLabelList(
  projectRoot: string,
): Promise<EngineResult<{ labels: unknown[]; count: number }>> {
  try {
    const { listLabels } = await import('@cleocode/core/internal');
    const accessor = await getAccessor(projectRoot);
    const labels = await listLabels(projectRoot, accessor);
    return { success: true, data: { labels, count: labels.length } };
  } catch {
    return engineError('E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * Show tasks associated with a label.
 * @task T5672
 */
export async function taskLabelShow(
  projectRoot: string,
  label: string,
): Promise<EngineResult<Record<string, unknown>>> {
  try {
    const { showLabelTasks } = await import('@cleocode/core/internal');
    const accessor = await getAccessor(projectRoot);
    const result = await showLabelTasks(label, projectRoot, accessor);
    return { success: true, data: result };
  } catch (err: unknown) {
    return cleoErrorToEngineError(err, 'E_INTERNAL', 'Failed to list labels');
  }
}

// ---------------------------------------------------------------------------
// Sync sub-domain (provider-agnostic task reconciliation)
// ---------------------------------------------------------------------------

/**
 * Reconcile external tasks with CLEO as SSoT.
 */
export async function taskSyncReconcile(
  projectRoot: string,
  params: {
    providerId: string;
    externalTasks: Array<import('@cleocode/contracts').ExternalTask>;
    dryRun?: boolean;
    conflictPolicy?: string;
    defaultPhase?: string;
    defaultLabels?: string[];
  },
): Promise<EngineResult<import('@cleocode/contracts').ReconcileResult>> {
  try {
    const { reconcile } = await import('@cleocode/core/internal');
    const accessor = await getAccessor(projectRoot);
    const result = await reconcile(
      params.externalTasks,
      {
        providerId: params.providerId,
        cwd: projectRoot,
        dryRun: params.dryRun,
        conflictPolicy: params.conflictPolicy as
          | import('@cleocode/contracts').ConflictPolicy
          | undefined,
        defaultPhase: params.defaultPhase,
        defaultLabels: params.defaultLabels,
      },
      accessor,
    );
    return { success: true, data: result };
  } catch (err) {
    return cleoErrorToEngineError(err, 'E_INTERNAL', 'Sync reconcile failed');
  }
}

/**
 * List external task links by provider or task ID.
 */
export async function taskSyncLinks(
  projectRoot: string,
  params?: { providerId?: string; taskId?: string },
): Promise<
  EngineResult<{ links: import('@cleocode/contracts').ExternalTaskLink[]; count: number }>
> {
  try {
    const { getLinksByProvider, getLinksByTaskId } = await import('@cleocode/core/internal');

    if (params?.taskId) {
      const links = await getLinksByTaskId(params.taskId, projectRoot);
      return { success: true, data: { links, count: links.length } };
    }

    if (params?.providerId) {
      const links = await getLinksByProvider(params.providerId, projectRoot);
      return { success: true, data: { links, count: links.length } };
    }

    return engineError('E_INVALID_INPUT', 'Either providerId or taskId is required');
  } catch (err) {
    return cleoErrorToEngineError(err, 'E_INTERNAL', 'Failed to list links');
  }
}

/**
 * Remove all external task links for a provider.
 */
export async function taskSyncLinksRemove(
  projectRoot: string,
  providerId: string,
): Promise<EngineResult<{ providerId: string; removed: number }>> {
  try {
    const { removeLinksByProvider } = await import('@cleocode/core/internal');
    const removed = await removeLinksByProvider(providerId, projectRoot);
    return { success: true, data: { providerId, removed } };
  } catch (err) {
    return cleoErrorToEngineError(err, 'E_INTERNAL', 'Failed to remove links');
  }
}

/**
 * Atomically claim a task for an agent.
 *
 * Fails if the task is already claimed by a different agent.
 * No-op if the task is already claimed by the same agent (idempotent).
 */
export async function taskClaim(
  projectRoot: string,
  taskId: string,
  agentId: string,
): Promise<EngineResult<{ taskId: string; agentId: string }>> {
  try {
    if (!taskId) return engineError('E_INVALID_INPUT', 'taskId is required');
    if (!agentId) return engineError('E_INVALID_INPUT', 'agentId is required');
    const acc = await getAccessor(projectRoot);
    await acc.claimTask(taskId, agentId);
    return { success: true, data: { taskId, agentId } };
  } catch (err) {
    return cleoErrorToEngineError(err, 'E_INTERNAL', 'Failed to claim task');
  }
}

/**
 * Release an agent's claim on a task, setting assignee to null.
 *
 * No-op if the task is not currently claimed.
 */
export async function taskUnclaim(
  projectRoot: string,
  taskId: string,
): Promise<EngineResult<{ taskId: string }>> {
  try {
    if (!taskId) return engineError('E_INVALID_INPUT', 'taskId is required');
    const acc = await getAccessor(projectRoot);
    await acc.unclaimTask(taskId);
    return { success: true, data: { taskId } };
  } catch (err) {
    return cleoErrorToEngineError(err, 'E_INTERNAL', 'Failed to unclaim task');
  }
}
