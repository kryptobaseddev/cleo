/**
 * Substrate-filtered BRAIN super-graph endpoint.
 *
 * GET /api/brain/substrate/:name
 *   → { nodes: LBNode[], edges: LBEdge[], counts, truncated }
 *
 * `:name` must be one of: brain | nexus | tasks | conduit | signaldock
 *
 * Query params:
 *   limit      — max nodes to return (default 500, max 2000)
 *   min_weight — minimum quality/weight threshold 0.0–1.0 (default 0)
 *
 * Returns 400 for unrecognised substrate names.
 * This endpoint is equivalent to GET /api/brain?substrates=<name>
 * but provides a cleaner URL and explicit 400 on bad substrate names.
 */

import { getAllSubstrates, type LBSubstrate } from '@cleocode/brain';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

const VALID_SUBSTRATES = new Set<LBSubstrate>(['brain', 'nexus', 'tasks', 'conduit', 'signaldock']);

export const GET: RequestHandler = ({ locals, params, url }) => {
  const name = params.name as LBSubstrate;
  if (!VALID_SUBSTRATES.has(name)) {
    return json(
      {
        error: `Unknown substrate: "${name}". Valid values: brain, nexus, tasks, conduit, signaldock`,
      },
      { status: 400 },
    );
  }

  const limitParam = Number(url.searchParams.get('limit') ?? '500');
  const limit = Math.min(Math.max(1, Number.isNaN(limitParam) ? 500 : limitParam), 2000);

  const minWeightParam = url.searchParams.get('min_weight');
  const minWeight = minWeightParam !== null ? Math.max(0, parseFloat(minWeightParam)) : 0;

  try {
    const graph = getAllSubstrates({
      limit,
      substrates: [name],
      minWeight,
      projectCtx: locals.projectCtx,
    });
    return json(graph);
  } catch (err) {
    return json({ error: String(err) }, { status: 500 });
  }
};
