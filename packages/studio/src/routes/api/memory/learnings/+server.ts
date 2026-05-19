/**
 * Memory learnings API endpoint.
 *
 * GET /api/memory/learnings
 *   Query params (all optional):
 *     - limit
 *
 * Delegates to `@cleocode/core` public memory API (T9615/T9616).
 * Zero raw SQL in this handler.
 *
 * @remarks
 * The CORE `getLearnings` API supports `limit` filtering.
 * The `min_confidence`, `actionable`, `min_quality`, `sort`, and `offset`
 * parameters are not yet exposed in the CORE public API — they are
 * documented as a follow-up (see T9616 notes). Client-side filtering can
 * be applied until CORE exposes these options.
 */

import { getLearnings, type LearningRecord } from '@cleocode/core';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export type { LearningRecord };

/** Response shape for GET /api/memory/learnings. */
export interface BrainLearningsResponse {
  learnings: LearningRecord[];
  total: number;
  filtered: number;
}

export const GET: RequestHandler = async ({ locals, url }) => {
  const limitRaw = url.searchParams.get('limit');
  const limit = Math.max(1, Math.min(200, Number.parseInt(limitRaw ?? '50', 10) || 50));

  try {
    const result = await getLearnings({
      limit,
      projectPath: locals.projectCtx.projectPath,
    });
    return json({
      learnings: result.learnings,
      total: result.learnings.length,
      filtered: result.learnings.length,
    } satisfies BrainLearningsResponse);
  } catch {
    return json({ learnings: [], total: 0, filtered: 0 } satisfies BrainLearningsResponse);
  }
};
