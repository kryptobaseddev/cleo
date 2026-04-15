/**
 * Sessions page server load — session history with task completions timeline.
 */

import { getTasksDb } from '$lib/server/db/connections.js';
import type { PageServerLoad } from './$types';

export interface WorkedTaskEntry {
  id: string;
  title: string;
  status: string;
  setAt: string;
  clearedAt: string | null;
}

export interface SessionEntry {
  id: string;
  name: string | null;
  status: string;
  agent: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  completedCount: number;
  createdCount: number;
  completedTasks: Array<{ id: string; title: string; status: string }>;
  /** Task currently active in this session (null if none or session ended). */
  currentTask: { id: string; title: string; status: string } | null;
  /** All tasks worked during this session from task_work_history. */
  workedTasks: WorkedTaskEntry[];
}

export const load: PageServerLoad = ({ locals }) => {
  const db = getTasksDb(locals.projectCtx);

  if (!db) {
    return { sessions: [] };
  }

  try {
    const rows = db
      .prepare(
        `SELECT id, name, status, agent, started_at, ended_at,
                current_task, tasks_completed_json, tasks_created_json
         FROM sessions
         ORDER BY started_at DESC
         LIMIT 100`,
      )
      .all() as Array<{
      id: string;
      name: string | null;
      status: string;
      agent: string | null;
      started_at: string;
      ended_at: string | null;
      current_task: string | null;
      tasks_completed_json: string | null;
      tasks_created_json: string | null;
    }>;

    // Pre-fetch all task_work_history rows for these sessions in one query
    const sessionIds = rows.map((r) => r.id);
    const workHistoryRows =
      sessionIds.length > 0
        ? (db
            .prepare(
              `SELECT twh.session_id, twh.task_id, twh.set_at, twh.cleared_at,
                      t.title, t.status
               FROM task_work_history twh
               JOIN tasks t ON t.id = twh.task_id
               WHERE twh.session_id IN (${sessionIds.map(() => '?').join(',')})
               ORDER BY twh.set_at ASC`,
            )
            .all(...sessionIds) as Array<{
            session_id: string;
            task_id: string;
            set_at: string;
            cleared_at: string | null;
            title: string;
            status: string;
          }>)
        : [];

    // Group work history by session
    const workHistoryBySession = new Map<string, WorkedTaskEntry[]>();
    for (const row of workHistoryRows) {
      const existing = workHistoryBySession.get(row.session_id) ?? [];
      existing.push({
        id: row.task_id,
        title: row.title,
        status: row.status,
        setAt: row.set_at,
        clearedAt: row.cleared_at,
      });
      workHistoryBySession.set(row.session_id, existing);
    }

    const sessions: SessionEntry[] = rows.map((s) => {
      let completedIds: string[] = [];
      try {
        completedIds = s.tasks_completed_json ? JSON.parse(s.tasks_completed_json) : [];
      } catch {
        completedIds = [];
      }

      let createdCount = 0;
      try {
        const created = s.tasks_created_json ? JSON.parse(s.tasks_created_json) : [];
        createdCount = Array.isArray(created) ? created.length : 0;
      } catch {
        createdCount = 0;
      }

      const completedTasks: Array<{ id: string; title: string; status: string }> = [];
      for (const tid of completedIds.slice(0, 20)) {
        const t = db.prepare('SELECT id, title, status FROM tasks WHERE id = ?').get(tid) as
          | { id: string; title: string; status: string }
          | undefined;
        if (t) completedTasks.push(t);
      }

      // Resolve current active task (only meaningful for active sessions)
      let currentTask: { id: string; title: string; status: string } | null = null;
      if (s.current_task) {
        const ct = db
          .prepare('SELECT id, title, status FROM tasks WHERE id = ?')
          .get(s.current_task) as { id: string; title: string; status: string } | undefined;
        if (ct) currentTask = ct;
      }

      const workedTasks = workHistoryBySession.get(s.id) ?? [];

      const durationMs =
        s.started_at && s.ended_at
          ? new Date(s.ended_at).getTime() - new Date(s.started_at).getTime()
          : null;

      return {
        id: s.id,
        name: s.name,
        status: s.status,
        agent: s.agent,
        startedAt: s.started_at,
        endedAt: s.ended_at,
        durationMs,
        completedCount: completedIds.length,
        createdCount,
        completedTasks,
        currentTask,
        workedTasks,
      };
    });

    return { sessions };
  } catch {
    return { sessions: [] };
  }
};
