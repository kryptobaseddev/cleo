/**
 * Statistics and analytics core module.
 * @task T4535
 * @epic T4454
 */

import { readJson } from '../../store/json.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { getTaskPath } from '../paths.js';
import type { TaskFile } from '../../types/task.js';
import type { DataAccessor } from '../../store/data-accessor.js';

/** Minimal audit row for stats queries. */
interface AuditRow {
  action: string;
  timestamp: string;
  afterStatus?: string;
}

/**
 * Query audit_log entries from SQLite.
 * Returns a flat array of rows with action, timestamp, and parsed after-status.
 * @task T5338
 */
async function queryAuditEntries(cwd?: string): Promise<AuditRow[]> {
  try {
    const { getDb } = await import('../../store/sqlite.js');
    const { auditLog } = await import('../../store/schema.js');
    const db = await getDb(cwd ?? process.cwd());
    const rows = await db
      .select({
        action: auditLog.action,
        timestamp: auditLog.timestamp,
        afterJson: auditLog.afterJson,
      })
      .from(auditLog)
      .orderBy(auditLog.timestamp);

    return rows.map(r => {
      let afterStatus: string | undefined;
      if (r.afterJson) {
        try {
          const after = JSON.parse(r.afterJson);
          afterStatus = after?.status;
        } catch { /* skip malformed */ }
      }
      return { action: r.action, timestamp: r.timestamp, afterStatus };
    });
  } catch {
    return [];
  }
}

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
}, accessor?: DataAccessor): Promise<Record<string, unknown>> {
  const periodDays = resolvePeriod(opts.period ?? '30');
  const data = accessor
    ? await accessor.loadTaskFile()
    : await readJson<TaskFile>(getTaskPath(opts.cwd));
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

  // Read audit entries from SQLite audit_log (ADR-024, T5338)
  const entries = await queryAuditEntries(opts.cwd);

  const isCreate = (e: AuditRow) => e.action === 'task_created' || e.action === 'add';
  const isComplete = (e: AuditRow) =>
    e.action === 'task_completed' || e.action === 'complete' ||
    (e.action === 'status_changed' && e.afterStatus === 'done');
  const isArchive = (e: AuditRow) => e.action === 'task_archived' || e.action === 'archive';

  const createdInPeriod = entries.filter(
    (e) => isCreate(e) && e.timestamp >= cutoff,
  ).length;
  const completedInPeriod = entries.filter(
    (e) => isComplete(e) && e.timestamp >= cutoff,
  ).length;
  const archivedInPeriod = entries.filter(
    (e) => isArchive(e) && e.timestamp >= cutoff,
  ).length;

  const completionRate = createdInPeriod > 0
    ? Math.round((completedInPeriod / createdInPeriod) * 10000) / 100
    : 0;

  // All-time from audit_log
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
}, accessor?: DataAccessor): Promise<Record<string, unknown>> {
  const data = accessor
    ? await accessor.loadTaskFile()
    : await readJson<TaskFile>(getTaskPath(opts.cwd));
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
  const allEntries = await queryAuditEntries(opts.cwd);

  const days = opts.days ?? 30;
  const cutoff = opts.since ?? new Date(Date.now() - days * 86400000).toISOString();
  const endDate = opts.until ?? new Date().toISOString();

  const completions = allEntries.filter(
    (e) => (e.action === 'task_completed' || e.action === 'complete' ||
            (e.action === 'status_changed' && e.afterStatus === 'done'))
      && e.timestamp >= cutoff
      && e.timestamp <= endDate,
  );

  // Group by date
  const byDate: Record<string, number> = {};
  for (const c of completions) {
    const date = c.timestamp.split('T')[0]!;
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
