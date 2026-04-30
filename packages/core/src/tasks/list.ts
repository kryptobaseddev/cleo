/**
 * Task listing with filters.
 * @task T4460
 * @epic T4454
 */

import type { Task, TaskPriority, TaskRecord, TaskStatus, TaskType } from '@cleocode/contracts';
import type { LAFSPage } from '@cleocode/lafs';
import { type EngineResult, engineSuccess } from '../engine-result.js';
import type { NextDirectives } from '../mvi-helpers.js';
import { taskListItemNext } from '../mvi-helpers.js';
import { paginate } from '../pagination.js';
import type { DataAccessor, TaskQueryFilters } from '../store/data-accessor.js';
import { getAccessor } from '../store/data-accessor.js';
import { tasksToRecords } from './engine-converters.js';

const TASK_LIST_DEFAULT_LIMIT = 10;

/** Compact task representation — minimal fields for list responses. */
export interface CompactTask {
  id: string;
  title: string;
  status: string;
  priority: string;
  type?: string;
  parentId?: string | null;
  /** Progressive disclosure directives for follow-up operations. */
  _next?: NextDirectives;
}

/** Convert a full Task to compact representation with _next directives. */
export function toCompact(task: Task): CompactTask {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    type: task.type,
    parentId: task.parentId,
    _next: taskListItemNext(task.id),
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
  /**
   * When `true`, omit rows with `status='archived'` from the result set.
   *
   * @remarks
   * T948: convenience flag used by Studio surfaces that must never render
   * archived tasks (kanban, /tasks API). Translates to `excludeStatus:
   * ['archived']` at the accessor layer. Ignored when `status` is already
   * set to a non-archived value.
   */
  excludeArchived?: boolean;
  /**
   * When `true`, order results by priority (critical → high → medium → low)
   * instead of the default position-based order.
   *
   * @remarks
   * T948: preserves the historic priority-first ordering of Studio's
   * `/api/tasks` and `/api/tasks/pipeline` endpoints, whose raw SQL used
   * `ORDER BY CASE priority WHEN 'critical' …`.
   */
  sortByPriority?: boolean;
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
    orderBy: options.sortByPriority ? 'priority' : 'position',
  };
  if (options.status) queryFilters.status = options.status;
  if (options.priority) queryFilters.priority = options.priority;
  if (options.type) queryFilters.type = options.type;
  if (options.parentId) queryFilters.parentId = options.parentId;
  if (options.phase) queryFilters.phase = options.phase;
  if (options.label) queryFilters.label = options.label;
  if (options.excludeArchived && options.status !== 'archived') {
    queryFilters.excludeStatus = 'archived';
  }

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

  // Enrich each task with _next progressive disclosure directives
  const enrichedTasks = tasks.map((t) => ({
    ...t,
    _next: taskListItemNext(t.id),
  }));

  return {
    tasks: enrichedTasks,
    total,
    filtered: filteredCount,
    page,
    pagination,
  };
}

// ---------------------------------------------------------------------------
// EngineResult-returning wrapper (T1568 / ADR-057 / ADR-058)
// ---------------------------------------------------------------------------

/**
 * List tasks with optional filters, wrapped in EngineResult.
 *
 * @param projectRoot - Absolute path to the project root
 * @param params - Optional filter, pagination, and format parameters
 * @returns EngineResult with task array, total count, and filtered count
 *
 * @task T1568
 * @epic T1566
 */
export async function taskList(
  projectRoot: string,
  params?: {
    parent?: string;
    status?: string;
    priority?: string;
    type?: string;
    phase?: string;
    label?: string;
    children?: boolean;
    limit?: number;
    offset?: number;
    compact?: boolean;
  },
): Promise<EngineResult<{ tasks: TaskRecord[] | CompactTask[]; total: number; filtered: number }>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const result = await listTasks(
      {
        parentId: params?.parent ?? undefined,
        status: params?.status as TaskStatus | undefined,
        priority: params?.priority as TaskPriority | undefined,
        type: params?.type as TaskType | undefined,
        phase: params?.phase,
        label: params?.label,
        children: params?.children,
        limit: params?.limit,
        offset: params?.offset,
      },
      projectRoot,
      accessor,
    );
    const tasks = params?.compact
      ? result.tasks.map((t) => toCompact(t))
      : tasksToRecords(result.tasks);
    return engineSuccess({ tasks, total: result.total, filtered: result.filtered }, result.page);
  } catch (err: unknown) {
    const e = err as { message?: string };
    return {
      success: false,
      error: { code: 'E_NOT_INITIALIZED', message: e?.message ?? 'Task database not initialized' },
    };
  }
}
