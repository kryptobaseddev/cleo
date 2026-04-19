/**
 * Brain canvas page server load (`/brain`).
 *
 * Loads the **full** unified graph on first paint.  Owner mandate (2026-04-15):
 * the canvas should always look complete — no half-payload first paint.
 *
 * @note The underlying API route is `/api/brain` (unified super-graph surface
 * wrapping memory + nexus + tasks + conduit + signaldock substrates). Memory
 * observations/patterns/decisions are served separately at `/api/memory/*`.
 */

import { type BrainGraph, getAllSubstrates } from '@cleocode/brain';
import type { PageServerLoad } from './$types';

/**
 * Disable SSR for the brain canvas route.
 *
 * The sigma.js graph renderer imports WebGL2RenderingContext at module load,
 * which is unavailable in Node.js during SSR. Since the route is a pure WebGL
 * canvas with no SSR-friendly content, disabling SSR delivers no quality loss
 * and eliminates the HTTP 500 on direct navigation.
 *
 * The initial graph data is still loaded by the load function below and sent
 * to the browser as part of the SvelteKit serialization envelope.
 */
export const ssr = false;

/** Hard cap to prevent runaway server-side memory on enormous registries. */
const MAX_NODES = 5000;

export interface PageData {
  graph: BrainGraph;
}

export const load: PageServerLoad = ({ locals }): PageData => {
  const graph = getAllSubstrates({ limit: MAX_NODES, projectCtx: locals.projectCtx });
  return { graph };
};
