/**
 * Memory decisions API endpoint.
 * GET /api/memory/decisions → { decisions: DecisionRecord[], total: number }
 *
 * Delegates to `@cleocode/core` public memory API (T9615/T9616).
 * Zero raw SQL in this handler.
 */

// T9766 — `MemoryDecisionRecord` is the canonical name in `@cleocode/contracts`
// (the contracts barrel also re-exports a session-ops `DecisionRecord` of a
// DIFFERENT shape — we deliberately import the memory variant by its full
// name and re-export it under the legacy `DecisionRecord` name so the API
// response shape stays stable for existing callers).
import type { MemoryDecisionRecord as DecisionRecord } from '@cleocode/contracts';
import { getDecisions } from '@cleocode/core';
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
