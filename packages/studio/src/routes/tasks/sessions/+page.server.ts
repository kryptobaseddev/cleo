/**
 * Sessions page server load — session history with task completions timeline.
 */

import { getTasksDb } from '$lib/server/db/connections.js';
import type { PageServerLoad } from './$types';

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
                tasks_completed_json, tasks_created_json
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
      tasks_completed_json: string | null;
      tasks_created_json: string | null;
    }>;

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
      };
    });

    return { sessions };
  } catch {
    return { sessions: [] };
  }
};
