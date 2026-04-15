/**
 * GET /api/tasks/[id]/deps — upstream (blockers) + downstream (dependents) for one task.
 *
 * Upstream: tasks that this task depends on (must complete first).
 * Downstream: tasks that depend on this task (are blocked by it).
 *
 * Returns 1-hop in/out plus a `allReady` flag indicating whether all
 * upstream blockers are done.
 */

import { json } from '@sveltejs/kit';
import { getTasksDb } from '$lib/server/db/connections.js';
import type { RequestHandler } from './$types';

interface DepTaskInfo {
  id: string;
  title: string;
  status: string;
  priority: string;
}

interface DepsResponse {
  taskId: string;
  upstream: DepTaskInfo[];
  downstream: DepTaskInfo[];
  allUpstreamReady: boolean;
  blockedCount: number;
  blockingCount: number;
}

export const GET: RequestHandler = ({ locals, params }) => {
  const db = getTasksDb(locals.projectCtx);
  if (!db) {
    return json({ error: 'tasks.db unavailable' }, { status: 503 });
  }

  const { id } = params;

  try {
    // Verify task exists
    const exists = db.prepare('SELECT id FROM tasks WHERE id = ?').get(id);
    if (!exists) {
      return json({ error: 'not found' }, { status: 404 });
    }

    // Upstream: tasks that THIS task depends on (this task is blocked until these are done)
    const upstream = db
      .prepare(
        `SELECT t.id, t.title, t.status, t.priority
         FROM tasks t
         INNER JOIN task_dependencies td ON td.depends_on = t.id
         WHERE td.task_id = ?
         ORDER BY t.id ASC`,
      )
      .all(id) as DepTaskInfo[];

    // Downstream: tasks that depend ON this task (this task blocks them)
    const downstream = db
      .prepare(
        `SELECT t.id, t.title, t.status, t.priority
         FROM tasks t
         INNER JOIN task_dependencies td ON td.task_id = t.id
         WHERE td.depends_on = ?
         ORDER BY t.id ASC`,
      )
      .all(id) as DepTaskInfo[];

    const allUpstreamReady = upstream.every((t) => t.status === 'done');
    const blockedCount = upstream.filter((t) => t.status !== 'done').length;

    const response: DepsResponse = {
      taskId: id,
      upstream,
      downstream,
      allUpstreamReady,
      blockedCount,
      blockingCount: downstream.length,
    };

    return json(response);
  } catch (err) {
    return json({ error: String(err) }, { status: 500 });
  }
};
