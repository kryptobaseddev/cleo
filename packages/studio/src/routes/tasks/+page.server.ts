/**
 * Tasks page server load — fetches basic stats for the placeholder view.
 */

import { getTasksDb } from '$lib/server/db/connections.js';
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
    const db = getTasksDb();
    if (db) {
      const totalRow = db.prepare('SELECT COUNT(*) as cnt FROM tasks').get() as { cnt: number };
      const epicRow = db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE type = 'epic'").get() as {
        cnt: number;
      };
      const activeRow = db
        .prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status = 'active'")
        .get() as { cnt: number };
      const doneRow = db
        .prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status = 'done'")
        .get() as { cnt: number };
      const pendingRow = db
        .prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status = 'pending'")
        .get() as { cnt: number };

      stats = [
        { value: formatCount(totalRow.cnt), label: 'Total Tasks' },
        { value: formatCount(epicRow.cnt), label: 'Epics' },
        { value: formatCount(activeRow.cnt), label: 'Active' },
        { value: formatCount(pendingRow.cnt), label: 'Pending' },
        { value: formatCount(doneRow.cnt), label: 'Done' },
      ];
    }
  } catch {
    // Database unavailable or schema mismatch
  }

  return { stats };
};
