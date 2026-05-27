/**
 * MVI record projection middleware (T9922 / Saga T9855 / E8.3).
 *
 * For the read ops declared in {@link PROJECTION_PLANS} this middleware trims
 * the response data payload down to its essential fields ("Minimum Viable
 * Information") so agents pay a fraction of the token cost they paid before.
 *
 * The user (or the renderer pipeline) opts back into the full record via
 * `--verbose`, `--full`, or `--human` — those flags are captured at CLI parse
 * time in {@link getProjectionOptOut} and read here once per request.
 *
 * `meta.projection` is stamped on every response that ran through this
 * middleware so consumers can distinguish a projected payload from a full
 * record without re-implementing the policy.
 *
 * This is distinct from `./projection.ts` (the tier-based domain-access gate)
 * and from `./field-filter.ts` (the LAFS `--fields` parameter). All three can
 * coexist on the same request.
 *
 * @module @cleocode/cleo/dispatch/middleware/mvi-record-projection
 *
 * @epic T9855
 * @task T9922
 */

import {
  applyProjectionPlan,
  PROJECTION_PLANS,
  type ProjectionMode,
  resolveProjectionMode,
} from '@cleocode/core';
import { getProjectionOptOut } from '../../cli/projection-context.js';
import type { DispatchRequest, DispatchResponse, Middleware } from '../types.js';

/**
 * Resolve the projection mode for a single request.
 *
 * Priority: a per-request override carried as `req.params._projection` wins
 * (used by tests and any internal caller that wants to bypass the global
 * CLI flag). Otherwise the global opt-out signal from
 * {@link getProjectionOptOut} decides.
 */
function resolveModeFor(req: DispatchRequest): ProjectionMode {
  const override = req.params?.['_projection'];
  if (override === 'full' || override === 'mvi') return override;
  return resolveProjectionMode(getProjectionOptOut() || undefined);
}

/**
 * Create the MVI record projection middleware.
 *
 * @returns A `Middleware` that strips response data fields per
 *          {@link PROJECTION_PLANS} and stamps `meta.projection`.
 */
export function createMviRecordProjection(): Middleware {
  return async (
    req: DispatchRequest,
    next: () => Promise<DispatchResponse>,
  ): Promise<DispatchResponse> => {
    // Resolve the mode BEFORE stripping the override token so the per-request
    // override (used by tests and any internal caller) survives the cleanup.
    const mode = resolveModeFor(req);

    // Strip the override token so domain handlers don't see it.
    if (req.params && '_projection' in req.params) {
      delete req.params['_projection'];
    }

    const opKey = `${req.domain}.${req.operation}`;
    const hasPlan = PROJECTION_PLANS[opKey] !== undefined;

    const response = await next();

    if (!hasPlan) return response;

    if (response.success && response.data !== undefined) {
      response.data = applyProjectionPlan(response.data, opKey, mode);
    }
    // Stamp the choice on every response that ran through a planned op,
    // including errors — agents inspecting an error envelope can still see
    // which mode the request resolved to.
    response.meta.projection = mode;
    return response;
  };
}
