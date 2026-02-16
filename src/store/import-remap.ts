/**
 * ID remapping logic for import system.
 * Ported from lib/data/import-remap.sh
 *
 * @epic T4454
 * @task T4530
 */

import type { Task } from '../types/task.js';

/** Forward and reverse remap tables. */
export interface RemapTable {
  forward: Map<string, string>; // source -> new
  reverse: Map<string, string>; // new -> source
}

/**
 * Get the next available task ID number from existing tasks.
 */
export function getNextAvailableId(tasks: Task[]): number {
  if (tasks.length === 0) return 1;
  const maxId = tasks.reduce((max, t) => {
    const num = parseInt(t.id.replace('T', ''), 10);
    return isNaN(num) ? max : Math.max(max, num);
  }, 0);
  return maxId + 1;
}

/**
 * Generate a remap table for importing tasks.
 * Maps source task IDs to new sequential IDs starting from nextAvailable.
 */
export function generateRemapTable(
  sourceTaskIds: string[],
  existingTasks: Task[],
): RemapTable {
  const forward = new Map<string, string>();
  const reverse = new Map<string, string>();
  let nextId = getNextAvailableId(existingTasks);

  for (const sourceId of sourceTaskIds) {
    const newId = `T${String(nextId).padStart(3, '0')}`;
    forward.set(sourceId, newId);
    reverse.set(newId, sourceId);
    nextId++;
  }

  return { forward, reverse };
}

/**
 * Validate that a remap table is complete and consistent.
 */
export function validateRemapTable(
  table: RemapTable,
  expectedSourceIds: string[],
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Check completeness
  for (const id of expectedSourceIds) {
    if (!table.forward.has(id)) {
      errors.push(`Missing mapping for source ID: ${id}`);
    }
  }

  // Check consistency
  for (const [source, target] of table.forward) {
    const reverseSource = table.reverse.get(target);
    if (reverseSource !== source) {
      errors.push(`Inconsistent mapping: ${source} -> ${target} -> ${reverseSource}`);
    }
  }

  // Check ID format
  for (const newId of table.reverse.keys()) {
    if (!/^T\d{3,}$/.test(newId)) {
      errors.push(`Invalid new task ID format: ${newId}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Remap a single task ID, returning original if not in table.
 */
export function remapTaskId(taskId: string | null, table: RemapTable): string | null {
  if (!taskId) return null;
  return table.forward.get(taskId) ?? taskId;
}

/**
 * Remap all ID references in a task.
 */
export function remapTaskReferences(
  task: Task,
  table: RemapTable,
  existingTaskIds: Set<string>,
  missingDepStrategy: 'strip' | 'fail' = 'strip',
): Task {
  const newId = table.forward.get(task.id);
  if (!newId) throw new Error(`No mapping for task ${task.id}`);

  // Remap parent
  let newParentId: string | null | undefined = undefined;
  if (task.parentId) {
    if (table.forward.has(task.parentId)) {
      newParentId = table.forward.get(task.parentId)!;
    } else if (existingTaskIds.has(task.parentId)) {
      newParentId = task.parentId;
    } else {
      newParentId = null; // Orphan
    }
  }

  // Remap dependencies
  let newDepends: string[] | undefined = undefined;
  if (task.depends?.length) {
    newDepends = [];
    for (const dep of task.depends) {
      if (table.forward.has(dep)) {
        newDepends.push(table.forward.get(dep)!);
      } else if (existingTaskIds.has(dep)) {
        newDepends.push(dep);
      } else if (missingDepStrategy === 'fail') {
        throw new Error(`Missing dependency ${dep} for task ${task.id}`);
      }
      // 'strip' strategy: just skip missing deps
    }
  }

  return {
    ...task,
    id: newId,
    ...(newParentId !== undefined ? { parentId: newParentId } : {}),
    ...(newDepends !== undefined ? { depends: newDepends } : {}),
  };
}

/**
 * Detect duplicate titles between import and target.
 */
export function detectDuplicateTitles(
  importTasks: Task[],
  existingTasks: Task[],
): Array<{ sourceId: string; title: string; existingId: string }> {
  const titleMap = new Map<string, string>();
  for (const t of existingTasks) {
    titleMap.set(t.title.toLowerCase(), t.id);
  }

  const conflicts: Array<{ sourceId: string; title: string; existingId: string }> = [];
  for (const t of importTasks) {
    const existing = titleMap.get(t.title.toLowerCase());
    if (existing) {
      conflicts.push({ sourceId: t.id, title: t.title, existingId: existing });
    }
  }

  return conflicts;
}

/**
 * Resolve duplicate title by appending suffix.
 */
export function resolveDuplicateTitle(
  title: string,
  existingTitles: Set<string>,
): string {
  let candidate = `${title} (imported)`;
  if (!existingTitles.has(candidate.toLowerCase())) return candidate;

  for (let i = 2; i <= 1000; i++) {
    candidate = `${title} (imported-${i})`;
    if (!existingTitles.has(candidate.toLowerCase())) return candidate;
  }

  return candidate;
}
