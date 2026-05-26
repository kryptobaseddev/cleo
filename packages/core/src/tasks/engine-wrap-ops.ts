/**
 * EngineResult wrappers for data/query task ops — deps, stats, export, lint, import.
 * Split from engine-wrap.ts to keep individual file sizes ≤780 LOC.
 * @task T10064
 * @epic T9834
 */

import type { TaskStatus, TasksContextParams, TasksContextResult } from '@cleocode/contracts';
import { TASK_STATUSES } from '@cleocode/contracts';
import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { cleoErrorToEngineResult } from '../errors-to-engine.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import type { DepGraphValidateResult, DepValidateScope } from './dep-graph-validator.js';
import { runValidation } from './dep-graph-validator.js';
import type { ComplexityFactor } from './task-analyze.js';
import { coreTaskComplexityEstimate } from './task-analyze.js';
import {
  coreTaskDepends,
  coreTaskDepsCycles,
  coreTaskDepsOverview,
  coreTaskSlice,
  coreTaskStats,
} from './task-data.js';
import {
  coreTaskBatchValidate,
  coreTaskExport,
  coreTaskHistory,
  coreTaskImport,
  coreTaskLint,
} from './task-import.js';
import { coreTaskContext } from './task-context.js';
import { computeCriticalPath, renderMermaidTree, renderTextTree } from './tree-render.js';
/**
 * Convert a caught error to an EngineResult failure.
 *
 * T9940: extracts the real LAFS code from any thrown `CleoError`. Non-CleoError
 * exceptions fall through to `E_INTERNAL`, never the misleading
 * `E_NOT_INITIALIZED` blanket label that the pre-T9940 wrapper used.
 *
 * @task T9940
 * @epic T9862
 */
function nonCrudEngineError<T>(err: unknown, fallbackMsg: string): EngineResult<T> {
  return cleoErrorToEngineResult<T>(err, 'E_INTERNAL', fallbackMsg);
}

/**
 * Deterministic complexity scoring.
 * @task T1568
 * @epic T1566
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
    return engineSuccess(result);
  } catch (err: unknown) {
    return nonCrudEngineError(err, 'Task database not initialized');
  }
}

/**
 * List dependencies for a task in a given direction.
 * @task T1568
 * @epic T1566
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
    return engineSuccess(result);
  } catch (err: unknown) {
    return nonCrudEngineError(err, 'Task database not initialized');
  }
}

/**
 * Return a localized WorkGraph slice around one task.
 * @task T10628
 */
export async function taskSlice(
  projectRoot: string,
  taskId: string,
  options: {
    radius?: number;
    depth?: number;
    budget?: number;
    direction?: 'upstream' | 'downstream' | 'around';
    includeRelates?: boolean;
  } = {},
): Promise<EngineResult> {
  try {
    const result = await coreTaskSlice(projectRoot, taskId, options);
    return engineSuccess(result);
  } catch (err: unknown) {
    return nonCrudEngineError(err, 'Task database not initialized');
  }
}

/**
 * Overview of all dependencies across the project.
 * @task T1568
 * @epic T1566
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
    return engineSuccess(result);
  } catch (err: unknown) {
    return nonCrudEngineError(err, 'Failed to load deps overview');
  }
}

/**
 * Detect circular dependencies across the project.
 * @task T1568
 * @epic T1566
 */
export async function taskDepsCycles(projectRoot: string): Promise<
  EngineResult<{
    hasCycles: boolean;
    cycles: Array<{ path: string[]; tasks: Array<{ id: string; title: string }> }>;
  }>
> {
  try {
    const result = await coreTaskDepsCycles(projectRoot);
    return engineSuccess(result);
  } catch (err: unknown) {
    return nonCrudEngineError(err, 'Failed to detect cycles');
  }
}

/**
 * Run dep-graph validation — orphan, circular, cross-epic gap, stale-dep detection.
 *
 * Fetches ALL tasks including archived so that deps pointing to archived tasks
 * are correctly treated as satisfied rather than missing (T9158 / T1954).
 * Without archived tasks in the pool, `validateDependencyRefs` incorrectly
 * flags them as E_MISSING_REF because `queryTasks({})` excludes archived by
 * default.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param epicId - Optional epic ID to scope validation to direct children only.
 * @param scope - Which tasks to include: all, open, or critical-priority only.
 * @returns EngineResult with validation issues and summary.
 * @task T1857
 * @epic T1855
 */
export async function taskDepsValidate(
  projectRoot: string,
  epicId?: string,
  scope: DepValidateScope = 'all',
): Promise<EngineResult<DepGraphValidateResult>> {
  try {
    const accessor = await getTaskAccessor(projectRoot);
    // Fetch ALL tasks including archived — archived deps must resolve as satisfied,
    // not as missing refs (T9158). queryTasks({}) excludes archived by default, so
    // we explicitly request all known statuses.
    const { tasks: allTasks } = await accessor.queryTasks({
      status: [...TASK_STATUSES] as TaskStatus[],
    });
    const result = runValidation(allTasks, { epicId, scope });
    return engineSuccess(result);
  } catch (err: unknown) {
    return nonCrudEngineError(err, 'Failed to run dep-graph validation');
  }
}

/**
 * Render a dep-graph tree for a given epic in text, Mermaid, or JSON format.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param epicId - Epic ID to visualise.
 * @param format - Output format: 'text' | 'mermaid' | 'json'.
 * @returns EngineResult with rendered output and structured node/edge data.
 * @task T1857
 * @epic T1855
 */
export async function taskDepsTree(
  projectRoot: string,
  epicId: string,
  format: 'text' | 'mermaid' | 'json' = 'text',
): Promise<EngineResult<import('@cleocode/contracts').TasksDepsTreeResult>> {
  try {
    const accessor = await getTaskAccessor(projectRoot);
    const { tasks } = await accessor.queryTasks({});

    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    const epic = taskMap.get(epicId);
    if (!epic) {
      return engineError('E_NOT_FOUND', `Epic not found: ${epicId}`);
    }

    // Gather direct children (non-recursive — epic's immediate children only)
    const children = tasks.filter((t) => t.parentId === epicId);
    const scopedIds = new Set([epicId, ...children.map((t) => t.id)]);
    const scopedTasks = tasks.filter((t) => scopedIds.has(t.id));

    // Build nodes
    const nodes = scopedTasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      depends: (t.depends ?? []).filter((d) => scopedIds.has(d)),
    }));

    // Build edges (dep → dependent, scoped to epic children)
    const edges: Array<{ from: string; to: string }> = [];
    for (const node of nodes) {
      for (const depId of node.depends) {
        if (scopedIds.has(depId)) {
          edges.push({ from: depId, to: node.id });
        }
      }
    }

    // Compute critical path (longest chain) via longest-path in DAG
    const criticalPath = computeCriticalPath(nodes, edges, epicId);

    let rendered: string | null = null;
    if (format === 'text') {
      rendered = renderTextTree(nodes, edges, criticalPath);
    } else if (format === 'mermaid') {
      rendered = renderMermaidTree(nodes, edges, criticalPath);
    }

    return engineSuccess({
      epicId,
      format,
      rendered,
      nodes,
      edges,
      criticalPath,
    });
  } catch (err: unknown) {
    return nonCrudEngineError(err, 'Failed to render dep tree');
  }
}

/**
 * Compute task statistics, optionally scoped to an epic.
 * @task T1568
 * @epic T1566
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
    return engineSuccess(result);
  } catch (err: unknown) {
    return nonCrudEngineError(err, 'Task database not initialized');
  }
}

/**
 * Export tasks as JSON or CSV.
 * @task T1568
 * @epic T1566
 */
export async function taskExport(
  projectRoot: string,
  params?: { format?: 'json' | 'csv'; status?: string; parent?: string },
): Promise<EngineResult<unknown>> {
  try {
    const result = await coreTaskExport(projectRoot, params);
    return engineSuccess(result);
  } catch (err: unknown) {
    return nonCrudEngineError(err, 'Task database not initialized');
  }
}

/**
 * Get task history from the log file.
 * @task T1568
 * @epic T1566
 */
export async function taskHistory(
  projectRoot: string,
  taskId: string,
  limit?: number,
): Promise<EngineResult<Array<Record<string, unknown>>>> {
  try {
    const result = await coreTaskHistory(projectRoot, taskId, limit);
    return engineSuccess(result);
  } catch (err: unknown) {
    return nonCrudEngineError(err, 'Failed to read task history');
  }
}

/**
 * Lint tasks for common issues.
 * @task T1568
 * @epic T1566
 */
export async function taskLint(
  projectRoot: string,
  taskId?: string,
): Promise<
  EngineResult<
    Array<{ taskId: string; severity: 'error' | 'warning'; rule: string; message: string }>
  >
> {
  try {
    const result = await coreTaskLint(projectRoot, taskId);
    return engineSuccess(result);
  } catch (err: unknown) {
    return nonCrudEngineError(err, 'Task database not initialized');
  }
}

/**
 * Validate multiple tasks at once.
 * @task T1568
 * @epic T1566
 */
export async function taskBatchValidate(
  projectRoot: string,
  taskIds: string[],
  checkMode: 'full' | 'quick' = 'full',
): Promise<
  EngineResult<{
    results: Record<
      string,
      Array<{ severity: 'error' | 'warning'; rule: string; message: string }>
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
    return engineSuccess(result);
  } catch (err: unknown) {
    return nonCrudEngineError(err, 'Task database not initialized');
  }
}

/**
 * Import tasks from a JSON source string or export package.
 * @task T1568
 * @epic T1566
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
    return engineSuccess(result);
  } catch (err: unknown) {
    return nonCrudEngineError(err, 'Failed to import tasks');
  }
}

/**
 * Atomically claim a task for an agent.
 * @task T1568
 * @epic T1566
 */
export async function taskClaim(
  projectRoot: string,
  taskId: string,
  agentId: string,
): Promise<EngineResult<{ taskId: string; agentId: string }>> {
  if (!taskId) return engineError('E_INVALID_INPUT', 'taskId is required');
  if (!agentId) return engineError('E_INVALID_INPUT', 'agentId is required');
  try {
    const acc = await getTaskAccessor(projectRoot);
    await acc.claimTask(taskId, agentId);
    return engineSuccess({ taskId, agentId });
  } catch (err: unknown) {
    return cleoErrorToEngineResult(err, 'E_INTERNAL', 'Failed to claim task');
  }
}

/**
 * Release an agent's claim on a task.
 * @task T1568
 * @epic T1566
 */
export async function taskUnclaim(
  projectRoot: string,
  taskId: string,
): Promise<EngineResult<{ taskId: string }>> {
  if (!taskId) return engineError('E_INVALID_INPUT', 'taskId is required');
  try {
    const acc = await getTaskAccessor(projectRoot);
    await acc.unclaimTask(taskId);
    return engineSuccess({ taskId });
  } catch (err: unknown) {
    return cleoErrorToEngineResult(err, 'E_INTERNAL', 'Failed to unclaim task');
  }
}

/**
 * Build a bounded task-scoped context pack.
 * @task T10629
 * @task T10630
 */
export async function taskContext(
  projectRoot: string,
  params: TasksContextParams,
): Promise<EngineResult<TasksContextResult>> {
  try {
    const result = await coreTaskContext(projectRoot, params);
    return engineSuccess(result);
  } catch (err: unknown) {
    return nonCrudEngineError(err, 'Task database not initialized');
  }
}
