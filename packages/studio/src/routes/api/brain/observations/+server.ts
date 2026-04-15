/**
 * Brain observations API endpoint.
 * GET /api/brain/observations?tier=short&type=episodic&min_quality=0.5 → { observations: BrainObservation[] }
 *
 * Supports optional query filters: tier, type, min_quality.
 */

import { json } from '@sveltejs/kit';
import { getBrainDb } from '$lib/server/db/connections.js';
import type { RequestHandler } from './$types';

/** A single observation record. */
export interface BrainObservation {
  id: string;
  type: string;
  title: string;
  subtitle: string | null;
  narrative: string | null;
  project: string | null;
  quality_score: number | null;
  memory_tier: string | null;
  memory_type: string | null;
  verified: number;
  valid_at: string | null;
  invalid_at: string | null;
  source_confidence: string | null;
  citation_count: number;
  prune_candidate: number;
  created_at: string;
}

export interface BrainObservationsResponse {
  observations: BrainObservation[];
  total: number;
  filtered: number;
}

export const GET: RequestHandler = ({ url }) => {
  const db = getBrainDb();
  if (!db) {
    return json({ observations: [], total: 0, filtered: 0 } satisfies BrainObservationsResponse);
  }

  try {
    const tier = url.searchParams.get('tier');
    const type = url.searchParams.get('type');
    const minQuality = url.searchParams.get('min_quality');

    const totalRow = db.prepare('SELECT COUNT(*) as cnt FROM brain_observations').get() as {
      cnt: number;
    };

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (tier) {
      conditions.push('memory_tier = ?');
      params.push(tier);
    }
    if (type) {
      conditions.push('memory_type = ?');
      params.push(type);
    }
    if (minQuality !== null) {
      const q = parseFloat(minQuality);
      if (!Number.isNaN(q)) {
        conditions.push('(quality_score IS NULL OR quality_score >= ?)');
        params.push(q);
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const observations = db
      .prepare(
        `SELECT id, type, title, subtitle, narrative, project,
                quality_score, memory_tier, memory_type, verified,
                valid_at, invalid_at, source_confidence, citation_count,
                prune_candidate, created_at
         FROM brain_observations
         ${whereClause}
         ORDER BY created_at DESC
         LIMIT 200`,
      )
      .all(...params) as BrainObservation[];

    return json({
      observations,
      total: totalRow.cnt,
      filtered: observations.length,
    } satisfies BrainObservationsResponse);
  } catch {
    return json({ observations: [], total: 0, filtered: 0 } satisfies BrainObservationsResponse);
  }
};
