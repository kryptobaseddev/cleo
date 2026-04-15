/**
 * Brain quality distribution API endpoint.
 * GET /api/brain/quality → quality distribution stats across all brain tables.
 */

import { json } from '@sveltejs/kit';
import { getBrainDb } from '$lib/server/db/connections.js';
import type { RequestHandler } from './$types';

/** Quality bucket counts for a single table. */
export interface QualityBucket {
  range: string;
  min: number;
  max: number;
  count: number;
}

/** Tier distribution counts. */
export interface TierCount {
  tier: string;
  count: number;
}

/** Type distribution counts. */
export interface TypeCount {
  memory_type: string;
  count: number;
}

export interface BrainQualityResponse {
  observations: {
    buckets: QualityBucket[];
    tiers: TierCount[];
    types: TypeCount[];
    verified_count: number;
    prune_count: number;
    invalidated_count: number;
  };
  decisions: {
    buckets: QualityBucket[];
    verified_count: number;
    prune_count: number;
  };
  patterns: {
    buckets: QualityBucket[];
    verified_count: number;
  };
  learnings: {
    buckets: QualityBucket[];
    verified_count: number;
  };
}

/** Build quality buckets for a table. */
function buildBuckets(db: import('node:sqlite').DatabaseSync, table: string): QualityBucket[] {
  const ranges = [
    { range: '0.0–0.2', min: 0, max: 0.2 },
    { range: '0.2–0.4', min: 0.2, max: 0.4 },
    { range: '0.4–0.6', min: 0.4, max: 0.6 },
    { range: '0.6–0.8', min: 0.6, max: 0.8 },
    { range: '0.8–1.0', min: 0.8, max: 1.0 },
  ];

  return ranges.map(({ range, min, max }) => {
    const isLast = max === 1.0;
    const row = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM ${table}
         WHERE quality_score >= ? AND quality_score ${isLast ? '<=' : '<'} ?`,
      )
      .get(min, max) as { cnt: number };
    return { range, min, max, count: row.cnt };
  });
}

export const GET: RequestHandler = () => {
  const db = getBrainDb();
  if (!db) {
    const empty = { buckets: [], verified_count: 0, prune_count: 0, invalidated_count: 0 };
    return json({
      observations: { ...empty, tiers: [], types: [] },
      decisions: empty,
      patterns: empty,
      learnings: empty,
    } as BrainQualityResponse);
  }

  try {
    // Observations
    const obsBuckets = buildBuckets(db, 'brain_observations');
    const obsTiers = db
      .prepare(
        `SELECT COALESCE(memory_tier, 'unknown') as tier, COUNT(*) as count
         FROM brain_observations GROUP BY memory_tier ORDER BY count DESC`,
      )
      .all() as TierCount[];
    const obsTypes = db
      .prepare(
        `SELECT COALESCE(memory_type, 'unknown') as memory_type, COUNT(*) as count
         FROM brain_observations GROUP BY memory_type ORDER BY count DESC`,
      )
      .all() as TypeCount[];
    const obsVerified = (
      db.prepare('SELECT COUNT(*) as cnt FROM brain_observations WHERE verified = 1').get() as {
        cnt: number;
      }
    ).cnt;
    const obsPrune = (
      db
        .prepare('SELECT COUNT(*) as cnt FROM brain_observations WHERE prune_candidate = 1')
        .get() as { cnt: number }
    ).cnt;
    const obsInvalidated = (
      db
        .prepare('SELECT COUNT(*) as cnt FROM brain_observations WHERE invalid_at IS NOT NULL')
        .get() as {
        cnt: number;
      }
    ).cnt;

    // Decisions
    const decBuckets = buildBuckets(db, 'brain_decisions');
    const decVerified = (
      db.prepare('SELECT COUNT(*) as cnt FROM brain_decisions WHERE verified = 1').get() as {
        cnt: number;
      }
    ).cnt;
    const decPrune = (
      db.prepare('SELECT COUNT(*) as cnt FROM brain_decisions WHERE prune_candidate = 1').get() as {
        cnt: number;
      }
    ).cnt;

    // Patterns
    const patBuckets = buildBuckets(db, 'brain_patterns');
    const patVerified = (
      db.prepare('SELECT COUNT(*) as cnt FROM brain_patterns WHERE verified = 1').get() as {
        cnt: number;
      }
    ).cnt;

    // Learnings
    const learnBuckets = buildBuckets(db, 'brain_learnings');
    const learnVerified = (
      db.prepare('SELECT COUNT(*) as cnt FROM brain_learnings WHERE verified = 1').get() as {
        cnt: number;
      }
    ).cnt;

    return json({
      observations: {
        buckets: obsBuckets,
        tiers: obsTiers,
        types: obsTypes,
        verified_count: obsVerified,
        prune_count: obsPrune,
        invalidated_count: obsInvalidated,
      },
      decisions: {
        buckets: decBuckets,
        verified_count: decVerified,
        prune_count: decPrune,
        invalidated_count: 0,
      },
      patterns: {
        buckets: patBuckets,
        verified_count: patVerified,
        prune_count: 0,
        invalidated_count: 0,
      },
      learnings: {
        buckets: learnBuckets,
        verified_count: learnVerified,
        prune_count: 0,
        invalidated_count: 0,
      },
    } satisfies BrainQualityResponse);
  } catch {
    const empty = { buckets: [], verified_count: 0, prune_count: 0, invalidated_count: 0 };
    return json({
      observations: { ...empty, tiers: [], types: [] },
      decisions: empty,
      patterns: empty,
      learnings: empty,
    } as BrainQualityResponse);
  }
};
