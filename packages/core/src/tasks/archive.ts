/**
 * Batch archive completed tasks.
 * @task T4461
 * @epic T4454
 */

import type { Task, TaskStatus } from '@cleocode/contracts';
import type { DataAccessor } from '../store/data-accessor.js';
import { getAccessor } from '../store/data-accessor.js';
import { safeAppendLog } from '../store/data-safety-central.js';

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
 * Moves them from active task data to archive.
 * @task T4461
 */
export async function archiveTasks(
  options: ArchiveTasksOptions = {},
  cwd?: string,
  accessor?: DataAccessor,
): Promise<ArchiveTasksResult> {
  const acc = accessor ?? (await getAccessor(cwd));
  const includeCancelled = options.includeCancelled ?? true;

  // Determine which tasks to archive using targeted queries
  let candidates: Task[];

  if (options.taskIds?.length) {
    candidates = await acc.loadTasks(options.taskIds);
  } else {
    const statuses: TaskStatus[] = includeCancelled ? ['done', 'cancelled'] : ['done'];
    const { tasks } = await acc.queryTasks({ status: statuses });
    candidates = tasks;
  }

  // Apply date filter
  if (options.before) {
    const beforeDate = new Date(options.before).getTime();
    candidates = candidates.filter((t) => {
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
      const activeCount = await acc.countActiveChildren(task.id);
      if (activeCount > 0) {
        skipped.push(task.id);
        continue;
      }
    }

    archived.push(task.id);
  }

  // For total count, query active task count
  const totalActive = await acc.countTasks();

  if (options.dryRun) {
    return {
      archived,
      skipped,
      total: totalActive,
      dryRun: true,
    };
  }

  if (archived.length === 0) {
    return { archived: [], skipped, total: totalActive };
  }

  // Archive each task using targeted writes
  const now = new Date().toISOString();
  const archivedSet = new Set(archived);
  const tasksToArchive = candidates.filter((t) => archivedSet.has(t.id));

  for (const t of tasksToArchive) {
    await acc.archiveSingleTask(t.id, {
      archivedAt: now,
      archiveReason: t.status === 'cancelled' ? 'cancelled' : 'completed',
    });
  }

  await safeAppendLog(
    acc,
    {
      id: `log-${Math.floor(Date.now() / 1000)}-${(await import('node:crypto')).randomBytes(3).toString('hex')}`,
      timestamp: new Date().toISOString(),
      action: 'tasks_archived',
      taskId: archived.join(','),
      actor: 'system',
      details: { count: archived.length, ids: archived },
      before: null,
      after: { count: archived.length, ids: archived },
    },
    cwd,
  );

  return { archived, skipped, total: totalActive };
}
