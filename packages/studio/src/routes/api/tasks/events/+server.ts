/**
 * GET /api/tasks/events — SSE endpoint for real-time task change notifications.
 *
 * Polls tasks.db every 2 seconds and emits 'task-updated' events when
 * the last updated_at timestamp changes.
 */

import { createSseStream, SSE_HEADERS } from '@cleocode/runtime/gateway/http';
import { getTasksDb } from '$lib/server/db/connections.js';
import type { RequestHandler } from './$types';

/** Poll interval (ms) for the tasks-events change detector. */
const POLL_INTERVAL_MS = 2000;

export const GET: RequestHandler = ({ locals, request }) => {
  const projectCtx = locals.projectCtx;

  // Route the stream lifecycle through the shared gateway HTTP SSE primitive
  // (R3-T6 · T11450). The observable wire is unchanged: named `event:` frames
  // in the same order (connected first, then task-updated/heartbeat). The
  // builder owns abort-on-disconnect + run-once teardown.
  const stream = createSseStream((emitter) => {
    let lastUpdated = '';
    let lastCount = 0;

    /** Emit one named SSE event (drops after close, never throws). */
    function send(event: string, data: unknown): void {
      emitter.send({ event, data });
    }

    // Send initial connection acknowledgement
    send('connected', { ts: new Date().toISOString() });

    const interval = setInterval(() => {
      if (emitter.closed) {
        clearInterval(interval);
        return;
      }

      try {
        const db = getTasksDb(projectCtx);
        if (!db) return;

        const row = db
          .prepare(
            `SELECT MAX(updated_at) as latest, COUNT(*) as cnt FROM tasks WHERE status != 'archived'`,
          )
          .get() as { latest: string | null; cnt: number };

        const latest = row?.latest ?? '';
        const cnt = row?.cnt ?? 0;

        if (latest !== lastUpdated || cnt !== lastCount) {
          lastUpdated = latest;
          lastCount = cnt;
          send('task-updated', {
            ts: new Date().toISOString(),
            latestChange: latest,
            activeCount: cnt,
          });
        } else {
          // Send heartbeat to keep connection alive
          send('heartbeat', { ts: new Date().toISOString() });
        }
      } catch {
        // DB temporarily unavailable — skip this tick
      }
    }, POLL_INTERVAL_MS);

    // Teardown: clear the poll timer when the stream ends.
    return () => {
      clearInterval(interval);
    };
  }, request.signal);

  return new Response(stream, { headers: { ...SSE_HEADERS } });
};
