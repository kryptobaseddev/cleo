/**
 * Show full task details by ID.
 * @task T4460
 * @epic T4454
 */

import type { Task, TaskRecord, TaskRef } from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts';
import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { CleoError } from '../errors.js';
import { getLifecycleStatus } from '../lifecycle/index.js';
import { getIvtrState } from '../lifecycle/ivtr-loop.js';
import type { NextDirectives } from '../mvi-helpers.js';
import { taskShowNext } from '../mvi-helpers.js';
import type { DataAccessor } from '../store/data-accessor.js';
import { getAccessor } from '../store/data-accessor.js';
import { computeTaskView, type TaskView } from './compute-task-view.js';
import {
  type IvtrHistoryEntry,
  type LifecycleStageEntry,
  taskToRecord,
  toHistoryEntry,
} from './engine-converters.js';

/** Enriched task with hierarchy info. */
export interface TaskDetail extends Task {
  children?: string[];
  dependencyStatus?: TaskRef[];
  unresolvedDeps?: TaskRef[];
  dependents?: string[];
  hierarchyPath?: string[];
  isArchived?: boolean;
  /** Progressive disclosure directives for follow-up operations. */
  _next?: NextDirectives;
}

/**
 * Get a task by ID with enriched details.
 * Checks active tasks first, then archive if not found.
 * @task T4460
 */
export async function showTask(
  taskId: string,
  cwd?: string,
  accessor?: DataAccessor,
): Promise<TaskDetail> {
  if (!taskId) {
    throw new CleoError(ExitCode.INVALID_INPUT, 'Task ID is required', {
      fix: 'cleo show T###',
      details: { field: 'taskId' },
    });
  }

  const acc = accessor ?? (await getAccessor(cwd));

  // First, try to find in active tasks via targeted query
  let task = await acc.loadSingleTask(taskId);
  let isArchived = false;

  // If not found in active tasks, check the archive
  if (!task) {
    const archive = await acc.loadArchive();
    if (archive) {
      task = archive.archivedTasks.find((t) => t.id === taskId) ?? null;
      if (task) {
        isArchived = true;
      }
    }
  }

  if (!task) {
    throw new CleoError(ExitCode.NOT_FOUND, `Task not found: ${taskId}`, {
      fix: `Use 'cleo find "${taskId}"' to search for similar IDs`,
      alternatives: [
        { action: 'Search for task', command: `cleo find "${taskId}"` },
        { action: 'List all tasks', command: 'cleo list' },
      ],
    });
  }

  const detail: TaskDetail = { ...task, isArchived };

  // Add children (only check active tasks, archived tasks don't have active children)
  if (!isArchived) {
    const children = await acc.getChildren(taskId);
    if (children.length > 0) {
      detail.children = children.map((c) => c.id);
    }

    // Add dependency status
    if (task.depends?.length) {
      const depTasks = await acc.loadTasks(task.depends);
      detail.dependencyStatus = task.depends.map((depId) => {
        const dep = depTasks.find((t) => t.id === depId);
        return {
          id: depId,
          status: dep?.status ?? 'unknown',
          title: dep?.title ?? 'Unknown task',
        };
      });

      // Add unresolvedDeps: only unresolved dependencies (not done/cancelled)
      const unresolved = detail.dependencyStatus.filter(
        (d) => d.status !== 'done' && d.status !== 'cancelled',
      );
      if (unresolved.length > 0) {
        detail.unresolvedDeps = unresolved;
      }
    }

    // Add dependents: tasks that depend on this one
    const dependentTasks = await acc.getDependents(taskId);
    if (dependentTasks.length > 0) {
      detail.dependents = dependentTasks.map((t) => t.id);
    }

    // Build hierarchy path via recursive ancestor chain (root-first, then append self)
    const ancestors = await acc.getAncestorChain(taskId);
    if (ancestors.length > 0) {
      detail.hierarchyPath = [...ancestors.map((t) => t.id), taskId];
    }
  }

  detail._next = taskShowNext(taskId);

  return detail;
}

// ---------------------------------------------------------------------------
// EngineResult-returning wrappers (T1568 / ADR-057 / ADR-058)
// These wrappers allow the dispatch layer to import from @cleocode/core/internal
// instead of task-engine.ts. Each function has identical semantics to its
// counterpart in task-engine.ts.
// ---------------------------------------------------------------------------

/**
 * Convert a caught error to an EngineResult failure.
 * Mirrors cleoErrorToEngineError from dispatch/_error.ts without cross-layer import.
 */
function caughtToEngineError<T>(
  err: unknown,
  fallbackCode: string,
  fallbackMsg: string,
): EngineResult<T> {
  const e = err as { code?: number; message?: string };
  const code = e?.code === 4 ? 'E_NOT_FOUND' : e?.code === 2 ? 'E_INVALID_INPUT' : fallbackCode;
  return engineError<T>(code, e?.message ?? fallbackMsg);
}

/**
 * Get a single task by ID, wrapped in EngineResult.
 *
 * Fetches the full task record and computes the canonical TaskView.
 *
 * @param projectRoot - Absolute path to the project root
 * @param taskId - Task identifier (e.g. "T001")
 * @returns EngineResult containing the task record and canonical view
 *
 * @task T1568
 * @epic T1566
 */
export async function taskShow(
  projectRoot: string,
  taskId: string,
): Promise<EngineResult<{ task: TaskRecord; view: TaskView | null }>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const detail = await showTask(taskId, projectRoot, accessor);
    const view = await computeTaskView(taskId, accessor);
    return engineSuccess({ task: taskToRecord(detail), view });
  } catch (err: unknown) {
    return caughtToEngineError(err, 'E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * Get a single task by ID, optionally including its lifecycle stage history.
 *
 * @param projectRoot - Absolute path to the project root
 * @param taskId - Task identifier (e.g. "T042")
 * @param includeHistory - When true, append lifecycle stage array
 * @returns EngineResult containing the task record and optional history
 *
 * @task T1568
 * @epic T1566
 */
export async function taskShowWithHistory(
  projectRoot: string,
  taskId: string,
  includeHistory: boolean,
): Promise<EngineResult<{ task: TaskRecord; history?: LifecycleStageEntry[] }>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const detail = await showTask(taskId, projectRoot, accessor);
    const task = taskToRecord(detail);

    if (!includeHistory) {
      return engineSuccess({ task });
    }

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
      history = [];
    }

    return engineSuccess({ task, history });
  } catch (err: unknown) {
    return caughtToEngineError(err, 'E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * Retrieve the IVTR phase history for a task.
 *
 * @param projectRoot - Absolute path to the project root
 * @param taskId - Task identifier (e.g. "T042")
 * @returns EngineResult with ivtrHistory array
 *
 * @task T1568
 * @epic T1566
 */
export async function taskShowIvtrHistory(
  projectRoot: string,
  taskId: string,
): Promise<EngineResult<{ ivtrHistory: IvtrHistoryEntry[] }>> {
  try {
    const ivtrState = await getIvtrState(taskId, { cwd: projectRoot });
    if (!ivtrState) {
      return engineSuccess({ ivtrHistory: [] });
    }
    const ivtrHistory: IvtrHistoryEntry[] = ivtrState.phaseHistory.map(toHistoryEntry);
    return engineSuccess({ ivtrHistory });
  } catch (err: unknown) {
    return caughtToEngineError(err, 'E_NOT_INITIALIZED', 'Failed to read IVTR state');
  }
}

/**
 * Check if a task exists.
 *
 * Returns `{ exists: true }` if the task is found, `{ exists: false }` otherwise.
 * Never fails — catches all errors and returns false.
 *
 * @param projectRoot - Absolute path to the project root
 * @param taskId - Task identifier to check
 * @returns EngineResult with exists flag and the queried taskId
 *
 * @task T1568
 * @epic T1566
 */
export async function taskExists(
  projectRoot: string,
  taskId: string,
): Promise<EngineResult<{ exists: boolean; taskId: string }>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const exists = await accessor.taskExists(taskId);
    return engineSuccess({ exists, taskId });
  } catch {
    return engineSuccess({ exists: false, taskId });
  }
}
