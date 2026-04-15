/**
 * Living Brain page server load.
 *
 * Fetches the initial graph from the unified Living Brain API with a
 * default limit of 500 nodes.  The client-side component can request
 * larger slices via the "Full graph" button.
 */

import { getAllSubstrates } from '$lib/server/living-brain/adapters/index.js';
import type { LBGraph } from '$lib/server/living-brain/types.js';
import type { PageServerLoad } from './$types';

export interface PageData {
  graph: LBGraph;
}

export const load: PageServerLoad = (): PageData => {
  const graph = getAllSubstrates({ limit: 500 });
  return { graph };
};
