/**
 * GET /api/tasks/[id]/stream — per-task LIVE WORKER stream for a Running-lane
 * card (T11929 · M5).
 *
 * A Running card on `/tasks/kanban` subscribes here to render the worker's
 * live output tail + a usage / cost meter + proof checkpoints. The wire mirrors
 * the existing `/api/tasks/events` SSE pattern (the shared `createSseStream`
 * primitive), so the board reuses ONE EventSource-per-card with the same
 * connected → frames → heartbeat cadence — no per-card polling.
 *
 * ## Source (gateway-ready, Studio-local today)
 *
 * The ratified realtime transport is the `/v1` gateway SSE
 * (`GET /v1/orchestrate/events`, T11921). That stream currently carries a
 * generic tick source until the daemon injects the real agent/worker/board
 * origin-tailing source. Until then — and so the board is useful in Studio dev
 * without a running daemon — this route derives the worker view from the
 * EXISTING Studio data layer the read-only board already reads: the active
 * session claiming this task (`listSessions`) plus its token usage
 * (`metrics.summarizeTokenUsage` scoped by `taskId`).
 *
 * TODO: subscribe to the gateway `orchestrate.events` SSE filtered to this task
 * once the daemon injects its real worker-output/usage source (T11559 / M5).
 *
 * Frame kinds match the pure
 * {@link import('$lib/components/tasks/worker-stream.js').WorkerStreamFrame}
 * fold: `connected` · `output` · `usage` · `checkpoint` · `heartbeat` · `done`.
 *
 * @task T11929
 * @epic T11559
 */

import { metrics } from '@cleocode/core';
import { listSessions } from '@cleocode/core/sessions';
import { createSseStream, SSE_HEADERS } from '@cleocode/runtime/gateway/http';
import type { RequestHandler } from './$types';

/** Poll cadence (ms) for the per-task worker change detector. */
const POLL_INTERVAL_MS = 2000;

/** Resolve the active session (if any) currently claiming this task. */
async function activeSessionForTask(
  projectPath: string,
  taskId: string,
): Promise<{ id: string; startedAt: string } | null> {
  try {
    const active = await listSessions(projectPath, { status: 'active' });
    const owner = active.find((s) => s.taskWork?.taskId === taskId);
    return owner ? { id: owner.id, startedAt: owner.startedAt } : null;
  } catch {
    return null;
  }
}

/** Resolve the cumulative usage snapshot for this task. */
async function usageForTask(
  projectPath: string,
  taskId: string,
): Promise<{ inputTokens: number; outputTokens: number; totalTokens: number; records: number }> {
  try {
    const summary = await metrics.summarizeTokenUsage(projectPath, { taskId });
    return {
      inputTokens: summary.inputTokens,
      outputTokens: summary.outputTokens,
      totalTokens: summary.totalTokens,
      records: summary.totalRecords,
    };
  } catch {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0, records: 0 };
  }
}

export const GET: RequestHandler = ({ locals, params, request }) => {
  const ctx = locals.projectCtx;
  const taskId = params.id;

  const stream = createSseStream((emitter) => {
    /** Emit one named SSE event (dropped after close, never throws). */
    function send(event: string, data: unknown): void {
      emitter.send({ event, data });
    }

    let started = false;
    /** Last usage total emitted — only re-emit on change to keep the wire quiet. */
    let lastTotalTokens = -1;
    /** Whether we have announced the worker as gone (terminal `done`). */
    let endedAnnounced = false;

    send('connected', { ts: new Date().toISOString(), taskId });

    /** One poll tick: detect worker presence + usage delta and emit frames. */
    async function tick(): Promise<void> {
      if (emitter.closed) return;
      const ts = new Date().toISOString();

      const session = await activeSessionForTask(ctx.projectPath, taskId);
      const usage = await usageForTask(ctx.projectPath, taskId);

      if (session && !started) {
        started = true;
        send('output', {
          ts,
          line: `▶ worker ${session.id} active on ${taskId} (since ${session.startedAt})`,
        });
      }

      if (usage.totalTokens !== lastTotalTokens) {
        lastTotalTokens = usage.totalTokens;
        send('usage', { ts, usage });
      }

      if (!session && started && !endedAnnounced) {
        // The worker that was running has gone — announce a clean terminal.
        endedAnnounced = true;
        send('output', { ts, line: `■ worker on ${taskId} ended` });
        send('done', { ts, reason: 'worker-ended' });
        return;
      }

      // Keepalive — drives the card's live dot + staleness clock.
      send('heartbeat', { ts });
    }

    // Kick once immediately so a freshly-opened card sees state without waiting.
    void tick();
    const interval = setInterval(() => {
      if (emitter.closed) {
        clearInterval(interval);
        return;
      }
      void tick();
    }, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, request.signal);

  return new Response(stream, { headers: { ...SSE_HEADERS } });
};
