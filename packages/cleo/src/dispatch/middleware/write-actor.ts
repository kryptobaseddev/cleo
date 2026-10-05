/**
 * Write-actor middleware (T13229).
 *
 * Runs every mutate operation inside `runWithWriteActor`, so each local
 * write frame it opens records the command (`op` = `<domain>.<operation>`)
 * and the resolved session. The sealer copies that actor onto the sealed
 * transaction, and the typed merge rules read `actor.op` on every replica:
 * without it a reopen or restore reaches other replicas as a plain write and
 * is voided there.
 *
 * Sits after the session resolver, so `req.sessionId` is final.
 *
 * @module dispatch/middleware/write-actor
 * @task T13229
 */

import { runWithWriteActor } from '@cleocode/core/store/sync/write-actor';
import type { DispatchNext, DispatchRequest, DispatchResponse, Middleware } from '../types.js';

/**
 * Create the write-actor middleware.
 *
 * @returns A middleware that scopes each mutate operation's writes to its actor.
 */
export function createWriteActor(): Middleware {
  return async (req: DispatchRequest, next: DispatchNext): Promise<DispatchResponse> => {
    if (req.gateway !== 'mutate') return next();
    return runWithWriteActor(
      {
        op: `${req.domain}.${req.operation}`,
        ...(req.sessionId ? { session: req.sessionId } : {}),
      },
      next,
    );
  };
}
