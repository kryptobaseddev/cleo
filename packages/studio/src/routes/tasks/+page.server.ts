/**
 * Tasks dashboard server load — status/priority/type counts, epic progress, recent activity.
 *
 * T874: epic progress now uses a single consistent basis — direct children
 * only — for both numerator and denominator. The previous implementation
 * mixed a recursive-descendant COUNT(*) with a plain status bucket, which
 * produced nonsense like "5/29 done" where 5 = direct children done and
 * 29 = all descendants including archived. Now both sides count the same
 * rows (`parent_id = epic.id AND status != 'archived'`), so counts match
 * `cleo list --parent <epicId>`.
 *
 * @task T874
 * @epic T870
 */

import { getTasksDb } from '$lib/server/db/connections.js';
import type { PageServerLoad } from './$types';

export interface DashboardStats {
  total: number;
  pending: number;
  active: number;
  done: number;
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
  total: number;
  done: number;
  active: number;
  pending: number;
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

/**
 * Compute dashboard epic-progress rows using a direct-children basis.
 *
 * Pure function so it can be unit-tested against an in-memory SQLite DB
 * without spinning up the full SvelteKit load context.
 *
 * @param db - SQLite DB handle (better-sqlite3-compatible).
 * @returns One {@link EpicProgress} row per non-archived epic.
 *
 * @remarks
 * Both numerator and denominator count the same row set
 * (`parent_id = epic.id AND status != 'archived'`), so the returned
 * `total` equals `cleo list --parent <epicId>`'s filtered count. The
 * previous recursive-descendant implementation produced an asymmetric
 * "5 done / 29 total" because the numerator and denominator counted
 * different things.
 *
 * @task T874
 * @epic T870
 */
export function computeEpicProgress(db: EpicProgressDbLike): EpicProgress[] {
  const epics = db
    .prepare(`SELECT id, title FROM tasks WHERE type = 'epic' AND status != 'archived' ORDER BY id`)
    .all() as Array<{ id: string; title: string }>;

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
      total,
      done: childMap['done'] ?? 0,
      active: childMap['active'] ?? 0,
      pending: childMap['pending'] ?? 0,
    };
  });
}

export const load: PageServerLoad = ({ locals }) => {
  const db = getTasksDb(locals.projectCtx);

  if (!db) {
    return { stats: null, recentTasks: [], epicProgress: [] };
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
      archived: statusMap['archived'] ?? 0,
      critical: priorityMap['critical'] ?? 0,
      high: priorityMap['high'] ?? 0,
      medium: priorityMap['medium'] ?? 0,
      low: priorityMap['low'] ?? 0,
      epics: typeMap['epic'] ?? 0,
      tasks: typeMap['task'] ?? 0,
      subtasks: typeMap['subtask'] ?? 0,
    };

    const recentTasks = db
      .prepare(
        `SELECT id, title, status, priority, type, pipeline_stage, updated_at
         FROM tasks
         WHERE status IN ('active', 'pending', 'done')
         ORDER BY updated_at DESC
         LIMIT 20`,
      )
      .all() as RecentTask[];

    // T874: epic progress uses direct-children basis on BOTH sides.
    // See computeEpicProgress for the full rationale.
    const epicProgress = computeEpicProgress(db);

    return { stats, recentTasks, epicProgress };
  } catch {
    return { stats: null, recentTasks: [], epicProgress: [] };
  }
};
