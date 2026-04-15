/**
 * Tasks dashboard server load — status/priority/type counts, epic progress, recent activity.
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
      total: Object.values(statusMap).reduce((a, b) => a + b, 0),
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

    const epics = db
      .prepare(`SELECT id, title FROM tasks WHERE type = 'epic' AND status != 'archived' LIMIT 20`)
      .all() as Array<{ id: string; title: string }>;

    const epicProgress: EpicProgress[] = epics.map((epic) => {
      const children = db
        .prepare(
          `WITH RECURSIVE desc(id, status) AS (
            SELECT id, status FROM tasks WHERE parent_id = ?
            UNION ALL
            SELECT t.id, t.status FROM tasks t INNER JOIN desc d ON t.parent_id = d.id
            LIMIT 500
          )
          SELECT status, COUNT(*) as cnt FROM desc GROUP BY status`,
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

    return { stats, recentTasks, epicProgress };
  } catch {
    return { stats: null, recentTasks: [], epicProgress: [] };
  }
};
