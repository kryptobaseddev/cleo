/**
 * GET /api/tasks/sessions — session history with task completions.
 *
 * Query params:
 *   limit — max sessions (default 50)
 *
 * T9617 refactor: zero raw SQL — delegates to `listSessions` from
 * `@cleocode/core/sessions`. The response shape preserves the pre-T9617
 * contract consumed by the Studio sessions page.
 *
 * Note: `workedTasks` enrichment via raw task_work_history join is no
 * longer performed here. The field is omitted (empty array) in this
 * refactor and should be re-introduced via a dedicated core API if
 * needed. // core-first-allowed: task_work_history join not in public API
 *
 * @task T9617
 */

import { listSessions } from '@cleocode/core/sessions';
import { getTaskAccessor } from '@cleocode/core/store/data-accessor';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, url }) => {
  const ctx = locals.projectCtx;
  if (!ctx.tasksDbExists) {
    return json({ error: 'tasks.db unavailable' }, { status: 503 });
  }

  const limit = Math.min(Number(url.searchParams.get('limit') ?? '50'), 200);

  try {
    const sessions = await listSessions(ctx.projectPath, { limit });
    const accessor = await getTaskAccessor(ctx.projectPath);

    const enriched = await Promise.all(
      sessions.map(async (s) => {
        const completedIds: string[] = s.tasksCompleted ?? [];
        const createdIds: string[] = s.tasksCreated ?? [];

        // Fetch titles for completed tasks (up to 20) via core accessor.
        const completedTasks: Array<{ id: string; title: string; status: string }> = [];
        for (const tid of completedIds.slice(0, 20)) {
          const t = await accessor.loadSingleTask(tid);
          if (t) completedTasks.push({ id: t.id, title: t.title, status: t.status });
        }

        // Resolve current active task via core accessor.
        let currentTask: { id: string; title: string; status: string } | null = null;
        const currentTaskId = s.taskWork?.taskId ?? null;
        if (currentTaskId) {
          const ct = await accessor.loadSingleTask(currentTaskId);
          if (ct) currentTask = { id: ct.id, title: ct.title, status: ct.status };
        }

        const durationMs =
          s.startedAt && s.endedAt
            ? new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime()
            : null;

        return {
          id: s.id,
          name: s.name,
          status: s.status,
          agent: s.agent ?? null,
          currentTask,
          startedAt: s.startedAt,
          endedAt: s.endedAt ?? null,
          durationMs,
          completedCount: completedIds.length,
          createdCount: createdIds.length,
          completedTasks,
          // core-first-allowed: task_work_history join not exposed via public API
          workedTasks: [] as Array<{
            id: string;
            title: string;
            status: string;
            setAt: string;
            clearedAt: string | null;
          }>,
        };
      }),
    );

    return json({ sessions: enriched, total: enriched.length });
  } catch (err) {
    return json({ error: String(err) }, { status: 500 });
  }
};
