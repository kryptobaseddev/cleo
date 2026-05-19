/**
 * Memory decisions API endpoint.
 * GET /api/memory/decisions → { decisions: DecisionRecord[], total: number }
 *
 * Delegates to `@cleocode/core` public memory API (T9615/T9616).
 * Zero raw SQL in this handler.
 */

import { type DecisionRecord, getDecisions } from '@cleocode/core';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export type { DecisionRecord };

/** Response envelope for GET /api/memory/decisions. */
export interface BrainDecisionsResponse {
  decisions: DecisionRecord[];
  total: number;
}

export const GET: RequestHandler = async ({ locals }) => {
  try {
    const { decisions } = await getDecisions({
      projectPath: locals.projectCtx.projectPath,
      limit: 500,
    });
    return json({ decisions, total: decisions.length } satisfies BrainDecisionsResponse);
  } catch {
    return json({ decisions: [], total: 0 } satisfies BrainDecisionsResponse);
  }
};
