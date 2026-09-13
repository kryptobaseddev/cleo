/**
 * Task listing with filters.
 * @task T4460
 * @epic T4454
 */

import type {
  Task,
  TaskKind,
  TaskPriority,
  TaskRecord,
  TaskSeverity,
  TaskStatus,
  TaskType,
} from '@cleocode/contracts';
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
import { assertTaskAxisFilters } from './axis-filters.js';
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
  /**
   * Severity axis filter (`P0`-`P3`), orthogonal to {@link priority}.
   * @task T12120 — GH #1245; previously accepted at the CLI and never applied.
   */
  severity?: TaskSeverity | TaskSeverity[];
  /**
   * Kind axis filter (ADR-066), orthogonal to {@link type}.
   * @task T12120 — GH #1246; previously accepted at the CLI and never applied.
   */
  kind?: TaskKind | TaskKind[];
  parentId?: string;
  phase?: string;
  label?: string;
  /**
   * No-op, retained for compatibility.
   *
   * @remarks
   * T12120 (GH #1247): `--children` was advertised in `--help` as "limit
   * parent queries to direct children" and threaded through four layers into
   * this options bag, but `listTasks` never read it — because `parentId`
   * ALREADY restricts to direct children on every path (the default query
   * applies `eq(tasks.parentId, ...)`, and the saga branch resolves members
   * through the same `parentId` containment since T10638). There is no
   * transitive mode for it to narrow from, so it cannot change a result.
   *
   * Kept as an accepted field rather than removed so the advertised CLI
   * surface stays stable; `listTasks` asserts the equivalence in tests so a
   * future transitive mode is forced to give this flag real meaning instead
   * of leaving it a lie.
   */
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
   * - `'saga.groups'` — legacy binding-source label retained for compatibility;
   *   the `--parent` target was a Saga and children were resolved via
   *   canonical `parentId` containment, not relation-based grouping.
   *
   * Absent when the default `parentId`-based query produced the result.
   * Dispatch layers (e.g. LAFS envelope wrappers) MAY lift this into
   * envelope meta as `meta.bindingSource`.
   *
   * @see ADR-088 — PM-Core V2 WorkGraph containment
   * @task T9658
   */
  bindingSource?: typeof LIST_BINDING_SAGA_GROUPS;
}

/**
 * List tasks with optional filtering and pagination.
 *
 * When `options.parentId` resolves to a Saga (`type='saga'`), children are
 * resolved via canonical `parentId` containment. All other filters (`status`,
 * `priority`, `type`, `phase`, `label`, `excludeArchived`) are applied to the
 * resolved member set in-memory. The returned `bindingSource` field is set to
 * `'saga.groups'` for legacy client compatibility only.
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
  // When --parent targets a Saga, resolve members through the canonical
  // Saga member helper. Falls back to the
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
  // Skip the raw parentId filter when routing through the Saga helper so the
  // helper remains the SSoT for Saga membership semantics.
  if (options.parentId && sagaMemberIds === null) queryFilters.parentId = options.parentId;
  if (options.phase) queryFilters.phase = options.phase;
  if (options.label) queryFilters.label = options.label;
  // T12120 (GH #1245/#1246) — validate BEFORE querying so an unrecognised
  // value raises E_VALIDATION instead of being dropped and widening the
  // result set to every task.
  const axes = assertTaskAxisFilters({
    severity: options.severity as string | string[] | undefined,
    kind: options.kind as string | string[] | undefined,
  });
  if (axes.severity) queryFilters.severity = axes.severity;
  if (axes.kind) queryFilters.kind = axes.kind;
  if (options.excludeArchived && options.status !== 'archived') {
    queryFilters.excludeStatus = 'archived';
  }

  const queryResult = await dataAccessor.queryTasks(queryFilters);
  let filtered: Task[];
  let filteredCount: number;
  if (sagaMemberIds !== null) {
    // Saga path: restrict the queried set to the saga's member Epic IDs.
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
    severity?: string | string[];
    kind?: string | string[];
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
        severity: params?.severity as TaskSeverity | TaskSeverity[] | undefined,
        kind: params?.kind as TaskKind | TaskKind[] | undefined,
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
