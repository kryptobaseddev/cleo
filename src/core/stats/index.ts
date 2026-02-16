/**
 * Statistics and analytics core module.
 * @task T4535
 * @epic T4454
 */

import { readJson, readLogEntries } from '../../store/json.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { getTodoPath, getLogPath } from '../paths.js';
import type { TodoFile } from '../../types/task.js';

/** Period alias resolution. */
function resolvePeriod(period: string): number {
  const aliases: Record<string, number> = {
    today: 1, t: 1,
    week: 7, w: 7,
    month: 30, m: 30,
    quarter: 90, q: 90,
    year: 365, y: 365,
  };
  const resolved = aliases[period];
  if (resolved) return resolved;
  const num = parseInt(period, 10);
  if (isNaN(num) || num <= 0) {
    throw new CleoError(ExitCode.INVALID_INPUT, `Invalid period: ${period}`);
  }
  return num;
}

/** Get project statistics. */
export async function getProjectStats(opts: {
  period?: string;
  verbose?: boolean;
  cwd?: string;
}): Promise<Record<string, unknown>> {
  const periodDays = resolvePeriod(opts.period ?? '30');
  const data = await readJson<TodoFile>(getTodoPath(opts.cwd));
  if (!data) {
    throw new CleoError(ExitCode.CONFIG_ERROR, 'Not in a CLEO project. Run cleo init first.');
  }

  const tasks = data.tasks ?? [];
  const pending = tasks.filter(t => t.status === 'pending').length;
  const active = tasks.filter(t => t.status === 'active').length;
  const done = tasks.filter(t => t.status === 'done').length;
  const blocked = tasks.filter(t => t.status === 'blocked').length;
  const totalActive = tasks.length;

  const cutoff = new Date(Date.now() - periodDays * 86400000).toISOString();

  // Read log for period metrics (handles hybrid JSON/JSONL format)
  const entries = await readLogEntries(getLogPath(opts.cwd));

  // Match both legacy (action: "task_created") and status_changed entries
  const isCreate = (e: Record<string, unknown>) => e.action === 'task_created';
  const isComplete = (e: Record<string, unknown>) =>
    e.action === 'task_completed' ||
    (e.action === 'status_changed' && (e.after as Record<string, unknown>)?.status === 'done');
  const isArchive = (e: Record<string, unknown>) => e.action === 'task_archived';

  const createdInPeriod = entries.filter(
    (e) => isCreate(e) && (e.timestamp as string) >= cutoff,
  ).length;
  const completedInPeriod = entries.filter(
    (e) => isComplete(e) && (e.timestamp as string) >= cutoff,
  ).length;
  const archivedInPeriod = entries.filter(
    (e) => isArchive(e) && (e.timestamp as string) >= cutoff,
  ).length;

  const completionRate = createdInPeriod > 0
    ? Math.round((completedInPeriod / createdInPeriod) * 10000) / 100
    : 0;

  // All-time from log
  const totalCreated = entries.filter(isCreate).length;
  const totalCompleted = entries.filter(isComplete).length;
  const totalArchived = entries.filter(isArchive).length;

  return {
    currentState: { pending, active, done, blocked, totalActive },
    completionMetrics: {
      periodDays,
      completedInPeriod,
      createdInPeriod,
      completionRate,
    },
    activityMetrics: {
      createdInPeriod,
      completedInPeriod,
      archivedInPeriod,
    },
    allTime: { totalCreated, totalCompleted, totalArchived },
  };
}

/** Get project dashboard data. */
export async function getDashboard(opts: {
  compact?: boolean;
  period?: number;
  showCharts?: boolean;
  sections?: string[];
  verbose?: boolean;
  quiet?: boolean;
  cwd?: string;
}): Promise<Record<string, unknown>> {
  const data = await readJson<TodoFile>(getTodoPath(opts.cwd));
  if (!data) {
    throw new CleoError(ExitCode.CONFIG_ERROR, 'Not in a CLEO project. Run cleo init first.');
  }

  const tasks = data.tasks ?? [];
  const pending = tasks.filter(t => t.status === 'pending').length;
  const active = tasks.filter(t => t.status === 'active').length;
  const done = tasks.filter(t => t.status === 'done').length;
  const blocked = tasks.filter(t => t.status === 'blocked').length;
  const total = tasks.length;

  const project = data.project?.name ?? 'Unknown Project';
  const currentPhase = data.project?.currentPhase ?? null;

  const focusId = data.focus?.currentTask ?? null;
  let focusTask = null;
  if (focusId) {
    focusTask = tasks.find(t => t.id === focusId) ?? null;
  }

  const highPriority = tasks.filter(
    t => (t.priority === 'critical' || t.priority === 'high') && t.status !== 'done',
  );
  const blockedTasks = tasks.filter(t => t.status === 'blocked');

  // Label aggregation
  const labelMap: Record<string, number> = {};
  for (const t of tasks) {
    for (const label of t.labels ?? []) {
      labelMap[label] = (labelMap[label] ?? 0) + 1;
    }
  }
  const topLabels = Object.entries(labelMap)
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  return {
    project,
    currentPhase,
    summary: { pending, active, blocked, done, total },
    focus: { currentTask: focusId, task: focusTask },
    highPriority: { count: highPriority.length, tasks: highPriority.slice(0, 5) },
    blockedTasks: { count: blockedTasks.length, tasks: blockedTasks },
    topLabels,
    periodDays: opts.period ?? 7,
  };
}

/** Get completion history data. */
export async function getCompletionHistory(opts: {
  days?: number;
  since?: string;
  until?: string;
  cwd?: string;
}): Promise<Record<string, unknown>> {
  const allEntries = await readLogEntries(getLogPath(opts.cwd));

  const days = opts.days ?? 30;
  const cutoff = opts.since ?? new Date(Date.now() - days * 86400000).toISOString();
  const endDate = opts.until ?? new Date().toISOString();

  const completions = allEntries.filter(
    (e) => (e.action === 'task_completed' ||
            (e.action === 'status_changed' && (e.after as Record<string, unknown>)?.status === 'done'))
      && (e.timestamp as string) >= cutoff
      && (e.timestamp as string) <= endDate,
  );

  // Group by date
  const byDate: Record<string, number> = {};
  for (const c of completions) {
    const date = (c.timestamp as string).split('T')[0]!;
    byDate[date] = (byDate[date] ?? 0) + 1;
  }

  const dailyCounts = Object.entries(byDate)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date, count }));

  const totalCompletions = completions.length;
  const avgPerDay = days > 0 ? Math.round((totalCompletions / days) * 100) / 100 : 0;
  const peakDay = dailyCounts.reduce(
    (max, d) => d.count > max.count ? d : max,
    { date: '', count: 0 },
  );

  return {
    period: { days, since: cutoff, until: endDate },
    totalCompletions,
    avgPerDay,
    peakDay,
    dailyCounts,
  };
}
