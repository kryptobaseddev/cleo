/**
 * Task listing with filters.
 * @task T4460
 * @epic T4454
 */

import { readJsonRequired } from '../../store/json.js';
import type { Task, TaskStatus, TaskPriority, TaskType, TodoFile } from '../../types/task.js';
import { getTodoPath } from '../paths.js';
import type { DataAccessor } from '../../store/data-accessor.js';

/** Filter options for listing tasks. */
export interface ListTasksOptions {
  status?: TaskStatus;
  priority?: TaskPriority;
  type?: TaskType;
  parentId?: string;
  phase?: string;
  label?: string;
  children?: boolean;
  limit?: number;
  offset?: number;
}

/** Result of listing tasks. */
export interface ListTasksResult {
  tasks: Task[];
  total: number;
  filtered: number;
  pagination?: {
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

/**
 * List tasks with optional filtering and pagination.
 * @task T4460
 */
export async function listTasks(options: ListTasksOptions = {}, cwd?: string, accessor?: DataAccessor): Promise<ListTasksResult> {
  const todoPath = getTodoPath(cwd);
  const data = accessor
    ? await accessor.loadTodoFile()
    : await readJsonRequired<TodoFile>(todoPath);

  let filtered = data.tasks;

  // Apply filters
  if (options.status) {
    filtered = filtered.filter(t => t.status === options.status);
  }

  if (options.priority) {
    filtered = filtered.filter(t => t.priority === options.priority);
  }

  if (options.type) {
    filtered = filtered.filter(t => t.type === options.type);
  }

  if (options.parentId) {
    if (options.children) {
      // Show direct children of the parent
      filtered = filtered.filter(t => t.parentId === options.parentId);
    } else {
      filtered = filtered.filter(t => t.parentId === options.parentId);
    }
  }

  if (options.phase) {
    filtered = filtered.filter(t => t.phase === options.phase);
  }

  if (options.label) {
    filtered = filtered.filter(t => t.labels?.includes(options.label!));
  }

  const total = data.tasks.length;
  const filteredCount = filtered.length;

  // Sort by position within parent groups
  filtered.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  // Apply pagination
  const limit = options.limit ?? 0;
  const offset = options.offset ?? 0;

  if (limit > 0) {
    const paginated = filtered.slice(offset, offset + limit);
    return {
      tasks: paginated,
      total,
      filtered: filteredCount,
      pagination: {
        limit,
        offset,
        hasMore: offset + limit < filteredCount,
      },
    };
  }

  if (offset > 0) {
    filtered = filtered.slice(offset);
  }

  return {
    tasks: filtered,
    total,
    filtered: filteredCount,
  };
}
