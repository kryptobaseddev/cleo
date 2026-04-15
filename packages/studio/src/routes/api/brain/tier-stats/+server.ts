/**
 * Brain tier-stats API endpoint (T748).
 *
 * GET /api/brain/tier-stats
 *
 * Returns:
 *   - Per-table tier distribution (short / medium / long counts)
 *   - Top-5 upcoming long-tier promotions with days-until-eligible countdown
 *
 * @task T748
 * @epic T726
 */

import { json } from '@sveltejs/kit';
import { getBrainDb } from '$lib/server/db/connections.js';
import type { RequestHandler } from './$types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Tier counts for a single brain table. */
export interface TableTierCounts {
  /** Table name (e.g. brain_observations). */
  table: string;
  /** Count of active short-tier entries. */
  short: number;
  /** Count of active medium-tier entries. */
  medium: number;
  /** Count of active long-tier entries. */
  long: number;
}

/** A medium-tier entry approaching long-tier promotion eligibility. */
export interface UpcomingPromotion {
  /** Entry ID. */
  id: string;
  /** Source brain table. */
  table: string;
  /** Fractional days remaining until 7-day long-tier gate elapses (0 = eligible now). */
  daysUntil: number;
  /** Human-readable track label: "citation (N)" or "verified". */
  track: string;
}

/** Full response shape. */
export interface TierStatsResponse {
  /** Per-table tier distributions. */
  tables: TableTierCounts[];
  /** Top-5 medium entries closest to long-tier eligibility. */
  upcomingLongPromotions: UpcomingPromotion[];
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * GET /api/brain/tier-stats — returns tier distribution + upcoming promotions.
 */
export const GET: RequestHandler = ({ locals }) => {
  const db = getBrainDb(locals.projectCtx);
  if (!db) {
    return json({
      tables: [],
      upcomingLongPromotions: [],
    } satisfies TierStatsResponse);
  }

  try {
    const brainTables = [
      { name: 'brain_observations', dateCol: 'created_at' },
      { name: 'brain_learnings', dateCol: 'created_at' },
      { name: 'brain_patterns', dateCol: 'extracted_at' },
      { name: 'brain_decisions', dateCol: 'created_at' },
    ] as const;

    // --- Per-table tier distribution ---
    const tables: TableTierCounts[] = [];
    for (const { name: tblName } of brainTables) {
      try {
        const rows = db
          .prepare(
            `SELECT COALESCE(memory_tier, 'short') as tier, COUNT(*) as cnt
             FROM ${tblName}
             WHERE invalid_at IS NULL
             GROUP BY memory_tier`,
          )
          .all() as Array<{ tier: string; cnt: number }>;

        const counts: TableTierCounts = { table: tblName, short: 0, medium: 0, long: 0 };
        for (const r of rows) {
          if (r.tier === 'short') counts.short = r.cnt;
          else if (r.tier === 'medium') counts.medium = r.cnt;
          else if (r.tier === 'long') counts.long = r.cnt;
        }
        tables.push(counts);
      } catch {
        tables.push({ table: tblName, short: 0, medium: 0, long: 0 });
      }
    }

    // --- Upcoming long-tier promotions ---
    // Medium entries with citation_count>=5 OR verified=1 that haven't crossed 7d yet
    const age7dMs = 7 * 24 * 60 * 60 * 1000;
    const nowMs = Date.now();

    interface PromoRow {
      id: string;
      created_at: string;
      citation_count: number;
      verified: number;
    }

    const upcoming: UpcomingPromotion[] = [];
    for (const { name: tblName, dateCol } of brainTables) {
      try {
        const rows = db
          .prepare(
            `SELECT id, ${dateCol} as created_at, citation_count, verified
             FROM ${tblName}
             WHERE memory_tier = 'medium'
               AND invalid_at IS NULL
               AND (citation_count >= 5 OR verified = 1)
             ORDER BY ${dateCol} ASC
             LIMIT 20`,
          )
          .all() as PromoRow[];

        for (const r of rows) {
          const entryMs = new Date(r.created_at.replace(' ', 'T') + 'Z').getTime();
          const promotionMs = entryMs + age7dMs;
          const daysUntil = Math.max(0, (promotionMs - nowMs) / (24 * 60 * 60 * 1000));
          const track = r.citation_count >= 5 ? `citation (${r.citation_count})` : 'verified';
          upcoming.push({ id: r.id, table: tblName, daysUntil, track });
        }
      } catch {
        // Table unavailable
      }
    }

    // Sort by soonest first, take top 5
    upcoming.sort((a, b) => a.daysUntil - b.daysUntil);
    const upcomingLongPromotions = upcoming.slice(0, 5);

    return json({ tables, upcomingLongPromotions } satisfies TierStatsResponse);
  } catch {
    return json({
      tables: [],
      upcomingLongPromotions: [],
    } satisfies TierStatsResponse);
  }
};
