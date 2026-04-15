/**
 * GET /api/tasks/events — SSE endpoint for real-time task change notifications.
 *
 * Polls tasks.db every 2 seconds and emits 'task-updated' events when
 * the last updated_at timestamp changes.
 */

import { getTasksDb } from '$lib/server/db/connections.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals }) => {
  const encoder = new TextEncoder();
  const projectCtx = locals.projectCtx;

  const stream = new ReadableStream({
    start(controller) {
      let lastUpdated = '';
      let lastCount = 0;
      let closed = false;

      function send(event: string, data: unknown): void {
        if (closed) return;
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          closed = true;
        }
      }

      // Send initial connection acknowledgement
      send('connected', { ts: new Date().toISOString() });

      const interval = setInterval(() => {
        if (closed) {
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
      }, 2000);

      // Cleanup when client disconnects
      return () => {
        closed = true;
        clearInterval(interval);
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
