/**
 * Task staleness detection - identify tasks that haven't been updated.
 * Ported from lib/tasks/staleness.sh
 *
 * @epic T4454
 * @task T4529
 */

import type { Task } from '../../types/task.js';

/** Staleness thresholds in days. */
export interface StalenessThresholds {
  /** Days before a task is considered stale. */
  stale: number;
  /** Days before a task is critically stale. */
  critical: number;
  /** Days before a task is considered abandoned. */
  abandoned: number;
}

/** Default thresholds. */
export const DEFAULT_THRESHOLDS: StalenessThresholds = {
  stale: 7,
  critical: 14,
  abandoned: 30,
};

/** Staleness classification. */
export type StalenessLevel = 'fresh' | 'stale' | 'critical' | 'abandoned';

/** Staleness assessment for a single task. */
export interface StalenessInfo {
  taskId: string;
  level: StalenessLevel;
  daysSinceUpdate: number;
  lastActivity: string;
}

/**
 * Calculate days since a date string (ISO format).
 */
function daysSince(dateStr: string): number {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Get the most recent activity timestamp for a task.
 */
export function getLastActivity(task: Task): string {
  const dates = [
    task.updatedAt,
    task.createdAt,
    task.completedAt,
    task.cancelledAt,
  ].filter((d): d is string => d != null && d !== '');

  if (dates.length === 0) return task.createdAt;

  return dates.reduce((latest, d) =>
    new Date(d) > new Date(latest) ? d : latest,
  );
}

/**
 * Classify staleness level for a task.
 */
export function classifyStaleness(
  task: Task,
  thresholds: StalenessThresholds = DEFAULT_THRESHOLDS,
): StalenessLevel {
  // Completed/cancelled tasks are never stale
  if (task.status === 'done' || task.status === 'cancelled') return 'fresh';

  const lastActivity = getLastActivity(task);
  const days = daysSince(lastActivity);

  if (days >= thresholds.abandoned) return 'abandoned';
  if (days >= thresholds.critical) return 'critical';
  if (days >= thresholds.stale) return 'stale';
  return 'fresh';
}

/**
 * Get staleness info for a single task.
 */
export function getStalenessInfo(
  task: Task,
  thresholds?: StalenessThresholds,
): StalenessInfo {
  const lastActivity = getLastActivity(task);
  return {
    taskId: task.id,
    level: classifyStaleness(task, thresholds),
    daysSinceUpdate: daysSince(lastActivity),
    lastActivity,
  };
}

/**
 * Find all stale tasks (stale, critical, or abandoned).
 */
export function findStaleTasks(
  tasks: Task[],
  thresholds?: StalenessThresholds,
): StalenessInfo[] {
  return tasks
    .filter((t) => t.status !== 'done' && t.status !== 'cancelled')
    .map((t) => getStalenessInfo(t, thresholds))
    .filter((info) => info.level !== 'fresh')
    .sort((a, b) => b.daysSinceUpdate - a.daysSinceUpdate);
}

/**
 * Get staleness summary statistics.
 */
export interface StalenessSummary {
  total: number;
  fresh: number;
  stale: number;
  critical: number;
  abandoned: number;
}

export function getStalenessSummary(
  tasks: Task[],
  thresholds?: StalenessThresholds,
): StalenessSummary {
  const activeTasks = tasks.filter(
    (t) => t.status !== 'done' && t.status !== 'cancelled',
  );

  const summary: StalenessSummary = {
    total: activeTasks.length,
    fresh: 0,
    stale: 0,
    critical: 0,
    abandoned: 0,
  };

  for (const task of activeTasks) {
    const level = classifyStaleness(task, thresholds);
    summary[level]++;
  }

  return summary;
}
