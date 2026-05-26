/**
 * Task listing with filters.
 * @task T4460
 * @epic T4454
 */

import type { Task, TaskPriority, TaskRecord, TaskStatus, TaskType } from '@cleocode/contracts';
import type { LAFSPage } from '@cleocode/lafs';
import { type EngineResult, engineSuccess } from '../engine-result.js';
import { cleoErrorToEngineResult } from '../errors-to-engine.js';
import type { NextDirectives } from '../mvi-helpers.js';
import { taskListItemNext } from '../mvi-helpers.js';
import { paginate } from '../pagination.js';
// T10123: Saga constants + member resolver moved to `../sagas/` (Saga T10113 /
// Epic T10208). Re-exported below for backwards-compat with consumers that
// still import them from this module — new code should import from
// `@cleocode/core` (which re-exports via `../sagas/index.ts`).
import { LIST_BINDING_SAGA_GROUPS, SAGA_GROUPS_RELATION, SAGA_LABEL } from '../sagas/constants.js'; // saga-label-ok: T10638 — SSoT backward-compat re-export
import { resolveSagaMemberIds } from '../sagas/storage.js';
import type { TaskQueryFilters } from '../store/data-accessor.js';
import { type DataAccessor, getTaskAccessor } from '../store/data-accessor.js';
import { tasksToRecords } from './engine-converters.js';

// Re-export saga constants for backwards-compat (T10123).
// Test fixtures and external consumers historically imported these from
// `./list.js`; the canonical home is now `../sagas/constants.ts`.
export { LIST_BINDING_SAGA_GROUPS, SAGA_GROUPS_RELATION, SAGA_LABEL }; // saga-label-ok: T10638 — SSoT backward-compat re-export

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
  /**
   * Tag identifying which resolution path produced `tasks`. Present when the
   * default `parentId` query was overridden by a routing branch.
   *
   * - `'saga.groups'` — the `--parent` target was a Saga (Epic with
   *   `label='saga'`) and children were resolved via
   *   `task_relations.type='groups'` edges instead of the `parentId` column.
   *
   * Absent when the default `parentId`-based query produced the result.
   * Dispatch layers (e.g. LAFS envelope wrappers) MAY lift this into
   * envelope meta as `meta.bindingSource`.
   *
   * @see ADR-073 §1 — Saga ↔ Epic linkage
   * @task T9658
   */
  bindingSource?: typeof LIST_BINDING_SAGA_GROUPS;
}

/**
 * List tasks with optional filtering and pagination.
 *
 * When `options.parentId` resolves to a Saga (Epic with `labels.includes('saga')`),
 * children are resolved via `task_relations.type='groups'` edges instead of the
 * default `parentId` column query (ADR-073 §1). All other filters (`status`,
 * `priority`, `type`, `phase`, `label`, `excludeArchived`) are applied to the
 * resolved member set in-memory. The returned `bindingSource` field is set to
 * `'saga.groups'` so dispatch layers can surface the routing in envelope meta.
 *
 * @task T4460
 * @task T9658 — Saga-aware --parent routing
 */
export async function listTasks(
  options: ListTasksOptions = {},
  cwd?: string,
  accessor?: DataAccessor,
): Promise<ListTasksResult> {
  const dataAccessor =
    accessor ?? (await (await import('../store/data-accessor.js')).getTaskAccessor(cwd));

  // T9658: Saga-aware --parent routing.
  // When --parent targets a Saga (label='saga'), children live in
  // task_relations.type='groups', NOT in the parentId column. Detect once
  // up-front and short-circuit through the groups path. Falls back to the
  // default parentId-based query when the parent is not a Saga (or does not
  // exist — non-existent IDs return an empty result set via the default path,
  // preserving the historical behavior).
  let sagaMemberIds: string[] | null = null;
  if (options.parentId) {
    sagaMemberIds = await resolveSagaMemberIds(dataAccessor, options.parentId);
  }

  // Build targeted query filters
  const queryFilters: TaskQueryFilters = {
    orderBy: options.sortByPriority ? 'priority' : 'position',
  };
  if (options.status) queryFilters.status = options.status;
  if (options.priority) queryFilters.priority = options.priority;
  if (options.type) queryFilters.type = options.type;
  // Skip parentId filter when routing through Saga groups — Saga members are
  // top-level Epics with no parentId, so the parentId column wouldn't match.
  if (options.parentId && sagaMemberIds === null) queryFilters.parentId = options.parentId;
  if (options.phase) queryFilters.phase = options.phase;
  if (options.label) queryFilters.label = options.label;
  if (options.excludeArchived && options.status !== 'archived') {
    queryFilters.excludeStatus = 'archived';
  }

  const queryResult = await dataAccessor.queryTasks(queryFilters);
  let filtered: Task[];
  let filteredCount: number;
  if (sagaMemberIds !== null) {
    // Saga path: restrict the queried set to the saga's member Epic IDs,
    // preserving the relation-order of the groups edges.
    const memberOrder = new Map<string, number>();
    for (let idx = 0; idx < sagaMemberIds.length; idx++) {
      const id = sagaMemberIds[idx];
      if (id !== undefined) memberOrder.set(id, idx);
    }
    const memberSet = new Set(sagaMemberIds);
    const sagaFiltered = queryResult.tasks
      .filter((t) => memberSet.has(t.id))
      .sort((a, b) => (memberOrder.get(a.id) ?? 0) - (memberOrder.get(b.id) ?? 0));
    filtered = sagaFiltered;
    filteredCount = sagaFiltered.length;
  } else {
    filtered = queryResult.tasks;
    filteredCount = queryResult.total;
  }

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
    ...(sagaMemberIds !== null ? { bindingSource: LIST_BINDING_SAGA_GROUPS } : {}),
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
): Promise<
  EngineResult<{
    tasks: TaskRecord[] | CompactTask[];
    total: number;
    filtered: number;
    bindingSource?: typeof LIST_BINDING_SAGA_GROUPS;
  }>
> {
  try {
    const accessor = await getTaskAccessor(projectRoot);
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
    return engineSuccess(
      {
        tasks,
        total: result.total,
        filtered: result.filtered,
        ...(result.bindingSource !== undefined ? { bindingSource: result.bindingSource } : {}),
      },
      result.page,
    );
  } catch (err: unknown) {
    // T9940: preserve CleoError LAFS codes; non-CleoError → E_INTERNAL,
    // never the misleading E_NOT_INITIALIZED blanket label.
    return cleoErrorToEngineResult(err, 'E_INTERNAL', 'Failed to list tasks');
  }
}
