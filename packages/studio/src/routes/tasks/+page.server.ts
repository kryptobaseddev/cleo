/**
 * Tasks dashboard server load — status/priority/type counts, epic progress, recent activity.
 *
 * T874: epic progress uses a single direct-children basis for both numerator
 * and denominator (see `_computeEpicProgress`).
 *
 * T878 (T900): adds two URL-driven display filters:
 *   - `?cancelled=1` — include cancelled epics in the Epic Progress panel
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
 * T958: rename — "Deferred" was a UI label for `status='cancelled'` on epics,
 * NOT a DB field. The canonical URL param is now `?cancelled=1`; legacy
 * `?deferred=1` still maps to the same behaviour for one release (with a
 * one-time `console.warn`). The `includeDeferred` option was renamed to
 * `includeCancelled` across the helper surface.
 *
 * T956: hybrid layout — the loader now returns BOTH the dashboard bundle
 * (stats, epicProgress, recentTasks, filters) AND the shared
 * {@link ExplorerBundle} (tasks, deps, epicProgress map, labels) so the
 * `/tasks` page can embed the 3-tab Task Explorer (Hierarchy / Graph /
 * Kanban) below the preserved dashboard panel. One server round-trip,
 * both surfaces hydrated.
 *
 * @task T874 | T878 | T948 | T956 | T958
 * @epic T876 (owner-labelled T900) | T949
 */

import type { Task, TaskRollupPayload } from '@cleocode/contracts';
import { computeTaskRollups } from '@cleocode/core/lifecycle/rollup';
import { getAccessor } from '@cleocode/core/store/data-accessor';
import { listTasks } from '@cleocode/core/tasks/list';
import { getTasksDb } from '$lib/server/db/connections.js';
import { type ExplorerBundle, loadExplorerBundle } from '$lib/server/tasks/explorer-loader.js';
import type { PageServerLoad } from './$types';

export type { ExplorerBundle };

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
  /**
   * Include cancelled epics in the Epic Progress panel (`?cancelled=1`).
   *
   * T958: renamed from `showDeferred`. Legacy `?deferred=1` still maps here
   * for one release via the server-side deprecation shim below.
   */
  showCancelled: boolean;
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
 * Options accepted by the epic-progress helpers.
 *
 * T958: `includeCancelled` is the canonical name; `includeDeferred` is a
 * deprecated alias kept for one release to avoid breaking callers that
 * pre-dated the rename. When both are set, `includeCancelled` wins.
 */
export interface DeprecatedEpicProgressOptions {
  /** Include `status='cancelled'` epics in the output (T958 canonical name). */
  includeCancelled?: boolean;
  /**
   * @deprecated T958 — use {@link DeprecatedEpicProgressOptions.includeCancelled}.
   * Still honoured for one release.
   */
  includeDeferred?: boolean;
}

/**
 * Resolve the canonical "include cancelled epics" flag from a possibly-legacy
 * options bag, preferring {@link DeprecatedEpicProgressOptions.includeCancelled}
 * over the deprecated `includeDeferred`.
 */
function resolveIncludeCancelled(options: DeprecatedEpicProgressOptions): boolean {
  if (typeof options.includeCancelled === 'boolean') return options.includeCancelled;
  if (typeof options.includeDeferred === 'boolean') return options.includeDeferred;
  return false;
}

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
 * T958: `options.includeDeferred` renamed to `options.includeCancelled`
 * since "deferred" was only ever a UI label for `status='cancelled'` on
 * epics — not a real DB field. The legacy option name is still accepted
 * for one release via {@link DeprecatedEpicProgressOptions}.
 *
 * @param db - SQLite DB handle (better-sqlite3-compatible).
 * @param options.includeCancelled - When true, include cancelled epics too.
 * @param options.includeDeferred - Deprecated alias for `includeCancelled`.
 * @returns One {@link EpicProgress} row per epic (filtered by `includeCancelled`).
 *
 * @task T874 | T878 | T948 | T958
 * @epic T876 | T949
 */
export function _computeEpicProgress(
  db: EpicProgressDbLike,
  options: DeprecatedEpicProgressOptions = {},
): EpicProgress[] {
  const includeCancelled = resolveIncludeCancelled(options);

  // By default: hide archived AND cancelled epics. Cancelled epics are the
  // bucket previously surfaced as "deferred" in the dashboard UI (see T900 /
  // T958 — owner-confirmed rename).
  const epicFilter = includeCancelled
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
 * T958: `options.includeDeferred` renamed to `options.includeCancelled`. The
 * deprecated key is still accepted for one release.
 *
 * @param projectPath - Absolute path to the active project (from
 *                      `locals.projectCtx.projectPath`). Passed straight to
 *                      `Cleo.forProject` so the DataAccessor opens against
 *                      the right tasks.db.
 * @param options.includeCancelled - Include `status='cancelled'` epics.
 * @param options.includeDeferred - Deprecated alias for `includeCancelled`.
 * @returns Epic progress rows in deterministic (sorted-id) order.
 */
export async function _computeEpicProgressViaRollup(
  projectPath: string,
  options: DeprecatedEpicProgressOptions = {},
): Promise<EpicProgress[]> {
  const includeCancelled = resolveIncludeCancelled(options);
  const accessor = await getAccessor(projectPath);
  // Pull every epic — `excludeArchived` trims the 99% case, and we filter
  // `cancelled` in-memory so we can honour the `includeCancelled` toggle
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
    .filter((e) => includeCancelled || e.status !== 'cancelled')
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
// Legacy `?deferred=1` deprecation shim (T958)
// ---------------------------------------------------------------------------

/**
 * One-time guard so the server only warns about a legacy `?deferred=1` URL
 * once per process lifetime, regardless of how many `/tasks` page loads see
 * the param. Mirrors the client-side guard in
 * `packages/studio/src/lib/stores/task-filters.svelte.ts`.
 */
let legacyDeferredWarningEmitted = false;

/**
 * Emit a one-time `console.warn` flagging `?deferred=1` as deprecated.
 *
 * @internal
 */
function warnLegacyDeferredParamOnce(): void {
  if (legacyDeferredWarningEmitted) return;
  legacyDeferredWarningEmitted = true;
  // eslint-disable-next-line no-console
  console.warn(
    '[tasks/+page.server] ?deferred=1 is deprecated; use ?cancelled=1. ' +
      'Alias removal tracked as a follow-up to T958.',
  );
}

/**
 * @internal
 * Test-only hook to reset the one-time `?deferred=1` warning guard so
 * repeated test cases can observe the warning firing exactly once per
 * scenario.
 */
export function __resetLegacyDeferredParamWarningForTests(): void {
  legacyDeferredWarningEmitted = false;
}

// ---------------------------------------------------------------------------
// Page load
// ---------------------------------------------------------------------------

/**
 * Empty explorer-bundle stub returned whenever the shared loader cannot
 * produce a payload (missing tasks.db, half-initialised project, or the
 * loader threw). The hybrid `/tasks` page can still render the dashboard
 * panel and show an "Explorer empty" message without crashing.
 */
function emptyExplorerBundle(): ExplorerBundle {
  return {
    tasks: [],
    deps: [],
    epicProgress: {},
    labels: [],
    loadedAt: new Date().toISOString(),
  };
}

/**
 * Load the shared Task Explorer payload side-by-side with the dashboard.
 *
 * Extracted as its own helper so the try/catch around the explorer loader
 * stays surgical — an Explorer failure must NOT blank the dashboard panel.
 *
 * @param ctx - Active project context (from `locals.projectCtx`).
 * @param includeArchived - Pass through the dashboard archived toggle.
 * @returns The explorer bundle, or an empty stub on any failure.
 *
 * @internal
 */
async function loadExplorerSafe(
  ctx: Parameters<typeof loadExplorerBundle>[0]['projectCtx'],
  includeArchived: boolean,
): Promise<ExplorerBundle> {
  try {
    return await loadExplorerBundle({ projectCtx: ctx, includeArchived });
  } catch {
    return emptyExplorerBundle();
  }
}

export const load: PageServerLoad = async ({ locals, url }) => {
  const db = getTasksDb(locals.projectCtx);

  // T878 / T958: read display filters from URL query params.
  //   - `?cancelled=1` is the canonical name (T958 rename).
  //   - `?deferred=1` is the legacy alias, honoured for one release.
  const cancelledParam = url.searchParams.get('cancelled') === '1';
  const legacyDeferredParam = url.searchParams.get('deferred') === '1';
  if (legacyDeferredParam) {
    warnLegacyDeferredParamOnce();
  }
  const showCancelled = cancelledParam || legacyDeferredParam;
  const showArchived = url.searchParams.get('archived') === '1';
  const filters: DashboardFilters = { showCancelled, showArchived };

  // T956: always load the shared Explorer bundle in parallel with the
  // dashboard queries. The 3 Explorer tabs project the same bundle
  // client-side; switching tabs does NOT re-query the server.
  const explorerPromise = loadExplorerSafe(locals.projectCtx, showArchived);

  if (!db) {
    const explorer = await explorerPromise;
    return { stats: null, recentTasks: [], epicProgress: [], filters, explorer };
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

    // T874/T878/T948/T958: epic progress uses the facade rollup so Studio
    // shares the CANONICAL projection with CLI + /tasks/pipeline (no more
    // drift). `includeCancelled` supersedes the legacy `includeDeferred`.
    let epicProgress: EpicProgress[] = [];
    try {
      epicProgress = await _computeEpicProgressViaRollup(locals.projectCtx.projectPath, {
        includeCancelled: showCancelled,
      });
    } catch {
      // Fall back to the in-memory SQL helper if the facade path errors
      // (e.g. accessor unavailable in a half-initialised project). The
      // dashboard should never be completely blank just because the rollup
      // layer is momentarily unreachable.
      epicProgress = _computeEpicProgress(db, { includeCancelled: showCancelled });
    }

    const explorer = await explorerPromise;

    return { stats, recentTasks, epicProgress, filters, explorer };
  } catch {
    const explorer = await explorerPromise;
    return { stats: null, recentTasks: [], epicProgress: [], filters, explorer };
  }
};
