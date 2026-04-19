/**
 * Memory learnings API endpoint (T990 Wave 1D).
 *
 * GET /api/memory/learnings
 *   Query params (all optional):
 *     - min_confidence: [0..1]
 *     - actionable: '1' | '0'
 *     - min_quality: [0..1]
 *     - sort: 'created_desc' | 'quality_desc' | 'citation_desc'
 *     - offset, limit
 *
 * Returns { learnings, total, filtered }.
 *
 * @task T990
 * @wave 1D
 */

import { json } from '@sveltejs/kit';
import { getBrainDb } from '$lib/server/db/connections.js';
import type { RequestHandler } from './$types';

/** Raw brain_learnings row projected for the Studio UI. */
export interface BrainLearningRow {
  id: string;
  insight: string;
  source: string | null;
  confidence: number | null;
  actionable: number;
  application: string | null;
  applicable_types: string | null;
  quality_score: number | null;
  memory_tier: string | null;
  verified: number;
  valid_at: string | null;
  invalid_at: string | null;
  prune_candidate: number;
  citation_count: number;
  created_at: string;
}

/** Response shape for GET /api/memory/learnings. */
export interface BrainLearningsResponse {
  learnings: BrainLearningRow[];
  total: number;
  filtered: number;
}

const LEARNING_COLUMNS = `id, insight, source, confidence, actionable, application,
  applicable_types, quality_score, memory_tier, verified,
  valid_at, invalid_at, prune_candidate, citation_count, created_at`;

export const GET: RequestHandler = ({ locals, url }) => {
  const db = getBrainDb(locals.projectCtx);
  if (!db) {
    return json({ learnings: [], total: 0, filtered: 0 } satisfies BrainLearningsResponse);
  }

  try {
    const minConfidence = url.searchParams.get('min_confidence');
    const actionable = url.searchParams.get('actionable');
    const minQuality = url.searchParams.get('min_quality');
    const sort = url.searchParams.get('sort') ?? 'created_desc';
    const offsetRaw = url.searchParams.get('offset');
    const limitRaw = url.searchParams.get('limit');

    const offset = Math.max(0, Math.min(100_000, Number.parseInt(offsetRaw ?? '0', 10) || 0));
    const limit = Math.max(1, Math.min(200, Number.parseInt(limitRaw ?? '50', 10) || 50));

    const totalRow = db.prepare('SELECT COUNT(*) as cnt FROM brain_learnings').get() as {
      cnt: number;
    };

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (minConfidence !== null) {
      const c = Number.parseFloat(minConfidence);
      if (Number.isFinite(c)) {
        conditions.push('(confidence IS NULL OR confidence >= ?)');
        params.push(c);
      }
    }
    if (actionable === '1') {
      conditions.push('actionable = 1');
    } else if (actionable === '0') {
      conditions.push('actionable = 0');
    }
    if (minQuality !== null) {
      const q = Number.parseFloat(minQuality);
      if (Number.isFinite(q)) {
        conditions.push('(quality_score IS NULL OR quality_score >= ?)');
        params.push(q);
      }
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const orderBy = (() => {
      switch (sort) {
        case 'quality_desc':
          return 'ORDER BY quality_score DESC NULLS LAST, created_at DESC';
        case 'citation_desc':
          return 'ORDER BY citation_count DESC, created_at DESC';
        default:
          return 'ORDER BY created_at DESC';
      }
    })();

    const learnings = db
      .prepare(
        `SELECT ${LEARNING_COLUMNS}
         FROM brain_learnings
         ${where}
         ${orderBy}
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as unknown as BrainLearningRow[];

    return json({
      learnings,
      total: totalRow.cnt,
      filtered: learnings.length,
    } satisfies BrainLearningsResponse);
  } catch {
    return json({ learnings: [], total: 0, filtered: 0 } satisfies BrainLearningsResponse);
  }
};
