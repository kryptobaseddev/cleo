/**
 * Archive statistics core module.
 * @task T4783
 */

import { readJson } from '../../store/json.js';
import { getArchivePath } from '../paths.js';
import type { DataAccessor } from '../../store/data-accessor.js';

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

interface ArchiveTask {
  createdAt?: string;
  completedAt?: string;
  _archive?: {
    archivedAt?: string;
    reason?: string;
  };
}

interface ArchiveFile {
  _meta?: {
    lastArchived: string | null;
  };
  archivedTasks: ArchiveTask[];
}

/** Get archive statistics. */
export async function getArchiveStats(
  opts: { period?: number; cwd?: string },
  accessor?: DataAccessor,
): Promise<ArchiveStatsResult> {
  const periodDays = opts.period ?? 30;
  const cutoff = new Date(Date.now() - periodDays * 86400000).toISOString();

  const archive = accessor
    ? await accessor.loadArchive() as unknown as ArchiveFile | null
    : await readJson<ArchiveFile>(getArchivePath(opts.cwd));

  if (!archive?.archivedTasks) {
    return {
      totalArchived: 0,
      byReason: {},
      averageCycleTimeDays: null,
      archiveRate: { periodDays, archivedInPeriod: 0 },
      lastArchived: null,
    };
  }

  const archived = archive.archivedTasks;

  // By reason
  const byReason: Record<string, number> = {};
  for (const t of archived) {
    const reason = t._archive?.reason || 'unknown';
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
  const averageCycleTimeDays = samples > 0
    ? Math.round((totalCycleDays / samples) * 100) / 100
    : null;

  // Archive rate
  const archivedInPeriod = archived.filter(t => {
    const archivedAt = t._archive?.archivedAt;
    return archivedAt && archivedAt >= cutoff;
  }).length;

  const lastArchived = archive._meta?.lastArchived ?? null;

  return {
    totalArchived: archived.length,
    byReason,
    averageCycleTimeDays,
    archiveRate: { periodDays, archivedInPeriod },
    lastArchived,
  };
}
