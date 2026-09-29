/**
 * Session activity heartbeat middleware (T12502 · T12540 · epic T12497).
 *
 * Every successful MUTATION by a bound session is that session's activity, so
 * after one succeeds this middleware runs ONE heartbeat for the session: it
 * refreshes the session's `lastActivity` (throttled to once a minute, T12540)
 * and extends every claim lease the session holds (T12502). A task claim is a
 * lease that lapses unless the holder keeps working; a crashed or abandoned
 * agent stops mutating, its leases expire and its `lastActivity` goes stale,
 * so liveness checks and `session gc` can tell it from a long-running agent
 * that is still working.
 *
 * Reads never renew (a heartbeat is a write). A failed renewal never fails
 * the command it followed.
 *
 * Bounding the wait: the store is node:sqlite, which is SYNCHRONOUS — a write
 * stuck behind another connection's lock blocks the event loop, so no timer
 * here can interrupt it. The real bound therefore lives in the store: the
 * renewal lowers `busy_timeout` to a few tens of milliseconds for its one
 * statement and skips the beat on `SQLITE_BUSY` (`runHeartbeatWrite`).
 * The budget below only caps ASYNCHRONOUS waits (e.g. opening the store).
 *
 * @task T12502
 */

import type { DispatchRequest, DispatchResponse, Middleware } from '../types.js';

/**
 * The longest a response waits on the ASYNCHRONOUS part of its heartbeat, in
 * milliseconds. It cannot interrupt a synchronous SQLite lock wait — the
 * store bounds that itself with a short `busy_timeout` and skips a contended
 * beat — so it only guards against a renewal that stalls between awaits.
 */
export const CLAIM_HEARTBEAT_BUDGET_MS = 250;

/**
 * Create the claim heartbeat.
 *
 * @param renew - Runs the session's heartbeat (activity + leases) in the request's project.
 * @param budgetMs - Upper bound on how long the response waits for the renewal.
 * @returns A middleware that renews the caller's claim leases after a successful mutation.
 * @task T12502
 */
export function createClaimHeartbeat(
  renew: (req: DispatchRequest, sessionId: string) => Promise<void>,
  budgetMs: number = CLAIM_HEARTBEAT_BUDGET_MS,
): Middleware {
  return async (
    req: DispatchRequest,
    next: () => Promise<DispatchResponse>,
  ): Promise<DispatchResponse> => {
    const response = await next();
    const sessionId = req.sessionId;
    if (req.gateway === 'mutate' && response.success && sessionId) {
      // Best-effort: a heartbeat must never fail the command it follows. The
      // race caps async stalls only; lock waits are bounded in the store.
      const renewal = renew(req, sessionId).catch(() => undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const budget = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, budgetMs);
        timer.unref?.();
      });
      await Promise.race([renewal, budget]);
      if (timer) clearTimeout(timer);
    }
    return response;
  };
}
