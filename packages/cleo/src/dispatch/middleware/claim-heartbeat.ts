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
 * @task T12502
 */

import type { DispatchRequest, DispatchResponse, Middleware } from '../types.js';

/**
 * Create the claim heartbeat.
 *
 * @param renew - Renews the session's leases in the request's project.
 * @returns A middleware that renews the caller's claim leases after a successful mutation.
 * @task T12502
 */
export function createClaimHeartbeat(
  renew: (req: DispatchRequest, sessionId: string) => Promise<void>,
): Middleware {
  return async (
    req: DispatchRequest,
    next: () => Promise<DispatchResponse>,
  ): Promise<DispatchResponse> => {
    const response = await next();
    const sessionId = req.sessionId;
    if (req.gateway === 'mutate' && response.success && sessionId) {
      try {
        await renew(req, sessionId);
      } catch {
        // A heartbeat must never fail the command it follows.
      }
    }
    return response;
  };
}
