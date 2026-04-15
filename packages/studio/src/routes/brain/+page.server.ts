/**
 * Brain canvas page server load (`/brain`).
 *
 * Fetches the initial graph from the unified Living Brain API with a
 * default limit of 500 nodes.  The client-side component can request
 * larger slices via the "Full graph" button.
 *
 * @note The underlying API route is `/api/living-brain` for historical reasons
 * (the route was originally served at `/living-brain`). A rename of the API
 * path is deferred to a future task to avoid churn in other consumers.
 */

import { getAllSubstrates } from '$lib/server/living-brain/adapters/index.js';
import type { LBGraph } from '$lib/server/living-brain/types.js';
import type { PageServerLoad } from './$types';

export interface PageData {
  graph: LBGraph;
}

export const load: PageServerLoad = ({ locals }): PageData => {
  const graph = getAllSubstrates({ limit: 500, projectCtx: locals.projectCtx });
  return { graph };
};
