/**
 * Core import logic — import tasks from export files.
 *
 * Extracted from CLI import command for dispatch layer access.
 *
 * @task T5323, T5328
 */

import { constants as fsConstants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { getAccessor } from '../../store/data-accessor.js';
import { computeChecksum } from '../../store/json.js';
import type { Task, TaskPriority, TaskStatus } from '../../types/task.js';

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

export interface ImportParams {
  file: string;
  parent?: string;
  phase?: string;
  onDuplicate?: DuplicateStrategy;
  addLabel?: string;
  dryRun?: boolean;
  cwd?: string;
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
export async function importTasks(params: ImportParams): Promise<ImportResult> {
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

  const accessor = await getAccessor(params.cwd);
  const data = await accessor.loadTaskFile();

  const existingIds = new Set(data.tasks.map((t) => t.id));
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
          const idx = data.tasks.findIndex((t) => t.id === importTask.id);
          if (idx !== -1) data.tasks[idx] = importTask;
          break;
        }
        case 'rename': {
          const newId = generateTaskId(existingIds);
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

    if (duplicateStrategy !== 'overwrite' || !isDuplicate) {
      data.tasks.push(importTask);
      existingIds.add(importTask.id);
    }

    imported.push(importTask);
  }

  if (params.dryRun) {
    return {
      imported: imported.length,
      skipped: skipped.length,
      renamed,
      totalTasks: data.tasks.length,
      dryRun: true,
    };
  }

  data._meta.checksum = computeChecksum(data.tasks);
  data.lastUpdated = new Date().toISOString();
  await accessor.saveTaskFile(data);

  return {
    imported: imported.length,
    skipped: skipped.length,
    renamed,
    totalTasks: data.tasks.length,
  };
}
