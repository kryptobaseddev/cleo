/**
 * CLI archive-stats command - analytics and insights from archived tasks.
 * Provides cycle time analysis, trend reporting, phase/label breakdowns.
 *
 * @task T4555
 * @epic T4545
 */

import { Command } from 'commander';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';
import { getAccessor } from '../../store/data-accessor.js';

/** Archived task shape (subset of fields used for stats). */
interface ArchivedTask {
  id: string;
  title: string;
  status: string;
  priority?: string;
  phase?: string;
  labels?: string[];
  _archive?: {
    archivedAt?: string;
    cycleTimeDays?: number;
    archiveSource?: string;
  };
}

type ReportType = 'summary' | 'by-phase' | 'by-label' | 'by-priority' | 'cycle-times' | 'trends';

/**
 * Filter tasks by date range on archivedAt.
 * @task T4555
 */
function filterByDate(
  tasks: ArchivedTask[],
  since?: string,
  until?: string,
): ArchivedTask[] {
  let filtered = tasks;
  if (since) {
    const sinceDate = since.includes('T') ? since : `${since}T00:00:00Z`;
    filtered = filtered.filter(t => (t._archive?.archivedAt ?? '') >= sinceDate);
  }
  if (until) {
    const untilDate = until.includes('T') ? until : `${until}T23:59:59Z`;
    filtered = filtered.filter(t => (t._archive?.archivedAt ?? '') <= untilDate);
  }
  return filtered;
}

/**
 * Generate summary statistics.
 * @task T4555
 */
function summaryReport(tasks: ArchivedTask[]): Record<string, unknown> {
  const byStatus: Record<string, number> = {};
  const byPriority: Record<string, number> = {};
  const sourceBreakdown: Record<string, number> = {};
  const cycleTimes: number[] = [];

  for (const t of tasks) {
    byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
    const prio = t.priority ?? 'unset';
    byPriority[prio] = (byPriority[prio] ?? 0) + 1;
    const src = t._archive?.archiveSource ?? 'unknown';
    sourceBreakdown[src] = (sourceBreakdown[src] ?? 0) + 1;
    if (t._archive?.cycleTimeDays != null) {
      cycleTimes.push(t._archive.cycleTimeDays);
    }
  }

  const sorted = tasks
    .filter(t => t._archive?.archivedAt)
    .sort((a, b) => (a._archive!.archivedAt!).localeCompare(b._archive!.archivedAt!));

  return {
    totalArchived: tasks.length,
    byStatus,
    byPriority,
    averageCycleTime: cycleTimes.length > 0
      ? Math.round((cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length) * 100) / 100
      : null,
    oldestArchived: sorted[0]?._archive?.archivedAt ?? null,
    newestArchived: sorted[sorted.length - 1]?._archive?.archivedAt ?? null,
    archiveSourceBreakdown: sourceBreakdown,
  };
}

/**
 * Group tasks by phase with cycle time averages.
 * @task T4555
 */
function byPhaseReport(tasks: ArchivedTask[]): Array<Record<string, unknown>> {
  const groups: Record<string, ArchivedTask[]> = {};
  for (const t of tasks) {
    const phase = t.phase ?? 'unassigned';
    if (!groups[phase]) groups[phase] = [];
    groups[phase]!.push(t);
  }
  return Object.entries(groups)
    .map(([phase, items]) => {
      const cycles = items
        .map(t => t._archive?.cycleTimeDays)
        .filter((c): c is number => c != null);
      return {
        phase,
        count: items.length,
        avgCycleTime: cycles.length > 0
          ? Math.round((cycles.reduce((a, b) => a + b, 0) / cycles.length) * 100) / 100
          : null,
      };
    })
    .sort((a, b) => b.count - a.count);
}

/**
 * Group tasks by label frequency.
 * @task T4555
 */
function byLabelReport(tasks: ArchivedTask[]): Array<{ label: string; count: number }> {
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

/**
 * Group tasks by priority.
 * @task T4555
 */
function byPriorityReport(tasks: ArchivedTask[]): Array<Record<string, unknown>> {
  const PRIO_ORDER = ['critical', 'high', 'medium', 'low', 'unset'];
  const groups: Record<string, ArchivedTask[]> = {};
  for (const t of tasks) {
    const prio = t.priority ?? 'unset';
    if (!groups[prio]) groups[prio] = [];
    groups[prio]!.push(t);
  }
  return Object.entries(groups)
    .map(([priority, items]) => {
      const cycles = items
        .map(t => t._archive?.cycleTimeDays)
        .filter((c): c is number => c != null);
      return {
        priority,
        count: items.length,
        avgCycleTime: cycles.length > 0
          ? Math.round((cycles.reduce((a, b) => a + b, 0) / cycles.length) * 100) / 100
          : null,
      };
    })
    .sort((a, b) => PRIO_ORDER.indexOf(a.priority as string) - PRIO_ORDER.indexOf(b.priority as string));
}

/**
 * Compute cycle time statistics with distribution buckets.
 * @task T4555
 */
function cycleTimesReport(tasks: ArchivedTask[]): Record<string, unknown> {
  const times = tasks
    .map(t => t._archive?.cycleTimeDays)
    .filter((c): c is number => c != null)
    .sort((a, b) => a - b);

  if (times.length === 0) {
    return {
      count: 0, min: null, max: null, avg: null, median: null,
      distribution: { '0-1 days': 0, '2-7 days': 0, '8-30 days': 0, '30+ days': 0 },
    };
  }

  const median = times.length % 2 === 0
    ? (times[times.length / 2 - 1]! + times[times.length / 2]!) / 2
    : times[Math.floor(times.length / 2)]!;

  const percentile = (p: number) => times[Math.floor(times.length * p)] ?? null;

  return {
    count: times.length,
    min: times[0],
    max: times[times.length - 1],
    avg: Math.round((times.reduce((a, b) => a + b, 0) / times.length) * 100) / 100,
    median,
    distribution: {
      '0-1 days': times.filter(t => t <= 1).length,
      '2-7 days': times.filter(t => t > 1 && t <= 7).length,
      '8-30 days': times.filter(t => t > 7 && t <= 30).length,
      '30+ days': times.filter(t => t > 30).length,
    },
    percentiles: {
      p25: percentile(0.25),
      p50: percentile(0.50),
      p75: percentile(0.75),
      p90: percentile(0.90),
    },
  };
}

/**
 * Compute archive trends by day and month.
 * @task T4555
 */
function trendsReport(tasks: ArchivedTask[]): Record<string, unknown> {
  const withDate = tasks.filter(t => t._archive?.archivedAt);
  const byDay: Record<string, number> = {};
  for (const t of withDate) {
    const date = t._archive!.archivedAt!.slice(0, 10);
    byDay[date] = (byDay[date] ?? 0) + 1;
  }
  const dailyEntries = Object.entries(byDay)
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const byMonth: Record<string, number> = {};
  for (const { date, count } of dailyEntries) {
    const month = date.slice(0, 7);
    byMonth[month] = (byMonth[month] ?? 0) + count;
  }
  const monthlyEntries = Object.entries(byMonth)
    .map(([month, count]) => ({ month, count }));

  const totalPeriod = dailyEntries.reduce((sum, d) => sum + d.count, 0);

  return {
    byDay: dailyEntries,
    byMonth: monthlyEntries,
    totalPeriod,
    averagePerDay: dailyEntries.length > 0
      ? Math.round((totalPeriod / dailyEntries.length) * 100) / 100
      : 0,
  };
}

/**
 * Get archive statistics data.
 * @task T4555
 */
export async function getArchiveStats(opts: {
  report?: ReportType;
  since?: string;
  until?: string;
  cwd?: string;
}): Promise<Record<string, unknown>> {
  const accessor = await getAccessor(opts.cwd);
  const data = await accessor.loadArchive();

  if (!data || !data.archivedTasks?.length) {
    return {
      report: opts.report ?? 'summary',
      data: { totalArchived: 0, message: 'No archived tasks found' },
    };
  }

  const tasks = data.archivedTasks as unknown as ArchivedTask[];
  const filtered = filterByDate(tasks, opts.since, opts.until);
  const reportType = opts.report ?? 'summary';

  let reportData: unknown;
  switch (reportType) {
    case 'summary':      reportData = summaryReport(filtered); break;
    case 'by-phase':     reportData = byPhaseReport(filtered); break;
    case 'by-label':     reportData = byLabelReport(filtered); break;
    case 'by-priority':  reportData = byPriorityReport(filtered); break;
    case 'cycle-times':  reportData = cycleTimesReport(filtered); break;
    case 'trends':       reportData = trendsReport(filtered); break;
    default:             reportData = summaryReport(filtered);
  }

  return {
    report: reportType,
    filters: (opts.since || opts.until) ? { since: opts.since ?? null, until: opts.until ?? null } : null,
    data: reportData,
  };
}

/**
 * Register the archive-stats command.
 * @task T4555
 */
export function registerArchiveStatsCommand(program: Command): void {
  program
    .command('archive-stats')
    .description('Generate analytics and insights from archived tasks')
    .option('--summary', 'Overview statistics (default)')
    .option('--by-phase', 'Breakdown by project phase')
    .option('--by-label', 'Breakdown by label')
    .option('--by-priority', 'Breakdown by priority')
    .option('--cycle-times', 'Analyze task completion cycle times')
    .option('--trends', 'Show archiving trends over time')
    .option('--since <date>', 'Only include tasks archived since DATE (YYYY-MM-DD)')
    .option('--until <date>', 'Only include tasks archived until DATE (YYYY-MM-DD)')
    .action(async (opts: Record<string, unknown>) => {
      try {
        let report: ReportType = 'summary';
        if (opts['byPhase']) report = 'by-phase';
        else if (opts['byLabel']) report = 'by-label';
        else if (opts['byPriority']) report = 'by-priority';
        else if (opts['cycleTimes']) report = 'cycle-times';
        else if (opts['trends']) report = 'trends';

        const result = await getArchiveStats({
          report,
          since: opts['since'] as string | undefined,
          until: opts['until'] as string | undefined,
        });
        console.log(formatSuccess(result));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
