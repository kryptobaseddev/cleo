/**
 * Task deletion (soft delete to archive).
 * @task T4461
 * @epic T4454
 */

import type { DataAccessor } from '../store/data-accessor.js';
import { getAccessor } from '../store/data-accessor.js';
import { safeAppendLog } from '../store/data-safety-central.js';
import { ExitCode } from '@cleocode/contracts';
import type { Task } from '@cleocode/contracts';
import { CleoError } from '../errors.js';

/** Options for deleting a task. */
export interface DeleteTaskOptions {
  taskId: string;
  force?: boolean;
  cascade?: boolean;
}

/** Result of deleting a task. */
export interface DeleteTaskResult {
  deletedTask: Task;
  cascadeDeleted?: string[];
}

/**
 * Delete a task (soft delete - moves to archive).
 * @task T4461
 */
export async function deleteTask(
  options: DeleteTaskOptions,
  cwd?: string,
  accessor?: DataAccessor,
): Promise<DeleteTaskResult> {
  const acc = accessor ?? (await getAccessor(cwd));

  // Targeted load: fetch only the task being deleted
  const task = await acc.loadSingleTask(options.taskId);
  if (!task) {
    throw new CleoError(ExitCode.NOT_FOUND, `Task not found: ${options.taskId}`, {
      fix: `Use 'cleo find "${options.taskId}"' to search`,
    });
  }

  const cascadeDeleted: string[] = [];

  // Check for children using targeted query
  const children = await acc.getChildren(options.taskId);
  if (children.length > 0) {
    if (!options.cascade && !options.force) {
      throw new CleoError(
        ExitCode.HAS_CHILDREN,
        `Task ${options.taskId} has ${children.length} children. Use --cascade to delete children or --force to orphan them.`,
        {
          alternatives: [
            { action: 'Delete with children', command: `cleo delete ${options.taskId} --cascade` },
            {
              action: 'Force delete (orphan children)',
              command: `cleo delete ${options.taskId} --force`,
            },
          ],
        },
      );
    }

    if (options.cascade) {
      // Use CTE-based subtree query for all descendants
      const subtree = await acc.getSubtree(options.taskId);
      for (const t of subtree) {
        if (t.id !== options.taskId) {
          cascadeDeleted.push(t.id);
        }
      }
    } else if (options.force) {
      // Orphan children by clearing their parentId
      for (const child of children) {
        child.parentId = null;
        child.type = 'task';
        await acc.upsertSingleTask(child);
      }
    }
  }

  // Check for dependents (other tasks depending on this one)
  if (!options.force) {
    const dependents = await acc.getDependents(options.taskId);
    if (dependents.length > 0) {
      throw new CleoError(
        ExitCode.HAS_DEPENDENTS,
        `Task ${options.taskId} is a dependency of: ${dependents.map((d) => d.id).join(', ')}`,
        { fix: `Use --force to delete anyway or remove the dependency first` },
      );
    }
  }

  // Determine IDs to delete
  const idsToDelete = new Set<string>([options.taskId, ...cascadeDeleted]);

  // Archive each deleted task
  const now = new Date().toISOString();
  for (const id of idsToDelete) {
    await acc.archiveSingleTask(id, {
      archivedAt: now,
      archiveReason: 'deleted',
    });
  }

  // Clean up dependency references on tasks that depended on deleted tasks
  for (const deletedId of idsToDelete) {
    const dependents = await acc.getDependents(deletedId);
    for (const dep of dependents) {
      if (!idsToDelete.has(dep.id)) {
        dep.depends = (dep.depends ?? []).filter((d) => !idsToDelete.has(d));
        if (dep.depends.length === 0) delete dep.depends;
        await acc.upsertSingleTask(dep);
      }
    }
  }

  await safeAppendLog(
    acc,
    {
      id: `log-${Math.floor(Date.now() / 1000)}-${(await import('node:crypto')).randomBytes(3).toString('hex')}`,
      timestamp: new Date().toISOString(),
      action: 'task_deleted',
      taskId: options.taskId,
      actor: 'system',
      details: {
        title: task.title,
        cascadeDeleted: cascadeDeleted.length > 0 ? cascadeDeleted : undefined,
      },
      before: null,
      after: {
        title: task.title,
        cascadeDeleted: cascadeDeleted.length > 0 ? cascadeDeleted : undefined,
      },
    },
    cwd,
  );

  return {
    deletedTask: task,
    ...(cascadeDeleted.length > 0 && { cascadeDeleted }),
  };
}
