/**
 * Brain canvas page server load (`/brain`).
 *
 * Loads the **full** unified graph on first paint.  Owner mandate (2026-04-15):
 * the canvas should always look complete — no half-payload first paint.
 *
 * @note The underlying API route is `/api/living-brain` for historical reasons
 * (the route was originally served at `/living-brain`). A rename of the API
 * path is deferred to a future task to avoid churn in other consumers.
 */

import { getAllSubstrates } from '$lib/server/living-brain/adapters/index.js';
import type { LBGraph } from '$lib/server/living-brain/types.js';
import type { PageServerLoad } from './$types';

/** Hard cap to prevent runaway server-side memory on enormous registries. */
const MAX_NODES = 5000;

export interface PageData {
  graph: LBGraph;
}

export const load: PageServerLoad = ({ locals }): PageData => {
  const graph = getAllSubstrates({ limit: MAX_NODES, projectCtx: locals.projectCtx });
  return { graph };
};
