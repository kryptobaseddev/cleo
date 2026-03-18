/**
 * Archive analytics — rich reporting and insights from archived tasks.
 *
 * Moved from CLI archive-stats command to core for reuse across
 * MCP, CLI, and programmatic consumers.
 *
 * @task T4555
 * @epic T4545
 */

import type { DataAccessor } from '../store/data-accessor.js';
import { getAccessor } from '../store/data-accessor.js';
import type { Task } from '@cleocode/contracts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Archive metadata that may be attached to archived task records. */
export interface ArchiveMetadata {
  archivedAt?: string;
  cycleTimeDays?: number;
  archiveSource?: string;
}

/** Archived task shape used internally for analytics. */
export interface AnalyticsTask {
  id: string;
  title: string;
  status: string;
  priority?: string;
  phase?: string;
  labels?: string[];
  archive: ArchiveMetadata;
}

export type ArchiveReportType =
  | 'summary'
  | 'by-phase'
  | 'by-label'
  | 'by-priority'
  | 'cycle-times'
  | 'trends';

/** Summary report result. */
export interface SummaryReportData {
  totalArchived: number;
  byStatus: Record<string, number>;
  byPriority: Record<string, number>;
  averageCycleTime: number | null;
  oldestArchived: string | null;
  newestArchived: string | null;
  archiveSourceBreakdown: Record<string, number>;
}

/** Phase group entry. */
export interface PhaseGroupEntry {
  phase: string;
  count: number;
  avgCycleTime: number | null;
}

/** Label frequency entry. */
export interface LabelFrequencyEntry {
  label: string;
  count: number;
}

/** Priority group entry. */
export interface PriorityGroupEntry {
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

/** Cycle times report result. */
export interface CycleTimesReportData {
  count: number;
  min: number | null;
  max: number | null;
  avg: number | null;
  median: number | null;
  distribution: CycleTimeDistribution;
  percentiles?: CycleTimePercentiles;
}

/** Daily archive entry. */
export interface DailyArchiveEntry {
  date: string;
  count: number;
}

/** Monthly archive entry. */
export interface MonthlyArchiveEntry {
  month: string;
  count: number;
}

/** Trends report result. */
export interface TrendsReportData {
  byDay: DailyArchiveEntry[];
  byMonth: MonthlyArchiveEntry[];
  totalPeriod: number;
  averagePerDay: number;
}

/** Empty archive sentinel (when totalArchived is 0). */
export interface EmptyArchiveData {
  totalArchived: 0;
  message: string;
}

/** Union type mapping report types to their data shapes. */
export type ArchiveReportDataMap = {
  summary: SummaryReportData;
  'by-phase': PhaseGroupEntry[];
  'by-label': LabelFrequencyEntry[];
  'by-priority': PriorityGroupEntry[];
  'cycle-times': CycleTimesReportData;
  trends: TrendsReportData;
};

/** The envelope returned by analyzeArchive. */
export interface ArchiveAnalyticsResult<R extends ArchiveReportType = ArchiveReportType> {
  report: R;
  filters: { since: string | null; until: string | null } | null;
  data: ArchiveReportDataMap[R] | EmptyArchiveData;
}

/** Options for analyzeArchive. */
export interface AnalyzeArchiveOptions {
  report?: ArchiveReportType;
  since?: string;
  until?: string;
  cwd?: string;
}

// ---------------------------------------------------------------------------
// Internal: task extraction from archive data
// ---------------------------------------------------------------------------

/** Type guard for raw objects that have _archive nested metadata (legacy JSON format). */
function hasNestedArchive(t: object): t is object & { _archive: ArchiveMetadata } {
  return '_archive' in t && typeof (t as { _archive: unknown })._archive === 'object';
}

/**
 * Extract archive metadata from a task record.
 * Handles both:
 * - Legacy JSON format: { _archive: { archivedAt, cycleTimeDays, archiveSource } }
 * - SQLite format: { archivedAt, cycleTimeDays, archiveReason } (flat properties on Task)
 */
function extractArchiveMetadata(t: Task): ArchiveMetadata {
  // Legacy JSON nested format
  if (hasNestedArchive(t)) {
    return t._archive;
  }

  // SQLite flat format — archive fields are tacked onto the Task object
  const raw = t as Task & {
    archivedAt?: string;
    archiveReason?: string;
    cycleTimeDays?: number;
  };

  return {
    archivedAt: raw.archivedAt,
    cycleTimeDays: raw.cycleTimeDays,
    archiveSource: raw.archiveReason,
  };
}

/** Convert raw Task[] from the accessor into AnalyticsTask[]. */
function toAnalyticsTasks(tasks: Task[]): AnalyticsTask[] {
  return tasks.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    phase: t.phase,
    labels: t.labels,
    archive: extractArchiveMetadata(t),
  }));
}

// ---------------------------------------------------------------------------
// Analysis functions (pure, no I/O)
// ---------------------------------------------------------------------------

/** Filter tasks by date range on archivedAt. */
export function filterByDate(
  tasks: AnalyticsTask[],
  since?: string,
  until?: string,
): AnalyticsTask[] {
  let filtered = tasks;
  if (since) {
    const sinceDate = since.includes('T') ? since : `${since}T00:00:00Z`;
    filtered = filtered.filter((t) => (t.archive.archivedAt ?? '') >= sinceDate);
  }
  if (until) {
    const untilDate = until.includes('T') ? until : `${until}T23:59:59Z`;
    filtered = filtered.filter((t) => (t.archive.archivedAt ?? '') <= untilDate);
  }
  return filtered;
}

/** Generate summary statistics. */
export function summaryReport(tasks: AnalyticsTask[]): SummaryReportData {
  const byStatus: Record<string, number> = {};
  const byPriority: Record<string, number> = {};
  const sourceBreakdown: Record<string, number> = {};
  const cycleTimes: number[] = [];

  for (const t of tasks) {
    byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
    const prio = t.priority ?? 'unset';
    byPriority[prio] = (byPriority[prio] ?? 0) + 1;
    const src = t.archive.archiveSource ?? 'unknown';
    sourceBreakdown[src] = (sourceBreakdown[src] ?? 0) + 1;
    if (t.archive.cycleTimeDays != null) {
      cycleTimes.push(t.archive.cycleTimeDays);
    }
  }

  const sorted = tasks
    .filter((t) => t.archive.archivedAt)
    .sort((a, b) => a.archive.archivedAt!.localeCompare(b.archive.archivedAt!));

  return {
    totalArchived: tasks.length,
    byStatus,
    byPriority,
    averageCycleTime:
      cycleTimes.length > 0
        ? Math.round((cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length) * 100) / 100
        : null,
    oldestArchived: sorted[0]?.archive.archivedAt ?? null,
    newestArchived: sorted[sorted.length - 1]?.archive.archivedAt ?? null,
    archiveSourceBreakdown: sourceBreakdown,
  };
}

/** Group tasks by phase with cycle time averages. */
export function byPhaseReport(tasks: AnalyticsTask[]): PhaseGroupEntry[] {
  const groups: Record<string, AnalyticsTask[]> = {};
  for (const t of tasks) {
    const phase = t.phase ?? 'unassigned';
    if (!groups[phase]) groups[phase] = [];
    groups[phase]!.push(t);
  }
  return Object.entries(groups)
    .map(([phase, items]) => {
      const cycles = items
        .map((t) => t.archive.cycleTimeDays)
        .filter((c): c is number => c != null);
      return {
        phase,
        count: items.length,
        avgCycleTime:
          cycles.length > 0
            ? Math.round((cycles.reduce((a, b) => a + b, 0) / cycles.length) * 100) / 100
            : null,
      };
    })
    .sort((a, b) => b.count - a.count);
}

/** Group tasks by label frequency. */
export function byLabelReport(tasks: AnalyticsTask[]): LabelFrequencyEntry[] {
  const counts: Record<string, number> = {};
  for (const t of tasks) {
    for (const label of t.labels ?? []) {
      counts[label] = (counts[label] ?? 0) + 1;
    }
  }
  return Object.entries(counts)
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
}

/** Group tasks by priority with cycle time averages. */
export function byPriorityReport(tasks: AnalyticsTask[]): PriorityGroupEntry[] {
  const PRIO_ORDER = ['critical', 'high', 'medium', 'low', 'unset'];
  const groups: Record<string, AnalyticsTask[]> = {};
  for (const t of tasks) {
    const prio = t.priority ?? 'unset';
    if (!groups[prio]) groups[prio] = [];
    groups[prio]!.push(t);
  }
  return Object.entries(groups)
    .map(([priority, items]) => {
      const cycles = items
        .map((t) => t.archive.cycleTimeDays)
        .filter((c): c is number => c != null);
      return {
        priority,
        count: items.length,
        avgCycleTime:
          cycles.length > 0
            ? Math.round((cycles.reduce((a, b) => a + b, 0) / cycles.length) * 100) / 100
            : null,
      };
    })
    .sort((a, b) => PRIO_ORDER.indexOf(a.priority) - PRIO_ORDER.indexOf(b.priority));
}

/** Compute cycle time statistics with distribution buckets. */
export function cycleTimesReport(tasks: AnalyticsTask[]): CycleTimesReportData {
  const times = tasks
    .map((t) => t.archive.cycleTimeDays)
    .filter((c): c is number => c != null)
    .sort((a, b) => a - b);

  if (times.length === 0) {
    return {
      count: 0,
      min: null,
      max: null,
      avg: null,
      median: null,
      distribution: { '0-1 days': 0, '2-7 days': 0, '8-30 days': 0, '30+ days': 0 },
    };
  }

  const median =
    times.length % 2 === 0
      ? (times[times.length / 2 - 1]! + times[times.length / 2]!) / 2
      : times[Math.floor(times.length / 2)]!;

  const percentile = (p: number): number | null => times[Math.floor(times.length * p)] ?? null;

  return {
    count: times.length,
    min: times[0]!,
    max: times[times.length - 1]!,
    avg: Math.round((times.reduce((a, b) => a + b, 0) / times.length) * 100) / 100,
    median,
    distribution: {
      '0-1 days': times.filter((t) => t <= 1).length,
      '2-7 days': times.filter((t) => t > 1 && t <= 7).length,
      '8-30 days': times.filter((t) => t > 7 && t <= 30).length,
      '30+ days': times.filter((t) => t > 30).length,
    },
    percentiles: {
      p25: percentile(0.25),
      p50: percentile(0.5),
      p75: percentile(0.75),
      p90: percentile(0.9),
    },
  };
}

/** Compute archive trends by day and month. */
export function trendsReport(tasks: AnalyticsTask[]): TrendsReportData {
  const withDate = tasks.filter((t) => t.archive.archivedAt);
  const byDay: Record<string, number> = {};
  for (const t of withDate) {
    const date = t.archive.archivedAt!.slice(0, 10);
    byDay[date] = (byDay[date] ?? 0) + 1;
  }
  const dailyEntries: DailyArchiveEntry[] = Object.entries(byDay)
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const byMonth: Record<string, number> = {};
  for (const { date, count } of dailyEntries) {
    const month = date.slice(0, 7);
    byMonth[month] = (byMonth[month] ?? 0) + count;
  }
  const monthlyEntries: MonthlyArchiveEntry[] = Object.entries(byMonth).map(([month, count]) => ({
    month,
    count,
  }));

  const totalPeriod = dailyEntries.reduce((sum, d) => sum + d.count, 0);

  return {
    byDay: dailyEntries,
    byMonth: monthlyEntries,
    totalPeriod,
    averagePerDay:
      dailyEntries.length > 0 ? Math.round((totalPeriod / dailyEntries.length) * 100) / 100 : 0,
  };
}

// ---------------------------------------------------------------------------
// Public API — orchestrates data loading + report generation
// ---------------------------------------------------------------------------

/**
 * Analyze archived tasks and produce a report.
 *
 * This is the primary entry point for archive analytics. It loads archive
 * data from the DataAccessor, normalizes task records, applies date filters,
 * and delegates to the appropriate report function.
 */
export async function analyzeArchive(
  opts: AnalyzeArchiveOptions,
  accessor?: DataAccessor,
): Promise<ArchiveAnalyticsResult> {
  const acc = accessor ?? (await getAccessor(opts.cwd));
  const data = await acc.loadArchive();

  const reportType = opts.report ?? 'summary';

  if (!data || !data.archivedTasks?.length) {
    return {
      report: reportType,
      filters: null,
      data: { totalArchived: 0 as const, message: 'No archived tasks found' },
    };
  }

  const tasks = toAnalyticsTasks(data.archivedTasks);
  const filtered = filterByDate(tasks, opts.since, opts.until);

  let reportData: ArchiveReportDataMap[ArchiveReportType];
  switch (reportType) {
    case 'summary':
      reportData = summaryReport(filtered);
      break;
    case 'by-phase':
      reportData = byPhaseReport(filtered);
      break;
    case 'by-label':
      reportData = byLabelReport(filtered);
      break;
    case 'by-priority':
      reportData = byPriorityReport(filtered);
      break;
    case 'cycle-times':
      reportData = cycleTimesReport(filtered);
      break;
    case 'trends':
      reportData = trendsReport(filtered);
      break;
    default:
      reportData = summaryReport(filtered);
  }

  return {
    report: reportType,
    filters:
      opts.since || opts.until ? { since: opts.since ?? null, until: opts.until ?? null } : null,
    data: reportData,
  };
}
