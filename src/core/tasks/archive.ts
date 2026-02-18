/**
 * Batch archive completed tasks.
 * @task T4461
 * @epic T4454
 */

import { readJsonRequired, readJson, saveJson, computeChecksum } from '../../store/json.js';
import type { Task, TodoFile } from '../../types/task.js';
import { getTodoPath, getArchivePath, getLogPath, getBackupDir } from '../paths.js';
import { logOperation } from './add.js';
import type { DataAccessor } from '../../store/data-accessor.js';

/** Options for archiving tasks. */
export interface ArchiveTasksOptions {
  /** Only archive tasks completed before this date (ISO string). */
  before?: string;
  /** Specific task IDs to archive. */
  taskIds?: string[];
  /** Archive cancelled tasks too. Default: true. */
  includeCancelled?: boolean;
  /** Dry run mode. */
  dryRun?: boolean;
}

/** Result of archiving tasks. */
export interface ArchiveTasksResult {
  archived: string[];
  skipped: string[];
  total: number;
  dryRun?: boolean;
}

/**
 * Archive completed (and optionally cancelled) tasks.
 * Moves them from todo.json to todo-archive.json.
 * @task T4461
 */
export async function archiveTasks(options: ArchiveTasksOptions = {}, cwd?: string, accessor?: DataAccessor): Promise<ArchiveTasksResult> {
  const todoPath = getTodoPath(cwd);
  const archivePath = getArchivePath(cwd);
  const logPath = getLogPath(cwd);
  const backupDir = getBackupDir(cwd);

  const data = accessor
    ? await accessor.loadTodoFile()
    : await readJsonRequired<TodoFile>(todoPath);
  const includeCancelled = options.includeCancelled ?? true;

  // Determine which tasks to archive
  let candidates: Task[];

  if (options.taskIds?.length) {
    candidates = data.tasks.filter(t => options.taskIds!.includes(t.id));
  } else {
    candidates = data.tasks.filter(t => {
      if (t.status === 'done') return true;
      if (includeCancelled && t.status === 'cancelled') return true;
      return false;
    });
  }

  // Apply date filter
  if (options.before) {
    const beforeDate = new Date(options.before).getTime();
    candidates = candidates.filter(t => {
      const completedAt = t.completedAt ?? t.cancelledAt ?? t.updatedAt;
      if (!completedAt) return false;
      return new Date(completedAt).getTime() < beforeDate;
    });
  }

  // Check for tasks that can't be archived
  const archived: string[] = [];
  const skipped: string[] = [];

  for (const task of candidates) {
    // Skip tasks that aren't done/cancelled
    if (task.status !== 'done' && task.status !== 'cancelled') {
      skipped.push(task.id);
      continue;
    }

    // Skip epics that have non-archived children
    if (task.type === 'epic') {
      const activeChildren = data.tasks.filter(
        t => t.parentId === task.id && t.status !== 'done' && t.status !== 'cancelled',
      );
      if (activeChildren.length > 0) {
        skipped.push(task.id);
        continue;
      }
    }

    archived.push(task.id);
  }

  if (options.dryRun) {
    return {
      archived,
      skipped,
      total: data.tasks.length,
      dryRun: true,
    };
  }

  if (archived.length === 0) {
    return { archived: [], skipped, total: data.tasks.length };
  }

  // Move tasks to archive
  const archivedSet = new Set(archived);
  const tasksToArchive = data.tasks.filter(t => archivedSet.has(t.id));
  const remainingTasks = data.tasks.filter(t => !archivedSet.has(t.id));

  // Read/create archive file
  let archiveData: { archivedTasks: Task[]; version?: string } | null;
  if (accessor) {
    archiveData = await accessor.loadArchive();
  } else {
    archiveData = await readJson<{ archivedTasks: Task[]; version?: string }>(archivePath);
  }
  if (!archiveData) {
    archiveData = { archivedTasks: [], version: '1.0.0' };
  }

  const now = new Date().toISOString();
  for (const t of tasksToArchive) {
    (t as Task & { archivedAt?: string }).archivedAt = now;
    archiveData.archivedTasks.push(t);
  }

  // Update todo.json
  data.tasks = remainingTasks;
  data._meta.checksum = computeChecksum(remainingTasks);
  data.lastUpdated = now;

  if (accessor) {
    await accessor.saveTodoFile(data);
    await accessor.saveArchive(archiveData);
    await accessor.appendLog({
      id: `log-${Math.floor(Date.now() / 1000)}-${(await import('node:crypto')).randomBytes(3).toString('hex')}`,
      timestamp: new Date().toISOString(),
      action: 'tasks_archived',
      taskId: archived.join(','),
      actor: 'system',
      details: { count: archived.length, ids: archived },
      before: null,
      after: { count: archived.length, ids: archived },
    });
  } else {
    await saveJson(todoPath, data, { backupDir });
    await saveJson(archivePath, archiveData, { backupDir });
    await logOperation(logPath, 'tasks_archived', archived.join(','), {
      count: archived.length,
      ids: archived,
    });
  }

  return { archived, skipped, total: data.tasks.length + archived.length };
}
