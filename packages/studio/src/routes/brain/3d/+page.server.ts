/**
 * Brain 3D canvas page server load (`/brain/3d`).
 *
 * Loads the **full** unified graph on first paint, same as `/brain`.
 * The 3D renderer (LivingBrain3D.svelte) uses the same graph data
 * as the 2D and GPU renderers.
 *
 * SSR is disabled because the 3D renderer uses THREE.js which depends on
 * WebGL — unavailable in Node.js SSR environment. The route is pure graphics
 * so no SSR content is lost.
 */

import { getAllSubstrates, type LBGraph } from '@cleocode/brain';
import type { PageServerLoad } from './$types';

/**
 * Disable SSR for the 3D brain canvas route.
 *
 * THREE.js and 3d-force-graph depend on WebGL APIs not available in Node.js.
 * Since the route is pure 3D visualization with no SSR-friendly content,
 * disabling SSR eliminates the HTTP 500 error on direct navigation.
 *
 * The initial graph data is still loaded by the load function below and sent
 * to the browser as part of the SvelteKit serialization envelope.
 */
export const ssr = false;

/** Hard cap to prevent runaway server-side memory on enormous registries. */
const MAX_NODES = 5000;

export interface PageData {
  graph: LBGraph;
}

export const load: PageServerLoad = ({ locals }): PageData => {
  const graph = getAllSubstrates({ limit: MAX_NODES, projectCtx: locals.projectCtx });
  return { graph };
};
