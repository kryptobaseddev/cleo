/**
 * Unified BRAIN super-graph API endpoint.
 *
 * GET /api/brain
 *   → { nodes: LBNode[], edges: LBEdge[], counts, truncated }
 *
 * Query params:
 *   limit      — max nodes to return (default 500, max 2000)
 *   substrates — comma-separated: brain,nexus,tasks,conduit,signaldock (default all)
 *   min_weight — minimum quality/weight threshold 0.0–1.0 (default 0)
 *
 * Serves the unified super-graph wrapping memory + nexus + tasks + conduit +
 * signaldock substrates. Individual memory observations/patterns/decisions are
 * served under /api/memory/*.
 *
 * @see packages/brain/src/types.ts for schema
 * @see docs/plans/brain-synaptic-visualization-research.md §5.2
 */

import { getAllSubstrates, type LBSubstrate } from '@cleocode/brain';
import { json } from '@sveltejs/kit';
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
