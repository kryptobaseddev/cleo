/**
 * The SOLID seam for the interactive dispatcher board's data layer
 * (T11790 · E2-STUDIO-DATA-LAYER).
 *
 * The board has two ORTHOGONAL concerns and this module splits them into two
 * narrow, framework-free interfaces so each can vary (and be mocked / tested)
 * independently — the opencode SyncProvider pattern (command vs subscription):
 *
 *  - {@link BoardCommandClient} — the WRITE path. Every mutation the board
 *    issues (drag→move, dispatch→spawn, add, assignee, re-rank) is a method
 *    here. The default impl ({@link httpBoardCommandClient}) POSTs the Studio
 *    `/api/tasks/*` routes, which themselves forward to the `/v1` gateway SDK
 *    client (the ratified write path — never a direct DB write from the
 *    browser, never a secret on the wire).
 *  - {@link BoardSubscription} — the LIVE path. ONE source of truth-change
 *    notifications. The default impl ({@link eventSourceBoardSubscription})
 *    opens a SINGLE `EventSource` against the Studio `tasks.subscribe` delegate
 *    (`/api/tasks/subscribe`, which forwards the gateway SSE) and surfaces every
 *    board lifecycle event + connection state — REPLACING the prior 2 s/15 s
 *    poll loop.
 *
 * The Svelte-5 rune store ({@link import('./saga-board.svelte.js')}) composes
 * BOTH: it calls the command client to mutate, and it re-hydrates on a
 * subscription event. Because the store depends only on these interfaces (DIP),
 * a test injects in-memory fakes and never touches `fetch` / `EventSource`.
 *
 * @packageDocumentation
 * @module $lib/stores/saga-board-client
 *
 * @task T11790 — command-client vs subscription-stream SOLID seam
 * @epic T11557 — E2-STUDIO-DATA-LAYER
 * @saga T11555
 */

import type { TaskPriority, TaskStatus } from '@cleocode/contracts';
import type { TaskRow, TasksResponse } from '../../routes/api/tasks/+server.js';

// ---------------------------------------------------------------------------
// Shared result type — a thin LAFS-flavoured success | failure carrier
// ---------------------------------------------------------------------------

/**
 * The narrow result every command returns: a tagged success carrying the
 * route's `/data` payload, or a tagged failure carrying a human-readable
 * message + the typed error code the route emitted. The store branches on
 * `ok` — it never throws across the seam.
 *
 * @typeParam T - The success payload shape (the route's `/data`).
 */
export type CommandResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** A drag→lane move: the implied status transition the board persists. */
export interface MoveCommand {
  /** Task being moved. */
  taskId: string;
  /** Lane the card came from (echoed for server-side re-validation). */
  fromLane: string;
  /** Lane the card was dropped into. */
  toLane: string;
}

/** A Conductor dispatch: spawn a worker for a Backlog/Ready card. */
export interface DispatchCommand {
  /** Task to spawn a worker for. */
  taskId: string;
  /** Spawn tier (0=minimal · 1=default · 2=full). */
  tier: 0 | 1 | 2;
}

/** A new-task create issued from the Conductor add surface. */
export interface CreateCommand {
  /** Required title. */
  title: string;
  /** Optional parent task id. */
  parent?: string;
  /** Optional priority. */
  priority?: TaskPriority;
  /** Optional acceptance criteria (one entry per AC). */
  acceptance?: string[];
}

/** A field patch on an existing task (status / priority / assignee / title). */
export interface PatchCommand {
  /** Task to patch. */
  taskId: string;
  /** New title, if changing. */
  title?: string;
  /** New status, if transitioning. */
  status?: TaskStatus;
  /** New priority, if re-prioritising. */
  priority?: TaskPriority;
  /** New assignee, or `null` to clear it. */
  assignee?: string | null;
}

/** The `/data` payload a successful move/patch/create/dispatch returns. */
export interface CommandData {
  /** The task id the mutation affected. */
  taskId: string;
  /** Which write path serviced it (`gateway` vs in-process `core` fallback). */
  via?: 'gateway' | 'core';
  /** Optional human-readable summary (success toast). */
  summary?: string;
  /** Any extra route-specific fields (echoed status, spawn payload, …). */
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// BoardCommandClient — the WRITE seam
// ---------------------------------------------------------------------------

/**
 * The write surface the board programs against. Every method is a single board
 * mutation; the impl decides HOW (HTTP → gateway SDK today). DIP: the store
 * depends on this interface, not on `fetch`.
 */
export interface BoardCommandClient {
  /** Move a card to a new lane (persists the implied status transition). */
  move(cmd: MoveCommand): Promise<CommandResult<CommandData>>;
  /** Dispatch a worker for a card (gateway-only — spawns a worktree). */
  dispatch(cmd: DispatchCommand): Promise<CommandResult<CommandData>>;
  /** Create a new task. */
  create(cmd: CreateCommand): Promise<CommandResult<CommandData>>;
  /** Patch fields on an existing task. */
  patch(cmd: PatchCommand): Promise<CommandResult<CommandData>>;
  /** Delete a task. */
  remove(taskId: string): Promise<CommandResult<CommandData>>;
}

// ---------------------------------------------------------------------------
// BoardSubscription — the LIVE seam
// ---------------------------------------------------------------------------

/** A single board lifecycle event surfaced by the subscription. */
export interface BoardEvent {
  /** Lifecycle kind, when the source classifies it (`created`/`updated`/`deleted`/`heartbeat`). */
  event?: string;
  /** Optional saga/parent scope the stream is bound to. */
  root?: string | null;
  /** Monotonic sequence number within the stream. */
  seq?: number;
  /** Free-form payload from the stream source. */
  [key: string]: unknown;
}

/** Callbacks a {@link BoardSubscription} invokes over its lifetime. */
export interface BoardSubscriptionHandlers {
  /** A board lifecycle event arrived — the store re-hydrates. */
  onEvent: (event: BoardEvent) => void;
  /** Connection state changed (drives the `live` indicator). */
  onConnectionChange?: (connected: boolean) => void;
}

/** A live subscription handle — call {@link close} to tear it down. */
export interface BoardSubscription {
  /** Tear the subscription down (idempotent). */
  close(): void;
}

/**
 * The live-source factory the store programs against. Opening a subscription
 * returns a handle; the store opens exactly ONE for the board's lifetime and
 * closes it on teardown. DIP: the store depends on this, not on `EventSource`.
 */
export type BoardSubscriptionFactory = (handlers: BoardSubscriptionHandlers) => BoardSubscription;

// ---------------------------------------------------------------------------
// Default HTTP command client (forwards Studio routes → gateway SDK)
// ---------------------------------------------------------------------------

/**
 * Parse a Studio `/api/tasks/*` LAFS envelope from a `fetch` Response into a
 * {@link CommandResult}. Never throws — a non-JSON / non-2xx response becomes a
 * tagged failure with the best message available.
 *
 * @typeParam T - The expected success `/data` shape.
 * @param res - The fetch response.
 * @returns The narrowed command result.
 */
async function readCommandEnvelope<T>(res: Response): Promise<CommandResult<T>> {
  let body: {
    success?: boolean;
    data?: unknown;
    error?: { code?: string; message?: string };
  };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return { ok: false, code: 'E_BAD_RESPONSE', message: `Request failed (${res.status})` };
  }
  if (res.ok && body.success !== false) {
    return { ok: true, data: (body.data ?? {}) as T };
  }
  return {
    ok: false,
    code: body.error?.code ?? `E_HTTP_${res.status}`,
    message: body.error?.message ?? `Request failed (${res.status})`,
  };
}

/**
 * POST a JSON body to a Studio route and narrow the envelope. The shared
 * transport for every {@link httpBoardCommandClient} method.
 *
 * @param fetchImpl - The `fetch` to use (injectable for SSR / tests).
 * @param path - The Studio route path (e.g. `/api/tasks`).
 * @param method - The HTTP method.
 * @param payload - The JSON request body, or `undefined` for none.
 * @returns The narrowed command result.
 */
async function postJson<T>(
  fetchImpl: typeof fetch,
  path: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  payload?: unknown,
): Promise<CommandResult<T>> {
  try {
    const res = await fetchImpl(path, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    });
    return await readCommandEnvelope<T>(res);
  } catch (e) {
    return {
      ok: false,
      code: 'E_NETWORK',
      message: e instanceof Error ? e.message : 'Network request failed',
    };
  }
}

/**
 * Build the default {@link BoardCommandClient}: every method POSTs / PATCHes /
 * DELETEs the Studio `/api/tasks/*` routes, which forward to the `/v1` gateway
 * SDK client. No direct core import, no DB handle, no secret in the browser.
 *
 * @param fetchImpl - The `fetch` implementation (defaults to the global; pass
 *   SvelteKit's `fetch` in a load, or a fake in a test).
 * @returns A command client bound to that `fetch`.
 */
export function httpBoardCommandClient(fetchImpl: typeof fetch = fetch): BoardCommandClient {
  return {
    move(cmd) {
      return postJson<CommandData>(fetchImpl, `/api/tasks/${cmd.taskId}/transition`, 'POST', {
        fromLane: cmd.fromLane,
        toLane: cmd.toLane,
      });
    },
    dispatch(cmd) {
      return postJson<CommandData>(fetchImpl, `/api/tasks/${cmd.taskId}/dispatch`, 'POST', {
        tier: cmd.tier,
      });
    },
    create(cmd) {
      return postJson<CommandData>(fetchImpl, '/api/tasks', 'POST', cmd);
    },
    patch(cmd) {
      const { taskId, ...fields } = cmd;
      return postJson<CommandData>(fetchImpl, `/api/tasks/${taskId}`, 'PATCH', fields);
    },
    remove(taskId) {
      return postJson<CommandData>(fetchImpl, `/api/tasks/${taskId}`, 'DELETE');
    },
  };
}

// ---------------------------------------------------------------------------
// Default EventSource subscription (ONE stream → tasks.subscribe delegate)
// ---------------------------------------------------------------------------

/**
 * The Studio delegate path that forwards the gateway `tasks.subscribe` SSE. The
 * store opens exactly ONE `EventSource` here — the single live channel that
 * replaces the legacy poll.
 */
export const TASKS_SUBSCRIBE_PATH = '/api/tasks/subscribe';

/**
 * Build the default {@link BoardSubscriptionFactory} over a SINGLE
 * `EventSource` pointed at the `tasks.subscribe` delegate.
 *
 * The gateway emits canonical `GatewayStreamEvent` frames (`data:`-only records
 * whose JSON is `{ kind, seq, data, error, requestId }`). This factory decodes
 * each `message`, surfaces `kind:'data'` frames as {@link BoardEvent}s (the
 * `data` payload is the board lifecycle event), and maps open / error / `done`
 * to the connection-state callback. Only browser-side: guarded so SSR is a
 * no-op handle.
 *
 * @param root - Optional saga/parent scope appended as `?root=`.
 * @returns A subscription factory the store opens once.
 */
export function eventSourceBoardSubscriptionFactory(root?: string): BoardSubscriptionFactory {
  return (handlers) => {
    // SSR guard — no EventSource on the server; the store hydrates from the
    // initial snapshot and the client `$effect` opens the real stream.
    if (typeof EventSource === 'undefined') {
      return { close() {} };
    }

    const url = root
      ? `${TASKS_SUBSCRIBE_PATH}?root=${encodeURIComponent(root)}`
      : TASKS_SUBSCRIBE_PATH;
    const src = new EventSource(url);

    src.onopen = () => handlers.onConnectionChange?.(true);

    src.onmessage = (msg: MessageEvent<string>) => {
      let frame: { kind?: string; seq?: number; data?: unknown };
      try {
        frame = JSON.parse(msg.data) as typeof frame;
      } catch {
        return; // Malformed frame — ignore (keep the stream alive).
      }
      if (frame.kind === 'data') {
        const payload =
          frame.data !== null && typeof frame.data === 'object'
            ? (frame.data as Record<string, unknown>)
            : {};
        handlers.onEvent({ ...payload, seq: frame.seq });
      } else if (frame.kind === 'done') {
        handlers.onConnectionChange?.(false);
      }
    };

    src.onerror = () => handlers.onConnectionChange?.(false);

    return {
      close() {
        src.close();
        handlers.onConnectionChange?.(false);
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Hydration source — reads the board snapshot (GET /api/tasks)
// ---------------------------------------------------------------------------

/**
 * A board snapshot row — the minimal task fields the board renders, lifted off
 * the `/api/tasks` {@link TaskRow}. Kept separate from `TaskRow` so the store's
 * card projection is stable even if the legacy row grows.
 */
export interface BoardSnapshotRow {
  /** Task id. */
  id: string;
  /** Title. */
  title: string;
  /** Lifecycle status. */
  status: TaskStatus;
  /** Priority. */
  priority: TaskPriority;
  /** Size chip, or null. */
  size: string | null;
  /** Parent task id, or null. */
  parentId: string | null;
  /** Raw `verification_json` for the gate dots, or null. */
  verificationJson: string | null;
}

/** Map a `/api/tasks` legacy row to the board snapshot shape. */
function toSnapshotRow(row: TaskRow): BoardSnapshotRow {
  return {
    id: row.id,
    title: row.title,
    status: row.status as TaskStatus,
    priority: row.priority as TaskPriority,
    size: row.size,
    parentId: row.parent_id,
    verificationJson: row.verification_json,
  };
}

/** The hydration surface — reads the current board snapshot from the gateway. */
export interface BoardHydrator {
  /** Fetch the current board snapshot (rows + the active-worker id set). */
  hydrate(): Promise<{ rows: BoardSnapshotRow[]; activeWorkerIds: string[] }>;
}

/**
 * Build the default {@link BoardHydrator}: GETs `/api/tasks` (which reads the
 * gateway data layer) and projects the rows + the `views` `nextAction` signal
 * into the board snapshot. A `running`-stage view (`nextAction` set + active
 * session) is surfaced as an active-worker id so the board's Running affordance
 * lights up without a second request.
 *
 * @param fetchImpl - The `fetch` to use (SvelteKit's in a load, global on the client).
 * @returns A hydrator bound to that `fetch`.
 */
export function httpBoardHydrator(fetchImpl: typeof fetch = fetch): BoardHydrator {
  return {
    async hydrate() {
      const res = await fetchImpl('/api/tasks?limit=1000');
      if (!res.ok) {
        throw new Error(`Failed to hydrate board snapshot (${res.status})`);
      }
      const body = (await res.json()) as TasksResponse;
      const rows = body.tasks.map(toSnapshotRow);
      // The active-worker set is derived from the canonical views: a task an
      // agent is actively executing holds `status === 'active'` (the claim
      // marks it active), so that is the running-worker signal the board's
      // Running affordance lights up on — no second request needed.
      const activeWorkerIds = body.views.filter((v) => v.status === 'active').map((v) => v.id);
      return { rows, activeWorkerIds };
    },
  };
}
