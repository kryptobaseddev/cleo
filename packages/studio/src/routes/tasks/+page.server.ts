/**
 * Tasks dashboard server load — status/priority/type counts, epic progress, recent activity.
 *
 * T874: epic progress uses a single direct-children basis for both numerator
 * and denominator (see `_computeEpicProgress`).
 *
 * T878 (T900): adds two URL-driven display filters:
 *   - `?deferred=1`  — include cancelled epics in the Epic Progress panel
 *                      (default: hidden; prevents clutter from long-term-parked epics)
 *   - `?archived=1`  — include archived tasks in Recent Activity and surface
 *                      an `archived` count on stats. Default: hidden.
 * Both are read server-side so the toggle round-trips through the URL and
 * remains shareable/bookmarkable. The dashboard UI wires `<a href>` links
 * rather than client state so SSR stays correct.
 *
 * T948: epic progress now flows through `cleo.lifecycle.computeRollupsBatch`
 * so Studio shares the CANONICAL projection with the CLI + /tasks/pipeline.
 * The old `_computeEpicProgress(db, options)` helper stays exported (now
 * `@deprecated`) so the T874/T878 tests — which pass a raw in-memory DB —
 * keep working. Production `load()` uses the rollup path; the helper is
 * only kept for back-compat.
 *
 * @task T874 | T878 | T948
 * @epic T876 (owner-labelled T900)
 */

import type { Task, TaskRollupPayload } from '@cleocode/contracts';
import { computeTaskRollups } from '@cleocode/core/lifecycle/rollup';
import { getAccessor } from '@cleocode/core/store/data-accessor';
import { listTasks } from '@cleocode/core/tasks/list';
import { getTasksDb } from '$lib/server/db/connections.js';
import type { PageServerLoad } from './$types';

export interface DashboardStats {
  total: number;
  pending: number;
  active: number;
  done: number;
  cancelled: number;
  archived: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  epics: number;
  tasks: number;
  subtasks: number;
}

export interface RecentTask {
  id: string;
  title: string;
  status: string;
  priority: string;
  type: string;
  pipeline_stage: string | null;
  updated_at: string;
}

export interface EpicProgress {
  id: string;
  title: string;
  status: string;
  total: number;
  done: number;
  active: number;
  pending: number;
  cancelled: number;
}

export interface DashboardFilters {
  /** Include cancelled epics in the Epic Progress panel (?deferred=1). */
  showDeferred: boolean;
  /** Include archived tasks in Recent Activity and surface archived count (?archived=1). */
  showArchived: boolean;
}

/**
 * Minimal shape of the `better-sqlite3` Database instance this module
 * actually uses. Declared locally to keep the file free of cross-package
 * type dependencies and testable against any conformant stub.
 */
export interface EpicProgressDbLike {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
  };
}

// ---------------------------------------------------------------------------
// Epic progress — deprecated pure helper (T874) + new rollup-backed entry (T948)
// ---------------------------------------------------------------------------

/**
 * Compute dashboard epic-progress rows using a direct-children basis.
 *
 * @deprecated T948: production `load()` now uses
 * {@link _computeEpicProgressViaRollup} which routes through
 * `cleo.lifecycle.computeRollupsBatch` so Studio, the CLI, and
 * `/tasks/pipeline` all see the same projection. This pure SQL helper is
 * retained only so the T874/T878 test suites (which pass an in-memory
 * `node:sqlite` db) keep working without a wholesale rewrite.
 *
 * Pure function so it can be unit-tested against an in-memory SQLite DB
 * without spinning up the full SvelteKit load context.
 *
 * @param db - SQLite DB handle (better-sqlite3-compatible).
 * @param options.includeDeferred - When true, include cancelled epics too.
 * @returns One {@link EpicProgress} row per epic (filtered by `includeDeferred`).
 *
 * @task T874 | T878 | T948
 * @epic T876
 */
export function _computeEpicProgress(
  db: EpicProgressDbLike,
  options: { includeDeferred?: boolean } = {},
): EpicProgress[] {
  const { includeDeferred = false } = options;

  // By default: hide archived AND cancelled epics. Cancelled epics are the
  // "deferred / parked" bucket the owner flagged in the T900 brief.
  const epicFilter = includeDeferred
    ? `status != 'archived'`
    : `status NOT IN ('archived','cancelled')`;

  const epics = db
    .prepare(
      `SELECT id, title, status FROM tasks WHERE type = 'epic' AND ${epicFilter} ORDER BY id`,
    )
    .all() as Array<{ id: string; title: string; status: string }>;

  return epics.map((epic) => {
    const children = db
      .prepare(
        `SELECT status, COUNT(*) as cnt
           FROM tasks
          WHERE parent_id = ?
            AND status != 'archived'
          GROUP BY status`,
      )
      .all(epic.id) as Array<{ status: string; cnt: number }>;

    const childMap = Object.fromEntries(children.map((r) => [r.status, r.cnt]));
    const total = Object.values(childMap).reduce((a, b) => a + b, 0);

    return {
      id: epic.id,
      title: epic.title,
      status: epic.status,
      total,
      done: childMap['done'] ?? 0,
      active: childMap['active'] ?? 0,
      pending: childMap['pending'] ?? 0,
      cancelled: childMap['cancelled'] ?? 0,
    };
  });
}

/**
 * Build an {@link EpicProgress} row from a parent epic + its child rollups.
 *
 * Pure transformation, no I/O. Child rollups arrive already filtered to the
 * epic's direct, non-archived children — this function only tallies
 * `execStatus` into dashboard buckets.
 *
 * Exported for tests (T948).
 */
export function _epicRowFromRollups(
  parent: { id: string; title: string; status: string },
  children: TaskRollupPayload[],
): EpicProgress {
  let done = 0;
  let active = 0;
  let pending = 0;
  let cancelled = 0;
  for (const child of children) {
    switch (child.execStatus) {
      case 'done':
        done += 1;
        break;
      case 'active':
        active += 1;
        break;
      case 'pending':
        pending += 1;
        break;
      case 'cancelled':
        cancelled += 1;
        break;
      // 'blocked' / 'archived' / 'proposed' fall through — not tallied, but
      // still counted toward `total` via children.length consistency below.
      default:
        break;
    }
  }
  return {
    id: parent.id,
    title: parent.title,
    status: parent.status,
    total: children.length,
    done,
    active,
    pending,
    cancelled,
  };
}

/**
 * Compute epic-progress rows via the canonical task-rollup facade.
 *
 * T948: this is the production path. For every non-archived epic we issue a
 * single `computeRollup` call to get the parent's exec status plus a
 * `computeRollupsBatch` for its direct children, then delegate to
 * {@link _epicRowFromRollups} for the tally.
 *
 * @param projectPath - Absolute path to the active project (from
 *                      `locals.projectCtx.projectPath`). Passed straight to
 *                      `Cleo.forProject` so the DataAccessor opens against
 *                      the right tasks.db.
 * @param options.includeDeferred - Include `status='cancelled'` epics.
 * @returns Epic progress rows in deterministic (sorted-id) order.
 */
export async function _computeEpicProgressViaRollup(
  projectPath: string,
  options: { includeDeferred?: boolean } = {},
): Promise<EpicProgress[]> {
  const { includeDeferred = false } = options;
  const accessor = await getAccessor(projectPath);
  // Pull every epic — `excludeArchived` trims the 99% case, and we filter
  // `cancelled` in-memory so we can honour the `includeDeferred` toggle
  // without a second round-trip.
  const epicsResult = await listTasks(
    {
      type: 'epic',
      excludeArchived: true,
      sortByPriority: false,
      limit: 1000,
    },
    projectPath,
    accessor,
  );

  const epics: Task[] = epicsResult.tasks
    .filter((e) => includeDeferred || e.status !== 'cancelled')
    .sort((a, b) => a.id.localeCompare(b.id));

  const rows: EpicProgress[] = [];
  for (const epic of epics) {
    // Direct children only — mirrors the T874 semantics of "cleo list
    // --parent <epicId>" so numerator and denominator stay symmetric.
    const childListResult = await listTasks(
      {
        parentId: epic.id,
        excludeArchived: true,
        sortByPriority: false,
        limit: 1000,
      },
      projectPath,
      accessor,
    );
    const childIds = childListResult.tasks.map((c) => c.id);
    const childRollups = await computeTaskRollups(childIds, accessor);
    rows.push(
      _epicRowFromRollups({ id: epic.id, title: epic.title, status: epic.status }, childRollups),
    );
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Page load
// ---------------------------------------------------------------------------

export const load: PageServerLoad = async ({ locals, url }) => {
  const db = getTasksDb(locals.projectCtx);

  // T878: read display filters from URL query params.
  const showDeferred = url.searchParams.get('deferred') === '1';
  const showArchived = url.searchParams.get('archived') === '1';
  const filters: DashboardFilters = { showDeferred, showArchived };

  if (!db) {
    return { stats: null, recentTasks: [], epicProgress: [], filters };
  }

  try {
    const countByStatus = db
      .prepare('SELECT status, COUNT(*) as cnt FROM tasks GROUP BY status')
      .all() as Array<{ status: string; cnt: number }>;

    const countByPriority = db
      .prepare(
        `SELECT priority, COUNT(*) as cnt FROM tasks WHERE status != 'archived' GROUP BY priority`,
      )
      .all() as Array<{ priority: string; cnt: number }>;

    const countByType = db
      .prepare(`SELECT type, COUNT(*) as cnt FROM tasks WHERE status != 'archived' GROUP BY type`)
      .all() as Array<{ type: string; cnt: number }>;

    const statusMap = Object.fromEntries(countByStatus.map((r) => [r.status, r.cnt]));
    const priorityMap = Object.fromEntries(countByPriority.map((r) => [r.priority, r.cnt]));
    const typeMap = Object.fromEntries(countByType.map((r) => [r.type, r.cnt]));

    const stats: DashboardStats = {
      total:
        (statusMap['pending'] ?? 0) +
        (statusMap['active'] ?? 0) +
        (statusMap['done'] ?? 0) +
        (statusMap['cancelled'] ?? 0),
      pending: statusMap['pending'] ?? 0,
      active: statusMap['active'] ?? 0,
      done: statusMap['done'] ?? 0,
      cancelled: statusMap['cancelled'] ?? 0,
      archived: statusMap['archived'] ?? 0,
      critical: priorityMap['critical'] ?? 0,
      high: priorityMap['high'] ?? 0,
      medium: priorityMap['medium'] ?? 0,
      low: priorityMap['low'] ?? 0,
      epics: typeMap['epic'] ?? 0,
      tasks: typeMap['task'] ?? 0,
      subtasks: typeMap['subtask'] ?? 0,
    };

    // T878: Recent Activity respects the archived toggle. When archived is
    // on, include 'archived' rows alongside active/pending/done. When off,
    // keep the pre-T878 behaviour (no archived noise).
    const recentStatusFilter = showArchived
      ? `status IN ('active', 'pending', 'done', 'archived')`
      : `status IN ('active', 'pending', 'done')`;
    const recentTasks = db
      .prepare(
        `SELECT id, title, status, priority, type, pipeline_stage, updated_at
         FROM tasks
         WHERE ${recentStatusFilter}
         ORDER BY updated_at DESC
         LIMIT 20`,
      )
      .all() as RecentTask[];

    // T874/T878/T948: epic progress uses the facade rollup so Studio shares
    // the CANONICAL projection with CLI + /tasks/pipeline (no more drift).
    let epicProgress: EpicProgress[] = [];
    try {
      epicProgress = await _computeEpicProgressViaRollup(locals.projectCtx.projectPath, {
        includeDeferred: showDeferred,
      });
    } catch {
      // Fall back to the in-memory SQL helper if the facade path errors
      // (e.g. accessor unavailable in a half-initialised project). The
      // dashboard should never be completely blank just because the rollup
      // layer is momentarily unreachable.
      epicProgress = _computeEpicProgress(db, { includeDeferred: showDeferred });
    }

    return { stats, recentTasks, epicProgress, filters };
  } catch {
    return { stats: null, recentTasks: [], epicProgress: [], filters };
  }
};
