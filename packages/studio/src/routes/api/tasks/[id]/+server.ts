/**
 * GET /api/tasks/[id] — single task with subtasks, verification, and acceptance.
 */

import { json } from '@sveltejs/kit';
import { getTasksDb } from '$lib/server/db/connections.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params }) => {
  const db = getTasksDb();
  if (!db) {
    return json({ error: 'tasks.db unavailable' }, { status: 503 });
  }

  const { id } = params;

  try {
    const task = db
      .prepare(
        `SELECT id, title, description, status, priority, type, parent_id,
                pipeline_stage, size, phase, labels_json, notes_json,
                acceptance_json, verification_json, created_at, updated_at,
                completed_at, assignee, session_id
         FROM tasks WHERE id = ?`,
      )
      .get(id);

    if (!task) {
      return json({ error: 'not found' }, { status: 404 });
    }

    const subtasks = db
      .prepare(
        `SELECT id, title, status, priority, type, pipeline_stage, size,
                verification_json, acceptance_json, created_at, completed_at
         FROM tasks WHERE parent_id = ?
         ORDER BY position ASC, created_at ASC`,
      )
      .all(id);

    return json({ task, subtasks });
  } catch (err) {
    return json({ error: String(err) }, { status: 500 });
  }
};
