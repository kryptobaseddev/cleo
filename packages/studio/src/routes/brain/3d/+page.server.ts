/**
 * Legacy `/brain/3d` route — redirects to the unified `/brain?view=3d`.
 *
 * Wave 1A of T990 consolidates all three legacy brain renderers
 * (sigma 2D, cosmos.gl GPU, 3d-force-graph) into a single canvas on
 * `/brain` driven by `ThreeBrainRenderer`. This file keeps old
 * bookmarks + external links alive by issuing a 301 permanent
 * redirect.
 */

import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const ssr = false;

export const load: PageServerLoad = () => {
  // 301 permanent — legacy URL is retired.
  throw redirect(301, '/brain?view=3d');
};
