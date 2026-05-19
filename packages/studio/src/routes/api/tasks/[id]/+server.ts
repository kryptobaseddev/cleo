/**
 * GET /api/tasks/[id] — single task with subtasks, verification, and acceptance.
 *
 * T9617 refactor: zero raw SQL — delegates to `showTask` from
 * `@cleocode/core/tasks`. The `task` field preserves the pre-T9617
 * snake_case row contract the UI reads (`row.verification_json`, etc).
 * The `subtasks` array and canonical `view` field are also retained.
 *
 * T943 refactor: enriches the response with a canonical `view` field produced
 * by `computeTaskView` from `@cleocode/core/tasks`. The `view` field contains
 * `status`, `pipelineStage`, `readyToComplete`, `nextAction`, and
 * `lifecycleProgress` — computed from the same DB query that powers the CLI
 * `cleo show` command so the values cannot diverge between surfaces.
 *
 * @task T943
 * @task T9617
 */

import { getTaskAccessor } from '@cleocode/core/store/data-accessor';
import { computeTaskView, showTask, type TaskDetail } from '@cleocode/core/tasks';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params }) => {
  const ctx = locals.projectCtx;
  if (!ctx.tasksDbExists) {
    return json({ error: 'tasks.db unavailable' }, { status: 503 });
  }

  const { id } = params;

  try {
    const accessor = await getTaskAccessor(ctx.projectPath);

    let detail: TaskDetail;
    try {
      detail = await showTask(id, ctx.projectPath, accessor);
    } catch (err) {
      const e = err as { code?: number; message?: string };
      if (e?.code === 4) {
        return json({ error: 'not found' }, { status: 404 });
      }
      throw err;
    }

    // Project core Task into the legacy snake_case shape the Studio UI expects.
    const task = {
      id: detail.id,
      title: detail.title,
      description: detail.description ?? null,
      status: detail.status,
      priority: detail.priority,
      type: detail.type ?? 'task',
      parent_id: detail.parentId ?? null,
      pipeline_stage: detail.pipelineStage ?? null,
      size: detail.size ?? null,
      phase: detail.phase ?? null,
      labels_json: detail.labels && detail.labels.length > 0 ? JSON.stringify(detail.labels) : null,
      notes_json: null, // core Task does not expose raw notes_json
      acceptance_json:
        detail.acceptance && detail.acceptance.length > 0
          ? JSON.stringify(detail.acceptance)
          : null,
      verification_json:
        detail.verification !== undefined && detail.verification !== null
          ? JSON.stringify(detail.verification)
          : null,
      created_at: detail.createdAt,
      updated_at: detail.updatedAt ?? detail.createdAt,
      completed_at: detail.completedAt ?? null,
      assignee: detail.assignee ?? null,
      session_id: null, // core Task does not expose raw session_id
    };

    // Resolve direct children using the already-open accessor.
    const childTasks = await accessor.getChildren(id);
    const subtasks = childTasks.map((c) => ({
      id: c.id,
      title: c.title,
      status: c.status,
      priority: c.priority,
      type: c.type ?? 'task',
      pipeline_stage: c.pipelineStage ?? null,
      size: c.size ?? null,
      verification_json:
        c.verification !== undefined && c.verification !== null
          ? JSON.stringify(c.verification)
          : null,
      acceptance_json:
        c.acceptance && c.acceptance.length > 0 ? JSON.stringify(c.acceptance) : null,
      created_at: c.createdAt,
      completed_at: c.completedAt ?? null,
    }));

    // Compute canonical TaskView so status + pipelineStage + readyToComplete
    // are always derived by the same function the CLI uses (T943).
    let view = null;
    try {
      view = await computeTaskView(id, accessor);
    } catch {
      // Degraded gracefully — raw task row still returned above.
    }

    return json({ task, subtasks, ...(view !== null ? { view } : {}) });
  } catch (err) {
    return json({ error: String(err) }, { status: 500 });
  }
};
