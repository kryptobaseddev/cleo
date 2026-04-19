/**
 * Memory patterns API endpoint (T990 Wave 1D).
 *
 * GET /api/memory/patterns
 *   Query params (all optional):
 *     - type: 'workflow' | 'blocker' | 'success' | 'failure' | 'optimization'
 *     - impact: 'low' | 'medium' | 'high'
 *     - min_quality: [0..1]
 *     - sort: 'created_desc' | 'quality_desc' | 'citation_desc'
 *     - offset, limit
 *
 * Returns { patterns, total, filtered } (raw row shape preserved so the
 * Svelte page can render column-by-column without an extra mapping layer).
 *
 * @task T990
 * @wave 1D
 */

import { json } from '@sveltejs/kit';
import { getBrainDb } from '$lib/server/db/connections.js';
import type { RequestHandler } from './$types';

/** Raw brain_patterns row projected for the Studio UI. */
export interface BrainPatternRow {
  id: string;
  type: string;
  pattern: string;
  context: string | null;
  impact: string | null;
  anti_pattern: string | null;
  mitigation: string | null;
  success_rate: number | null;
  frequency: number;
  quality_score: number | null;
  memory_tier: string | null;
  verified: number;
  valid_at: string | null;
  invalid_at: string | null;
  prune_candidate: number;
  citation_count: number;
  extracted_at: string;
}

/** Response shape for GET /api/memory/patterns. */
export interface BrainPatternsResponse {
  patterns: BrainPatternRow[];
  total: number;
  filtered: number;
}

/** Columns we project — declared once so every `SELECT` path stays identical. */
const PATTERN_COLUMNS = `id, type, pattern, context, impact, anti_pattern, mitigation,
  success_rate, frequency, quality_score, memory_tier, verified,
  valid_at, invalid_at, prune_candidate, citation_count, extracted_at`;

export const GET: RequestHandler = ({ locals, url }) => {
  const db = getBrainDb(locals.projectCtx);
  if (!db) {
    return json({ patterns: [], total: 0, filtered: 0 } satisfies BrainPatternsResponse);
  }

  try {
    const type = url.searchParams.get('type');
    const impact = url.searchParams.get('impact');
    const minQuality = url.searchParams.get('min_quality');
    const sort = url.searchParams.get('sort') ?? 'created_desc';
    const offsetRaw = url.searchParams.get('offset');
    const limitRaw = url.searchParams.get('limit');

    const offset = Math.max(0, Math.min(100_000, Number.parseInt(offsetRaw ?? '0', 10) || 0));
    const limit = Math.max(1, Math.min(200, Number.parseInt(limitRaw ?? '50', 10) || 50));

    const totalRow = db.prepare('SELECT COUNT(*) as cnt FROM brain_patterns').get() as {
      cnt: number;
    };

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (type) {
      conditions.push('type = ?');
      params.push(type);
    }
    if (impact) {
      conditions.push('impact = ?');
      params.push(impact);
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
          return 'ORDER BY quality_score DESC NULLS LAST, extracted_at DESC';
        case 'citation_desc':
          return 'ORDER BY citation_count DESC, extracted_at DESC';
        default:
          return 'ORDER BY extracted_at DESC';
      }
    })();

    const patterns = db
      .prepare(
        `SELECT ${PATTERN_COLUMNS}
         FROM brain_patterns
         ${where}
         ${orderBy}
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as unknown as BrainPatternRow[];

    return json({
      patterns,
      total: totalRow.cnt,
      filtered: patterns.length,
    } satisfies BrainPatternsResponse);
  } catch {
    return json({ patterns: [], total: 0, filtered: 0 } satisfies BrainPatternsResponse);
  }
};
