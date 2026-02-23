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

import { getAccessor } from '../../store/data-accessor.js';
import type { Task } from '../../types/task.js';
// validation-rules.js still used by other engines; core modules handle their own validation
// Core module imports for accessor-based operations
import { addTask as coreAddTask } from '../../core/tasks/add.js';
import { updateTask as coreUpdateTask } from '../../core/tasks/update.js';
import { deleteTask as coreDeleteTask } from '../../core/tasks/delete.js';
import { archiveTasks as coreArchiveTasks } from '../../core/tasks/archive.js';
import { showTask as coreShowTask } from '../../core/tasks/show.js';
import { listTasks as coreListTasks } from '../../core/tasks/list.js';
import { findTasks as coreFindTasks } from '../../core/tasks/find.js';
// Non-CRUD core operations
import {
  coreTaskNext,
  coreTaskBlockers,
  coreTaskTree,
  coreTaskDeps,
  coreTaskRelates,
  coreTaskRelatesAdd,
  coreTaskAnalyze,
  coreTaskRestore,
  coreTaskUnarchive,
  coreTaskReorder,
  coreTaskReparent,
  coreTaskPromote,
  coreTaskReopen,
  coreTaskComplexityEstimate,
  coreTaskDepends,
  coreTaskStats,
  coreTaskExport,
  coreTaskHistory,
  coreTaskLint,
  coreTaskBatchValidate,
  coreTaskImport,
  type TaskTreeNode,
  type ComplexityFactor,
} from '../../core/tasks/task-ops.js';

/**
 * Convert a core Task to a TaskRecord for backward compatibility.
 * TaskRecord has string-typed status/priority; Task has union types.
 *
 * @task T4657
 * @epic T4654
 */
function taskToRecord(task: Task): TaskRecord {
  return task as unknown as TaskRecord;
}

/**
 * Convert an array of core Tasks to TaskRecords.
 *
 * @task T4657
 * @epic T4654
 */
function tasksToRecords(tasks: Task[]): TaskRecord[] {
  return tasks as unknown as TaskRecord[];
}

/**
 * Task object as stored in todo.json
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
  verification?: Record<string, unknown> | null;
  origin?: string | null;
  createdBy?: string | null;
  validatedBy?: string | null;
  testedBy?: string | null;
  lifecycleState?: string | null;
  validationHistory?: Array<Record<string, unknown>>;
  blockedBy?: string[];
  cancellationReason?: string;
}

// Local TodoFile interface removed — DataAccessor uses the canonical TodoFile from types/task.ts.

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

/**
 * Engine result wrapper
 */
export interface EngineResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
    exitCode?: number;
  };
}

// loadTodoFile and saveTodoFile removed — all operations now use DataAccessor.
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
  taskId: string
): Promise<EngineResult<{ task: TaskRecord }>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const detail = await coreShowTask(taskId, projectRoot, accessor);
    return { success: true, data: { task: taskToRecord(detail) } };
  } catch (err: unknown) {
    const code = (err as { code?: number })?.code;
    if (code === 4 /* NOT_FOUND */) {
      return {
        success: false,
        error: { code: 'E_NOT_FOUND', message: (err as Error).message || `Task '${taskId}' not found` },
      };
    }
    if (code === 2 /* INVALID_INPUT */) {
      return {
        success: false,
        error: { code: 'E_INVALID_INPUT', message: (err as Error).message || 'Invalid input' },
      };
    }
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: (err as Error).message || 'Task database not initialized' } };
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
    limit?: number;
  }
): Promise<EngineResult<{ tasks: TaskRecord[]; total: number }>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const result = await coreListTasks({
      parentId: params?.parent ?? undefined,
      status: params?.status as import('../../types/task.js').TaskStatus | undefined,
      limit: params?.limit,
    }, projectRoot, accessor);
    return { success: true, data: { tasks: tasksToRecords(result.tasks), total: result.total } };
  } catch {
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'Task database not initialized' } };
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
  limit?: number
): Promise<EngineResult<{ results: MinimalTaskRecord[]; total: number }>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const findResult = await coreFindTasks({
      query,
      limit: limit ?? 20,
    }, projectRoot, accessor);

    const results: MinimalTaskRecord[] = findResult.results.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      priority: r.priority,
      parentId: r.parentId,
    }));

    return { success: true, data: { results, total: results.length } };
  } catch {
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'Task database not initialized' } };
  }
}

/**
 * Check if a task exists
 * @task T4657
 * @epic T4654
 */
export async function taskExists(
  projectRoot: string,
  taskId: string
): Promise<EngineResult<{ exists: boolean; taskId: string }>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const data = await accessor.loadTodoFile();
    const exists = data.tasks.some((t) => t.id === taskId);
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
  }
): Promise<EngineResult<{ task: TaskRecord; duplicate: boolean }>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const result = await coreAddTask({
      title: params.title,
      description: params.description,
      parentId: params.parent || null,
      depends: params.depends,
      priority: (params.priority as import('../../types/task.js').TaskPriority) || 'medium',
      labels: params.labels,
      type: (params.type as import('../../types/task.js').TaskType) || undefined,
    }, projectRoot, accessor);

    return {
      success: true,
      data: { task: taskToRecord(result.task), duplicate: result.duplicate ?? false },
    };
  } catch (err: unknown) {
    const cleoErr = err as { code?: number; message?: string };
    // Map CleoError exit codes to engine error codes (see src/types/exit-codes.ts)
    if (cleoErr.code === 10 /* PARENT_NOT_FOUND */) {
      return { success: false, error: { code: 'E_PARENT_NOT_FOUND', message: cleoErr.message ?? 'Parent task not found', exitCode: 10 } };
    }
    if (cleoErr.code === 11 /* DEPTH_EXCEEDED */) {
      return { success: false, error: { code: 'E_DEPTH_EXCEEDED', message: cleoErr.message ?? 'Max hierarchy depth exceeded', exitCode: 11 } };
    }
    if (cleoErr.code === 12 /* SIBLING_LIMIT */) {
      return { success: false, error: { code: 'E_SIBLING_LIMIT', message: cleoErr.message ?? 'Max siblings exceeded', exitCode: 12 } };
    }
    if (cleoErr.code === 13 /* INVALID_PARENT_TYPE */) {
      return { success: false, error: { code: 'E_INVALID_PARENT', message: cleoErr.message ?? 'Invalid parent type', exitCode: 13 } };
    }
    if (cleoErr.code === 14 /* CIRCULAR_REFERENCE */) {
      return { success: false, error: { code: 'E_CIRCULAR_REFERENCE', message: cleoErr.message ?? 'Circular reference detected', exitCode: 14 } };
    }
    if (cleoErr.code === 6 /* VALIDATION_ERROR */ || cleoErr.code === 2 /* INVALID_INPUT */) {
      return { success: false, error: { code: 'E_VALIDATION_FAILED', message: cleoErr.message ?? 'Validation failed', exitCode: cleoErr.code } };
    }
    if (cleoErr.code === 4 /* NOT_FOUND */) {
      return { success: false, error: { code: 'E_NOT_FOUND', message: cleoErr.message ?? 'Task not found', exitCode: 4 } };
    }
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: cleoErr.message ?? 'Task database not initialized' } };
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
  }
): Promise<EngineResult<{ task: TaskRecord; changes?: string[] }>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const result = await coreUpdateTask({
      taskId,
      title: updates.title,
      description: updates.description,
      status: updates.status as import('../../types/task.js').TaskStatus | undefined,
      priority: updates.priority as import('../../types/task.js').TaskPriority | undefined,
      notes: updates.notes,
      labels: updates.labels,
      addLabels: updates.addLabels,
      removeLabels: updates.removeLabels,
      depends: updates.depends,
      addDepends: updates.addDepends,
      removeDepends: updates.removeDepends,
      acceptance: updates.acceptance,
      parentId: updates.parent,
      type: updates.type as import('../../types/task.js').TaskType | undefined,
      size: updates.size as import('../../types/task.js').TaskSize | undefined,
    }, projectRoot, accessor);

    return { success: true, data: { task: taskToRecord(result.task), changes: result.changes } };
  } catch (err: unknown) {
    const cleoErr = err as { code?: number; message?: string };
    if (cleoErr.code === 4 /* NOT_FOUND */) {
      return { success: false, error: { code: 'E_NOT_FOUND', message: cleoErr.message ?? `Task '${taskId}' not found` } };
    }
    if (cleoErr.code === 6 /* VALIDATION_ERROR */ || cleoErr.code === 2 /* INVALID_INPUT */) {
      return { success: false, error: { code: 'E_VALIDATION_FAILED', message: cleoErr.message ?? 'Validation failed' } };
    }
    if (cleoErr.code === 102 /* NO_CHANGE */) {
      return { success: false, error: { code: 'E_NO_CHANGE', message: cleoErr.message ?? 'No changes specified' } };
    }
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: cleoErr.message ?? 'Task database not initialized' } };
  }
}

/**
 * Complete a task (set status to done)
 */
export async function taskComplete(
  projectRoot: string,
  taskId: string,
  notes?: string
): Promise<EngineResult<{ task: TaskRecord; changes?: string[] }>> {
  return taskUpdate(projectRoot, taskId, {
    status: 'done',
    notes: notes || undefined,
  });
}

/**
 * Delete a task
 */
export async function taskDelete(
  projectRoot: string,
  taskId: string,
  force?: boolean
): Promise<EngineResult<{ deletedTask: TaskRecord; deleted: boolean; cascadeDeleted?: string[] }>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const result = await coreDeleteTask({
      taskId,
      force: force ?? false,
      cascade: force ?? false,
    }, projectRoot, accessor);

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
      return { success: false, error: { code: 'E_NOT_FOUND', message: cleoErr.message ?? `Task '${taskId}' not found` } };
    }
    if (cleoErr.code === 16 /* HAS_CHILDREN */) {
      return { success: false, error: { code: 'E_HAS_CHILDREN', message: cleoErr.message ?? `Task '${taskId}' has children` } };
    }
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: cleoErr.message ?? 'Task database not initialized' } };
  }
}

/**
 * Archive completed tasks.
 * Moves done/cancelled tasks from todo.json to todo-archive.json.
 */
export async function taskArchive(
  projectRoot: string,
  taskId?: string,
  before?: string
): Promise<EngineResult<{ archivedCount: number; archivedTasks: Array<{ id: string }> }>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const result = await coreArchiveTasks({
      taskIds: taskId ? [taskId] : undefined,
      before,
    }, projectRoot, accessor);

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
      return { success: false, error: { code: 'E_NOT_FOUND', message: cleoErr.message ?? `Task not found` } };
    }
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: cleoErr.message ?? 'Task database not initialized' } };
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
  }
): Promise<EngineResult<{
  suggestions: Array<{
    id: string;
    title: string;
    priority: string;
    phase: string | null;
    score: number;
    reasons?: string[];
  }>;
  totalCandidates: number;
}>> {
  try {
    const result = await coreTaskNext(projectRoot, params);
    return { success: true, data: result };
  } catch {
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'Task database not initialized' } };
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
  params?: { analyze?: boolean }
): Promise<EngineResult<{
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
}>> {
  try {
    const result = await coreTaskBlockers(projectRoot, params);
    return { success: true, data: result };
  } catch {
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'Task database not initialized' } };
  }
}

/**
 * Build hierarchy tree.
 * @task T4657
 * @task T4790
 * @epic T4654
 */
export async function taskTree(
  projectRoot: string,
  taskId?: string
): Promise<EngineResult<{ tree: TaskTreeNode[]; totalNodes: number }>> {
  try {
    const result = await coreTaskTree(projectRoot, taskId);
    return { success: true, data: result };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('not found')) {
      return { success: false, error: { code: 'E_NOT_FOUND', message } };
    }
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'Task database not initialized' } };
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
  taskId: string
): Promise<EngineResult<{
  taskId: string;
  dependsOn: Array<{ id: string; title: string; status: string }>;
  dependedOnBy: Array<{ id: string; title: string; status: string }>;
  unresolvedDeps: string[];
  allDepsReady: boolean;
}>> {
  try {
    const result = await coreTaskDeps(projectRoot, taskId);
    return { success: true, data: result };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('not found')) {
      return { success: false, error: { code: 'E_NOT_FOUND', message } };
    }
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'Task database not initialized' } };
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
  taskId: string
): Promise<EngineResult<{
  taskId: string;
  relations: Array<{
    taskId: string;
    type: string;
    reason?: string;
  }>;
  count: number;
}>> {
  try {
    const result = await coreTaskRelates(projectRoot, taskId);
    return { success: true, data: result };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('not found')) {
      return { success: false, error: { code: 'E_NOT_FOUND', message } };
    }
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'Task database not initialized' } };
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
  reason?: string
): Promise<EngineResult<{ from: string; to: string; type: string; added: boolean }>> {
  try {
    const result = await coreTaskRelatesAdd(projectRoot, taskId, relatedId, type, reason);
    return { success: true, data: result };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('not found')) {
      return { success: false, error: { code: 'E_NOT_FOUND', message } };
    }
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'Failed to update task relations' } };
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
  taskId?: string
): Promise<EngineResult<{
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
}>> {
  try {
    const result = await coreTaskAnalyze(projectRoot, taskId);
    return { success: true, data: result };
  } catch {
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'Task database not initialized' } };
  }
}

/**
 * Restore a cancelled task back to pending.
 * @task T4790
 */
export async function taskRestore(
  projectRoot: string,
  taskId: string,
  params?: { cascade?: boolean; notes?: string }
): Promise<EngineResult<{ task: string; restored: string[]; count: number }>> {
  try {
    const result = await coreTaskRestore(projectRoot, taskId, params);
    return { success: true, data: result };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('not found')) {
      return { success: false, error: { code: 'E_NOT_FOUND', message } };
    }
    if (message.includes('not cancelled')) {
      return { success: false, error: { code: 'E_INVALID_STATUS', message } };
    }
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'Failed to restore task' } };
  }
}

/**
 * Move an archived task back to todo.json with status 'done' (or specified status).
 * @task T4790
 */
export async function taskUnarchive(
  projectRoot: string,
  taskId: string,
  params?: { status?: string; preserveStatus?: boolean }
): Promise<EngineResult<{ task: string; unarchived: boolean; title: string; status: string }>> {
  try {
    const result = await coreTaskUnarchive(projectRoot, taskId, params);
    return { success: true, data: result };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('not found')) {
      return { success: false, error: { code: 'E_NOT_FOUND', message } };
    }
    if (message.includes('already exists')) {
      return { success: false, error: { code: 'E_ID_COLLISION', message } };
    }
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'Failed to unarchive task' } };
  }
}

/**
 * Change task position within its sibling group.
 * @task T4790
 */
export async function taskReorder(
  projectRoot: string,
  taskId: string,
  position: number
): Promise<EngineResult<{ task: string; reordered: boolean; newPosition: number; totalSiblings: number }>> {
  try {
    const result = await coreTaskReorder(projectRoot, taskId, position);
    return { success: true, data: result };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('not found')) {
      return { success: false, error: { code: 'E_NOT_FOUND', message } };
    }
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'Failed to reorder task' } };
  }
}

/**
 * Move task under a different parent.
 * @task T4790
 */
export async function taskReparent(
  projectRoot: string,
  taskId: string,
  newParentId: string | null
): Promise<EngineResult<{
  task: string;
  reparented: boolean;
  oldParent: string | null;
  newParent: string | null;
  newType?: string;
}>> {
  try {
    const result = await coreTaskReparent(projectRoot, taskId, newParentId);
    return { success: true, data: result };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('not found')) {
      const code = message.includes('Parent') ? 'E_PARENT_NOT_FOUND' : 'E_NOT_FOUND';
      return { success: false, error: { code, message } };
    }
    if (message.includes('subtask')) {
      return { success: false, error: { code: 'E_INVALID_PARENT_TYPE', message } };
    }
    if (message.includes('circular')) {
      return { success: false, error: { code: 'E_CIRCULAR_REFERENCE', message } };
    }
    if (message.includes('depth')) {
      return { success: false, error: { code: 'E_DEPTH_EXCEEDED', message } };
    }
    if (message.includes('siblings')) {
      return { success: false, error: { code: 'E_SIBLING_LIMIT', message } };
    }
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'Failed to reparent task' } };
  }
}

/**
 * Promote a subtask to task or task to root (remove parent).
 * @task T4790
 */
export async function taskPromote(
  projectRoot: string,
  taskId: string
): Promise<EngineResult<{ task: string; promoted: boolean; previousParent: string | null; typeChanged: boolean }>> {
  try {
    const result = await coreTaskPromote(projectRoot, taskId);
    return { success: true, data: result };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('not found')) {
      return { success: false, error: { code: 'E_NOT_FOUND', message } };
    }
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'Failed to promote task' } };
  }
}

/**
 * Reopen a completed task (set status back to pending).
 * @task T4790
 */
export async function taskReopen(
  projectRoot: string,
  taskId: string,
  params?: { status?: string; reason?: string }
): Promise<EngineResult<{ task: string; reopened: boolean; previousStatus: string; newStatus: string }>> {
  try {
    const result = await coreTaskReopen(projectRoot, taskId, params);
    return { success: true, data: result };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('not found')) {
      return { success: false, error: { code: 'E_NOT_FOUND', message } };
    }
    if (message.includes('not completed')) {
      return { success: false, error: { code: 'E_INVALID_STATUS', message } };
    }
    if (message.includes('Invalid target')) {
      return { success: false, error: { code: 'E_INVALID_INPUT', message } };
    }
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'Failed to reopen task' } };
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
  params: { taskId: string }
): Promise<EngineResult<{
  size: 'small' | 'medium' | 'large';
  score: number;
  factors: ComplexityFactor[];
  dependencyDepth: number;
  subtaskCount: number;
  fileCount: number;
}>> {
  try {
    const result = await coreTaskComplexityEstimate(projectRoot, params);
    return { success: true, data: result };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('not found')) {
      return { success: false, error: { code: 'E_NOT_FOUND', message } };
    }
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'Task database not initialized' } };
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
  direction: 'upstream' | 'downstream' | 'both' = 'both'
): Promise<EngineResult<{
  taskId: string;
  direction: string;
  upstream: Array<{ id: string; title: string; status: string }>;
  downstream: Array<{ id: string; title: string; status: string }>;
}>> {
  try {
    const result = await coreTaskDepends(projectRoot, taskId, direction);
    return { success: true, data: result };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('not found')) {
      return { success: false, error: { code: 'E_NOT_FOUND', message } };
    }
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'Task database not initialized' } };
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
  epicId?: string
): Promise<EngineResult<{
  total: number;
  pending: number;
  active: number;
  blocked: number;
  done: number;
  cancelled: number;
  byPriority: Record<string, number>;
  byType: Record<string, number>;
}>> {
  try {
    const result = await coreTaskStats(projectRoot, epicId);
    return { success: true, data: result };
  } catch {
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'Task database not initialized' } };
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
  }
): Promise<EngineResult<unknown>> {
  try {
    const result = await coreTaskExport(projectRoot, params);
    return { success: true, data: result };
  } catch {
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'Task database not initialized' } };
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
  limit?: number
): Promise<EngineResult<Array<Record<string, unknown>>>> {
  try {
    const result = await coreTaskHistory(projectRoot, taskId, limit);
    return { success: true, data: result };
  } catch {
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'Failed to read task history' } };
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
  taskId?: string
): Promise<EngineResult<Array<{
  taskId: string;
  severity: 'error' | 'warning';
  rule: string;
  message: string;
}>>> {
  try {
    const result = await coreTaskLint(projectRoot, taskId);
    return { success: true, data: result };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('not found')) {
      return { success: false, error: { code: 'E_NOT_FOUND', message } };
    }
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'Task database not initialized' } };
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
  checkMode: 'full' | 'quick' = 'full'
): Promise<EngineResult<{
  results: Record<string, Array<{
    severity: 'error' | 'warning';
    rule: string;
    message: string;
  }>>;
  summary: {
    totalTasks: number;
    validTasks: number;
    invalidTasks: number;
    totalIssues: number;
    errors: number;
    warnings: number;
  };
}>> {
  try {
    const result = await coreTaskBatchValidate(projectRoot, taskIds, checkMode);
    return { success: true, data: result };
  } catch {
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'Task database not initialized' } };
  }
}

/**
 * Import tasks from a JSON source string or export package.
 * @task T4790
 */
export async function taskImport(
  projectRoot: string,
  source: string,
  overwrite?: boolean
): Promise<EngineResult<{ imported: number; skipped: number; errors: string[]; remapTable?: Record<string, string> }>> {
  try {
    const result = await coreTaskImport(projectRoot, source, overwrite);
    return { success: true, data: result };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('Invalid JSON')) {
      return { success: false, error: { code: 'E_INVALID_INPUT', message } };
    }
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'Failed to import tasks' } };
  }
}
