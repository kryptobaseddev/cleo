/**
 * Statistics and analytics core module.
 * @task T4535
 * @epic T4454
 */

import type { Task, TaskRecord } from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts';
import { CleoError } from '../errors.js';
import { getProjectInfoSync } from '../project-info.js';
import type { DataAccessor } from '../store/data-accessor.js';
import { getAccessor } from '../store/data-accessor.js';

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
    const { getDb } = await import('../store/sqlite.js');
    const { auditLog } = await import('../store/tasks-schema.js');
    const db = await getDb(cwd ?? process.cwd());
    const rows = await db
      .select({
        action: auditLog.action,
        timestamp: auditLog.timestamp,
        afterJson: auditLog.afterJson,
      })
      .from(auditLog)
      .orderBy(auditLog.timestamp);

    return rows.map((r) => {
      let afterStatus: string | undefined;
      if (r.afterJson) {
        try {
          const after = JSON.parse(r.afterJson);
          afterStatus = after?.status;
        } catch {
          /* skip malformed */
        }
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
    today: 1,
    t: 1,
    week: 7,
    w: 7,
    month: 30,
    m: 30,
    quarter: 90,
    q: 90,
    year: 365,
    y: 365,
  };
  const resolved = aliases[period];
  if (resolved) return resolved;
  const num = parseInt(period, 10);
  if (Number.isNaN(num) || num <= 0) {
    throw new CleoError(ExitCode.INVALID_INPUT, `Invalid period: ${period}`);
  }
  return num;
}

/** Get project statistics. */
export async function getProjectStats(
  opts: {
    period?: string;
    verbose?: boolean;
    cwd?: string;
  },
  accessor?: DataAccessor,
): Promise<Record<string, unknown>> {
  const periodDays = resolvePeriod(opts.period ?? '30');
  const acc = accessor ?? (await getAccessor(opts.cwd));
  const { tasks } = await acc.queryTasks({});
  const pending = tasks.filter((t) => t.status === 'pending').length;
  const active = tasks.filter((t) => t.status === 'active').length;
  const done = tasks.filter((t) => t.status === 'done').length;
  const blocked = tasks.filter((t) => t.status === 'blocked').length;
  const cancelled = tasks.filter((t) => t.status === 'cancelled').length;
  const totalActive = tasks.length;

  const cutoff = new Date(Date.now() - periodDays * 86400000).toISOString();

  // Read audit entries from SQLite audit_log (ADR-024, T5338)
  const entries = await queryAuditEntries(opts.cwd);

  const isCreate = (e: AuditRow) => e.action === 'task_created' || e.action === 'add';
  const isComplete = (e: AuditRow) =>
    e.action === 'task_completed' ||
    e.action === 'complete' ||
    (e.action === 'status_changed' && e.afterStatus === 'done');
  const isArchive = (e: AuditRow) => e.action === 'task_archived' || e.action === 'archive';

  const createdInPeriod = entries.filter((e) => isCreate(e) && e.timestamp >= cutoff).length;
  const completedInPeriod = entries.filter((e) => isComplete(e) && e.timestamp >= cutoff).length;
  const archivedInPeriod = entries.filter((e) => isArchive(e) && e.timestamp >= cutoff).length;

  const completionRate =
    createdInPeriod > 0 ? Math.round((completedInPeriod / createdInPeriod) * 10000) / 100 : 0;

  // All-time from direct DB counts (audit_log is incomplete — started after task creation history)
  let totalCreated = 0;
  let totalCompleted = 0;
  let totalCancelled = 0;
  let totalArchived = 0;
  let archivedCompleted = 0;
  let archivedCount = 0;
  try {
    const { getDb } = await import('../store/sqlite.js');
    const { count: dbCount, eq: dbEq, and: dbAnd } = await import('drizzle-orm');
    const { tasks: tasksTable } = await import('../store/tasks-schema.js');
    const db = await getDb(opts.cwd);
    const statusRows = await db
      .select({ status: tasksTable.status, c: dbCount() })
      .from(tasksTable)
      .groupBy(tasksTable.status)
      .all();
    const statusMap: Record<string, number> = {};
    for (const row of statusRows) {
      statusMap[row.status] = row.c;
    }
    archivedCount = statusMap['archived'] ?? 0;
    totalCreated = Object.values(statusMap).reduce((sum, n) => sum + n, 0);
    totalCancelled = statusMap['cancelled'] ?? 0;
    totalArchived = archivedCount;

    // Count archived tasks that were completed (archiveReason = 'completed')
    const archivedDoneRow = await db
      .select({ c: dbCount() })
      .from(tasksTable)
      .where(
        dbAnd(dbEq(tasksTable.status, 'archived'), dbEq(tasksTable.archiveReason, 'completed')),
      )
      .get();
    archivedCompleted = archivedDoneRow?.c ?? 0;
    // totalCompleted: use audit log as SSoT (same source as completedInPeriod) to ensure
    // the two metrics are consistent. DB-based status counts under-count because they miss
    // tasks that were completed then cancelled, deleted, or archived with a non-default reason.
    totalCompleted = entries.filter(isComplete).length;
  } catch {
    // fallback to audit_log counts if DB unavailable
    totalCreated = entries.filter(isCreate).length;
    totalCompleted = entries.filter(isComplete).length;
    totalArchived = entries.filter(isArchive).length;
  }

  return {
    currentState: {
      pending,
      active,
      done,
      blocked,
      cancelled,
      totalActive,
      archived: archivedCount,
      grandTotal: totalActive + archivedCount,
    },
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
    allTime: { totalCreated, totalCompleted, totalCancelled, totalArchived, archivedCompleted },
  };
}

/** Priority numeric weights for ranking blocked tasks. */
const PRIORITY_WEIGHT: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

/** Labels that add urgency boost to blocked task ranking. */
const URGENT_LABELS = new Set(['critical', 'blocker', 'bug']);

/**
 * Compute a ranking score for a blocked task.
 * Higher score = more urgent = sort first.
 */
export function rankBlockedTask(task: Task, allTasks: Task[], focusTask: Task | null): number {
  let score = 0;

  // (1) Priority weight: 10-40 points
  score += (PRIORITY_WEIGHT[task.priority ?? 'low'] ?? 1) * 10;

  // (2) Downstream impact: tasks whose depends array includes this task's id
  const downstreamCount = allTasks.filter(
    (t) => t.status !== 'done' && (t.depends ?? []).includes(task.id),
  ).length;
  score += downstreamCount * 5;

  // (3) Age weight: capped at 30 days, 1 point per day
  const ageMs = Date.now() - new Date(task.createdAt).getTime();
  const ageDays = Math.min(Math.floor(ageMs / 86_400_000), 30);
  score += ageDays;

  // (4) Focus proximity boost (+15 if sibling/parent/child of focused task)
  if (focusTask) {
    const isFocusChild = task.parentId != null && task.parentId === focusTask.id;
    const isFocusParent = focusTask.parentId != null && task.id === focusTask.parentId;
    const isFocusSibling = task.parentId != null && task.parentId === focusTask.parentId;
    if (isFocusChild || isFocusParent || isFocusSibling) {
      score += 15;
    }
  }

  // (5) Urgent label boost: +8 per urgent label
  for (const label of task.labels ?? []) {
    if (URGENT_LABELS.has(label.toLowerCase())) {
      score += 8;
    }
  }

  // (6) Staleness penalty: recently updated (< 3 days ago) may be actively worked
  if (task.updatedAt) {
    const updatedDaysAgo = (Date.now() - new Date(task.updatedAt).getTime()) / 86_400_000;
    if (updatedDaysAgo < 3) {
      score -= 10;
    }
  }

  return score;
}

/** Priority sort order (lower number = higher priority = sort first). */
const PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** Get project dashboard data. */
export async function getDashboard(
  opts: {
    compact?: boolean;
    period?: number;
    showCharts?: boolean;
    sections?: string[];
    verbose?: boolean;
    quiet?: boolean;
    cwd?: string;
    blockedTasksLimit?: number;
  },
  accessor?: DataAccessor,
): Promise<Record<string, unknown>> {
  const acc = accessor ?? (await getAccessor(opts.cwd));
  const { tasks } = await acc.queryTasks({});

  const pending = tasks.filter((t) => t.status === 'pending').length;
  const active = tasks.filter((t) => t.status === 'active').length;
  const done = tasks.filter((t) => t.status === 'done').length;
  const blocked = tasks.filter((t) => t.status === 'blocked').length;
  const cancelled = tasks.filter((t) => t.status === 'cancelled').length;
  const total = tasks.length;

  // Query archived count directly from DB (loadTaskFile excludes archived rows)
  let archived = 0;
  try {
    const { getDb } = await import('../store/sqlite.js');
    const { count: dbCount, eq: dbEq } = await import('drizzle-orm');
    const { tasks: tasksTable } = await import('../store/tasks-schema.js');
    const db = await getDb(opts.cwd);
    const row = await db
      .select({ c: dbCount() })
      .from(tasksTable)
      .where(dbEq(tasksTable.status, 'archived'))
      .get();
    archived = row?.c ?? 0;
  } catch {
    // archived count unavailable; grandTotal will equal total
  }

  const meta = await acc.getMetaValue<import('@cleocode/contracts').ProjectMeta>('project_meta');
  // Fall back to the legacy 'project' key, then to the directory name from project-info.json
  const legacyMeta = meta
    ? null
    : await acc.getMetaValue<{ name?: string; currentPhase?: string }>('project');
  const resolvedName =
    meta?.name ?? legacyMeta?.name ?? getProjectInfoSync(opts.cwd)?.projectName ?? null;
  const project = resolvedName ?? 'Unknown Project';
  const currentPhase = meta?.currentPhase ?? legacyMeta?.currentPhase ?? null;

  const focus = await acc.getMetaValue<import('@cleocode/contracts').TaskWorkState>('focus_state');
  const focusId = focus?.currentTask ?? null;
  let focusTask: Task | null = null;
  if (focusId) {
    focusTask = tasks.find((t) => t.id === focusId) ?? null;
  }

  const highPriority = tasks
    .filter(
      (t) =>
        (t.priority === 'critical' || t.priority === 'high') &&
        t.status !== 'done' &&
        t.status !== 'cancelled' &&
        !t.cancelledAt,
    )
    .sort((a, b) => {
      const pDiff =
        (PRIORITY_ORDER[a.priority ?? 'low'] ?? 9) - (PRIORITY_ORDER[b.priority ?? 'low'] ?? 9);
      if (pDiff !== 0) return pDiff;
      return (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
    });

  const blockedTasksLimitVal = opts.blockedTasksLimit ?? 10;
  const allBlockedTasks = tasks.filter((t) => t.status === 'blocked');
  const rankedBlocked = allBlockedTasks
    .map((t) => ({ task: t, score: rankBlockedTask(t, tasks, focusTask) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (a.task.createdAt ?? '').localeCompare(b.task.createdAt ?? '');
    })
    .map((r) => r.task);

  // Label aggregation (active tasks only — exclude cancelled)
  const labelMap: Record<string, number> = {};
  for (const t of tasks) {
    if (t.status === 'cancelled') continue;
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
    summary: {
      pending,
      active,
      blocked,
      done,
      cancelled,
      total,
      archived,
      grandTotal: total + archived,
    },
    focus: { currentTask: focusId, task: focusTask },
    highPriority: { count: highPriority.length, tasks: highPriority.slice(0, 5) },
    blockedTasks: {
      count: rankedBlocked.length,
      limit: blockedTasksLimitVal,
      tasks: rankedBlocked.slice(0, blockedTasksLimitVal),
    },
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
    (e) =>
      (e.action === 'task_completed' ||
        e.action === 'complete' ||
        (e.action === 'status_changed' && e.afterStatus === 'done')) &&
      e.timestamp >= cutoff &&
      e.timestamp <= endDate,
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
  const peakDay = dailyCounts.reduce((max, d) => (d.count > max.count ? d : max), {
    date: '',
    count: 0,
  });

  return {
    period: { days, since: cutoff, until: endDate },
    totalCompletions,
    avgPerDay,
    peakDay,
    dailyCounts,
  };
}

// Re-export workflow telemetry (T065)
export {
  getWorkflowComplianceReport,
  type WorkflowComplianceReport,
  type WorkflowRuleMetric,
} from './workflow-telemetry.js';

/**
 * Dashboard data shape for the system dash command.
 *
 * @task T1571
 */
export interface DashboardData {
  /** Project name or directory basename. */
  project: string;
  /** Currently active project phase, or null. */
  currentPhase: string | null;
  /** Task count breakdown by status. */
  summary: {
    pending: number;
    active: number;
    blocked: number;
    done: number;
    cancelled: number;
    total: number;
    archived: number;
    grandTotal: number;
  };
  /** Currently focused task work state. */
  taskWork: {
    currentTask: string | null;
    task: TaskRecord | null;
  };
  /** Active session ID, or null. */
  activeSession: string | null;
  /** High-priority tasks summary. */
  highPriority: { count: number; tasks: TaskRecord[] };
  /** Blocked tasks summary. */
  blockedTasks: {
    count: number;
    limit: number;
    tasks: TaskRecord[];
  };
  /** Recently completed task records. */
  recentCompletions: TaskRecord[];
  /** Most frequently used labels with counts. */
  topLabels: Array<{ label: string; count: number }>;
}

/**
 * Project statistics data shape including extended breakdowns.
 *
 * @task T1571
 */
export interface StatsData {
  /** Current task counts by status. */
  currentState: {
    pending: number;
    active: number;
    done: number;
    blocked: number;
    cancelled: number;
    totalActive: number;
    archived: number;
    grandTotal: number;
  };
  /** Task counts grouped by priority level. */
  byPriority: Record<string, number>;
  /** Task counts grouped by task type. */
  byType: Record<string, number>;
  /** Task counts grouped by project phase (pipelineStage). */
  byPhase: Record<string, number>;
  /** Completion rate metrics over the configured period. */
  completionMetrics: {
    periodDays: number;
    completedInPeriod: number;
    createdInPeriod: number;
    completionRate: number;
  };
  /** Activity metrics over the configured period. */
  activityMetrics: {
    createdInPeriod: number;
    completedInPeriod: number;
    archivedInPeriod: number;
  };
  /** Lifetime metrics across all time. */
  allTime: {
    totalCreated: number;
    totalCompleted: number;
    totalCancelled: number;
    totalArchived: number;
    archivedCompleted: number;
  };
  /** Average time from creation to completion. */
  cycleTimes: {
    averageDays: number | null;
    samples: number;
  };
}

/**
 * Get extended project statistics including breakdowns by priority, type, phase,
 * and cycle time computation.
 *
 * Extends `getProjectStats` with the additional fields that system-engine.ts
 * computed via accessor queries. Moving this logic into core ensures a single
 * source of truth for stats computation.
 *
 * @param cwd - Absolute path to the project root
 * @param params - Optional period and accessor
 * @param accessor - Optional pre-opened DataAccessor
 * @returns Extended stats data
 *
 * @task T1571
 */
export async function getProjectStatsExtended(
  cwd: string,
  params?: { period?: number },
  accessor?: DataAccessor,
): Promise<StatsData> {
  const acc = accessor ?? (await getAccessor(cwd));
  const coreResult = await getProjectStats({ period: String(params?.period ?? 30), cwd }, acc);

  const queryResult = await acc.queryTasks({});
  const tasks = (queryResult?.tasks as Task[]) ?? [];

  const activeTasks = tasks.filter((t) => t.status !== 'cancelled');
  const byPriority: Record<string, number> = {};
  for (const t of activeTasks) {
    byPriority[t.priority] = (byPriority[t.priority] ?? 0) + 1;
  }
  const byType: Record<string, number> = {};
  for (const t of activeTasks) {
    const ttype = t.type ?? 'task';
    byType[ttype] = (byType[ttype] ?? 0) + 1;
  }
  const byPhase: Record<string, number> = {};
  for (const t of activeTasks) {
    const phase = t.pipelineStage ?? 'unassigned';
    byPhase[phase] = (byPhase[phase] ?? 0) + 1;
  }

  const completedTasks = tasks.filter((t) => t.status === 'done' && t.completedAt && t.createdAt);
  let totalCycleDays = 0;
  let samples = 0;
  for (const t of completedTasks) {
    const created = new Date(t.createdAt).getTime();
    const completed = new Date(t.completedAt!).getTime();
    if (completed > created) {
      totalCycleDays += (completed - created) / 86400000;
      samples++;
    }
  }
  const averageDays = samples > 0 ? Math.round((totalCycleDays / samples) * 100) / 100 : null;

  const coreData = coreResult as Record<string, unknown>;
  const currentState = coreData.currentState as Record<string, number>;
  const completionMetrics = coreData.completionMetrics as Record<string, number>;
  const activityMetrics = coreData.activityMetrics as Record<string, number>;
  const allTime = coreData.allTime as Record<string, number>;

  return {
    currentState: {
      pending: currentState.pending ?? 0,
      active: currentState.active ?? 0,
      done: currentState.done ?? 0,
      blocked: currentState.blocked ?? 0,
      cancelled: tasks.filter((t) => t.status === 'cancelled').length,
      totalActive: currentState.totalActive ?? 0,
      archived: currentState.archived ?? 0,
      grandTotal: currentState.grandTotal ?? currentState.totalActive ?? 0,
    },
    byPriority,
    byType,
    byPhase,
    completionMetrics: completionMetrics as StatsData['completionMetrics'],
    activityMetrics: activityMetrics as StatsData['activityMetrics'],
    allTime: allTime as StatsData['allTime'],
    cycleTimes: { averageDays, samples },
  };
}
