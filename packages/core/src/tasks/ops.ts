/**
 * Tasks domain Core operations — ADR-057 D1 normalized shape.
 *
 * Each exported function follows the uniform `(projectRoot: string, params: <Op>Params)`
 * signature so the dispatch layer can call Core directly without positional-arg
 * coupling or inline business logic.
 *
 * The original Core functions (`addTask`, `listTasks`, etc.) are preserved with their
 * existing signatures for internal Core callers. This file provides **normalized wrappers**
 * that satisfy the ADR-057 D1 shape at the dispatch boundary.
 *
 * Field-name mapping (ADR-057 D2 canonical wire form → Core internal form):
 *   - `params.parent` → `options.parentId` (tasks add/update)
 *   - `params.role`   → `options.role` (same field name, no mapping needed)
 *
 * @module tasks/ops
 * @task T1458 — tasks domain Core API SSoT alignment (ADR-057 D1+D2)
 * @task T1445 — `tasksCoreOps` type registry for OpsFromCore inference
 * @see ADR-057 — Core API normalization
 * @see packages/contracts/src/operations/tasks.ts
 */

import type {
  TaskPriority,
  TaskRole,
  TaskScope,
  TaskSeverity,
  TaskSize,
  TaskStatus,
  TasksOps,
  TaskType,
} from '@cleocode/contracts';
import { type AddTaskResult, addTask } from './add.js';
import { type ArchiveTasksResult, archiveTasks } from './archive.js';
import { type CompleteTaskResult, completeTask } from './complete.js';
import { type DeleteTaskResult, deleteTask } from './delete.js';
import { type FindTasksResult, findTasks } from './find.js';
import { type ListTasksResult, listTasks } from './list.js';
import { showTask, type TaskDetail } from './show.js';
import { type UpdateTaskResult, updateTask } from './update.js';

// ---------------------------------------------------------------------------
// Query ops
// ---------------------------------------------------------------------------

/**
 * Normalized wrapper for {@link showTask}.
 * ADR-057 D1 shape: (projectRoot: string, params: TasksShowOpsParams)
 *
 * @param projectRoot - Absolute path to the project root.
 * @param params - Operation parameters.
 * @returns TaskDetail for the given task ID.
 * @throws CleoError with ExitCode.NOT_FOUND when task does not exist.
 */
export async function tasksShowOp(
  projectRoot: string,
  params: { taskId: string },
): Promise<TaskDetail> {
  return showTask(params.taskId, projectRoot);
}

/**
 * Normalized wrapper for {@link listTasks}.
 * ADR-057 D1 shape: (projectRoot: string, params: TasksListOpsParams)
 *
 * @param projectRoot - Absolute path to the project root.
 * @param params - Operation parameters.
 * @returns List of tasks matching the given filters.
 */
export async function tasksListOp(
  projectRoot: string,
  params: {
    parent?: string;
    status?: TaskStatus;
    priority?: TaskPriority;
    type?: TaskType;
    phase?: string;
    label?: string;
    children?: boolean;
    limit?: number;
    offset?: number;
  } = {},
): Promise<ListTasksResult> {
  return listTasks(
    {
      // ADR-057 D2: wire field `parent` maps to Core internal `parentId`
      parentId: params.parent,
      status: params.status,
      priority: params.priority,
      type: params.type,
      phase: params.phase,
      label: params.label,
      children: params.children,
      limit: params.limit,
      offset: params.offset,
    },
    projectRoot,
  );
}

/**
 * Normalized wrapper for {@link findTasks}.
 * ADR-057 D1 shape: (projectRoot: string, params: TasksFindOpsParams)
 *
 * @param projectRoot - Absolute path to the project root.
 * @param params - Operation parameters.
 * @returns Find results with matching tasks.
 */
export async function tasksFindOp(
  projectRoot: string,
  params: {
    query: string;
    limit?: number;
    id?: string;
    exact?: boolean;
    status?: TaskStatus;
    includeArchive?: boolean;
    offset?: number;
    role?: TaskRole;
  },
): Promise<FindTasksResult> {
  return findTasks(
    {
      query: params.query,
      id: params.id,
      exact: params.exact,
      status: params.status,
      includeArchive: params.includeArchive,
      limit: params.limit,
      offset: params.offset,
      role: params.role,
    },
    projectRoot,
  );
}

// ---------------------------------------------------------------------------
// Mutate ops
// ---------------------------------------------------------------------------

/**
 * Normalized wrapper for {@link addTask}.
 * ADR-057 D1 shape: (projectRoot: string, params: TasksAddOpsParams)
 *
 * @param projectRoot - Absolute path to the project root.
 * @param params - Operation parameters.
 * @returns AddTaskResult with the created task.
 * @throws CleoError on validation failures or duplicate detection.
 */
export async function tasksAddOp(
  projectRoot: string,
  params: {
    title: string;
    description?: string;
    /** Canonical wire field for parent task ID (ADR-057 D2). */
    parent?: string;
    depends?: string[];
    priority?: TaskPriority;
    labels?: string[];
    type?: TaskType;
    acceptance?: string[];
    phase?: string;
    size?: TaskSize;
    notes?: string;
    files?: string[];
    dryRun?: boolean;
    /** Task role axis — intent of work (T944). */
    role?: TaskRole;
    scope?: TaskScope;
    severity?: TaskSeverity;
    /**
     * Bypass the BRAIN duplicate-detection rejection guard (T1633).
     * Audited to `.cleo/audit/duplicate-bypass.jsonl`.
     */
    forceDuplicate?: boolean;
  },
): Promise<AddTaskResult> {
  return addTask(
    {
      title: params.title,
      description: params.description,
      // ADR-057 D2: wire field `parent` maps to Core internal `parentId`
      parentId: params.parent,
      depends: params.depends,
      priority: params.priority,
      labels: params.labels,
      type: params.type,
      acceptance: params.acceptance,
      phase: params.phase,
      size: params.size,
      notes: params.notes,
      files: params.files,
      dryRun: params.dryRun,
      role: params.role,
      scope: params.scope,
      severity: params.severity,
      forceDuplicate: params.forceDuplicate,
    },
    projectRoot,
  );
}

/**
 * Normalized wrapper for {@link updateTask}.
 * ADR-057 D1 shape: (projectRoot: string, params: TasksUpdateOpsParams)
 *
 * @param projectRoot - Absolute path to the project root.
 * @param params - Operation parameters.
 * @returns UpdateTaskResult with the updated task and change log.
 * @throws CleoError with ExitCode.NOT_FOUND when task does not exist.
 */
export async function tasksUpdateOp(
  projectRoot: string,
  params: {
    taskId: string;
    title?: string;
    description?: string;
    status?: TaskStatus;
    priority?: TaskPriority;
    notes?: string;
    labels?: string[];
    addLabels?: string[];
    removeLabels?: string[];
    depends?: string[];
    addDepends?: string[];
    removeDepends?: string[];
    acceptance?: string[];
    /** Canonical wire field for parent task ID (ADR-057 D2). */
    parent?: string | null;
    type?: TaskType;
    size?: TaskSize;
    files?: string[];
    pipelineStage?: string;
    role?: TaskRole;
    scope?: TaskScope;
  },
): Promise<UpdateTaskResult> {
  return updateTask(
    {
      taskId: params.taskId,
      title: params.title,
      description: params.description,
      status: params.status,
      priority: params.priority,
      notes: params.notes,
      labels: params.labels,
      addLabels: params.addLabels,
      removeLabels: params.removeLabels,
      depends: params.depends,
      addDepends: params.addDepends,
      removeDepends: params.removeDepends,
      acceptance: params.acceptance,
      // ADR-057 D2: wire field `parent` maps to Core internal `parentId`
      parentId: params.parent,
      type: params.type,
      size: params.size,
      files: params.files,
      pipelineStage: params.pipelineStage,
      role: params.role,
      scope: params.scope,
    },
    projectRoot,
  );
}

/**
 * Normalized wrapper for {@link completeTask}.
 * ADR-057 D1 shape: (projectRoot: string, params: TasksCompleteOpsParams)
 *
 * @param projectRoot - Absolute path to the project root.
 * @param params - Operation parameters.
 * @returns CompleteTaskResult with the completed task.
 * @throws CleoError on gate failures or when task does not exist.
 */
export async function tasksCompleteOp(
  projectRoot: string,
  params: {
    taskId: string;
    notes?: string;
    acknowledgeRisk?: string;
  },
): Promise<CompleteTaskResult> {
  return completeTask(
    {
      taskId: params.taskId,
      notes: params.notes,
      acknowledgeRisk: params.acknowledgeRisk,
    },
    projectRoot,
  );
}

/**
 * Normalized wrapper for {@link deleteTask}.
 * ADR-057 D1 shape: (projectRoot: string, params: TasksDeleteOpsParams)
 *
 * @param projectRoot - Absolute path to the project root.
 * @param params - Operation parameters.
 * @returns DeleteTaskResult with the deleted task.
 * @throws CleoError with ExitCode.NOT_FOUND when task does not exist.
 */
export async function tasksDeleteOp(
  projectRoot: string,
  params: {
    taskId: string;
    force?: boolean;
  },
): Promise<DeleteTaskResult> {
  return deleteTask(
    {
      taskId: params.taskId,
      force: params.force,
    },
    projectRoot,
  );
}

/**
 * Normalized wrapper for {@link archiveTasks}.
 * ADR-057 D1 shape: (projectRoot: string, params: TasksArchiveOpsParams)
 *
 * @param projectRoot - Absolute path to the project root.
 * @param params - Operation parameters.
 * @returns ArchiveTasksResult with the archived task IDs and count.
 */
export async function tasksArchiveOp(
  projectRoot: string,
  params: {
    taskId?: string;
    before?: string;
    taskIds?: string[];
    includeCancelled?: boolean;
    dryRun?: boolean;
  } = {},
): Promise<ArchiveTasksResult> {
  // When a specific taskId is given, treat it as a single-item taskIds list
  const taskIds = params.taskIds ?? (params.taskId ? [params.taskId] : undefined);
  return archiveTasks(
    {
      before: params.before,
      taskIds,
      includeCancelled: params.includeCancelled,
      dryRun: params.dryRun,
    },
    projectRoot,
  );
}

// ---------------------------------------------------------------------------
// Core operation type registry (T1445 — OpsFromCore inference)
// ---------------------------------------------------------------------------

/**
 * Type helper: extract the single-arg function type for a tasks operation.
 *
 * @typeParam Op - A key of `TasksOps` (e.g. `'show'`, `'add'`).
 */
type TaskCoreOperation<Op extends keyof TasksOps> = (
  params: TasksOps[Op][0],
) => Promise<TasksOps[Op][1]>;

/**
 * Tasks operation signature registry — consumed by the dispatch layer for
 * `OpsFromCore<typeof coreTasks.tasksCoreOps>` inference.
 *
 * @example
 * ```ts
 * import type { tasks as coreTasks } from '@cleocode/core';
 * import type { OpsFromCore } from '../adapters/typed.js';
 *
 * type TasksOps = OpsFromCore<typeof coreTasks.tasksCoreOps>;
 * ```
 *
 * @task T1445 — OpsFromCore inference migration
 */
export declare const tasksCoreOps: {
  // Query ops
  readonly show: TaskCoreOperation<'show'>;
  readonly list: TaskCoreOperation<'list'>;
  readonly find: TaskCoreOperation<'find'>;
  readonly tree: TaskCoreOperation<'tree'>;
  readonly blockers: TaskCoreOperation<'blockers'>;
  readonly depends: TaskCoreOperation<'depends'>;
  readonly analyze: TaskCoreOperation<'analyze'>;
  readonly impact: TaskCoreOperation<'impact'>;
  readonly next: TaskCoreOperation<'next'>;
  readonly plan: TaskCoreOperation<'plan'>;
  readonly relates: TaskCoreOperation<'relates'>;
  readonly 'complexity.estimate': TaskCoreOperation<'complexity.estimate'>;
  readonly history: TaskCoreOperation<'history'>;
  readonly current: TaskCoreOperation<'current'>;
  readonly 'label.list': TaskCoreOperation<'label.list'>;
  readonly 'sync.links': TaskCoreOperation<'sync.links'>;
  // Mutate ops
  readonly add: TaskCoreOperation<'add'>;
  readonly update: TaskCoreOperation<'update'>;
  readonly complete: TaskCoreOperation<'complete'>;
  readonly cancel: TaskCoreOperation<'cancel'>;
  readonly delete: TaskCoreOperation<'delete'>;
  readonly archive: TaskCoreOperation<'archive'>;
  readonly restore: TaskCoreOperation<'restore'>;
  readonly reparent: TaskCoreOperation<'reparent'>;
  readonly reorder: TaskCoreOperation<'reorder'>;
  readonly 'relates.add': TaskCoreOperation<'relates.add'>;
  readonly start: TaskCoreOperation<'start'>;
  readonly stop: TaskCoreOperation<'stop'>;
  readonly 'sync.reconcile': TaskCoreOperation<'sync.reconcile'>;
  readonly 'sync.links.remove': TaskCoreOperation<'sync.links.remove'>;
  readonly claim: TaskCoreOperation<'claim'>;
  readonly unclaim: TaskCoreOperation<'unclaim'>;
};
