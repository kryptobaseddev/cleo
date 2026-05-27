/**
 * Streaming Brain graph chunks endpoint — progressive-disclosure tier 1 and 2.
 *
 * GET /api/brain/chunks
 *   → application/x-ndjson (one JSON object per line, newline-delimited)
 *
 * ## Protocol
 *
 * Each chunk is a JSON object on its own line.  Two event kinds are emitted:
 *
 * ```
 * {"kind":"chunk","tier":1,"nodes":[...],"edges":[...],"counts":{...},"truncated":false}
 * {"kind":"done","tier":1,"totalNodes":423,"elapsed":312}
 * ```
 *
 * The client reads the stream line-by-line, appending nodes/edges to its
 * in-memory graph on each `chunk` event, then marks the tier complete on
 * `done`.
 *
 * ## Query parameters
 *
 * | Param        | Default | Notes                                              |
 * |--------------|---------|---------------------------------------------------|
 * | `tier`       | `1`     | 1 or 2.  Tier 0 is served via `/api/brain`.        |
 * | `substrates` | all     | comma-separated filter                             |
 * | `min_weight` | `0`     | quality/weight threshold                           |
 *
 * Tier limits are fixed: tier 1 = 1000 nodes, tier 2 = 5000 nodes.
 *
 * ## Client integration
 *
 * Agent E's page calls {@link streamRemainingNodes} (exported from
 * `$lib/server/brain/streaming.ts`) from `onMount` after the tier-0
 * data is in place.
 *
 * @task T990
 */

import { type BrainSubstrate, getAllSubstrates } from '@cleocode/brain';
import { recordBrainLoadDuration } from '$lib/server/brain/index.js';
import type { RequestHandler } from './$types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Node limits per tier (chunks endpoint handles tier 1 and 2 only). */
const TIER_LIMITS: Record<1 | 2, number> = {
  1: 1000,
  2: 5000,
};

/** Valid substrate identifiers. */
const VALID_SUBSTRATES = new Set<BrainSubstrate>([
  'brain',
  'nexus',
  'tasks',
  'conduit',
  'signaldock',
]);

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const GET: RequestHandler = ({ locals, url }) => {
  const t0 = performance.now();

  // --- Parse tier (only 1 and 2 are valid here; default to 1) ---
  const tierParam = Number(url.searchParams.get('tier') ?? '1');
  const tier: 1 | 2 = tierParam === 2 ? 2 : 1;

  // --- Parse substrates ---
  const substratesParam = url.searchParams.get('substrates');
  const substrates = substratesParam
    ? substratesParam
        .split(',')
        .map((s) => s.trim())
        .filter((s): s is BrainSubstrate => VALID_SUBSTRATES.has(s as BrainSubstrate))
    : undefined;

  // --- Parse min_weight ---
  const minWeightParam = url.searchParams.get('min_weight');
  const minWeight = minWeightParam !== null ? Math.max(0, parseFloat(minWeightParam)) : 0;

  const limit = TIER_LIMITS[tier];

  // --- Build NDJSON stream ---
  const readable = new ReadableStream({
    start(controller) {
      try {
        const graph = getAllSubstrates({
          limit,
          substrates,
          minWeight,
          projectCtx: locals.projectCtx,
        });

        const elapsed = performance.now() - t0;
        recordBrainLoadDuration(tier, elapsed);

        // Emit the single chunk containing all nodes/edges for this tier.
        const chunkLine = JSON.stringify({
          kind: 'chunk',
          tier,
          nodes: graph.nodes,
          edges: graph.edges,
          counts: graph.counts,
          truncated: graph.truncated,
        });
        controller.enqueue(new TextEncoder().encode(chunkLine + '\n'));

        // Emit done sentinel.
        const doneLine = JSON.stringify({
          kind: 'done',
          tier,
          totalNodes: graph.nodes.length,
          elapsed: Math.round(elapsed),
        });
        controller.enqueue(new TextEncoder().encode(doneLine + '\n'));

        console.info(
          `[brain/chunks] tier=${tier} elapsed=${elapsed.toFixed(1)}ms nodes=${graph.nodes.length}`,
        );
      } catch (err) {
        const errLine = JSON.stringify({ kind: 'error', message: String(err) });
        controller.enqueue(new TextEncoder().encode(errLine + '\n'));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-store',
      'Transfer-Encoding': 'chunked',
    },
  });
};
