/**
 * Brain overview page server load — fetches stats for the dashboard.
 *
 * T748: Added per-table tier distribution chart data and upcoming long-tier
 * promotion countdown.
 */

import { getBrainDb } from '$lib/server/db/connections.js';
import type { PageServerLoad } from './$types';

interface Stat {
  value: string;
  label: string;
}

interface RecentItem {
  id: string;
  label: string;
  node_type: string;
  quality_score: number;
  created_at: string;
}

interface NodeTypeCount {
  node_type: string;
  count: number;
}

interface TierCount {
  tier: string;
  count: number;
}

/** Per-table tier distribution for the bar chart. */
interface TableTierDistribution {
  table: string;
  short: number;
  medium: number;
  long: number;
}

/** Entry approaching long-tier promotion eligibility. */
interface UpcomingPromotion {
  id: string;
  table: string;
  daysUntil: number;
  track: string;
}

function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export const load: PageServerLoad = ({ locals }) => {
  let stats: Stat[] | null = null;
  let recentNodes: RecentItem[] = [];
  let nodeTypeCounts: NodeTypeCount[] = [];
  let tierCounts: TierCount[] = [];
  const tierDistribution: TableTierDistribution[] = [];
  let upcomingPromotions: UpcomingPromotion[] = [];

  try {
    const db = getBrainDb(locals.projectCtx);
    if (db) {
      const nodeRow = db.prepare('SELECT COUNT(*) as cnt FROM brain_page_nodes').get() as {
        cnt: number;
      };
      const edgeRow = db.prepare('SELECT COUNT(*) as cnt FROM brain_page_edges').get() as {
        cnt: number;
      };
      const obsRow = db.prepare('SELECT COUNT(*) as cnt FROM brain_observations').get() as {
        cnt: number;
      };
      const decRow = db.prepare('SELECT COUNT(*) as cnt FROM brain_decisions').get() as {
        cnt: number;
      };
      const patRow = db.prepare('SELECT COUNT(*) as cnt FROM brain_patterns').get() as {
        cnt: number;
      };
      const learnRow = db.prepare('SELECT COUNT(*) as cnt FROM brain_learnings').get() as {
        cnt: number;
      };
      const verifiedRow = db
        .prepare('SELECT COUNT(*) as cnt FROM brain_observations WHERE verified = 1')
        .get() as { cnt: number };
      const pruneRow = db
        .prepare('SELECT COUNT(*) as cnt FROM brain_observations WHERE prune_candidate = 1')
        .get() as { cnt: number };

      stats = [
        { value: formatCount(nodeRow.cnt), label: 'Graph Nodes' },
        { value: formatCount(edgeRow.cnt), label: 'Graph Edges' },
        { value: formatCount(obsRow.cnt), label: 'Observations' },
        { value: formatCount(decRow.cnt), label: 'Decisions' },
        { value: formatCount(patRow.cnt), label: 'Patterns' },
        { value: formatCount(learnRow.cnt), label: 'Learnings' },
        { value: formatCount(verifiedRow.cnt), label: 'Verified' },
        { value: formatCount(pruneRow.cnt), label: 'Prune Candidates' },
      ];

      recentNodes = db
        .prepare(
          `SELECT id, label, node_type, quality_score, created_at
           FROM brain_page_nodes
           ORDER BY last_activity_at DESC, created_at DESC
           LIMIT 10`,
        )
        .all() as RecentItem[];

      nodeTypeCounts = db
        .prepare(
          `SELECT node_type, COUNT(*) as count
           FROM brain_page_nodes
           GROUP BY node_type
           ORDER BY count DESC`,
        )
        .all() as NodeTypeCount[];

      tierCounts = db
        .prepare(
          `SELECT COALESCE(memory_tier, 'unknown') as tier, COUNT(*) as count
           FROM brain_observations
           GROUP BY memory_tier
           ORDER BY count DESC`,
        )
        .all() as TierCount[];

      // T748: Per-table tier distribution for bar chart
      const brainTables = [
        { name: 'brain_observations', dateCol: 'created_at' },
        { name: 'brain_learnings', dateCol: 'created_at' },
        { name: 'brain_patterns', dateCol: 'extracted_at' },
        { name: 'brain_decisions', dateCol: 'created_at' },
      ] as const;

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

          const dist: TableTierDistribution = { table: tblName, short: 0, medium: 0, long: 0 };
          for (const r of rows) {
            if (r.tier === 'short') dist.short = r.cnt;
            else if (r.tier === 'medium') dist.medium = r.cnt;
            else if (r.tier === 'long') dist.long = r.cnt;
          }
          tierDistribution.push(dist);
        } catch {
          tierDistribution.push({ table: tblName, short: 0, medium: 0, long: 0 });
        }
      }

      // T748: Upcoming long-tier promotions countdown
      const age7dMs = 7 * 24 * 60 * 60 * 1000;
      const nowMs = Date.now();
      const allUpcoming: UpcomingPromotion[] = [];

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
            .all() as Array<{
            id: string;
            created_at: string;
            citation_count: number;
            verified: number;
          }>;

          for (const r of rows) {
            const entryMs = new Date(r.created_at.replace(' ', 'T') + 'Z').getTime();
            const promotionMs = entryMs + age7dMs;
            const daysUntil = Math.max(0, (promotionMs - nowMs) / (24 * 60 * 60 * 1000));
            const track = r.citation_count >= 5 ? `citation (${r.citation_count})` : 'verified';
            allUpcoming.push({ id: r.id, table: tblName, daysUntil, track });
          }
        } catch {
          // Table unavailable
        }
      }

      allUpcoming.sort((a, b) => a.daysUntil - b.daysUntil);
      upcomingPromotions = allUpcoming.slice(0, 5);
    }
  } catch {
    // Database unavailable or schema mismatch
  }

  return { stats, recentNodes, nodeTypeCounts, tierCounts, tierDistribution, upcomingPromotions };
};
