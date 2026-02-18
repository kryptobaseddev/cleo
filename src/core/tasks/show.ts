/**
 * Show full task details by ID.
 * @task T4460
 * @epic T4454
 */

import { readJsonRequired } from '../../store/json.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import type { Task, TodoFile } from '../../types/task.js';
import { getTodoPath } from '../paths.js';
import type { DataAccessor } from '../../store/data-accessor.js';

/** Enriched task with hierarchy info. */
export interface TaskDetail extends Task {
  children?: string[];
  dependencyStatus?: Array<{ id: string; status: string; title: string }>;
  hierarchyPath?: string[];
}

/**
 * Get a task by ID with enriched details.
 * @task T4460
 */
export async function showTask(taskId: string, cwd?: string, accessor?: DataAccessor): Promise<TaskDetail> {
  if (!taskId) {
    throw new CleoError(ExitCode.INVALID_INPUT, 'Task ID is required');
  }

  const todoPath = getTodoPath(cwd);
  const data = accessor
    ? await accessor.loadTodoFile()
    : await readJsonRequired<TodoFile>(todoPath);

  const task = data.tasks.find(t => t.id === taskId);
  if (!task) {
    throw new CleoError(
      ExitCode.NOT_FOUND,
      `Task not found: ${taskId}`,
      {
        fix: `Use 'cleo find "${taskId}"' to search for similar IDs`,
        alternatives: [
          { action: 'Search for task', command: `cleo find "${taskId}"` },
          { action: 'List all tasks', command: 'cleo list' },
        ],
      },
    );
  }

  const detail: TaskDetail = { ...task };

  // Add children
  const children = data.tasks.filter(t => t.parentId === taskId);
  if (children.length > 0) {
    detail.children = children.map(c => c.id);
  }

  // Add dependency status
  if (task.depends?.length) {
    detail.dependencyStatus = task.depends.map(depId => {
      const dep = data.tasks.find(t => t.id === depId);
      return {
        id: depId,
        status: dep?.status ?? 'unknown',
        title: dep?.title ?? 'Unknown task',
      };
    });
  }

  // Build hierarchy path
  const path: string[] = [taskId];
  let currentId: string | null | undefined = task.parentId;
  const visited = new Set<string>();
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    path.unshift(currentId);
    const parent = data.tasks.find(t => t.id === currentId);
    currentId = parent?.parentId;
  }
  if (path.length > 1) {
    detail.hierarchyPath = path;
  }

  return detail;
}
