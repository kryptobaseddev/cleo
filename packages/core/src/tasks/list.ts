/**
 * Task listing with filters.
 * @task T4460
 * @epic T4454
 */

import type { Task, TaskPriority, TaskStatus, TaskType } from '@cleocode/contracts';
import type { LAFSPage } from '@cleocode/lafs';
import { paginate } from '../pagination.js';
import type { DataAccessor, TaskQueryFilters } from '../store/data-accessor.js';

const TASK_LIST_DEFAULT_LIMIT = 10;

/** Compact task representation — minimal fields for MCP list responses. */
export interface CompactTask {
  id: string;
  title: string;
  status: string;
  priority: string;
  type?: string;
  parentId?: string | null;
}

/** Convert a full Task to compact representation. */
export function toCompact(task: Task): CompactTask {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    type: task.type,
    parentId: task.parentId,
  };
}

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
  page: LAFSPage;
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
export async function listTasks(
  options: ListTasksOptions = {},
  cwd?: string,
  accessor?: DataAccessor,
): Promise<ListTasksResult> {
  const dataAccessor =
    accessor ?? (await (await import('../store/data-accessor.js')).getAccessor(cwd));

  // Build targeted query filters
  const queryFilters: TaskQueryFilters = {
    orderBy: 'position',
  };
  if (options.status) queryFilters.status = options.status;
  if (options.priority) queryFilters.priority = options.priority;
  if (options.type) queryFilters.type = options.type;
  if (options.parentId) queryFilters.parentId = options.parentId;
  if (options.phase) queryFilters.phase = options.phase;
  if (options.label) queryFilters.label = options.label;

  const queryResult = await dataAccessor.queryTasks(queryFilters);
  const filtered = queryResult.tasks;
  const filteredCount = queryResult.total;

  // Get total count of all tasks (unfiltered) for the response
  const total = await dataAccessor.countTasks();

  const limit =
    options.limit === 0
      ? undefined
      : typeof options.limit === 'number' && options.limit > 0
        ? options.limit
        : TASK_LIST_DEFAULT_LIMIT;
  const offset =
    typeof options.offset === 'number' && options.offset > 0 ? options.offset : undefined;
  const { items: tasks, page } = paginate(filtered, limit, offset);
  const pagination =
    page.mode === 'offset'
      ? {
          limit: page.limit,
          offset: page.offset,
          hasMore: page.hasMore,
        }
      : undefined;

  return {
    tasks,
    total,
    filtered: filteredCount,
    page,
    pagination,
  };
}
