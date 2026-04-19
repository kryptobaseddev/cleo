/**
 * Shared Task Explorer data loader (T952).
 *
 * Single server-side loader consumed by the CLEO Studio `/tasks` surface
 * (dashboard panel + 3-tab Task Explorer: Hierarchy / Graph / Kanban).
 *
 * All three Explorer tabs project from the SAME {@link ExplorerBundle}, so
 * only ONE DB round-trip is issued per SvelteKit page load. Switching tabs
 * client-side does not re-query the server.
 *
 * Reference spec: `docs/specs/CLEO-TASK-DASHBOARD-SPEC.md` §3 / §5.
 *
 * ## Query budget (per `loadExplorerBundle` call)
 *
 * Four prepared statements execute per load:
 *
 * 1. `SELECT … FROM tasks WHERE status != 'archived'` (or unfiltered when
 *    `includeArchived`) — the node set.
 * 2. `SELECT task_id, depends_on FROM task_dependencies` — the edge set.
 * 3. Epic rollup is computed **in-memory** from the already-loaded task set
 *    (walk `parentId` pointers once to build a `parent -> children[]`
 *    adjacency, then sum per epic). This adds zero SQL round-trips.
 * 4. Distinct labels are aggregated in the same single pass over tasks.
 *
 * ## Epic progress semantics (preserved from T874)
 *
 * `epicProgress[epicId]` counts the **direct children** of the epic with
 * `status != 'archived'`. This matches `cleo list --parent <epicId>` and is
 * consistent with `_computeEpicProgress` in
 * `packages/studio/src/routes/tasks/+page.server.ts` (the deprecated helper
 * retained for unit-testing compatibility). Grand-children are NOT
 * double-counted.
 *
 * ## Project context
 *
 * The loader is project-context-aware — it opens tasks.db via
 * {@link getTasksDb} against `opts.projectCtx.tasksDbPath`. This lets Studio
 * switch between any project registered in `nexus.db` without touching
 * hard-coded paths.
 *
 * @task T952
 * @epic T949
 */

import type { Task, TaskPriority, TaskStatus, TaskType } from '@cleocode/contracts';
import { getTasksDb } from '../db/connections.js';
import type { ProjectContext } from '../project-context.js';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/**
 * A single task dependency edge as stored in the `task_dependencies` table.
 *
 * `taskId` depends on `dependsOn` — i.e. `dependsOn` must be complete before
 * `taskId` can proceed. This matches the SQLite column semantics exactly.
 */
export interface TaskDependencyEdge {
  /** ID of the task that has the dependency (the "blocked" side). */
  taskId: string;
  /** ID of the task this depends on (the "blocker" side). */
  dependsOn: string;
}

/**
 * Per-epic progress rollup bucket — direct children only (T874 semantics).
 *
 * `total` is the denominator (count of direct children with
 * `status != 'archived'`), and `done + cancelled + active` is the partial
 * numerator. `pending` / `blocked` children contribute to `total` without
 * being counted in any bucket; callers should compute `pending = total -
 * (done + cancelled + active)` if they need that derived value.
 */
export interface EpicProgressBucket {
  /** Number of direct, non-archived children. Denominator. */
  total: number;
  /** Children with `status = 'done'`. */
  done: number;
  /** Children with `status = 'cancelled'`. */
  cancelled: number;
  /** Children with `status = 'active'`. */
  active: number;
}

/**
 * Everything the Task Explorer renders in a single payload.
 *
 * Returned verbatim from `+page.server.ts` load functions; the UI projects
 * this into Hierarchy / Graph / Kanban views client-side.
 */
export interface ExplorerBundle {
  /** All non-archived tasks for the current project context. */
  tasks: Task[];
  /** All dependency edges (task_dependencies table). */
  deps: TaskDependencyEdge[];
  /** Epic hierarchy rollup: `{ epicId -> { total, done, cancelled, active } }`. */
  epicProgress: Record<string, EpicProgressBucket>;
  /** Distinct labels across all tasks (for FilterChipGroup). */
  labels: string[];
  /** Snapshot timestamp (ISO) for UI freshness indicator. */
  loadedAt: string;
}

/**
 * Options for {@link loadExplorerBundle}.
 */
export interface LoadExplorerOptions {
  /** Active project context (from `event.locals.projectCtx`). */
  projectCtx: ProjectContext;
  /**
   * Include archived tasks (rare).
   *
   * When `false` (default), tasks with `status = 'archived'` are excluded
   * from the `tasks` array and from epic-progress rollups. Dependency edges
   * are filtered to those whose *both* endpoints are included.
   *
   * @defaultValue false
   */
  includeArchived?: boolean;
  /**
   * Max tasks to load (cap for very large projects). Applied AFTER the
   * archived filter, ORDER BY `id` ASC for stable ordering.
   *
   * @defaultValue 2000
   */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Raw SQLite row shape (internal)
// ---------------------------------------------------------------------------

/**
 * Mirror of the columns selected from `tasks` below — snake_case SQLite
 * output from `node:sqlite`.
 *
 * Kept internal: the loader projects this to {@link Task} before exposing
 * anything on the public boundary.
 */
interface TaskRowSqlite {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  type: string | null;
  parent_id: string | null;
  pipeline_stage: string | null;
  size: string | null;
  phase: string | null;
  position: number | null;
  position_version: number | null;
  labels_json: string | null;
  acceptance_json: string | null;
  files_json: string | null;
  notes_json: string | null;
  verification_json: string | null;
  origin: string | null;
  blocked_by: string | null;
  epic_lifecycle: string | null;
  no_auto_complete: number | null;
  created_at: string;
  updated_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  created_by: string | null;
  modified_by: string | null;
  session_id: string | null;
  assignee: string | null;
}

/**
 * Mirror of `task_dependencies` row shape from `node:sqlite`.
 */
interface DependencyRowSqlite {
  task_id: string;
  depends_on: string;
}

// ---------------------------------------------------------------------------
// Helpers (internal)
// ---------------------------------------------------------------------------

/**
 * Parse a JSON column into a string array, returning `[]` on any failure.
 *
 * Used for `labels_json`, `notes_json`, `files_json`. Defensive: bad JSON
 * must not poison the entire bundle — silently degrade to empty.
 */
function parseStringArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}

/**
 * Parse a JSON column into an unknown array, preserving object entries.
 *
 * Used for `acceptance_json` (mixed strings + AcceptanceGate objects) and
 * for passing through `verification_json` shape without imposing strict
 * validation in this loader.
 */
function parseJsonArray(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Parse a JSON column into an object, returning `undefined` on any failure.
 */
function parseJsonObject<T>(raw: string | null): T | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as T) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Convert a raw snake_case SQLite row to the canonical camelCase
 * {@link Task} contract used across CLEO.
 *
 * Mirrors `packages/core/src/store/converters.ts#rowToTask` for consumers
 * that read directly from `node:sqlite` (Studio server load) instead of the
 * Drizzle-backed DataAccessor path.
 */
function rowToTask(row: TaskRowSqlite): Task {
  const provenance =
    row.created_by !== null || row.modified_by !== null || row.session_id !== null
      ? {
          createdBy: row.created_by,
          modifiedBy: row.modified_by,
          sessionId: row.session_id,
        }
      : undefined;

  return {
    id: row.id,
    title: row.title,
    description: row.description ?? '',
    status: row.status as TaskStatus,
    priority: row.priority as TaskPriority,
    type: (row.type as TaskType | null) ?? undefined,
    parentId: row.parent_id ?? undefined,
    position: row.position ?? undefined,
    positionVersion: row.position_version ?? undefined,
    size: (row.size as Task['size']) ?? undefined,
    phase: row.phase ?? undefined,
    files: parseStringArray(row.files_json),
    acceptance: parseJsonArray(row.acceptance_json) as Task['acceptance'],
    labels: parseStringArray(row.labels_json),
    notes: parseStringArray(row.notes_json),
    origin: (row.origin as Task['origin']) ?? undefined,
    blockedBy: row.blocked_by ?? undefined,
    epicLifecycle: (row.epic_lifecycle as Task['epicLifecycle']) ?? undefined,
    noAutoComplete: row.no_auto_complete === null ? undefined : row.no_auto_complete !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    cancelledAt: row.cancelled_at ?? undefined,
    cancellationReason: row.cancellation_reason ?? undefined,
    verification: parseJsonObject<NonNullable<Task['verification']>>(row.verification_json),
    provenance,
    pipelineStage: row.pipeline_stage ?? undefined,
    assignee: row.assignee ?? undefined,
  };
}

/**
 * Build `{ epicId -> EpicProgressBucket }` from the already-loaded task
 * array.
 *
 * Pure function — no DB access. Algorithm:
 *
 * 1. Bucket every task by `parentId` into `childrenByParent`.
 * 2. For every epic (`type = 'epic'`), look up its direct children and tally
 *    their statuses.
 *
 * Complexity: O(N) where N is `tasks.length`.
 *
 * @remarks
 * Archived children are already filtered out at the SQL layer when
 * `includeArchived` is false. When `includeArchived` is true, archived
 * children are included in `total` but NOT tallied in any of
 * `done/cancelled/active` (they belong in none of those buckets).
 */
export function _computeEpicProgressRollup(tasks: Task[]): Record<string, EpicProgressBucket> {
  const childrenByParent = new Map<string, Task[]>();
  for (const task of tasks) {
    const parent = task.parentId;
    if (!parent) continue;
    const bucket = childrenByParent.get(parent);
    if (bucket) {
      bucket.push(task);
    } else {
      childrenByParent.set(parent, [task]);
    }
  }

  const result: Record<string, EpicProgressBucket> = {};
  for (const task of tasks) {
    if (task.type !== 'epic') continue;
    const children = childrenByParent.get(task.id) ?? [];
    let done = 0;
    let cancelled = 0;
    let active = 0;
    for (const child of children) {
      switch (child.status) {
        case 'done':
          done += 1;
          break;
        case 'cancelled':
          cancelled += 1;
          break;
        case 'active':
          active += 1;
          break;
        default:
          break;
      }
    }
    result[task.id] = {
      total: children.length,
      done,
      cancelled,
      active,
    };
  }
  return result;
}

/**
 * Aggregate distinct labels from the loaded task set. Output is sorted for
 * deterministic rendering in the `FilterChipGroup`.
 */
export function _collectDistinctLabels(tasks: Task[]): string[] {
  const seen = new Set<string>();
  for (const task of tasks) {
    const labels = task.labels;
    if (!labels) continue;
    for (const label of labels) {
      if (typeof label === 'string' && label.length > 0) {
        seen.add(label);
      }
    }
  }
  return [...seen].sort();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** SELECT list that maps 1:1 to {@link TaskRowSqlite}. Hoisted for reuse. */
const TASKS_SELECT_COLUMNS = `
  id, title, description, status, priority, type, parent_id, pipeline_stage,
  size, phase, position, position_version, labels_json, acceptance_json,
  files_json, notes_json, verification_json, origin, blocked_by,
  epic_lifecycle, no_auto_complete, created_at, updated_at, completed_at,
  cancelled_at, cancellation_reason, created_by, modified_by, session_id,
  assignee
`;

/** Fallback empty bundle returned when tasks.db does not exist. */
function emptyBundle(): ExplorerBundle {
  return {
    tasks: [],
    deps: [],
    epicProgress: {},
    labels: [],
    loadedAt: new Date().toISOString(),
  };
}

/**
 * Load the full Task Explorer payload for the active project context.
 *
 * @param opts - Load options (project context + optional filters).
 * @returns A snapshot of the entire explorer-relevant data set.
 *
 * @remarks
 * When `tasks.db` does not exist for the project (e.g. freshly-registered
 * project that hasn't run `cleo init`), returns an empty bundle rather than
 * throwing. Callers render a "tasks.db not found" empty state.
 *
 * Closes the SQLite connection before returning so the loader does not leak
 * file handles. One connection per call is fine — `node:sqlite` open is
 * sub-millisecond per {@link getTasksDb} documentation.
 *
 * @example
 * ```ts
 * // In packages/studio/src/routes/tasks/+page.server.ts
 * export const load: PageServerLoad = async ({ locals, url }) => {
 *   const bundle = await loadExplorerBundle({ projectCtx: locals.projectCtx });
 *   return { bundle };
 * };
 * ```
 */
export async function loadExplorerBundle(opts: LoadExplorerOptions): Promise<ExplorerBundle> {
  const { projectCtx } = opts;
  const includeArchived = opts.includeArchived ?? false;
  const rawLimit = opts.limit ?? 2000;
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 2000;

  const db = getTasksDb(projectCtx);
  if (!db) return emptyBundle();

  try {
    const whereClause = includeArchived ? '' : `WHERE status != 'archived'`;
    const taskRows = db
      .prepare(
        `SELECT ${TASKS_SELECT_COLUMNS}
         FROM tasks
         ${whereClause}
         ORDER BY id ASC
         LIMIT ?`,
      )
      .all(limit) as TaskRowSqlite[];

    const tasks = taskRows.map(rowToTask);

    // Dependency edges are loaded in full; filtering by the loaded id-set
    // below keeps the Explorer's graph view consistent with its node set.
    const depRows = db
      .prepare('SELECT task_id, depends_on FROM task_dependencies')
      .all() as DependencyRowSqlite[];

    const loadedIds = new Set(tasks.map((t) => t.id));
    const deps: TaskDependencyEdge[] = depRows
      .filter((r) => loadedIds.has(r.task_id) && loadedIds.has(r.depends_on))
      .map((r) => ({ taskId: r.task_id, dependsOn: r.depends_on }));

    const epicProgress = _computeEpicProgressRollup(tasks);
    const labels = _collectDistinctLabels(tasks);

    return {
      tasks,
      deps,
      epicProgress,
      labels,
      loadedAt: new Date().toISOString(),
    };
  } finally {
    db.close();
  }
}
