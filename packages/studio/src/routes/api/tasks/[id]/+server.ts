/**
 * GET /api/tasks/[id] — single task with subtasks, verification, and acceptance.
 *
 * T943 refactor: enriches the response with a canonical `view` field produced
 * by `computeTaskView` from `@cleocode/core/tasks`. The `view` field contains
 * `status`, `pipelineStage`, `readyToComplete`, `nextAction`, and
 * `lifecycleProgress` — computed from the same DB query that powers the CLI
 * `cleo show` command so the values cannot diverge between surfaces.
 *
 * Fallback: when `computeTaskView` returns null (task not found in the live
 * DB, e.g. freshly migrated) `view` is omitted from the response.
 *
 * @task T943
 */

import { getAccessor } from '@cleocode/core/store/data-accessor';
import { computeTaskView } from '@cleocode/core/tasks';
import { json } from '@sveltejs/kit';
import { getTasksDb } from '$lib/server/db/connections.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params }) => {
  const db = getTasksDb(locals.projectCtx);
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

    // Compute canonical TaskView so status + pipelineStage + readyToComplete
    // are always derived by the same function the CLI uses (T943).
    let view = null;
    try {
      const accessor = await getAccessor(locals.projectCtx.projectPath);
      view = await computeTaskView(id, accessor);
    } catch {
      // Degraded gracefully — raw task row still returned above.
    }

    return json({ task, subtasks, ...(view !== null ? { view } : {}) });
  } catch (err) {
    return json({ error: String(err) }, { status: 500 });
  }
};
