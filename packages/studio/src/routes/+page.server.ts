/**
 * Home page ("Mission Control") server load.
 *
 * Supplies everything the Wave 1E root dashboard renders without needing
 * client-side fetches on first paint:
 *
 *   - Substrate stats (nexus, brain, tasks) — driven from their DBs.
 *   - A 24-hour activity histogram bucketed by hour (brain observations +
 *     tasks completions). Feeds the `Sparkline` on the dashboard.
 *   - A 20-row "recent activity" cross-feed (decisions, observations,
 *     task completions) ordered by timestamp.
 *   - Active session count — populates the `LIVE` indicator.
 *
 * All queries are wrapped in `try / catch` so a corrupt or missing DB
 * degrades gracefully to null arrays instead of 500ing the page.
 *
 * @task T990
 * @wave 1E
 */

import { getBrainDb, getNexusDb, getTasksDb } from '$lib/server/db/connections.js';
import type { PageServerLoad } from './$types';

export interface DashboardStat {
  value: string;
  label: string;
}

export interface ActivityBucket {
  /** ISO hour start (for tooltip / debug). */
  hourStart: string;
  /** Total activity points landed in this bucket. */
  total: number;
  /** Brain observations specifically. */
  observations: number;
  /** Task completions specifically. */
  completions: number;
}

export interface RecentActivityRow {
  kind: 'observation' | 'decision' | 'task-done' | 'task-created';
  id: string;
  title: string;
  detail: string | null;
  timestamp: string;
}

export interface DashboardData {
  nexusStats: DashboardStat[] | null;
  brainStats: DashboardStat[] | null;
  tasksStats: DashboardStat[] | null;
  /** Hour-by-hour bucket counts for the last 24h, oldest first. */
  activity24h: ActivityBucket[];
  /** Cross-substrate recent activity (newest first). */
  recentActivity: RecentActivityRow[];
  /** Count of currently active sessions. */
  activeSessions: number;
  /** Cached stats for observation / decision counts (for dashboard tiles). */
  observationCount: number | null;
  decisionCount: number | null;
  /** Active project name for the hero meta line. */
  projectName: string;
  /** Active project path for the hero meta line. */
  projectPath: string;
}

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/**
 * Build 24 hourly buckets from `now - 23h` → `now`.
 */
function buildBuckets(now: number): ActivityBucket[] {
  const buckets: ActivityBucket[] = [];
  const startHour = now - 23 * 60 * 60 * 1000;
  const hourStart = (t: number) => new Date(t - (t % (60 * 60 * 1000)));
  for (let i = 0; i < 24; i++) {
    const ts = hourStart(startHour + i * 60 * 60 * 1000);
    buckets.push({
      hourStart: ts.toISOString(),
      total: 0,
      observations: 0,
      completions: 0,
    });
  }
  return buckets;
}

function bucketIndex(iso: string, now: number): number {
  try {
    const t = new Date(iso).getTime();
    const delta = now - t;
    if (delta < 0 || delta > TWENTY_FOUR_HOURS_MS) return -1;
    const hoursAgo = Math.floor(delta / (60 * 60 * 1000));
    return Math.max(0, 23 - hoursAgo);
  } catch {
    return -1;
  }
}

export const load: PageServerLoad = ({ locals }) => {
  const now = Date.now();
  const cutoff = new Date(now - TWENTY_FOUR_HOURS_MS).toISOString();

  let nexusStats: DashboardStat[] | null = null;
  let brainStats: DashboardStat[] | null = null;
  let tasksStats: DashboardStat[] | null = null;
  let observationCount: number | null = null;
  let decisionCount: number | null = null;
  let activeSessions = 0;

  const activity24h = buildBuckets(now);
  const recentActivity: RecentActivityRow[] = [];

  // -------- Nexus ----------
  try {
    const nexus = getNexusDb();
    if (nexus) {
      const nodeRow = nexus.prepare('SELECT COUNT(*) AS cnt FROM nexus_nodes').get() as {
        cnt: number;
      };
      const relRow = nexus.prepare('SELECT COUNT(*) AS cnt FROM nexus_relations').get() as {
        cnt: number;
      };
      nexusStats = [
        { value: formatCount(nodeRow.cnt), label: 'Symbols' },
        { value: formatCount(relRow.cnt), label: 'Relations' },
      ];
    }
  } catch {
    // leave null
  }

  // -------- Brain ----------
  try {
    const brain = getBrainDb(locals.projectCtx);
    if (brain) {
      const nodeRow = brain.prepare('SELECT COUNT(*) AS cnt FROM brain_page_nodes').get() as {
        cnt: number;
      };
      const obsRow = brain.prepare('SELECT COUNT(*) AS cnt FROM brain_observations').get() as {
        cnt: number;
      };
      brainStats = [
        { value: formatCount(nodeRow.cnt), label: 'Nodes' },
        { value: formatCount(obsRow.cnt), label: 'Observations' },
      ];
      observationCount = obsRow.cnt;

      try {
        const decRow = brain.prepare('SELECT COUNT(*) AS cnt FROM brain_decisions').get() as {
          cnt: number;
        };
        decisionCount = decRow.cnt;
      } catch {
        // table may not exist
      }

      // Observations in last 24h — bucket them
      try {
        const recent = brain
          .prepare(
            'SELECT id, title, created_at FROM brain_observations WHERE created_at >= ? ORDER BY created_at DESC LIMIT 500',
          )
          .all(cutoff) as Array<{ id: string; title: string | null; created_at: string }>;
        for (const row of recent) {
          const idx = bucketIndex(row.created_at, now);
          if (idx >= 0) {
            const bucket = activity24h[idx];
            if (bucket) {
              bucket.observations++;
              bucket.total++;
            }
          }
        }
        // newest 6 for the recent-activity feed
        for (const row of recent.slice(0, 6)) {
          recentActivity.push({
            kind: 'observation',
            id: row.id,
            title: row.title ?? '(observation)',
            detail: null,
            timestamp: row.created_at,
          });
        }
      } catch {
        // skip
      }

      // Recent decisions — only for the feed
      try {
        const decisions = brain
          .prepare(
            'SELECT id, title, created_at FROM brain_decisions ORDER BY created_at DESC LIMIT 6',
          )
          .all() as Array<{ id: string; title: string; created_at: string }>;
        for (const row of decisions) {
          recentActivity.push({
            kind: 'decision',
            id: row.id,
            title: row.title,
            detail: null,
            timestamp: row.created_at,
          });
        }
      } catch {
        // skip
      }
    }
  } catch {
    // leave null
  }

  // -------- Tasks ----------
  try {
    const tasks = getTasksDb(locals.projectCtx);
    if (tasks) {
      const taskRow = tasks.prepare('SELECT COUNT(*) AS cnt FROM tasks').get() as {
        cnt: number;
      };
      const epicRow = tasks
        .prepare("SELECT COUNT(*) AS cnt FROM tasks WHERE type = 'epic'")
        .get() as { cnt: number };
      tasksStats = [
        { value: formatCount(taskRow.cnt), label: 'Tasks' },
        { value: formatCount(epicRow.cnt), label: 'Epics' },
      ];

      // Completions in last 24h
      try {
        const recent = tasks
          .prepare(
            'SELECT id, title, completed_at FROM tasks WHERE completed_at IS NOT NULL AND completed_at >= ? ORDER BY completed_at DESC LIMIT 500',
          )
          .all(cutoff) as Array<{ id: string; title: string; completed_at: string }>;
        for (const row of recent) {
          const idx = bucketIndex(row.completed_at, now);
          if (idx >= 0) {
            const bucket = activity24h[idx];
            if (bucket) {
              bucket.completions++;
              bucket.total++;
            }
          }
        }
        for (const row of recent.slice(0, 6)) {
          recentActivity.push({
            kind: 'task-done',
            id: row.id,
            title: row.title,
            detail: null,
            timestamp: row.completed_at,
          });
        }
      } catch {
        // skip
      }

      // Newly-created tasks in last 24h → feed only
      try {
        const created = tasks
          .prepare(
            'SELECT id, title, created_at FROM tasks WHERE created_at >= ? ORDER BY created_at DESC LIMIT 6',
          )
          .all(cutoff) as Array<{ id: string; title: string; created_at: string }>;
        for (const row of created) {
          recentActivity.push({
            kind: 'task-created',
            id: row.id,
            title: row.title,
            detail: null,
            timestamp: row.created_at,
          });
        }
      } catch {
        // skip
      }

      try {
        const sessions = tasks
          .prepare("SELECT COUNT(*) AS cnt FROM sessions WHERE status = 'active'")
          .get() as { cnt: number };
        activeSessions = sessions.cnt;
      } catch {
        activeSessions = 0;
      }
    }
  } catch {
    // leave null
  }

  // Sort the cross-feed (newest first) + trim to 20
  recentActivity.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));

  return {
    nexusStats,
    brainStats,
    tasksStats,
    activity24h,
    recentActivity: recentActivity.slice(0, 20),
    activeSessions,
    observationCount,
    decisionCount,
    projectName: locals.projectCtx.name,
    projectPath: locals.projectCtx.projectPath,
  } satisfies DashboardData;
};
