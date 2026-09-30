/**
 * Core import logic — import tasks from export files.
 *
 * Extracted from CLI import command for dispatch layer access.
 *
 * @task T5323, T5328
 */

import { constants as fsConstants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import type { AdminImportParams, Task, TaskPriority, TaskStatus } from '@cleocode/contracts';
import { allocateNextTaskId } from '../sequence/index.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { queryTasksIncludingArchived } from '../store/import-remap.js';

type DuplicateStrategy = 'skip' | 'overwrite' | 'rename';

function generateTaskId(existingIds: Set<string>): string {
  let maxNum = 0;
  for (const id of existingIds) {
    const num = parseInt(id.replace('T', ''), 10);
    if (!Number.isNaN(num) && num > maxNum) maxNum = num;
  }
  const newId = `T${String(maxNum + 1).padStart(4, '0')}`;
  existingIds.add(newId);
  return newId;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  renamed: Array<{ oldId: string; newId: string }>;
  totalTasks: number;
  dryRun?: boolean;
}

/**
 * Import tasks from an export file.
 */
export async function importTasks(
  projectRoot: string,
  params: AdminImportParams,
): Promise<ImportResult> {
  const { file } = params;

  try {
    await access(file, fsConstants.R_OK);
  } catch {
    throw new Error(`Import file not found: ${file}`);
  }

  const content = await readFile(file, 'utf-8');
  let importData: Record<string, unknown>;
  try {
    importData = JSON.parse(content);
  } catch {
    throw new Error(`Invalid JSON in import file: ${file}`);
  }

  let importTasks: Task[];
  if (Array.isArray(importData)) {
    importTasks = importData as Task[];
  } else if (Array.isArray(importData['tasks'])) {
    importTasks = importData['tasks'] as Task[];
  } else {
    throw new Error('Import file must contain a tasks array');
  }

  if (importTasks.length === 0) {
    return { imported: 0, skipped: 0, renamed: [], totalTasks: 0, dryRun: params.dryRun };
  }

  const accessor = await getTaskAccessor(projectRoot);
  // Duplicates are decided against every stored id, archived included: an
  // archived task still owns its id (T12724).
  const storedTasks = await queryTasksIncludingArchived(accessor);
  const existingTasks = storedTasks.filter((t) => t.status !== 'archived');

  const existingIds = new Set(storedTasks.map((t) => t.id));
  // The ids stored before this import (existingIds grows as tasks are queued).
  const existingTaskIds = new Set(existingIds);
  const duplicateStrategy: DuplicateStrategy = params.onDuplicate ?? 'skip';
  const parentId = params.parent;
  const phase = params.phase;
  const addLabel = params.addLabel;

  const idMapping = new Map<string, string>();
  const imported: Task[] = [];
  const skipped: string[] = [];
  const renamed: Array<{ oldId: string; newId: string }> = [];

  for (const importTask of importTasks) {
    const isDuplicate = existingIds.has(importTask.id);

    if (isDuplicate) {
      switch (duplicateStrategy) {
        case 'skip': {
          skipped.push(importTask.id);
          continue;
        }
        case 'overwrite': {
          // Will be upserted below
          break;
        }
        case 'rename': {
          // A dry run predicts; a real import takes the id from the allocator (T12724).
          const newId = params.dryRun
            ? generateTaskId(existingIds)
            : await allocateNextTaskId(projectRoot);
          existingIds.add(newId);
          idMapping.set(importTask.id, newId);
          renamed.push({ oldId: importTask.id, newId });
          importTask.id = newId;
          break;
        }
      }
    }

    if (parentId) importTask.parentId = parentId;
    if (phase) importTask.phase = phase;
    if (addLabel) {
      importTask.labels = importTask.labels ?? [];
      if (!importTask.labels.includes(addLabel)) {
        importTask.labels.push(addLabel);
      }
    }

    importTask.status = importTask.status ?? ('pending' as TaskStatus);
    importTask.priority = importTask.priority ?? ('medium' as TaskPriority);
    importTask.createdAt = importTask.createdAt ?? new Date().toISOString();
    importTask.updatedAt = new Date().toISOString();

    if (importTask.depends) {
      importTask.depends = importTask.depends.map((depId) => idMapping.get(depId) ?? depId);
    }
    if (importTask.parentId && idMapping.has(importTask.parentId)) {
      importTask.parentId = idMapping.get(importTask.parentId)!;
    }

    existingIds.add(importTask.id);
    imported.push(importTask);
  }

  const totalTasks =
    existingTasks.length + imported.filter((t) => !existingTasks.some((e) => e.id === t.id)).length;

  if (params.dryRun) {
    return {
      imported: imported.length,
      skipped: skipped.length,
      renamed,
      totalTasks,
      dryRun: true,
    };
  }

  // Only the 'overwrite' duplicate strategy may replace a stored task; every
  // other imported task is new and must not overwrite on an id collision. One
  // transaction: a collision leaves nothing half-imported (T12724).
  await accessor.transaction(async (tx) => {
    for (const task of imported) {
      // An overwrite replaces a stored task with a different one: its identity
      // is cleared for the fill to re-derive, or refused once shared; a new
      // task's uid is derived, never stamped at import time (T12806).
      if (duplicateStrategy === 'overwrite' && existingTaskIds.has(task.id)) {
        await tx.upsertSingleTask(task);
        await tx.clearTaskIdentity?.(task.id);
      } else await tx.insertNewTask(task, { origin: 'imported' });
    }
  });

  return {
    imported: imported.length,
    skipped: skipped.length,
    renamed,
    totalTasks,
  };
}
