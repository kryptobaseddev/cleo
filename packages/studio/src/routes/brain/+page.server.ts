/**
 * Brain overview page server load — fetches stats for the dashboard.
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

function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export const load: PageServerLoad = () => {
  let stats: Stat[] | null = null;
  let recentNodes: RecentItem[] = [];
  let nodeTypeCounts: NodeTypeCount[] = [];
  let tierCounts: TierCount[] = [];

  try {
    const db = getBrainDb();
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
    }
  } catch {
    // Database unavailable or schema mismatch
  }

  return { stats, recentNodes, nodeTypeCounts, tierCounts };
};
