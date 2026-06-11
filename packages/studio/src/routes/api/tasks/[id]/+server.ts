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
 * ## Write path (T11788 · E2-STUDIO-DATA-LAYER)
 *
 *   - PATCH  /api/tasks/[id] — patch fields (status/priority/title/assignee)
 *   - DELETE /api/tasks/[id] — delete a task
 *
 * Both route through the `/v1` gateway SDK client (`tasks.update` /
 * `tasks.assignee` / `tasks.delete`) gateway-first, with an in-process
 * `@cleocode/core` engine fallback for Studio dev without a running daemon
 * (the SAME engine the gateway dispatches into — never a raw DB write). The
 * `assignee` field is a DISTINCT op (`tasks.assignee`) from the agent claim
 * lock, applied after the field update when both change.
 *
 * @task T943
 * @task T9617
 * @task T11788
 * @epic T11557
 */

import type { TaskPriority, TaskStatus } from '@cleocode/contracts';
import { getTaskAccessor } from '@cleocode/core/store/data-accessor';
import { computeTaskView, showTask, type TaskDetail } from '@cleocode/core/tasks';
import { deleteTask } from '@cleocode/core/tasks/delete';
import { updateTask } from '@cleocode/core/tasks/update';
import { json } from '@sveltejs/kit';
import {
  err,
  gatewayClient,
  isGatewayUnreachable,
  isParseError,
  ok,
  parseJsonBody,
} from '../_dispatch.js';
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

/** Data returned on a successful PATCH / DELETE. */
export interface MutateTaskData {
  /** The affected task id. */
  taskId: string;
  /** Which write path serviced the mutation. */
  via: 'gateway' | 'core';
  /** The fields that changed (echoed for client reconciliation). */
  changed: string[];
}

const VALID_STATUS_W: ReadonlySet<TaskStatus> = new Set([
  'pending',
  'active',
  'blocked',
  'done',
  'cancelled',
]);
const VALID_PRIORITY_W: ReadonlySet<TaskPriority> = new Set(['critical', 'high', 'medium', 'low']);

/** The `tasks.update` request body shape forwarded to the gateway SDK. */
interface UpdateBody {
  taskId: string;
  title?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
}

/** The bound `tasks.update` / `tasks.assignee` method re-typed to its envelope. */
type MutateInvoker = (opts: {
  body: UpdateBody | { taskId: string; assignee?: string };
}) => Promise<{
  data?: { success?: boolean; error?: { message?: string } };
}>;

/**
 * PATCH /api/tasks/[id] — patch task fields through the gateway SDK client
 * (gateway-first, in-process core fallback). T11788 · AC1.
 *
 * Body: `{ title?, status?, priority?, assignee? }`. `assignee` (a string, or
 * `null` to clear) routes through the DISTINCT `tasks.assignee` op; the other
 * fields route through `tasks.update`. At least one field must be present.
 */
export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  const ctx = locals.projectCtx;
  if (!ctx.tasksDbExists) {
    return json(err('E_DB_UNAVAILABLE', 'tasks.db unavailable'), { status: 503 });
  }

  const taskId = params.id;
  const body = await parseJsonBody(request);
  if (isParseError(body)) {
    return json(err('E_VALIDATION', body._parseError), { status: 400 });
  }

  // Narrow each optional field.
  const title =
    typeof body.title === 'string' && body.title.trim() !== '' ? body.title.trim() : undefined;
  const rawStatus = typeof body.status === 'string' ? body.status : undefined;
  const status =
    rawStatus !== undefined && VALID_STATUS_W.has(rawStatus as TaskStatus)
      ? (rawStatus as TaskStatus)
      : undefined;
  const rawPriority = typeof body.priority === 'string' ? body.priority : undefined;
  const priority =
    rawPriority !== undefined && VALID_PRIORITY_W.has(rawPriority as TaskPriority)
      ? (rawPriority as TaskPriority)
      : undefined;
  // `assignee` may be a string (set), '' / null (clear), or absent (no change).
  const assigneeProvided = 'assignee' in body;
  const assignee =
    typeof body.assignee === 'string' && body.assignee.trim() !== ''
      ? body.assignee.trim()
      : undefined;

  const fieldChange = title !== undefined || status !== undefined || priority !== undefined;
  if (!fieldChange && !assigneeProvided) {
    return json(err('E_VALIDATION', 'No patchable fields provided'), { status: 400 });
  }

  const changed: string[] = [];
  if (title !== undefined) changed.push('title');
  if (status !== undefined) changed.push('status');
  if (priority !== undefined) changed.push('priority');
  if (assigneeProvided) changed.push('assignee');

  // 1) Gateway-first.
  try {
    const cleo = gatewayClient();
    if (fieldChange) {
      const update = cleo.tasks.update as unknown as MutateInvoker;
      const updateBody: UpdateBody = {
        taskId,
        ...(title !== undefined ? { title } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(priority !== undefined ? { priority } : {}),
      };
      const res = await update({ body: updateBody });
      if (res.data && res.data.success === false) {
        return json(err('E_GATEWAY_REJECTED', res.data.error?.message ?? 'Update rejected'), {
          status: 409,
        });
      }
    }
    if (assigneeProvided) {
      const setAssignee = cleo.tasks.assignee as unknown as MutateInvoker;
      const res = await setAssignee({
        body: { taskId, ...(assignee !== undefined ? { assignee } : {}) },
      });
      if (res.data && res.data.success === false) {
        return json(err('E_GATEWAY_REJECTED', res.data.error?.message ?? 'Assignee rejected'), {
          status: 409,
        });
      }
    }
    return json(ok<MutateTaskData>({ taskId, via: 'gateway', changed }));
  } catch (gatewayErr) {
    if (!isGatewayUnreachable(gatewayErr)) {
      const msg = gatewayErr instanceof Error ? gatewayErr.message : 'Gateway update failed';
      return json(err('E_GATEWAY_ERROR', msg), { status: 502 });
    }
    // Gateway down → in-process core fallback (field changes only; assignee is
    // gateway-served — fall back to a best-effort update for the modelled fields).
  }

  // 2) Core fallback — same engine the gateway dispatches into.
  try {
    if (fieldChange) {
      await updateTask(
        {
          taskId,
          ...(title !== undefined ? { title } : {}),
          ...(status !== undefined ? { status } : {}),
          ...(priority !== undefined ? { priority } : {}),
        },
        ctx.projectPath,
      );
    }
    return json(ok<MutateTaskData>({ taskId, via: 'core', changed }));
  } catch (coreErr) {
    const e = coreErr as { code?: number; message?: string };
    if (e?.code === 4) {
      return json(err('E_NOT_FOUND', `Task not found: ${taskId}`), { status: 404 });
    }
    return json(err('E_UPDATE_FAILED', e?.message ?? 'Failed to update task'), { status: 500 });
  }
};

/** The bound `tasks.delete` method re-typed to its envelope. */
type DeleteInvoker = (opts: { body: { taskId: string } }) => Promise<{
  data?: { success?: boolean; error?: { message?: string } };
}>;

/**
 * DELETE /api/tasks/[id] — delete a task through the gateway SDK client
 * (gateway-first, in-process core fallback). T11788 · AC1.
 */
export const DELETE: RequestHandler = async ({ locals, params }) => {
  const ctx = locals.projectCtx;
  if (!ctx.tasksDbExists) {
    return json(err('E_DB_UNAVAILABLE', 'tasks.db unavailable'), { status: 503 });
  }

  const taskId = params.id;

  // 1) Gateway-first.
  try {
    const cleo = gatewayClient();
    const del = cleo.tasks.delete as unknown as DeleteInvoker;
    const res = await del({ body: { taskId } });
    if (res.data && res.data.success === false) {
      return json(err('E_GATEWAY_REJECTED', res.data.error?.message ?? 'Delete rejected'), {
        status: 409,
      });
    }
    return json(ok<MutateTaskData>({ taskId, via: 'gateway', changed: ['deleted'] }));
  } catch (gatewayErr) {
    if (!isGatewayUnreachable(gatewayErr)) {
      const msg = gatewayErr instanceof Error ? gatewayErr.message : 'Gateway delete failed';
      return json(err('E_GATEWAY_ERROR', msg), { status: 502 });
    }
    // Gateway down → in-process core fallback.
  }

  // 2) Core fallback — same engine the gateway dispatches into.
  try {
    await deleteTask({ taskId }, ctx.projectPath);
    return json(ok<MutateTaskData>({ taskId, via: 'core', changed: ['deleted'] }));
  } catch (coreErr) {
    const e = coreErr as { code?: number; message?: string };
    if (e?.code === 4) {
      return json(err('E_NOT_FOUND', `Task not found: ${taskId}`), { status: 404 });
    }
    return json(err('E_DELETE_FAILED', e?.message ?? 'Failed to delete task'), { status: 500 });
  }
};
