/**
 * POST /api/tasks/[id]/transition — drag→transition write path for the
 * interactive agent-lifecycle dispatcher board (T11928 · M5).
 *
 * A drag of a card to a new lane on `/tasks/kanban` persists the implied
 * `tasks.status` change. The board computes the move with the pure
 * {@link import('$lib/components/tasks/lane-transition.js').planLaneTransition}
 * rules and POSTs `{ fromLane, toLane }` here; this route RE-VALIDATES the plan
 * server-side (defense in depth — never trust a client-asserted status), then
 * issues a real `tasks.update` mutation:
 *
 *  1. **Gateway-first** — through the `/v1` gateway SDK client (`tasks.update`),
 *     the ratified write path (T11920). This is a true `tasks.update` mutation
 *     envelope over `/v1`, never local state and never a raw DB write.
 *  2. **Core fallback** — when the daemon listener is unreachable, fall back to
 *     the in-process `@cleocode/core` `updateTask` ENGINE (the same engine the
 *     gateway dispatches into). Still a mutation envelope; still gate-aware.
 *
 * TODO: pure-SDK-over-gateway once `cleo daemon serve` is the Studio default —
 * drop the core fallback and require the gateway (tracked under T11559 / M5).
 *
 * Invalid moves (drag to Done, into a resolved lane, out of Done, same lane)
 * are rejected with a typed reason BEFORE any mutation, so the board reverts +
 * toasts without touching the store.
 *
 * @task T11928
 * @epic T11559
 */

import type { TaskStatus } from '@cleocode/contracts';
import { updateTask } from '@cleocode/core/tasks';
import { json } from '@sveltejs/kit';
import {
  AGENT_LIFECYCLE_LANES,
  type AgentLifecycleLane,
} from '$lib/components/tasks/agent-lifecycle-lane.js';
import { planLaneTransition } from '$lib/components/tasks/lane-transition.js';
import {
  err,
  gatewayClient,
  isGatewayUnreachable,
  isParseError,
  ok,
  parseJsonBody,
  requireString,
} from '../../_dispatch.js';
import type { RequestHandler } from './$types';

/** Data returned on a successful transition. */
export interface TransitionData {
  /** The task moved. */
  taskId: string;
  /** The status the task now holds. */
  status: TaskStatus;
  /** The lane it moved from (echoed for client reconciliation). */
  fromLane: AgentLifecycleLane;
  /** The lane it moved into. */
  toLane: AgentLifecycleLane;
  /** Which write path serviced the mutation. */
  via: 'gateway' | 'core';
  /** Human-readable summary (success toast). */
  summary: string;
}

/** Narrow a string to a known lane id. */
function asLane(v: string): AgentLifecycleLane | null {
  return (AGENT_LIFECYCLE_LANES as readonly string[]).includes(v)
    ? (v as AgentLifecycleLane)
    : null;
}

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const ctx = locals.projectCtx;
  if (!ctx.tasksDbExists) {
    return json(err('E_DB_UNAVAILABLE', 'tasks.db unavailable'), { status: 503 });
  }

  const taskId = params.id;
  const body = await parseJsonBody(request);
  if (isParseError(body)) {
    return json(err('E_VALIDATION', body._parseError), { status: 400 });
  }

  const fromR = requireString(body, 'fromLane', 32);
  if (!fromR.ok) return json(err('E_VALIDATION', fromR.message), { status: 400 });
  const toR = requireString(body, 'toLane', 32);
  if (!toR.ok) return json(err('E_VALIDATION', toR.message), { status: 400 });

  const fromLane = asLane(fromR.value);
  const toLane = asLane(toR.value);
  if (!fromLane || !toLane) {
    return json(err('E_VALIDATION', 'fromLane / toLane must be valid lane ids'), { status: 400 });
  }

  // Re-validate the lifecycle move server-side — never trust the client.
  const planned = planLaneTransition(taskId, fromLane, toLane);
  if (!planned.ok) {
    // 422: the request was well-formed but the move is not a permitted
    // transition. The board reverts the optimistic move + toasts this message.
    return json(err(`E_INVALID_TRANSITION:${planned.reason}`, planned.message), { status: 422 });
  }

  const { status, summary } = planned.plan;

  // 1) Gateway-first.
  try {
    const cleo = gatewayClient();
    const res = await cleo.tasks.update({ body: { taskId, status } });
    const envelope = res.data as { success?: boolean; error?: { message?: string } } | undefined;
    if (envelope && envelope.success === false) {
      return json(
        err('E_GATEWAY_REJECTED', envelope.error?.message ?? 'Gateway rejected the update'),
        { status: 409 },
      );
    }
    return json(ok<TransitionData>({ taskId, status, fromLane, toLane, via: 'gateway', summary }));
  } catch (gatewayErr) {
    if (!isGatewayUnreachable(gatewayErr)) {
      const msg = gatewayErr instanceof Error ? gatewayErr.message : 'Gateway update failed';
      return json(err('E_GATEWAY_ERROR', msg), { status: 502 });
    }
    // Gateway down → fall through to the in-process core engine.
  }

  // 2) Core fallback — same engine the gateway dispatches into.
  try {
    await updateTask({ taskId, status }, ctx.projectPath);
    return json(ok<TransitionData>({ taskId, status, fromLane, toLane, via: 'core', summary }));
  } catch (coreErr) {
    const e = coreErr as { code?: number; message?: string };
    // ExitCode.NOT_FOUND === 4
    if (e?.code === 4) {
      return json(err('E_NOT_FOUND', `Task not found: ${taskId}`), { status: 404 });
    }
    return json(err('E_UPDATE_FAILED', e?.message ?? 'Failed to update task status'), {
      status: 500,
    });
  }
};
