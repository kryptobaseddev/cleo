/**
 * Memory decisions API endpoint.
 * GET /api/memory/decisions → { decisions: BrainDecision[] }
 *
 * Returns brain_decisions ordered chronologically for timeline view.
 */

import { json } from '@sveltejs/kit';
import { getBrainDb } from '$lib/server/db/connections.js';
import type { RequestHandler } from './$types';

/** A single decision record. */
export interface BrainDecision {
  id: string;
  type: string;
  decision: string;
  rationale: string;
  confidence: string;
  outcome: string | null;
  context_epic_id: string | null;
  context_task_id: string | null;
  context_phase: string | null;
  quality_score: number | null;
  memory_tier: string | null;
  verified: number;
  valid_at: string | null;
  invalid_at: string | null;
  prune_candidate: number;
  created_at: string;
}

export interface BrainDecisionsResponse {
  decisions: BrainDecision[];
  total: number;
}

export const GET: RequestHandler = ({ locals }) => {
  const db = getBrainDb(locals.projectCtx);
  if (!db) {
    return json({ decisions: [], total: 0 } satisfies BrainDecisionsResponse);
  }

  try {
    const totalRow = db.prepare('SELECT COUNT(*) as cnt FROM brain_decisions').get() as {
      cnt: number;
    };

    const decisions = db
      .prepare(
        `SELECT id, type, decision, rationale, confidence, outcome,
                context_epic_id, context_task_id, context_phase,
                quality_score, memory_tier, verified, valid_at, invalid_at,
                prune_candidate, created_at
         FROM brain_decisions
         ORDER BY created_at ASC`,
      )
      .all() as BrainDecision[];

    return json({ decisions, total: totalRow.cnt } satisfies BrainDecisionsResponse);
  } catch {
    return json({ decisions: [], total: 0 } satisfies BrainDecisionsResponse);
  }
};
