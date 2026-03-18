/**
 * Show full task details by ID.
 * @task T4460
 * @epic T4454
 */

import type { DataAccessor } from '../store/data-accessor.js';
import { getAccessor } from '../store/data-accessor.js';
import { ExitCode } from '@cleocode/contracts';
import type { Task, TaskRef } from '@cleocode/contracts';
import { CleoError } from '../errors.js';

/** Enriched task with hierarchy info. */
export interface TaskDetail extends Task {
  children?: string[];
  dependencyStatus?: TaskRef[];
  unresolvedDeps?: TaskRef[];
  dependents?: string[];
  hierarchyPath?: string[];
  isArchived?: boolean;
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
    throw new CleoError(ExitCode.INVALID_INPUT, 'Task ID is required');
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

    // Build hierarchy path via recursive ancestor chain
    const ancestors = await acc.getAncestorChain(taskId);
    if (ancestors.length > 1) {
      detail.hierarchyPath = ancestors.map((t) => t.id);
    }
  }

  return detail;
}
