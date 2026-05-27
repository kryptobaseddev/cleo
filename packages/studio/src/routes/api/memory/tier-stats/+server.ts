/**
 * Memory tier-stats API endpoint.
 *
 * GET /api/memory/tier-stats
 *
 * Returns:
 *   - Per-table tier distribution (short / medium / long counts)
 *   - Top-5 upcoming long-tier promotions with days-until-eligible countdown
 *
 * Delegates to `@cleocode/core` public memory API (T9615/T9616).
 * Zero raw SQL in this handler.
 *
 * @task T748
 * @epic T726
 */

import {
  getTierStats,
  type TableTierCounts,
  type TierStatsResult,
  type UpcomingPromotion,
} from '@cleocode/core';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export type { TableTierCounts, TierStatsResult, UpcomingPromotion };

/** Full response shape. */
export interface TierStatsResponse {
  /** Per-table tier distributions. */
  tables: TableTierCounts[];
  /** Top-5 medium entries closest to long-tier eligibility. */
  upcomingLongPromotions: UpcomingPromotion[];
}

/**
 * GET /api/memory/tier-stats — returns tier distribution + upcoming promotions.
 */
export const GET: RequestHandler = async ({ locals }) => {
  try {
    const result = await getTierStats(locals.projectCtx.projectPath);
    return json({
      tables: result.tables,
      upcomingLongPromotions: result.upcomingLongPromotions,
    } satisfies TierStatsResponse);
  } catch {
    return json({
      tables: [],
      upcomingLongPromotions: [],
    } satisfies TierStatsResponse);
  }
};
