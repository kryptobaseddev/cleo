/**
 * Release guards - epic-completeness and double-listing checks.
 *
 * Pre-release validation to ensure all tasks in an epic are accounted for
 * and no task appears in multiple releases.
 *
 * @task T4454
 * @epic T4454
 */

import { readJson } from '../../store/json.js';
import { getTodoPath } from '../paths.js';
import type { TodoFile, Task } from '../../types/task.js';
import type { DataAccessor } from '../../store/data-accessor.js';

/** Epic completeness result. */
export interface EpicCompletenessResult {
  hasIncomplete: boolean;
  epics: Array<{
    epicId: string;
    epicTitle: string;
    totalChildren: number;
    includedChildren: number;
    missingChildren: Array<{ id: string; title: string; status: string }>;
  }>;
  orphanTasks: string[];
}

/**
 * Walk parent chain to find the epic ancestor of a task.
 */
function findEpicAncestor(
  taskId: string,
  tasksById: Map<string, Task>,
): string | null {
  const task = tasksById.get(taskId);
  if (!task) return null;
  if (task.type === 'epic') return taskId;

  // Walk up parent chain (max 3 levels)
  let current = task;
  for (let depth = 0; depth < 3; depth++) {
    if (!current.parentId) return null;
    const parent = tasksById.get(current.parentId);
    if (!parent) return null;
    if (parent.type === 'epic') return parent.id;
    current = parent;
  }
  return null;
}

/**
 * Check epic completeness for a set of release task IDs.
 * Verifies all children of each referenced epic are included.
 */
export async function checkEpicCompleteness(
  releaseTaskIds: string[],
  cwd?: string,
  accessor?: DataAccessor,
): Promise<EpicCompletenessResult> {
  const data = accessor
    ? await accessor.loadTodoFile()
    : await readJson<TodoFile>(getTodoPath(cwd));
  if (!data?.tasks) {
    return { hasIncomplete: false, epics: [], orphanTasks: [] };
  }

  const tasksById = new Map<string, Task>();
  for (const task of data.tasks) {
    tasksById.set(task.id, task);
  }

  const releaseSet = new Set(releaseTaskIds);

  // Map each release task to its epic
  const taskToEpic = new Map<string, string | null>();
  for (const taskId of releaseTaskIds) {
    taskToEpic.set(taskId, findEpicAncestor(taskId, tasksById));
  }

  // Find orphan tasks (no epic)
  const orphanTasks = releaseTaskIds.filter(id => !taskToEpic.get(id));

  // Group by epic
  const byEpic = new Map<string, string[]>();
  for (const [taskId, epicId] of taskToEpic) {
    if (!epicId) continue;
    if (!byEpic.has(epicId)) byEpic.set(epicId, []);
    byEpic.get(epicId)!.push(taskId);
  }

  // Check each epic for completeness
  const epics: EpicCompletenessResult['epics'] = [];
  let hasIncomplete = false;

  for (const [epicId, includedTasks] of byEpic) {
    const epic = tasksById.get(epicId);
    if (!epic) continue;

    // Find all children of this epic
    const allChildren = data.tasks.filter(t => t.parentId === epicId && t.id !== epicId);
    const includedSet = new Set(includedTasks);
    const missingChildren = allChildren
      .filter(t => !includedSet.has(t.id) && !releaseSet.has(t.id))
      .map(t => ({ id: t.id, title: t.title, status: t.status }));

    if (missingChildren.length > 0) hasIncomplete = true;

    epics.push({
      epicId,
      epicTitle: epic.title,
      totalChildren: allChildren.length,
      includedChildren: includedTasks.length,
      missingChildren,
    });
  }

  return { hasIncomplete, epics, orphanTasks };
}

/** Double-listing check result. */
export interface DoubleListingResult {
  hasDoubleListing: boolean;
  duplicates: Array<{
    taskId: string;
    releases: string[];
  }>;
}

/**
 * Check if any tasks are listed in multiple releases.
 */
export function checkDoubleListing(
  releaseTaskIds: string[],
  existingReleases: Array<{ version: string; tasks: string[] }>,
): DoubleListingResult {
  const duplicates: DoubleListingResult['duplicates'] = [];

  for (const taskId of releaseTaskIds) {
    const inReleases = existingReleases
      .filter(r => r.tasks.includes(taskId))
      .map(r => r.version);

    if (inReleases.length > 0) {
      duplicates.push({ taskId, releases: inReleases });
    }
  }

  return {
    hasDoubleListing: duplicates.length > 0,
    duplicates,
  };
}
