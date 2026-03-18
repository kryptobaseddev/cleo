/**
 * Archive types for archived task records and metadata.
 *
 * @task T4555
 */

import type { Task } from './task.js';

/** Archive metadata attached to archived task records. */
export interface ArchiveMetadata {
  archivedAt?: string;
  cycleTimeDays?: number;
  archiveSource?: string;
  archiveReason?: string;
}

/** A task with archive metadata. */
export interface ArchivedTask extends Task {
  _archive?: ArchiveMetadata;
}

/** Report type for archive statistics. */
export type ArchiveReportType =
  | 'summary'
  | 'by-phase'
  | 'by-label'
  | 'by-priority'
  | 'cycle-times'
  | 'trends';

/** Summary report from archive statistics. */
export interface ArchiveSummaryReport {
  totalArchived: number;
  byStatus: Record<string, number>;
  byPriority: Record<string, number>;
  averageCycleTime: number | null;
  oldestArchived: string | null;
  newestArchived: string | null;
  archiveSourceBreakdown: Record<string, number>;
}

/** Phase breakdown entry from archive statistics. */
export interface ArchivePhaseEntry {
  phase: string;
  count: number;
  avgCycleTime: number | null;
}

/** Label breakdown entry from archive statistics. */
export interface ArchiveLabelEntry {
  label: string;
  count: number;
}

/** Priority breakdown entry from archive statistics. */
export interface ArchivePriorityEntry {
  priority: string;
  count: number;
  avgCycleTime: number | null;
}

/** Cycle time distribution buckets. */
export interface CycleTimeDistribution {
  '0-1 days': number;
  '2-7 days': number;
  '8-30 days': number;
  '30+ days': number;
}

/** Cycle time percentiles. */
export interface CycleTimePercentiles {
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
}

/** Cycle times report from archive statistics. */
export interface ArchiveCycleTimesReport {
  count: number;
  min: number | null;
  max: number | null;
  avg: number | null;
  median: number | null;
  distribution: CycleTimeDistribution;
  percentiles?: CycleTimePercentiles;
}

/** Daily archive trend entry. */
export interface ArchiveDailyTrend {
  date: string;
  count: number;
}

/** Monthly archive trend entry. */
export interface ArchiveMonthlyTrend {
  month: string;
  count: number;
}

/** Trends report from archive statistics. */
export interface ArchiveTrendsReport {
  byDay: ArchiveDailyTrend[];
  byMonth: ArchiveMonthlyTrend[];
  totalPeriod: number;
  averagePerDay: number;
}

/** Archive statistics result envelope. */
export interface ArchiveStatsEnvelope {
  report: ArchiveReportType;
  filters: { since: string | null; until: string | null } | null;
  data:
    | ArchiveSummaryReport
    | ArchivePhaseEntry[]
    | ArchiveLabelEntry[]
    | ArchivePriorityEntry[]
    | ArchiveCycleTimesReport
    | ArchiveTrendsReport
    | { totalArchived: 0; message: string };
}
