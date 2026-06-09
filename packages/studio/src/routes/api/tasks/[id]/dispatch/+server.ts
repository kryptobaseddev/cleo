/**
 * POST /api/tasks/[id]/dispatch — Conductor "Dispatch" action for the
 * interactive dispatcher board (T11930 · M5).
 *
 * Dispatching a Backlog/Ready card SPAWNS a real worker in a git worktree via
 * `orchestrate.spawn`. Spawning is real, expensive, and provisions filesystem +
 * worktree state, so this is GATEWAY-ONLY and SERVER-SIDE:
 *
 *  - **Server-side only** — the spawn never runs from the raw browser client.
 *    Secrets, worktree creation, and the orchestrate surface stay behind this
 *    route (the request only carries the task id + tier).
 *  - **Gateway-only (no in-process fallback)** — the spawn routes through the
 *    `/v1` gateway SDK client into the daemon's orchestrate surface. When the
 *    daemon listener is down we return a typed `E_GATEWAY_UNREACHABLE` so the UI
 *    tells the operator to start `cleo daemon serve` rather than silently
 *    spawning a worktree from a web request.
 *
 * On success the task transitions to the Running lane (the spawn marks it
 * active / claimed) and the live worker stream (T11929) attaches to the card.
 *
 * @task T11930
 * @epic T11559
 */

import { json } from '@sveltejs/kit';
import {
  err,
  gatewayClient,
  isGatewayUnreachable,
  isParseError,
  ok,
  parseJsonBody,
} from '../../_dispatch.js';
import type { RequestHandler } from './$types';

/** Data returned on a successful dispatch. */
export interface DispatchData {
  /** The task dispatched. */
  taskId: string;
  /** Spawn tier requested (0=minimal, 1=default, 2=full). */
  tier: 0 | 1 | 2;
  /** The raw `/data` payload from the orchestrate.spawn envelope. */
  spawn: Record<string, unknown>;
}

/**
 * The `orchestrate.spawn` request body shape (taskId + spawn knobs).
 *
 * The generated SDK types `orchestrate.spawn` with `body?: never` (the op's
 * params are not individually contracted in the OpenAPI projection yet), but
 * the gateway reads the POST JSON body as the operation params at runtime. We
 * therefore type the body locally and forward it via the bound method, casting
 * ONLY the options bag at this single boundary — no `any`, no `as unknown as`
 * chain on data.
 */
interface SpawnBody {
  taskId: string;
  tier?: 0 | 1 | 2;
  noWorktree?: boolean;
}

/** The bound spawn method, re-typed to accept the runtime body params. */
type SpawnInvoker = (opts: { body: SpawnBody }) => Promise<{
  data?: { success?: boolean; data?: Record<string, unknown>; error?: { message?: string } };
}>;

export const POST: RequestHandler = async ({ params, request }) => {
  const taskId = params.id;

  const body = await parseJsonBody(request);
  if (isParseError(body)) {
    return json(err('E_VALIDATION', body._parseError), { status: 400 });
  }

  // Tier is the only client-tunable knob; clamp to the valid 0|1|2 set.
  const rawTier = body.tier;
  const tier: 0 | 1 | 2 = rawTier === 0 || rawTier === 2 ? rawTier : 1;

  try {
    const cleo = gatewayClient();
    // The wrapper forwards the options bag verbatim (injecting the client), so a
    // body reaches the gateway as the operation params despite the `never` type.
    const spawn = cleo.orchestrate.spawn as unknown as SpawnInvoker;
    const res = await spawn({ body: { taskId, tier } });
    const envelope = res.data;
    if (envelope && envelope.success === false) {
      return json(err('E_SPAWN_REJECTED', envelope.error?.message ?? 'Spawn rejected'), {
        status: 409,
      });
    }
    return json(ok<DispatchData>({ taskId, tier, spawn: envelope?.data ?? {} }));
  } catch (e) {
    if (isGatewayUnreachable(e)) {
      return json(
        err(
          'E_GATEWAY_UNREACHABLE',
          'The CLEO daemon is not running. Start it with `cleo daemon serve` to dispatch a worker.',
        ),
        { status: 503 },
      );
    }
    const msg = e instanceof Error ? e.message : 'Spawn failed';
    return json(err('E_SPAWN_ERROR', msg), { status: 502 });
  }
};
