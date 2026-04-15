/**
 * Home page server load — fetches summary stats from all three databases.
 */

import { getBrainDb, getNexusDb, getTasksDb } from '$lib/server/db/connections.js';
import type { PageServerLoad } from './$types';

interface Stat {
  value: string;
  label: string;
}

function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export const load: PageServerLoad = ({ locals }) => {
  let nexusStats: Stat[] | null = null;
  let brainStats: Stat[] | null = null;
  let tasksStats: Stat[] | null = null;

  try {
    const nexus = getNexusDb();
    if (nexus) {
      const nodeRow = nexus.prepare('SELECT COUNT(*) as cnt FROM nexus_nodes').get() as {
        cnt: number;
      };
      const relRow = nexus.prepare('SELECT COUNT(*) as cnt FROM nexus_relations').get() as {
        cnt: number;
      };
      nexusStats = [
        { value: formatCount(nodeRow.cnt), label: 'Symbols' },
        { value: formatCount(relRow.cnt), label: 'Relations' },
      ];
    }
  } catch {
    // Database unavailable or schema mismatch — leave null
  }

  try {
    const brain = getBrainDb(locals.projectCtx);
    if (brain) {
      const nodeRow = brain.prepare('SELECT COUNT(*) as cnt FROM brain_page_nodes').get() as {
        cnt: number;
      };
      const obsRow = brain.prepare('SELECT COUNT(*) as cnt FROM brain_observations').get() as {
        cnt: number;
      };
      brainStats = [
        { value: formatCount(nodeRow.cnt), label: 'Nodes' },
        { value: formatCount(obsRow.cnt), label: 'Observations' },
      ];
    }
  } catch {
    // Database unavailable or schema mismatch — leave null
  }

  try {
    const tasks = getTasksDb(locals.projectCtx);
    if (tasks) {
      const taskRow = tasks.prepare('SELECT COUNT(*) as cnt FROM tasks').get() as { cnt: number };
      const epicRow = tasks
        .prepare("SELECT COUNT(*) as cnt FROM tasks WHERE type = 'epic'")
        .get() as { cnt: number };
      tasksStats = [
        { value: formatCount(taskRow.cnt), label: 'Tasks' },
        { value: formatCount(epicRow.cnt), label: 'Epics' },
      ];
    }
  } catch {
    // Database unavailable or schema mismatch — leave null
  }

  return { nexusStats, brainStats, tasksStats };
};
