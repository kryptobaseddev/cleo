/**
 * Pure-logic helpers for the Kanban tab (T955).
 *
 * Keeps the Kanban-view bucketing algorithm testable in isolation from the
 * Svelte component shell — vitest runs with `environment: 'node'` (see
 * `packages/studio/vitest.config.ts`) which cannot mount `.svelte` files, so
 * any logic that needs unit-test coverage lives in a plain `.ts` module.
 *
 * ## Responsibility matrix
 *
 * | Concern                          | Lives here                  |
 * | -------------------------------- | --------------------------- |
 * | Column order / visibility        | {@link KANBAN_COLUMN_ORDER} |
 * | Walk `parentId` → root epic      | {@link findRootEpicId}      |
 * | Filter tasks (query/pri/labels)  | {@link applyKanbanFilters}  |
 * | Bucket tasks into column + epic  | {@link bucketKanbanTasks}   |
 *
 * Status filtering is deliberately NOT applied here — the Kanban's columns
 * already represent `status`, so the store's `filters.state.status` array
 * is consumed as a **column-visibility** predicate instead (see
 * {@link columnIsVisible}).
 *
 * @task T955
 * @epic T949
 */

import type { Task, TaskPriority, TaskStatus } from '@cleocode/contracts';

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/**
 * Canonical ordered list of Kanban column statuses.
 *
 * Deliberately excludes `archived` (filtered at the loader) and `proposed`
 * (pre-lifecycle; not surfaced in the primary dashboard view). Operator
 * decision captured in `docs/specs/CLEO-TASK-DASHBOARD-SPEC.md` §5.4.
 */
export const KANBAN_COLUMN_ORDER: readonly TaskStatus[] = [
  'pending',
  'active',
  'blocked',
  'done',
  'cancelled',
] as const;

/** Sentinel epic id used to group tasks with no root-epic ancestor. */
export const NO_EPIC_GROUP_ID = '__no_epic__' as const;

/** Human-readable title for the "no epic" bucket. */
export const NO_EPIC_GROUP_TITLE = 'No epic' as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single epic-grouping bucket inside a Kanban column.
 *
 * `epicId === NO_EPIC_GROUP_ID` for root-parented tasks that have no
 * ancestor task of type `epic`.
 */
export interface KanbanEpicGroup {
  /** Root epic id, or {@link NO_EPIC_GROUP_ID} for the fallback bucket. */
  epicId: string;
  /** Display title — the epic's `title` or {@link NO_EPIC_GROUP_TITLE}. */
  epicTitle: string;
  /** Tasks in this group, ordered stably by their id. */
  tasks: Task[];
}

/** All groups for one column in canonical order. */
export interface KanbanColumn {
  /** Status-axis identifier for the column. */
  status: TaskStatus;
  /** Cached total across every epic group (pre-computed for header counts). */
  taskCount: number;
  /** Epic groups in this column, keyed by root epic id. */
  groups: KanbanEpicGroup[];
}

/** The full bucketed shape consumed by {@link KanbanTab}. */
export interface KanbanBuckets {
  /** Columns in {@link KANBAN_COLUMN_ORDER}. */
  columns: KanbanColumn[];
  /** Total tasks across every column (after filter application). */
  filteredTotal: number;
}

/**
 * Narrow subset of {@link TaskFilters.state} used by Kanban bucketing.
 *
 * Decoupled from the full {@link import('../../stores/task-filters.svelte.js').TaskFilterState}
 * shape so tests can construct literals without pulling in URL-state
 * machinery.
 */
export interface KanbanFilterPredicate {
  /** Free-text search query (case-insensitive; matches id + title). */
  query: string;
  /** Multi-select priority chip selection. Empty = include all. */
  priority: TaskPriority[];
  /** Multi-select label filter. Empty = include all. */
  labels: string[];
  /** When true, include cancelled tasks (already filtered otherwise). */
  cancelled: boolean;
  /**
   * Column-visibility selector — if non-empty, ONLY these statuses render
   * as visible columns. Empty array = show all columns.
   */
  status: TaskStatus[];
}

// ---------------------------------------------------------------------------
// Epic ancestor resolution
// ---------------------------------------------------------------------------

/**
 * Build a `{ id -> Task }` map from a flat task array.
 *
 * Defensive against duplicate ids (last-write wins — tasks.db enforces
 * uniqueness at the SQL layer so this is effectively a one-to-one map).
 *
 * @param tasks - Every task in the current bundle.
 * @returns A lookup table keyed by `task.id`.
 */
export function indexTasksById(tasks: readonly Task[]): Map<string, Task> {
  const map = new Map<string, Task>();
  for (const t of tasks) {
    map.set(t.id, t);
  }
  return map;
}

/**
 * Walk `parentId` upward to find the **top-level epic ancestor** for a task.
 *
 * Algorithm:
 *
 * 1. Start at `task`.
 * 2. If the current node has `type === 'epic'` AND `parentId == null`,
 *    return its id — we have reached a root epic.
 * 3. Otherwise climb to `parentId`; if null/missing, the task is not nested
 *    under any epic, return `null`.
 * 4. Loop detection: a `Set` of visited ids guards against malformed cycles.
 *
 * Edge cases:
 *
 * - **Task IS the root epic** (epic with null parent) → returns its own id.
 * - **Task is a nested epic** (epic with a parent chain) → climbs past
 *   itself to find the outermost epic.
 * - **Root-level non-epic task** (no parent, `type !== 'epic'`) → returns
 *   `null` (goes in the "No epic" bucket).
 * - **Orphan** (parent id points to a missing task) → returns `null`.
 * - **Cycle** (A → B → A) → returns `null` to prevent infinite loops.
 *
 * @param task - The leaf task to resolve.
 * @param byId - A prebuilt lookup map (see {@link indexTasksById}).
 * @returns The root-epic id, or `null` if none exists.
 */
export function findRootEpicId(task: Task, byId: ReadonlyMap<string, Task>): string | null {
  const visited = new Set<string>();
  let current: Task | undefined = task;
  let lastEpicSeen: Task | null = null;

  while (current) {
    if (visited.has(current.id)) {
      // Cycle — bail without erroring.
      return null;
    }
    visited.add(current.id);

    if (current.type === 'epic') {
      lastEpicSeen = current;
    }

    const parentId = current.parentId ?? null;
    if (parentId === null || parentId === undefined) {
      break;
    }

    const parent = byId.get(parentId);
    if (!parent) {
      // Broken parent link — treat as root.
      break;
    }
    current = parent;
  }

  return lastEpicSeen?.id ?? null;
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/**
 * Lowercase, null-safe compare against the search query.
 *
 * @param haystack - Any string, possibly empty.
 * @param needleLower - The already-lowercased query token.
 * @returns `true` if `haystack` contains `needleLower`, case-insensitive.
 */
function containsIgnoreCase(haystack: string, needleLower: string): boolean {
  if (!haystack) return false;
  return haystack.toLowerCase().includes(needleLower);
}

/**
 * Return `true` iff `task` passes every non-column filter in `predicate`.
 *
 * **Status is deliberately NOT checked here** — the Kanban columns ARE the
 * status axis, so we hide unwanted columns instead of dropping their cards
 * (see {@link columnIsVisible}).
 *
 * @param task - Task to test.
 * @param predicate - Narrowed filter predicate.
 * @returns Whether the task should appear in its column.
 */
export function taskMatchesKanbanFilter(task: Task, predicate: KanbanFilterPredicate): boolean {
  // 1. Query — case-insensitive match on id OR title.
  const q = predicate.query.trim().toLowerCase();
  if (q.length > 0) {
    const hitId = containsIgnoreCase(task.id, q);
    const hitTitle = containsIgnoreCase(task.title, q);
    if (!hitId && !hitTitle) return false;
  }

  // 2. Priority — empty selection means "include all priorities".
  if (predicate.priority.length > 0) {
    if (!predicate.priority.includes(task.priority)) return false;
  }

  // 3. Labels — match ANY selected label.
  if (predicate.labels.length > 0) {
    const taskLabels = task.labels ?? [];
    const anyMatch = predicate.labels.some((l) => taskLabels.includes(l));
    if (!anyMatch) return false;
  }

  // 4. Cancelled gate — when `cancelled` is false, hide cancelled cards.
  //    Operator wants cancelled explicit-opt-in everywhere per spec §7.
  if (!predicate.cancelled && task.status === 'cancelled') return false;

  return true;
}

/**
 * Apply every non-status filter to a task list in one pass.
 *
 * Pure and stable — the output preserves input order, so downstream epic
 * grouping sees deterministic ordering.
 *
 * @param tasks - Input task list.
 * @param predicate - Filter predicate.
 * @returns A new array of tasks that passed the filter.
 */
export function applyKanbanFilters(
  tasks: readonly Task[],
  predicate: KanbanFilterPredicate,
): Task[] {
  return tasks.filter((t) => taskMatchesKanbanFilter(t, predicate));
}

/**
 * Whether a given column should render, given the `status` filter.
 *
 * Empty `predicate.status` → show every column.
 * Non-empty → only show columns whose status appears in the array.
 *
 * @param status - Column's status axis value.
 * @param predicate - Filter predicate.
 * @returns `true` if the column should render.
 */
export function columnIsVisible(status: TaskStatus, predicate: KanbanFilterPredicate): boolean {
  if (predicate.status.length === 0) return true;
  return predicate.status.includes(status);
}

// ---------------------------------------------------------------------------
// Bucketing
// ---------------------------------------------------------------------------

/**
 * Stable id comparator for deterministic within-group ordering.
 *
 * Uses the numeric portion of `T\d+` ids when present, falling back to
 * lexicographic compare for non-standard ids (e.g. imported legacy tasks).
 */
function compareTaskIds(a: string, b: string): number {
  const na = Number.parseInt(a.replace(/^T/, ''), 10);
  const nb = Number.parseInt(b.replace(/^T/, ''), 10);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Bucket filtered tasks into columns × epic groups.
 *
 * ## Contract
 *
 * - Every {@link KANBAN_COLUMN_ORDER} status produces a column, EVEN when
 *   it has zero tasks — the component renders empty columns with a `(0)`
 *   count so the UI shape stays stable.
 * - Within each column, groups are ordered by epic id (ascending numeric),
 *   with the {@link NO_EPIC_GROUP_ID} bucket (if present) placed LAST so
 *   named epics surface first.
 * - Within each group, tasks are sorted by id ascending for deterministic
 *   rendering.
 *
 * Cancelled / column-visibility filtering is NOT applied here — bucketing
 * always produces the full shape, and the component renders columns
 * conditionally based on {@link columnIsVisible}.
 *
 * @param filteredTasks - Tasks already passed through
 *                         {@link applyKanbanFilters}.
 * @param byId - Full-task lookup for ancestor resolution.
 * @returns A {@link KanbanBuckets} snapshot.
 */
export function bucketKanbanTasks(
  filteredTasks: readonly Task[],
  byId: ReadonlyMap<string, Task>,
): KanbanBuckets {
  // First pass: bucket by status → epicId → tasks[].
  const bucketed = new Map<TaskStatus, Map<string, Task[]>>();
  for (const status of KANBAN_COLUMN_ORDER) {
    bucketed.set(status, new Map<string, Task[]>());
  }

  for (const task of filteredTasks) {
    const columnBucket = bucketed.get(task.status);
    if (!columnBucket) continue; // unknown status (e.g. proposed) — drop

    const rootEpicId = findRootEpicId(task, byId) ?? NO_EPIC_GROUP_ID;
    const groupTasks = columnBucket.get(rootEpicId);
    if (groupTasks) {
      groupTasks.push(task);
    } else {
      columnBucket.set(rootEpicId, [task]);
    }
  }

  // Second pass: materialize ordered columns + groups.
  const columns: KanbanColumn[] = [];
  let filteredTotal = 0;

  for (const status of KANBAN_COLUMN_ORDER) {
    const columnBucket = bucketed.get(status) ?? new Map<string, Task[]>();

    const epicIds = [...columnBucket.keys()].sort((a, b) => {
      // Place NO_EPIC_GROUP_ID last, everything else by id ascending.
      if (a === NO_EPIC_GROUP_ID) return 1;
      if (b === NO_EPIC_GROUP_ID) return -1;
      return compareTaskIds(a, b);
    });

    const groups: KanbanEpicGroup[] = epicIds.map((epicId) => {
      const tasks = (columnBucket.get(epicId) ?? [])
        .slice()
        .sort((a, b) => compareTaskIds(a.id, b.id));
      const epicTitle =
        epicId === NO_EPIC_GROUP_ID ? NO_EPIC_GROUP_TITLE : (byId.get(epicId)?.title ?? epicId);
      return { epicId, epicTitle, tasks };
    });

    const taskCount = groups.reduce((sum, g) => sum + g.tasks.length, 0);
    filteredTotal += taskCount;

    columns.push({ status, taskCount, groups });
  }

  return { columns, filteredTotal };
}
