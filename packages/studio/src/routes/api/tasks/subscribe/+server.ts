/**
 * GET /api/tasks/subscribe — Studio DELEGATE for the gateway `tasks.subscribe`
 * streaming op (T11789 · E2-STUDIO-DATA-LAYER).
 *
 * The saga-board rune store ({@link import('$lib/stores/saga-board.svelte.js')})
 * opens exactly ONE `EventSource` here — the single live channel that REPLACES
 * the legacy 2 s tasks-events + 15 s health poll loop. The wire is the canonical
 * {@link import('@cleocode/contracts/gateway').GatewayStreamEvent}: `data:`-only
 * SSE records whose JSON is `{ kind, seq, data, error, requestId }`, exactly as
 * the gateway emits, so the store decodes identically whether the daemon serves
 * the stream or this route does.
 *
 * ## Source (gateway-first, Studio-local fallback)
 *
 * The ratified realtime transport is the `/v1` gateway SSE
 * (`GET /v1/tasks/subscribe`, T11785). When `cleo daemon serve` is up this route
 * PROXIES that stream byte-for-byte (the daemon owns the real store-tailing
 * source). When the daemon is unreachable — Studio dev without a daemon — it
 * falls back to a Studio-local board-change detector that routes through the
 * `@cleocode/core` `listTasks` FACADE (CORE-first — NO raw SQL: the change
 * signal is `max(updatedAt)` + active count derived from the core projection,
 * the same surface `/api/tasks` GET reads), emitted as canonical
 * `GatewayStreamEvent` frames so the board stays live either way.
 *
 * Secrets never cross the wire: the proxy forwards only the public stream body,
 * and the local fallback emits only the public board-change signal.
 *
 * @task T11789
 * @task T11785
 * @epic T11557
 * @saga T11555
 */

import type { GatewayStreamEvent } from '@cleocode/contracts/gateway';
import { getTaskAccessor } from '@cleocode/core/store/data-accessor';
import { listTasks } from '@cleocode/core/tasks/list';
import { createSseStream, encodeStreamEvent, SSE_HEADERS } from '@cleocode/runtime/gateway/http';
import { resolveGatewayBaseUrl } from '../_dispatch.js';
import type { RequestHandler } from './$types';

/** Poll cadence (ms) for the Studio-local board-change detector fallback. */
const POLL_INTERVAL_MS = 2000;

/** Connect timeout (ms) for the gateway proxy attempt before falling back. */
const GATEWAY_CONNECT_TIMEOUT_MS = 1500;

/**
 * Attempt to proxy the gateway `GET /v1/tasks/subscribe` SSE. Returns the
 * upstream `Response` (its `text/event-stream` body) on success, or `null` when
 * the daemon listener is unreachable (so the caller falls back to the local
 * board-change detector).
 *
 * @param baseUrl - The resolved gateway base URL.
 * @param root - Optional saga/parent scope forwarded as `?root=`.
 * @param signal - Abort signal tied to the client disconnect.
 * @returns The upstream SSE response, or `null` when unreachable.
 */
async function tryProxyGatewayStream(
  baseUrl: string,
  root: string | null,
  signal: AbortSignal,
): Promise<Response | null> {
  const qs = root ? `?root=${encodeURIComponent(root)}` : '';
  const url = `${baseUrl}/v1/tasks/subscribe${qs}`;
  // Bound the initial connect so an unreachable daemon falls back fast.
  const connectCtl = new AbortController();
  const timer = setTimeout(() => connectCtl.abort(), GATEWAY_CONNECT_TIMEOUT_MS);
  // Tie the upstream request to BOTH the connect timeout and the client abort.
  const onClientAbort = (): void => connectCtl.abort();
  signal.addEventListener('abort', onClientAbort);
  try {
    const res = await fetch(url, {
      headers: { accept: 'text/event-stream' },
      signal: connectCtl.signal,
    });
    clearTimeout(timer);
    signal.removeEventListener('abort', onClientAbort);
    if (!res.ok || res.body === null) return null;
    return res;
  } catch {
    clearTimeout(timer);
    signal.removeEventListener('abort', onClientAbort);
    return null;
  }
}

export const GET: RequestHandler = async ({ locals, url, request }) => {
  const ctx = locals.projectCtx;
  const root = url.searchParams.get('root');
  const baseUrl = resolveGatewayBaseUrl();

  // 1) Gateway-first — proxy the daemon's real store-tailing stream verbatim.
  const upstream = await tryProxyGatewayStream(baseUrl, root, request.signal);
  if (upstream?.body) {
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  }

  // 2) Studio-local fallback — emit canonical GatewayStreamEvent frames from a
  //    CORE-first board-change probe (listTasks facade, NO raw SQL) so the board
  //    stays live without a running daemon.
  const requestId = `studio-${Date.now().toString(36)}`;
  const projectPath = ctx.projectPath;
  const stream = createSseStream((emitter) => {
    let seq = 0;
    let lastUpdated = '';
    let lastCount = -1;
    /** Guards against overlapping ticks when a probe outlives its interval. */
    let probing = false;

    /** Emit one canonical board-event `data` frame (dropped after close). */
    function emit(event: 'connected' | 'updated' | 'heartbeat'): void {
      const frame: GatewayStreamEvent = {
        kind: 'data',
        seq,
        data: { scope: 'tasks.board', root: root ?? null, event, ts: new Date().toISOString() },
        requestId,
      };
      emitter.sendRaw(encodeStreamEvent(frame));
      seq += 1;
    }

    /**
     * Derive the board-change signal through the `@cleocode/core` facade: the
     * latest `updatedAt` + the non-archived task count. CORE-first — the same
     * projection `/api/tasks` GET reads, never raw SQL.
     */
    async function probe(): Promise<{ latest: string; count: number }> {
      const accessor = await getTaskAccessor(projectPath);
      const result = await listTasks({ excludeArchived: true, limit: 1000 }, projectPath, accessor);
      let latest = '';
      for (const t of result.tasks) {
        const u = t.updatedAt ?? t.createdAt;
        if (typeof u === 'string' && u > latest) latest = u;
      }
      return { latest, count: result.tasks.length };
    }

    // Initial connected frame so the store flips `connected` immediately.
    emit('connected');

    const interval = setInterval(() => {
      if (emitter.closed) {
        clearInterval(interval);
        return;
      }
      if (probing) return;
      probing = true;
      void probe()
        .then(({ latest, count }) => {
          if (emitter.closed) return;
          // First probe seeds the baseline (no spurious initial 'updated').
          if (lastCount === -1) {
            lastUpdated = latest;
            lastCount = count;
            emit('heartbeat');
            return;
          }
          if (latest !== lastUpdated || count !== lastCount) {
            lastUpdated = latest;
            lastCount = count;
            emit('updated');
          } else {
            emit('heartbeat');
          }
        })
        .catch(() => {
          // Transient read error — keep the stream alive; next tick retries.
        })
        .finally(() => {
          probing = false;
        });
    }, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, request.signal);

  return new Response(stream, { headers: { ...SSE_HEADERS } });
};
