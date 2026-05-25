/**
 * Multi-agent orchestration dashboard metrics (T10461-T10464).
 *
 * Read-only aggregation over the existing task store, worktree list, and audit
 * JSONL files. This module intentionally does not introduce a new dashboard
 * persistence layer: every value is derived from existing SSoTs at call time.
 */

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Task, WorktreeInfo } from '@cleocode/contracts';
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

export interface DashboardWorktreeState {
  path: string;
  branch: string;
  taskId: string | null;
  statusCategory: string;
  isDirty: boolean;
  hasUnpushedCommits: boolean;
  isStalled: boolean;
  reasons: string[];
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
    dirty: number;
    unpushed: number;
    stalled: number;
  };
  stalledWorktrees: DashboardWorktreeState[];
}

export interface CollectDashboardOptions {
  accessor?: DataAccessor;
  now?: Date;
  rateWindowHours?: number;
  /** Test hook: skip git worktree enumeration and use these status categories. */
  worktreeStatusCategories?: readonly string[];
  /** Test hook: skip git worktree enumeration and use these full worktree states. */
  worktreeStates?: readonly DashboardWorktreeState[];
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
  const worktreeStates =
    options.worktreeStates ??
    (options.worktreeStatusCategories
      ? statesFromCategories(options.worktreeStatusCategories)
      : await collectWorktreeStates(projectRoot));
  const worktrees = summarizeWorktrees(worktreeStates);
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
    stalledWorktrees: worktreeStates.filter((worktree) => worktree.isStalled),
  };
}

/** One-line summary safe for spawn-prompt injection. */
export function formatDashboardPromptSummary(metrics: OrchestrateDashboardMetrics): string {
  return `queue=${metrics.queueDepth} ready / ${metrics.queue.active} active; worktrees=${metrics.activeWorktreeCount} active (${metrics.worktrees.stalled} stalled: ${metrics.worktrees.dirty} dirty, ${metrics.worktrees.unpushed} unpushed); adminMerge=${formatRate(metrics.adminMergeRate)}/h; forceBypass=${formatRate(metrics.forceBypassRate)}/h (${metrics.forceBypassRate.windowHours}h)`;
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

async function collectWorktreeStates(
  projectRoot: string,
): Promise<readonly DashboardWorktreeState[]> {
  const result = await listWorktrees({ projectRoot });
  if (!result.success) return [];
  return result.data.worktrees.map((worktree) => describeWorktreeState(worktree));
}

function summarizeWorktrees(
  states: readonly DashboardWorktreeState[],
): OrchestrateDashboardMetrics['worktrees'] {
  const counts = {
    total: states.length,
    active: 0,
    locked: 0,
    stale: 0,
    orphan: 0,
    merged: 0,
    dirty: 0,
    unpushed: 0,
    stalled: 0,
  };
  for (const state of states) {
    const { statusCategory: category } = state;
    if (category === 'active') counts.active += 1;
    else if (category === 'locked') counts.locked += 1;
    else if (category === 'stale') counts.stale += 1;
    else if (category === 'orphan') counts.orphan += 1;
    else if (category === 'merged') counts.merged += 1;
    if (state.isDirty) counts.dirty += 1;
    if (state.hasUnpushedCommits) counts.unpushed += 1;
    if (state.isStalled) counts.stalled += 1;
  }
  return counts;
}

function statesFromCategories(categories: readonly string[]): DashboardWorktreeState[] {
  return categories.map((statusCategory) => ({
    path: '',
    branch: '',
    taskId: null,
    statusCategory,
    isDirty: false,
    hasUnpushedCommits: false,
    isStalled: statusCategory === 'stale',
    reasons: statusCategory === 'stale' ? ['stale'] : [],
  }));
}

function describeWorktreeState(worktree: WorktreeInfo): DashboardWorktreeState {
  const isWorkerWorktree = worktree.taskId !== null;
  const isDirty = isWorkerWorktree && hasDirtyWorktree(worktree.path);
  const hasUnpushedCommits = isWorkerWorktree && hasUnpushedWork(worktree.path);
  const reasons = [
    ...(worktree.statusCategory === 'stale' ? ['stale'] : []),
    ...(isDirty ? ['dirty'] : []),
    ...(hasUnpushedCommits ? ['unpushed'] : []),
  ];
  return {
    path: worktree.path,
    branch: worktree.branch,
    taskId: worktree.taskId,
    statusCategory: worktree.statusCategory,
    isDirty,
    hasUnpushedCommits,
    isStalled: reasons.length > 0,
    reasons,
  };
}

function hasDirtyWorktree(worktreePath: string): boolean {
  try {
    return (
      execFileSync('git', ['status', '--porcelain'], {
        cwd: worktreePath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 15_000,
      }).trim().length > 0
    );
  } catch {
    return false;
  }
}

function hasUnpushedWork(worktreePath: string): boolean {
  try {
    const count = execFileSync('git', ['rev-list', '--count', '@{u}..HEAD'], {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15_000,
    }).trim();
    return Number.parseInt(count, 10) > 0;
  } catch {
    return false;
  }
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
