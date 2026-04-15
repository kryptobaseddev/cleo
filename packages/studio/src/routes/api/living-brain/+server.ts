/**
 * Unified Living Brain API endpoint.
 *
 * GET /api/living-brain
 *   → { nodes: LBNode[], edges: LBEdge[], counts, truncated }
 *
 * Query params:
 *   limit      — max nodes to return (default 500, max 2000)
 *   substrates — comma-separated: brain,nexus,tasks,conduit,signaldock (default all)
 *   min_weight — minimum quality/weight threshold 0.0–1.0 (default 0)
 *
 * @see packages/studio/src/lib/server/living-brain/types.ts for schema
 * @see docs/plans/brain-synaptic-visualization-research.md §5.2
 */

import { json } from '@sveltejs/kit';
import { getAllSubstrates } from '$lib/server/living-brain/adapters/index.js';
import type { LBSubstrate } from '$lib/server/living-brain/types.js';
import type { RequestHandler } from './$types';

const VALID_SUBSTRATES = new Set<LBSubstrate>(['brain', 'nexus', 'tasks', 'conduit', 'signaldock']);

export const GET: RequestHandler = ({ locals, url }) => {
  const limitParam = Number(url.searchParams.get('limit') ?? '500');
  const limit = Math.min(Math.max(1, Number.isNaN(limitParam) ? 500 : limitParam), 2000);

  const substratesParam = url.searchParams.get('substrates');
  const substrates = substratesParam
    ? substratesParam
        .split(',')
        .map((s) => s.trim())
        .filter((s): s is LBSubstrate => VALID_SUBSTRATES.has(s as LBSubstrate))
    : undefined;

  const minWeightParam = url.searchParams.get('min_weight');
  const minWeight = minWeightParam !== null ? Math.max(0, parseFloat(minWeightParam)) : 0;

  try {
    const graph = getAllSubstrates({ limit, substrates, minWeight, projectCtx: locals.projectCtx });
    return json(graph);
  } catch (err) {
    return json({ error: String(err) }, { status: 500 });
  }
};
