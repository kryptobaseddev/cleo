/**
 * GET /api/tasks/[id]/deps — upstream (blockers) + downstream (dependents) for one task.
 *
 * Upstream: tasks that this task depends on (must complete first).
 * Downstream: tasks that depend on this task (are blocked by it).
 *
 * Returns 1-hop in/out plus a `allReady` flag indicating whether all
 * upstream blockers are done.
 *
 * T9617 refactor: zero raw SQL — delegates to `taskDeps` from
 * `@cleocode/core/tasks`. The response shape preserves the pre-T9617
 * contract consumed by the Studio dep panel.
 *
 * @task T9617
 */

import { taskDeps } from '@cleocode/core/tasks';
import { json } from '@sveltejs/kit';
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

export const GET: RequestHandler = async ({ locals, params }) => {
  const ctx = locals.projectCtx;
  if (!ctx.tasksDbExists) {
    return json({ error: 'tasks.db unavailable' }, { status: 503 });
  }

  const { id } = params;

  const result = await taskDeps(ctx.projectPath, id);

  if (!result.success) {
    if (result.error?.code === 'E_NOT_FOUND') {
      return json({ error: 'not found' }, { status: 404 });
    }
    return json({ error: result.error?.message ?? 'Failed to load deps' }, { status: 500 });
  }

  const { dependsOn, dependedOnBy, unresolvedDeps, allDepsReady } = result.data;

  // Map to the legacy upstream/downstream shape with priority field.
  // core taskDeps does not return priority in the dep entries — supply a
  // stable default so the response contract is maintained.
  const upstream: DepTaskInfo[] = dependsOn.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    priority: 'medium', // core-first-allowed: priority not in taskDeps result
  }));

  const downstream: DepTaskInfo[] = dependedOnBy.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    priority: 'medium', // core-first-allowed: priority not in taskDeps result
  }));

  const blockedCount = unresolvedDeps.length;

  const response: DepsResponse = {
    taskId: id,
    upstream,
    downstream,
    allUpstreamReady: allDepsReady,
    blockedCount,
    blockingCount: downstream.length,
  };

  return json(response);
};
