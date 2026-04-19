/**
 * SSE Live Synapses stream endpoint.
 *
 * GET /api/living-brain/stream
 *   → text/event-stream
 *
 * Emits `LBStreamEvent` objects encoded as `data: <JSON>\n\n`.
 *
 * Event types:
 *   hello          — sent immediately on connect
 *   heartbeat      — sent every 30 s (prevents proxy/client timeout)
 *   node.create    — new row in brain_observations
 *   edge.strengthen — brain_page_edges weight updated
 *   task.status    — tasks row status changed
 *   message.send   — new row in conduit messages
 *
 * Polling uses a per-source watermark (`last_seen_id` or `last_seen_ts`)
 * so already-delivered rows are never replayed.
 *
 * The stream self-terminates when the client disconnects (AbortSignal).
 *
 * @see packages/brain/src/types.ts — LBStreamEvent
 */

import type { LBNode, LBStreamEvent } from '@cleocode/brain';
import { getBrainDb, getConduitDb, getTasksDb } from '$lib/server/db/connections.js';
import type { ProjectContext } from '$lib/server/project-context.js';
import type { RequestHandler } from './$types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How often (ms) to poll source tables for new rows. */
const POLL_INTERVAL_MS = 1_000;

/** How often (ms) to send a heartbeat to prevent connection drop. */
const HEARTBEAT_INTERVAL_MS = 30_000;

/** Max chars for message preview in message.send events. */
const MESSAGE_PREVIEW_LEN = 120;

// ---------------------------------------------------------------------------
// Row types (internal — brain, tasks, conduit)
// ---------------------------------------------------------------------------

/** Raw row from brain_observations returned by the change-detection query. */
interface ObsRow {
  id: string;
  title: string;
  quality_score: number | null;
  memory_tier: string | null;
  created_at: string;
  source_session_id: string | null;
}

/** Raw row from brain_page_edges returned by the weight-update query. */
interface EdgeRow {
  from_id: string;
  to_id: string;
  edge_type: string;
  weight: number;
  updated_at: string | null;
}

/** Raw row from tasks returned by the status-change query. */
interface TaskRow {
  id: string;
  status: string;
  updated_at: string | null;
}

/** Raw row from conduit messages returned by the INSERT-detection query. */
interface MsgRow {
  id: string;
  content: string;
  from_agent_id: string | null;
  to_agent_id: string | null;
  created_at: number;
}

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

/**
 * Serialises an `LBStreamEvent` to the `data: …\n\n` SSE wire format.
 *
 * @param event - The event to encode.
 * @returns SSE-formatted string ready for the stream.
 */
function sseEncode(event: LBStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

// ---------------------------------------------------------------------------
// Watermark state (per-connection)
// ---------------------------------------------------------------------------

interface WatermarkState {
  /** Highest brain_observations rowid seen so far. */
  lastObsRowid: number;
  /**
   * Snapshot of brain_page_edges weights seen at connection open.
   * Key: `from_id|to_id`, value: last-known weight.
   */
  edgeWeights: Map<string, number>;
  /** Highest tasks rowid seen so far (for status-change detection). */
  lastTaskRowid: number;
  /** Last-known status per task id. */
  taskStatuses: Map<string, string>;
  /** Highest conduit messages rowid seen so far. */
  lastMsgRowid: number;
}

/**
 * Initialises watermarks from the current state of all source tables.
 * This prevents replaying historical rows when a client first connects.
 *
 * @param ctx - Active project context for resolving per-project DB paths.
 * @returns Initial watermark state.
 */
function initWatermarks(ctx: ProjectContext): WatermarkState {
  const state: WatermarkState = {
    lastObsRowid: 0,
    edgeWeights: new Map(),
    lastTaskRowid: 0,
    taskStatuses: new Map(),
    lastMsgRowid: 0,
  };

  try {
    const brainDb = getBrainDb(ctx);
    if (brainDb) {
      // Highest rowid in brain_observations
      const obsMax = brainDb
        .prepare('SELECT COALESCE(MAX(rowid), 0) AS max_rowid FROM brain_observations')
        .get() as { max_rowid: number } | undefined;
      state.lastObsRowid = obsMax?.max_rowid ?? 0;

      // Snapshot all current edge weights
      const edges = brainDb
        .prepare('SELECT from_id, to_id, weight FROM brain_page_edges')
        .all() as Array<{ from_id: string; to_id: string; weight: number }>;
      for (const e of edges) {
        state.edgeWeights.set(`${e.from_id}|${e.to_id}`, e.weight);
      }
    }
  } catch {
    // DB absent — watermarks stay at 0 / empty
  }

  try {
    const tasksDb = getTasksDb(ctx);
    if (tasksDb) {
      // Highest rowid in tasks
      const taskMax = tasksDb
        .prepare('SELECT COALESCE(MAX(rowid), 0) AS max_rowid FROM tasks')
        .get() as { max_rowid: number } | undefined;
      state.lastTaskRowid = taskMax?.max_rowid ?? 0;

      // Snapshot current statuses for rowids we've already seen
      const rows = tasksDb.prepare('SELECT id, status FROM tasks').all() as Array<{
        id: string;
        status: string;
      }>;
      for (const r of rows) {
        state.taskStatuses.set(r.id, r.status);
      }
    }
  } catch {
    // DB absent
  }

  try {
    const conduitDb = getConduitDb(ctx);
    if (conduitDb) {
      const msgMax = conduitDb
        .prepare('SELECT COALESCE(MAX(rowid), 0) AS max_rowid FROM messages')
        .get() as { max_rowid: number } | undefined;
      state.lastMsgRowid = msgMax?.max_rowid ?? 0;
    }
  } catch {
    // DB absent
  }

  return state;
}

// ---------------------------------------------------------------------------
// Per-poll event detection
// ---------------------------------------------------------------------------

/**
 * Checks brain_observations for rows inserted since the last poll.
 *
 * @param state - Current watermark state (mutated on new rows).
 * @param ctx - Active project context for resolving brain.db path.
 * @returns Array of `node.create` events to emit.
 */
function detectNewObservations(state: WatermarkState, ctx: ProjectContext): LBStreamEvent[] {
  const events: LBStreamEvent[] = [];
  try {
    const db = getBrainDb(ctx);
    if (!db) return events;

    const rows = db
      .prepare(
        `SELECT rowid, id, title, quality_score, memory_tier, created_at, source_session_id
         FROM brain_observations
         WHERE rowid > ?
         ORDER BY rowid ASC`,
      )
      .all(state.lastObsRowid) as Array<ObsRow & { rowid: number }>;

    for (const row of rows) {
      state.lastObsRowid = row.rowid;
      const node: LBNode = {
        id: `brain:${row.id}`,
        kind: 'observation',
        substrate: 'brain',
        label: row.title,
        weight: row.quality_score ?? undefined,
        createdAt: row.created_at,
        meta: {
          memory_tier: row.memory_tier,
          created_at: row.created_at,
          source_session_id: row.source_session_id,
        },
      };
      events.push({ type: 'node.create', node, ts: new Date().toISOString() });
    }
  } catch {
    // DB unavailable — skip this poll cycle
  }
  return events;
}

/**
 * Checks brain_page_edges for rows whose weight changed since last poll.
 *
 * Compares against the in-memory weight snapshot. Both newly added edges
 * (not in snapshot) and existing edges with a changed weight are emitted.
 *
 * @param state - Current watermark state (mutated on weight changes).
 * @param ctx - Active project context for resolving brain.db path.
 * @returns Array of `edge.strengthen` events to emit.
 */
function detectEdgeWeightChanges(state: WatermarkState, ctx: ProjectContext): LBStreamEvent[] {
  const events: LBStreamEvent[] = [];
  try {
    const db = getBrainDb(ctx);
    if (!db) return events;

    const rows = db
      .prepare(
        `SELECT from_id, to_id, edge_type, weight, updated_at
         FROM brain_page_edges`,
      )
      .all() as EdgeRow[];

    for (const row of rows) {
      const key = `${row.from_id}|${row.to_id}`;
      const prevWeight = state.edgeWeights.get(key);
      if (prevWeight === undefined || prevWeight !== row.weight) {
        state.edgeWeights.set(key, row.weight);
        // Only emit if this is a real change (i.e. not first snapshot)
        if (prevWeight !== undefined) {
          events.push({
            type: 'edge.strengthen',
            fromId: `brain:${row.from_id}`,
            toId: `brain:${row.to_id}`,
            edgeType: row.edge_type,
            weight: row.weight,
            ts: new Date().toISOString(),
          });
        }
      }
    }
  } catch {
    // DB unavailable — skip
  }
  return events;
}

/**
 * Checks the tasks table for rows whose status changed since last poll.
 *
 * Uses rowid watermark to detect new tasks, then status-map diff for
 * tasks already seen.
 *
 * @param state - Current watermark state (mutated on changes).
 * @param ctx - Active project context for resolving tasks.db path.
 * @returns Array of `task.status` events to emit.
 */
function detectTaskStatusChanges(state: WatermarkState, ctx: ProjectContext): LBStreamEvent[] {
  const events: LBStreamEvent[] = [];
  try {
    const db = getTasksDb(ctx);
    if (!db) return events;

    // Check for new tasks inserted after our watermark
    const newRows = db
      .prepare(
        `SELECT rowid, id, status, updated_at
         FROM tasks
         WHERE rowid > ?
         ORDER BY rowid ASC`,
      )
      .all(state.lastTaskRowid) as Array<TaskRow & { rowid: number }>;

    for (const row of newRows) {
      state.lastTaskRowid = row.rowid;
      state.taskStatuses.set(row.id, row.status);
      events.push({
        type: 'task.status',
        taskId: row.id,
        status: row.status,
        ts: new Date().toISOString(),
      });
    }

    // Check existing tasks for status changes (updates don't change rowid)
    if (state.taskStatuses.size > 0) {
      const ids = [...state.taskStatuses.keys()];
      const placeholders = ids.map(() => '?').join(',');
      const existingRows = db
        .prepare(`SELECT id, status FROM tasks WHERE id IN (${placeholders})`)
        .all(...ids) as Array<{ id: string; status: string }>;

      for (const row of existingRows) {
        const prev = state.taskStatuses.get(row.id);
        if (prev !== undefined && prev !== row.status) {
          state.taskStatuses.set(row.id, row.status);
          events.push({
            type: 'task.status',
            taskId: row.id,
            status: row.status,
            ts: new Date().toISOString(),
          });
        }
      }
    }
  } catch {
    // DB unavailable — skip
  }
  return events;
}

/**
 * Checks conduit messages for rows inserted since the last poll.
 *
 * @param state - Current watermark state (mutated on new rows).
 * @param ctx - Active project context for resolving conduit.db path.
 * @returns Array of `message.send` events to emit.
 */
function detectNewMessages(state: WatermarkState, ctx: ProjectContext): LBStreamEvent[] {
  const events: LBStreamEvent[] = [];
  try {
    const db = getConduitDb(ctx);
    if (!db) return events;

    const rows = db
      .prepare(
        `SELECT rowid, id, content, from_agent_id, to_agent_id, created_at
         FROM messages
         WHERE rowid > ?
         ORDER BY rowid ASC`,
      )
      .all(state.lastMsgRowid) as Array<MsgRow & { rowid: number }>;

    for (const row of rows) {
      state.lastMsgRowid = row.rowid;
      const preview =
        row.content.length > MESSAGE_PREVIEW_LEN
          ? `${row.content.slice(0, MESSAGE_PREVIEW_LEN)}…`
          : row.content;
      events.push({
        type: 'message.send',
        messageId: row.id,
        fromAgentId: row.from_agent_id ?? '',
        toAgentId: row.to_agent_id ?? '',
        preview,
        ts: new Date().toISOString(),
      });
    }
  } catch {
    // DB unavailable — skip
  }
  return events;
}

// ---------------------------------------------------------------------------
// SvelteKit GET handler
// ---------------------------------------------------------------------------

export const GET: RequestHandler = ({ locals, request }) => {
  const signal = request.signal;
  const projectCtx = locals.projectCtx;

  const stream = new ReadableStream({
    start(controller) {
      /** Whether the stream has been closed (prevent double-close). */
      let closed = false;

      function close(): void {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed
        }
      }

      // Abort on client disconnect
      signal.addEventListener('abort', close);

      // Initialise per-connection watermarks
      const watermarks = initWatermarks(projectCtx);

      // Send hello immediately
      controller.enqueue(
        new TextEncoder().encode(sseEncode({ type: 'hello', ts: new Date().toISOString() })),
      );

      // ---------------------------------------------------------------------------
      // Heartbeat timer
      // ---------------------------------------------------------------------------
      const heartbeatTimer = setInterval(() => {
        if (closed) {
          clearInterval(heartbeatTimer);
          return;
        }
        try {
          controller.enqueue(
            new TextEncoder().encode(
              sseEncode({ type: 'heartbeat', ts: new Date().toISOString() }),
            ),
          );
        } catch {
          clearInterval(heartbeatTimer);
          close();
        }
      }, HEARTBEAT_INTERVAL_MS);

      // ---------------------------------------------------------------------------
      // Poll timer
      // ---------------------------------------------------------------------------
      const pollTimer = setInterval(() => {
        if (closed) {
          clearInterval(pollTimer);
          return;
        }

        const events: LBStreamEvent[] = [
          ...detectNewObservations(watermarks, projectCtx),
          ...detectEdgeWeightChanges(watermarks, projectCtx),
          ...detectTaskStatusChanges(watermarks, projectCtx),
          ...detectNewMessages(watermarks, projectCtx),
        ];

        for (const event of events) {
          if (closed) break;
          try {
            controller.enqueue(new TextEncoder().encode(sseEncode(event)));
          } catch {
            clearInterval(pollTimer);
            clearInterval(heartbeatTimer);
            close();
            return;
          }
        }
      }, POLL_INTERVAL_MS);

      // Ensure timers are cleared when stream is cancelled externally
      return () => {
        clearInterval(heartbeatTimer);
        clearInterval(pollTimer);
        signal.removeEventListener('abort', close);
        close();
      };
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
};
