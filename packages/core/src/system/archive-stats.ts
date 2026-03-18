/**
 * Archive statistics core module.
 * @task T4783
 */

import type { ArchivedTask } from '@cleocode/contracts';
import type { DataAccessor } from '../store/data-accessor.js';
import { getAccessor } from '../store/data-accessor.js';

export interface ArchiveStatsResult {
  totalArchived: number;
  byReason: Record<string, number>;
  averageCycleTimeDays: number | null;
  archiveRate: {
    periodDays: number;
    archivedInPeriod: number;
  };
  lastArchived: string | null;
}

/** Get archive statistics. */
export async function getArchiveStats(
  opts: { period?: number; cwd?: string },
  accessor?: DataAccessor,
): Promise<ArchiveStatsResult> {
  const periodDays = opts.period ?? 30;
  const cutoff = new Date(Date.now() - periodDays * 86400000).toISOString();

  const acc = accessor ?? (await getAccessor(opts.cwd));
  const archive = await acc.loadArchive();

  if (!archive?.archivedTasks) {
    return {
      totalArchived: 0,
      byReason: {},
      averageCycleTimeDays: null,
      archiveRate: { periodDays, archivedInPeriod: 0 },
      lastArchived: null,
    };
  }

  // ArchivedTask extends Task with _archive metadata; safe narrowing from Task[]
  const archived = archive.archivedTasks as ArchivedTask[];

  // By reason
  const byReason: Record<string, number> = {};
  for (const t of archived) {
    const reason = t._archive?.archiveReason || 'unknown';
    byReason[reason] = (byReason[reason] ?? 0) + 1;
  }

  // Average cycle time
  let totalCycleDays = 0;
  let samples = 0;
  for (const t of archived) {
    if (t.createdAt && t.completedAt) {
      const created = new Date(t.createdAt).getTime();
      const completed = new Date(t.completedAt).getTime();
      if (completed > created) {
        totalCycleDays += (completed - created) / 86400000;
        samples++;
      }
    }
  }
  const averageCycleTimeDays =
    samples > 0 ? Math.round((totalCycleDays / samples) * 100) / 100 : null;

  // Archive rate
  const archivedInPeriod = archived.filter((t) => {
    const archivedAt = t._archive?.archivedAt;
    return archivedAt && archivedAt >= cutoff;
  }).length;

  // Find the most recent archived-at timestamp
  let lastArchived: string | null = null;
  for (const t of archived) {
    const at = t._archive?.archivedAt;
    if (at && (!lastArchived || at > lastArchived)) {
      lastArchived = at;
    }
  }

  return {
    totalArchived: archived.length,
    byReason,
    averageCycleTimeDays,
    archiveRate: { periodDays, archivedInPeriod },
    lastArchived,
  };
}
