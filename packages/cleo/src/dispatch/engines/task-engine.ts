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

import type { Task } from '@cleocode/contracts';
// validation-rules.js still used by other engines; core modules handle their own validation
// Core module imports for accessor-based operations
import {
  type CompactTask,
  // Non-CRUD core operations
  type ComplexityFactor,
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
  toCompact,
} from '@cleocode/core/internal';
import { type EngineResult, engineError } from './_error.js';

const TASK_COMPLETE_EXIT_TO_ENGINE_CODE: Record<number, string> = {
  4: 'E_NOT_FOUND',
  5: 'E_DEPENDENCY_ERROR',
  6: 'E_VALIDATION_FAILED',
  16: 'E_HAS_CHILDREN',
  17: 'E_TASK_COMPLETED',
  40: 'E_VERIFICATION_INIT_FAILED',
  44: 'E_MAX_ROUNDS_EXCEEDED',
  45: 'E_GATE_DEPENDENCY',
  80: 'E_LIFECYCLE_GATE_FAILED',
};

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
    relates: task.relates,
    files: task.files,
    acceptance: task.acceptance,
    notes: task.notes,
    labels: task.labels,
    size: task.size ?? null,
    epicLifecycle: task.epicLifecycle ?? null,
    noAutoComplete: task.noAutoComplete ?? null,
    verification: task.verification ? { ...task.verification } : null,
    origin: task.origin ?? null,
    cancellationReason: task.cancellationReason,
    blockedBy: task.blockedBy ? [task.blockedBy] : undefined,
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

/**
 * Task object as stored in task data.
 */
export interface TaskRecord {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  type?: string;
  phase?: string;
  createdAt: string;
  updatedAt: string | null;
  completedAt?: string | null;
  cancelledAt?: string | null;
  parentId?: string | null;
  position?: number | null;
  positionVersion?: number;
  depends?: string[];
  relates?: Array<{
    taskId: string;
    type: string;
    reason?: string;
  }>;
  files?: string[];
  acceptance?: string[];
  notes?: string[];
  labels?: string[];
  size?: string | null;
  epicLifecycle?: string | null;
  noAutoComplete?: boolean | null;
  verification?: import('@cleocode/contracts').TaskVerification | null;
  origin?: string | null;
  createdBy?: string | null;
  validatedBy?: string | null;
  testedBy?: string | null;
  lifecycleState?: string | null;
  validationHistory?: Array<Record<string, unknown>>;
  blockedBy?: string[];
  cancellationReason?: string;
}

// Local TaskFile interface removed — DataAccessor uses the canonical TaskFile from types/task.ts.

/**
 * Minimal task representation for find results
 */
export interface MinimalTaskRecord {
  id: string;
  title: string;
  status: string;
  priority: string;
  parentId?: string | null;
}

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
 * Get a single task by ID
 * @task T4657
 * @epic T4654
 */
export async function taskShow(
  projectRoot: string,
  taskId: string,
): Promise<EngineResult<{ task: TaskRecord }>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const detail = await coreShowTask(taskId, projectRoot, accessor);
    return { success: true, data: { task: taskToRecord(detail) } };
  } catch (err: unknown) {
    const code = (err as { code?: number })?.code;
    if (code === 4 /* NOT_FOUND */) {
      return engineError('E_NOT_FOUND', (err as Error).message || `Task '${taskId}' not found`);
    }
    if (code === 2 /* INVALID_INPUT */) {
      return engineError('E_INVALID_INPUT', (err as Error).message || 'Invalid input');
    }
    return engineError(
      'E_NOT_INITIALIZED',
      (err as Error).message || 'Task database not initialized',
    );
  }
}

/**
 * List tasks with optional filters
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
  } catch {
    return engineError('E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * Fuzzy search tasks by title/description/ID
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
  },
): Promise<EngineResult<{ results: MinimalTaskRecord[]; total: number }>> {
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
      },
      projectRoot,
      accessor,
    );

    const results: MinimalTaskRecord[] = findResult.results.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      priority: r.priority,
      parentId: r.parentId,
    }));

    return { success: true, data: { results, total: results.length } };
  } catch {
    return engineError('E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * Check if a task exists
 * @task T4657
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
 * Create a new task
 */
export async function taskCreate(
  projectRoot: string,
  params: {
    title: string;
    description: string;
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
  },
): Promise<EngineResult<{ task: TaskRecord; duplicate: boolean }>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const result = await coreAddTask(
      {
        title: params.title,
        description: params.description,
        parentId: params.parent || null,
        depends: params.depends,
        priority: (params.priority as import('@cleocode/contracts').TaskPriority) || 'medium',
        labels: params.labels,
        type: (params.type as import('@cleocode/contracts').TaskType) || undefined,
        phase: params.phase,
        size: params.size as import('@cleocode/contracts').TaskSize | undefined,
        acceptance: params.acceptance,
        notes: params.notes,
        files: params.files,
      },
      projectRoot,
      accessor,
    );

    return {
      success: true,
      data: { task: taskToRecord(result.task), duplicate: result.duplicate ?? false },
    };
  } catch (err: unknown) {
    const cleoErr = err as { code?: number; message?: string };
    // Map CleoError exit codes to engine error codes (see src/types/exit-codes.ts)
    if (cleoErr.code === 10 /* PARENT_NOT_FOUND */) {
      return engineError('E_PARENT_NOT_FOUND', cleoErr.message ?? 'Parent task not found');
    }
    if (cleoErr.code === 11 /* DEPTH_EXCEEDED */) {
      return engineError('E_DEPTH_EXCEEDED', cleoErr.message ?? 'Max hierarchy depth exceeded');
    }
    if (cleoErr.code === 12 /* SIBLING_LIMIT */) {
      return engineError('E_SIBLING_LIMIT', cleoErr.message ?? 'Max siblings exceeded');
    }
    if (cleoErr.code === 13 /* INVALID_PARENT_TYPE */) {
      return engineError('E_INVALID_PARENT', cleoErr.message ?? 'Invalid parent type');
    }
    if (cleoErr.code === 14 /* CIRCULAR_REFERENCE */) {
      return engineError('E_CIRCULAR_REFERENCE', cleoErr.message ?? 'Circular reference detected');
    }
    if (cleoErr.code === 6 /* VALIDATION_ERROR */ || cleoErr.code === 2 /* INVALID_INPUT */) {
      return engineError('E_VALIDATION_FAILED', cleoErr.message ?? 'Validation failed');
    }
    if (cleoErr.code === 4 /* NOT_FOUND */) {
      return engineError('E_NOT_FOUND', cleoErr.message ?? 'Task not found');
    }
    return engineError('E_NOT_INITIALIZED', cleoErr.message ?? 'Task database not initialized');
  }
}

/**
 * Update a task
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
      },
      projectRoot,
      accessor,
    );

    return { success: true, data: { task: taskToRecord(result.task), changes: result.changes } };
  } catch (err: unknown) {
    const cleoErr = err as { code?: number; message?: string };
    if (cleoErr.code === 4 /* NOT_FOUND */) {
      return engineError('E_NOT_FOUND', cleoErr.message ?? `Task '${taskId}' not found`);
    }
    if (cleoErr.code === 6 /* VALIDATION_ERROR */ || cleoErr.code === 2 /* INVALID_INPUT */) {
      return engineError('E_VALIDATION_FAILED', cleoErr.message ?? 'Validation failed');
    }
    if (cleoErr.code === 102 /* NO_CHANGE */) {
      return engineError('E_NO_CHANGE', cleoErr.message ?? 'No changes specified');
    }
    return engineError('E_NOT_INITIALIZED', cleoErr.message ?? 'Task database not initialized');
  }
}

/**
 * Complete a task (set status to done)
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
    return {
      success: true,
      data: {
        task: result.task as TaskRecord,
        ...(result.autoCompleted && { autoCompleted: result.autoCompleted }),
        ...(result.unblockedTasks && { unblockedTasks: result.unblockedTasks }),
      },
    };
  } catch (err: unknown) {
    const cleoErr = err as { code?: number; message?: string };
    const message = cleoErr.message ?? 'Failed to complete task';
    if (typeof cleoErr.code === 'number') {
      const mappedCode = TASK_COMPLETE_EXIT_TO_ENGINE_CODE[cleoErr.code];
      if (mappedCode) {
        return engineError(mappedCode, message);
      }
    }
    return engineError('E_INTERNAL', message);
  }
}

/**
 * Delete a task
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
    const cleoErr = err as { code?: number; message?: string };
    if (cleoErr.code === 4 /* NOT_FOUND */) {
      return engineError('E_NOT_FOUND', cleoErr.message ?? `Task '${taskId}' not found`);
    }
    if (cleoErr.code === 16 /* HAS_CHILDREN */) {
      return engineError('E_HAS_CHILDREN', cleoErr.message ?? `Task '${taskId}' has children`);
    }
    return engineError('E_NOT_INITIALIZED', cleoErr.message ?? 'Task database not initialized');
  }
}

/**
 * Archive completed tasks.
 * Moves done/cancelled tasks from active task data to archive.
 */
export async function taskArchive(
  projectRoot: string,
  taskId?: string,
  before?: string,
): Promise<EngineResult<{ archivedCount: number; archivedTasks: Array<{ id: string }> }>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const result = await coreArchiveTasks(
      {
        taskIds: taskId ? [taskId] : undefined,
        before,
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
    const cleoErr = err as { code?: number; message?: string };
    if (cleoErr.code === 4 /* NOT_FOUND */) {
      return engineError('E_NOT_FOUND', cleoErr.message ?? 'Task not found');
    }
    return engineError('E_NOT_INITIALIZED', cleoErr.message ?? 'Task database not initialized');
  }
}

// ===== Non-CRUD Operations (delegated to core/tasks/task-ops.ts) =====

/**
 * Suggest next task to work on based on priority, phase alignment, age, and dependency readiness.
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
 * @task T4657
 * @task T4790
 * @epic T4654
 */
export async function taskTree(projectRoot: string, taskId?: string): Promise<EngineResult> {
  try {
    const result = await coreTaskTree(projectRoot, taskId);
    return { success: true, data: result };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('not found')) {
      return engineError('E_NOT_FOUND', message);
    }
    return engineError('E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * Show dependencies for a task - both what it depends on and what depends on it.
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
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('not found')) {
      return engineError('E_NOT_FOUND', message);
    }
    return engineError('E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * Show task relations (existing relates entries).
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
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('not found')) {
      return engineError('E_NOT_FOUND', message);
    }
    return engineError('E_GENERAL', `Failed to read task relations: ${message}`);
  }
}

/**
 * Add a relation between two tasks.
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
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('not found')) {
      return engineError('E_NOT_FOUND', message);
    }
    if (message.includes('Invalid relation type')) {
      return engineError('E_VALIDATION', message, {
        fix: 'Use a valid relation type: related, blocks, duplicates, absorbs, fixes, extends, supersedes',
      });
    }
    return engineError('E_GENERAL', `Failed to update task relations: ${message}`);
  }
}

/**
 * Analyze a task for description quality, missing fields, and dependency health.
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
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('not found')) {
      return engineError('E_NOT_FOUND', message);
    }
    return engineError('E_GENERAL', `Task analysis failed: ${message}`);
  }
}

/**
 * Restore a cancelled task back to pending.
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
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('not found')) {
      return engineError('E_NOT_FOUND', message);
    }
    if (message.includes('not cancelled')) {
      return engineError('E_INVALID_INPUT', message);
    }
    return engineError('E_NOT_INITIALIZED', 'Failed to restore task');
  }
}

/**
 * Move an archived task back to active task data with status 'done' (or specified status).
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
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('not found')) {
      return engineError('E_NOT_FOUND', message);
    }
    if (message.includes('already exists')) {
      return engineError('E_ID_COLLISION', message);
    }
    return engineError('E_NOT_INITIALIZED', 'Failed to unarchive task');
  }
}

/**
 * Change task position within its sibling group.
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
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('not found')) {
      return engineError('E_NOT_FOUND', message);
    }
    return engineError('E_NOT_INITIALIZED', 'Failed to reorder task');
  }
}

/**
 * Move task under a different parent.
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
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('not found')) {
      const code = message.includes('Parent') ? 'E_PARENT_NOT_FOUND' : 'E_NOT_FOUND';
      return engineError(code, message);
    }
    if (message.includes('subtask')) {
      return engineError('E_INVALID_PARENT_TYPE', message);
    }
    if (message.includes('circular')) {
      return engineError('E_CIRCULAR_REFERENCE', message);
    }
    if (message.includes('depth')) {
      return engineError('E_DEPTH_EXCEEDED', message);
    }
    if (message.includes('siblings')) {
      return engineError('E_SIBLING_LIMIT', message);
    }
    return engineError('E_NOT_INITIALIZED', 'Failed to reparent task');
  }
}

/**
 * Promote a subtask to task or task to root (remove parent).
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
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('not found')) {
      return engineError('E_NOT_FOUND', message);
    }
    return engineError('E_NOT_INITIALIZED', 'Failed to promote task');
  }
}

/**
 * Reopen a completed task (set status back to pending).
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
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('not found')) {
      return engineError('E_NOT_FOUND', message);
    }
    if (message.includes('not completed')) {
      return engineError('E_INVALID_INPUT', message);
    }
    if (message.includes('Invalid target')) {
      return engineError('E_INVALID_INPUT', message);
    }
    return engineError('E_NOT_INITIALIZED', 'Failed to reopen task');
  }
}

/**
 * Cancel a task (soft terminal state — reversible via restore).
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
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('not found')) return engineError('E_NOT_FOUND', message);
    if (message.includes('already cancelled') || message.includes('completed'))
      return engineError('E_INVALID_INPUT', message);
    return engineError('E_INTERNAL', message);
  }
}

/**
 * Deterministic complexity scoring from task metadata.
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
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('not found')) {
      return engineError('E_NOT_FOUND', message);
    }
    return engineError('E_NOT_INITIALIZED', 'Task database not initialized');
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
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('not found')) {
      return engineError('E_NOT_FOUND', message);
    }
    return engineError('E_NOT_INITIALIZED', 'Task database not initialized');
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
    const message = err instanceof Error ? err.message : String(err);
    return engineError('E_NOT_INITIALIZED', message);
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
    const message = err instanceof Error ? err.message : String(err);
    return engineError('E_NOT_INITIALIZED', message);
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
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('not found')) {
      return engineError('E_NOT_FOUND', message);
    }
    return engineError('E_NOT_INITIALIZED', 'Task database not initialized');
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
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('Invalid JSON')) {
      return engineError('E_INVALID_INPUT', message);
    }
    return engineError('E_NOT_INITIALIZED', 'Failed to import tasks');
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
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('not found')) {
      return engineError('E_NOT_FOUND', message);
    }
    return engineError('E_INTERNAL', message);
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
    const message = err instanceof Error ? err.message : String(err);
    return engineError('E_INTERNAL', message);
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
        conflictPolicy: params.conflictPolicy as import('@cleocode/contracts').ConflictPolicy | undefined,
        defaultPhase: params.defaultPhase,
        defaultLabels: params.defaultLabels,
      },
      accessor,
    );
    return { success: true, data: result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return engineError('E_INTERNAL', message);
  }
}

/**
 * List external task links by provider or task ID.
 */
export async function taskSyncLinks(
  projectRoot: string,
  params?: { providerId?: string; taskId?: string },
): Promise<EngineResult<{ links: import('@cleocode/contracts').ExternalTaskLink[]; count: number }>> {
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
    const message = err instanceof Error ? err.message : String(err);
    return engineError('E_INTERNAL', message);
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
    const message = err instanceof Error ? err.message : String(err);
    return engineError('E_INTERNAL', message);
  }
}
