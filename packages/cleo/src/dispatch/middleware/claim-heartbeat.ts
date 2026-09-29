/**
 * Claim heartbeat middleware (T12502 · epic T12497).
 *
 * A task claim is a lease: it lapses unless the holder keeps working. Every
 * successful MUTATION by a bound session is that session's activity, so after
 * one succeeds this middleware extends every lease the session holds. A
 * crashed or abandoned agent stops mutating, its leases expire, and another
 * session may then take the task over explicitly (`--take-over`).
 *
 * Reads never renew (a heartbeat is a write). A failed renewal never fails
 * the command it followed.
 *
 * Bounding the wait: the store is node:sqlite, which is SYNCHRONOUS — a write
 * stuck behind another connection's lock blocks the event loop, so no timer
 * here can interrupt it. The real bound therefore lives in the store: the
 * renewal lowers `busy_timeout` to a few tens of milliseconds for its one
 * statement and skips the beat on `SQLITE_BUSY` (`renewSessionClaims`).
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
 * @param renew - Renews the session's leases in the request's project.
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
