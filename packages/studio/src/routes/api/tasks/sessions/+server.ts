/**
 * GET /api/tasks/sessions — session history with task completions.
 *
 * Query params:
 *   limit — max sessions (default 50)
 */

import { json } from '@sveltejs/kit';
import { getTasksDb } from '$lib/server/db/connections.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals, url }) => {
  const db = getTasksDb(locals.projectCtx);
  if (!db) {
    return json({ error: 'tasks.db unavailable' }, { status: 503 });
  }

  const limit = Math.min(Number(url.searchParams.get('limit') ?? '50'), 200);

  try {
    const sessions = db
      .prepare(
        `SELECT id, name, status, agent, scope_json, current_task,
                tasks_completed_json, tasks_created_json, started_at, ended_at,
                stats_json, debrief_json
         FROM sessions
         ORDER BY started_at DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{
      id: string;
      name: string | null;
      status: string;
      agent: string | null;
      scope_json: string | null;
      current_task: string | null;
      tasks_completed_json: string | null;
      tasks_created_json: string | null;
      started_at: string;
      ended_at: string | null;
      stats_json: string | null;
      debrief_json: string | null;
    }>;

    // For each session, enrich with completed task titles if IDs present
    const enriched = sessions.map((s) => {
      let completedIds: string[] = [];
      try {
        completedIds = s.tasks_completed_json ? JSON.parse(s.tasks_completed_json) : [];
      } catch {
        completedIds = [];
      }

      let createdIds: string[] = [];
      try {
        createdIds = s.tasks_created_json ? JSON.parse(s.tasks_created_json) : [];
      } catch {
        createdIds = [];
      }

      // Fetch titles for completed tasks (up to 20)
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
        currentTask: s.current_task,
        startedAt: s.started_at,
        endedAt: s.ended_at,
        durationMs,
        completedCount: completedIds.length,
        createdCount: createdIds.length,
        completedTasks,
      };
    });

    return json({ sessions: enriched, total: enriched.length });
  } catch (err) {
    return json({ error: String(err) }, { status: 500 });
  }
};
