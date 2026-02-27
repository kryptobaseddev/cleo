/**
 * Task deletion (soft delete to archive).
 * @task T4461
 * @epic T4454
 */

import { readJsonRequired, readJson, saveJson, computeChecksum } from '../../store/json.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import type { Task, TaskFile } from '../../types/task.js';
import { getTaskPath, getArchivePath, getLogPath, getBackupDir } from '../paths.js';
import { logOperation } from './add.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import {
  safeSaveTaskFile,
  safeSaveArchive,
  safeAppendLog,
} from '../../store/data-safety-central.js';

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
export async function deleteTask(options: DeleteTaskOptions, cwd?: string, accessor?: DataAccessor): Promise<DeleteTaskResult> {
  const taskPath = getTaskPath(cwd);
  const archivePath = getArchivePath(cwd);
  const logPath = getLogPath(cwd);
  const backupDir = getBackupDir(cwd);

  const data = accessor
    ? await accessor.loadTaskFile()
    : await readJsonRequired<TaskFile>(taskPath);

  const taskIdx = data.tasks.findIndex(t => t.id === options.taskId);
  if (taskIdx === -1) {
    throw new CleoError(
      ExitCode.NOT_FOUND,
      `Task not found: ${options.taskId}`,
      { fix: `Use 'cleo find "${options.taskId}"' to search` },
    );
  }

  const task = data.tasks[taskIdx]!;
  const cascadeDeleted: string[] = [];

  // Check for children
  const children = data.tasks.filter(t => t.parentId === options.taskId);
  if (children.length > 0) {
    if (!options.cascade && !options.force) {
      throw new CleoError(
        ExitCode.HAS_CHILDREN,
        `Task ${options.taskId} has ${children.length} children. Use --cascade to delete children or --force to orphan them.`,
        {
          alternatives: [
            { action: 'Delete with children', command: `cleo delete ${options.taskId} --cascade` },
            { action: 'Force delete (orphan children)', command: `cleo delete ${options.taskId} --force` },
          ],
        },
      );
    }

    if (options.cascade) {
      // Recursively find all descendants
      const toDelete = new Set<string>([options.taskId]);
      const findDescendants = (parentId: string) => {
        for (const t of data.tasks) {
          if (t.parentId === parentId && !toDelete.has(t.id)) {
            toDelete.add(t.id);
            cascadeDeleted.push(t.id);
            findDescendants(t.id);
          }
        }
      };
      findDescendants(options.taskId);
    } else if (options.force) {
      // Orphan children by clearing their parentId
      for (const child of children) {
        child.parentId = null;
        child.type = 'task';
      }
    }
  }

  // Check for dependents (other tasks depending on this one)
  if (!options.force) {
    const dependents = data.tasks.filter(t =>
      t.depends?.includes(options.taskId) && t.id !== options.taskId,
    );
    if (dependents.length > 0) {
      throw new CleoError(
        ExitCode.HAS_DEPENDENTS,
        `Task ${options.taskId} is a dependency of: ${dependents.map(d => d.id).join(', ')}`,
        { fix: `Use --force to delete anyway or remove the dependency first` },
      );
    }
  }

  // Determine tasks to move to archive
  const idsToDelete = new Set<string>([options.taskId, ...cascadeDeleted]);
  const tasksToArchive = data.tasks.filter(t => idsToDelete.has(t.id));
  const remainingTasks = data.tasks.filter(t => !idsToDelete.has(t.id));

  // Read/create archive
  let archive: { archivedTasks: Task[]; version?: string } | null;
  if (accessor) {
    archive = await accessor.loadArchive();
  } else {
    archive = await readJson<{ archivedTasks: Task[]; version?: string }>(archivePath);
  }
  if (!archive) {
    archive = { archivedTasks: [], version: '1.0.0' };
  }

  // Move tasks to archive
  const now = new Date().toISOString();
  for (const t of tasksToArchive) {
    (t as Task & { archivedAt?: string }).archivedAt = now;
    archive.archivedTasks.push(t);
  }

  // Clean up dependency references — track which tasks were modified
  const depsModifiedIds = new Set<string>();
  for (const t of remainingTasks) {
    if (t.depends) {
      const before = t.depends.length;
      t.depends = t.depends.filter(d => !idsToDelete.has(d));
      if (t.depends.length !== before) depsModifiedIds.add(t.id);
      if (t.depends.length === 0) delete t.depends;
    }
  }

  // Update data
  data.tasks = remainingTasks;
  data._meta.checksum = computeChecksum(data.tasks);
  data.lastUpdated = now;

  if (accessor) {
    if (accessor.removeSingleTask && accessor.archiveSingleTask) {
      // Fine-grained path: archive each deleted task
      for (const t of tasksToArchive) {
        await accessor.archiveSingleTask(t.id, {
          archivedAt: now,
          archiveReason: 'deleted',
        });
      }
      // If force-orphaning children, upsert each orphaned child
      if (options.force && !options.cascade && children.length > 0 && accessor.upsertSingleTask) {
        for (const child of children) {
          await accessor.upsertSingleTask(child);
        }
      }
      // Clean up dependency references on remaining tasks that were modified
      if (depsModifiedIds.size > 0 && accessor.upsertSingleTask) {
        for (const t of remainingTasks) {
          if (depsModifiedIds.has(t.id)) {
            await accessor.upsertSingleTask(t);
          }
        }
      }
    } else {
      await safeSaveTaskFile(accessor, data, cwd);
      await safeSaveArchive(accessor, archive, cwd);
    }
    await safeAppendLog(accessor, {
      id: `log-${Math.floor(Date.now() / 1000)}-${(await import('node:crypto')).randomBytes(3).toString('hex')}`,
      timestamp: new Date().toISOString(),
      action: 'task_deleted',
      taskId: options.taskId,
      actor: 'system',
      details: { title: task.title, cascadeDeleted: cascadeDeleted.length > 0 ? cascadeDeleted : undefined },
      before: null,
      after: { title: task.title, cascadeDeleted: cascadeDeleted.length > 0 ? cascadeDeleted : undefined },
    }, cwd);
  } else {
    await saveJson(taskPath, data, { backupDir });
    await saveJson(archivePath, archive, { backupDir });
    await logOperation(logPath, 'task_deleted', options.taskId, {
      title: task.title,
      cascadeDeleted: cascadeDeleted.length > 0 ? cascadeDeleted : undefined,
    });
  }

  return {
    deletedTask: task,
    ...(cascadeDeleted.length > 0 && { cascadeDeleted }),
  };
}
