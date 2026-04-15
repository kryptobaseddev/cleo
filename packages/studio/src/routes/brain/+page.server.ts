/**
 * Brain page server load — fetches basic stats for the placeholder view.
 */

import { getBrainDb } from '$lib/server/db/connections.js';
import type { PageServerLoad } from './$types';

interface Stat {
  value: string;
  label: string;
}

function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export const load: PageServerLoad = () => {
  let stats: Stat[] | null = null;

  try {
    const db = getBrainDb();
    if (db) {
      const nodeRow = db.prepare('SELECT COUNT(*) as cnt FROM brain_page_nodes').get() as {
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

      stats = [
        { value: formatCount(nodeRow.cnt), label: 'Graph Nodes' },
        { value: formatCount(obsRow.cnt), label: 'Observations' },
        { value: formatCount(decRow.cnt), label: 'Decisions' },
        { value: formatCount(patRow.cnt), label: 'Patterns' },
        { value: formatCount(learnRow.cnt), label: 'Learnings' },
      ];
    }
  } catch {
    // Database unavailable or schema mismatch
  }

  return { stats };
};
