/**
 * Dispatch path for the `cleo tui` cockpit — spawn a worker for a focused
 * Backlog/Ready card via `orchestrate.spawn` THROUGH the gateway SDK client
 * (T11935 · M5). Plus the pure Conductor role-lane builder the dispatch UI
 * renders (orchestrator → Lead → worker).
 *
 * ## SDK-only, no shell-out (T11935 · AC3)
 *
 * Spawning is real + expensive (it provisions a git worktree). It routes ONLY
 * through {@link createCleoClient}`.orchestrate.spawn` against the daemon's
 * `/v1` listener — there is NO `child_process`, NO `cleo` CLI shell-out, NO
 * direct `@cleocode/core` domain import. This mirrors the Studio dispatch route
 * (`/api/tasks/[id]/dispatch`, relate T11930): the SAME bound SDK method, the
 * SAME gateway-only policy, the SAME typed-error surface so the two human
 * surfaces dispatch identically.
 *
 * The generated SDK types `orchestrate.spawn` with `body?: never` (the op's
 * params are not individually contracted in the OpenAPI projection yet), but the
 * gateway reads the POST JSON body as the operation params at runtime. We type
 * the body locally and forward it via the bound method, casting ONLY the options
 * bag at this single boundary — no `any`, no `as unknown as` chain on data.
 *
 * Errors NEVER throw out of {@link dispatchWorker}: a daemon-down connection, a
 * rejected spawn, and an unexpected failure all resolve to a typed
 * {@link DispatchResult} the cockpit renders inline on a status line — the TUI
 * never crashes (T11935 · AC3).
 *
 * @packageDocumentation
 * @task T11935
 * @epic T11916
 * @see packages/studio/src/routes/api/tasks/[id]/dispatch/+server.ts — the Studio reference (relate T11930)
 */

import { createCleoClient } from '@cleocode/core/gateway-client';

/** Spawn tier — the `--tier` knob on `orchestrate.spawn` (0=minimal,1=default,2=full). */
export type SpawnTier = 0 | 1 | 2;

/**
 * The `orchestrate.spawn` request body shape (taskId + spawn knobs). Typed
 * locally because the generated SDK declares the op body as `never`; the gateway
 * reads it as the operation params at runtime.
 */
interface SpawnBody {
  /** The task to dispatch a worker for. */
  taskId: string;
  /** Spawn prompt tier. */
  tier?: SpawnTier;
}

/** The bound spawn method, re-typed to accept the runtime body params. */
type SpawnInvoker = (opts: { body: SpawnBody }) => Promise<{
  data?: { success?: boolean; data?: Record<string, unknown>; error?: { message?: string } };
  response?: unknown;
}>;

/** Outcome of a {@link dispatchWorker} call. */
export type DispatchResult =
  | {
      /** The spawn succeeded — the worker is provisioned. */
      readonly ok: true;
      /** The task dispatched. */
      readonly taskId: string;
      /** The tier requested. */
      readonly tier: SpawnTier;
      /** The raw `/data` payload from the spawn envelope (worktree path, branch, …). */
      readonly data: Record<string, unknown>;
    }
  | {
      /** The spawn did not happen. */
      readonly ok: false;
      /** The task that failed to dispatch. */
      readonly taskId: string;
      /** A typed reason code for the inline status line. */
      readonly code: 'E_GATEWAY_UNREACHABLE' | 'E_SPAWN_REJECTED' | 'E_SPAWN_ERROR';
      /** A human-readable, single-line message. */
      readonly message: string;
    };

/** Clamp an arbitrary tier to the valid `0 | 1 | 2` set, defaulting to `1`. */
export function clampTier(raw: number): SpawnTier {
  return raw === 0 || raw === 2 ? raw : 1;
}

/**
 * Dispatch a worker for `taskId` by calling `orchestrate.spawn` through the
 * gateway SDK client. NEVER throws — every failure (daemon unreachable, rejected
 * spawn, unexpected error) resolves to a typed {@link DispatchResult} the
 * cockpit renders inline.
 *
 * The hey-api client does NOT throw on a failed connection; it yields a result
 * with NO `response` object (the request never reached an HTTP server) — the
 * same daemon-down signal the cockpit's unary read path keys on. We map that to
 * `E_GATEWAY_UNREACHABLE`.
 *
 * @param baseUrl - The gateway base URL (the cockpit's configured target).
 * @param taskId - The Backlog/Ready task to spawn a worker for.
 * @param tier - The spawn prompt tier (defaults to `1`).
 * @returns A {@link DispatchResult} — success carries the spawn `/data`, failure
 *   a typed code + message.
 */
export async function dispatchWorker(
  baseUrl: string,
  taskId: string,
  tier: SpawnTier = 1,
): Promise<DispatchResult> {
  try {
    const client = createCleoClient({ baseUrl });
    // The wrapper forwards the options bag verbatim (injecting the client), so a
    // body reaches the gateway as the operation params despite the `never` type.
    const spawn = client.orchestrate.spawn as unknown as SpawnInvoker;
    const res = await spawn({ body: { taskId, tier } });

    // No `response` object ⇒ the request never reached an HTTP server (daemon
    // not serving) — distinct from a reachable daemon that rejected the spawn.
    if (res.response == null) {
      return {
        ok: false,
        taskId,
        code: 'E_GATEWAY_UNREACHABLE',
        message: 'daemon gateway not reachable — start it with `cleo daemon serve`',
      };
    }

    const envelope = res.data;
    if (envelope && envelope.success === false) {
      return {
        ok: false,
        taskId,
        code: 'E_SPAWN_REJECTED',
        message: envelope.error?.message ?? 'spawn rejected',
      };
    }

    return { ok: true, taskId, tier, data: envelope?.data ?? {} };
  } catch (e) {
    // Defensive: a thrown transport error is also "could not dispatch".
    const message = e instanceof Error ? e.message : 'spawn failed';
    return { ok: false, taskId, code: 'E_SPAWN_ERROR', message };
  }
}

// ---------------------------------------------------------------------------
// Conductor role lane (orchestrator → Lead → worker)
// ---------------------------------------------------------------------------

/** One node in the Conductor role chain. */
export interface ConductorRole {
  /** Role label (`Orchestrator` | `Lead` | `Worker`). */
  readonly label: string;
  /** The concrete value bound to this role (e.g. `you`, `orchestrate`, the assignee). */
  readonly value: string;
  /** A one-line hint describing the role's part in the dispatch. */
  readonly hint: string;
}

/**
 * Build the Conductor role lane the dispatch UI renders for a card — the
 * orchestrator → Lead → worker chain the spawn composes, from the data already
 * on the card (no extra fetch). Mirrors the Studio ConductorBar role chain
 * (relate T11930) so both surfaces show the same lifecycle.
 *
 * @param taskId - The task being dispatched.
 * @param assignee - The claimed worker/agent id, when known (else `worktree`).
 * @returns The three-node {@link ConductorRole} chain in dispatch order.
 */
export function buildConductorLane(taskId: string, assignee: string | null): ConductorRole[] {
  return [
    { label: 'Orchestrator', value: 'you', hint: 'cockpit dispatcher' },
    { label: 'Lead', value: 'orchestrate', hint: 'spawn pipeline' },
    {
      label: 'Worker',
      value: assignee && assignee.length > 0 ? assignee : 'worktree',
      hint: `isolated agent · ${taskId}`,
    },
  ];
}

/**
 * Render the Conductor role lane as a single compact terminal line, e.g.
 * `Conductor: Orchestrator(you) → Lead(orchestrate) → Worker(worktree)`.
 *
 * @param roles - The chain from {@link buildConductorLane}.
 * @returns One render line.
 */
export function renderConductorLane(roles: readonly ConductorRole[]): string {
  const chain = roles.map((r) => `${r.label}(${r.value})`).join(' → ');
  return `Conductor: ${chain}`;
}
