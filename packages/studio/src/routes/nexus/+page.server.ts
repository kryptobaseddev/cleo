/**
 * Nexus page server load — fetches basic stats for the placeholder view.
 */

import { getNexusDb } from '$lib/server/db/connections.js';
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
    const db = getNexusDb();
    if (db) {
      const nodeRow = db.prepare('SELECT COUNT(*) as cnt FROM nexus_nodes').get() as {
        cnt: number;
      };
      const relRow = db.prepare('SELECT COUNT(*) as cnt FROM nexus_relations').get() as {
        cnt: number;
      };
      const kindRows = db
        .prepare('SELECT kind, COUNT(*) as cnt FROM nexus_nodes GROUP BY kind ORDER BY cnt DESC')
        .all() as { kind: string; cnt: number }[];

      stats = [
        { value: formatCount(nodeRow.cnt), label: 'Total Symbols' },
        { value: formatCount(relRow.cnt), label: 'Total Relations' },
        ...kindRows.slice(0, 4).map((r) => ({
          value: formatCount(r.cnt),
          label: r.kind.charAt(0).toUpperCase() + r.kind.slice(1) + 's',
        })),
      ];
    }
  } catch {
    // Database unavailable
  }

  return { stats };
};
