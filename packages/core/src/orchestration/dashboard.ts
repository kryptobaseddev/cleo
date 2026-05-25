/**
 * Multi-agent orchestration dashboard metrics (T10461-T10464).
 *
 * Read-only aggregation over the existing task store, worktree list, and audit
 * JSONL files. This module intentionally does not introduce a new dashboard
 * persistence layer: every value is derived from existing SSoTs at call time.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import type { DataAccessor } from '../store/data-accessor.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { getForceBypassPath } from '../tasks/gate-audit.js';
import { WORKTREE_LIFECYCLE_AUDIT_FILE } from '../worktree/audit.js';
import { listWorktrees } from '../worktree/list.js';

/** Observation window used for audit-derived rates. */
export const DASHBOARD_RATE_WINDOW_HOURS = 24;

export interface DashboardRateMetric {
  count: number;
  perHour: number;
  windowHours: number;
}

export interface OrchestrateDashboardMetrics {
  generatedAt: string;
  projectRoot: string;
  queueDepth: number;
  queue: {
    ready: number;
    pending: number;
    active: number;
    blocked: number;
  };
  adminMergeRate: DashboardRateMetric;
  forceBypassRate: DashboardRateMetric;
  activeWorktreeCount: number;
  worktrees: {
    total: number;
    active: number;
    locked: number;
    stale: number;
    orphan: number;
    merged: number;
  };
}

export interface CollectDashboardOptions {
  accessor?: DataAccessor;
  now?: Date;
  rateWindowHours?: number;
  /** Test hook: skip git worktree enumeration and use these status categories. */
  worktreeStatusCategories?: readonly string[];
}

/**
 * Collect the compact observability dashboard for parallel orchestrators.
 */
export async function collectOrchestrateDashboard(
  projectRoot: string,
  options: CollectDashboardOptions = {},
): Promise<OrchestrateDashboardMetrics> {
  const now = options.now ?? new Date();
  const windowHours = options.rateWindowHours ?? DASHBOARD_RATE_WINDOW_HOURS;
  const accessor = options.accessor ?? (await getTaskAccessor(projectRoot));
  const { tasks } = await accessor.queryTasks({});

  const queue = summarizeQueue(tasks);
  const worktreeCategories =
    options.worktreeStatusCategories ?? (await collectWorktreeStatusCategories(projectRoot));
  const worktrees = summarizeWorktrees(worktreeCategories);
  const [adminMergeRate, forceBypassRate] = await Promise.all([
    countJsonlEvents(
      join(projectRoot, WORKTREE_LIFECYCLE_AUDIT_FILE),
      now,
      windowHours,
      (record) =>
        record['success'] === true &&
        (record['action'] === 'complete' || record['action'] === 'complete-skip'),
    ),
    countJsonlEvents(getForceBypassPath(projectRoot), now, windowHours, () => true),
  ]);

  return {
    generatedAt: now.toISOString(),
    projectRoot,
    queueDepth: queue.ready,
    queue,
    adminMergeRate,
    forceBypassRate,
    activeWorktreeCount: worktrees.active,
    worktrees,
  };
}

/** One-line summary safe for spawn-prompt injection. */
export function formatDashboardPromptSummary(metrics: OrchestrateDashboardMetrics): string {
  return `queue=${metrics.queueDepth} ready / ${metrics.queue.active} active; worktrees=${metrics.activeWorktreeCount} active; adminMerge=${formatRate(metrics.adminMergeRate)}/h; forceBypass=${formatRate(metrics.forceBypassRate)}/h (${metrics.forceBypassRate.windowHours}h)`;
}

function summarizeQueue(tasks: Task[]): OrchestrateDashboardMetrics['queue'] {
  const done = new Set(
    tasks
      .filter((task) => task.status === 'done' || task.status === 'cancelled')
      .map((task) => task.id),
  );
  let ready = 0;
  let pending = 0;
  let active = 0;
  let blocked = 0;

  for (const task of tasks) {
    if (task.status === 'active') active += 1;
    if (task.status === 'blocked') blocked += 1;
    if (task.status !== 'pending') continue;
    pending += 1;
    const deps = task.depends ?? [];
    if (deps.every((dep) => done.has(dep))) ready += 1;
  }

  return { ready, pending, active, blocked };
}

async function collectWorktreeStatusCategories(projectRoot: string): Promise<readonly string[]> {
  const result = await listWorktrees({ projectRoot });
  if (!result.success) return [];
  return result.data.worktrees.map((worktree) => worktree.statusCategory);
}

function summarizeWorktrees(
  categories: readonly string[],
): OrchestrateDashboardMetrics['worktrees'] {
  const counts = { total: categories.length, active: 0, locked: 0, stale: 0, orphan: 0, merged: 0 };
  for (const category of categories) {
    if (category === 'active') counts.active += 1;
    else if (category === 'locked') counts.locked += 1;
    else if (category === 'stale') counts.stale += 1;
    else if (category === 'orphan') counts.orphan += 1;
    else if (category === 'merged') counts.merged += 1;
  }
  return counts;
}

async function countJsonlEvents(
  path: string,
  now: Date,
  windowHours: number,
  predicate: (record: Record<string, unknown>) => boolean,
): Promise<DashboardRateMetric> {
  let text = '';
  try {
    text = await readFile(path, 'utf-8');
  } catch {
    return { count: 0, perHour: 0, windowHours };
  }

  const minMs = now.getTime() - windowHours * 60 * 60 * 1000;
  let count = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      const timestamp =
        typeof record['timestamp'] === 'string' ? Date.parse(record['timestamp']) : NaN;
      if (Number.isNaN(timestamp) || timestamp < minMs || timestamp > now.getTime()) continue;
      if (predicate(record)) count += 1;
    } catch {
      // Ignore malformed audit lines; dashboard aggregation must be best-effort.
    }
  }
  return { count, perHour: roundRate(count / windowHours), windowHours };
}

function formatRate(rate: DashboardRateMetric): string {
  return rate.perHour.toFixed(2).replace(/\.00$/, '');
}

function roundRate(value: number): number {
  return Math.round(value * 100) / 100;
}
