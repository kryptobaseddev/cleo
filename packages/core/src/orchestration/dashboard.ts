/**
 * Multi-agent orchestration dashboard metrics (T10461-T10464).
 *
 * Read-only aggregation over the existing task store, worktree list, and audit
 * JSONL files. This module intentionally does not introduce a new dashboard
 * persistence layer: every value is derived from existing SSoTs at call time.
 */

import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Task, WorktreeInfo } from '@cleocode/contracts';
import type { DataAccessor } from '../store/data-accessor.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { getForceBypassPath } from '../tasks/gate-audit.js';
import { WORKTREE_LIFECYCLE_AUDIT_FILE } from '../worktree/audit.js';
import {
  enumerateWorktrees,
  isDisposalCandidate,
  isPrimaryWorktree,
  listWorktrees,
  loadOwningTaskStatuses,
  resolvePrimaryWorktreePath,
} from '../worktree/list.js';
import {
  readSentinelIndex,
  taskIdFromBranch,
  taskIdFromWorktreeDir,
} from '../worktree/sentinel-index.js';

/** Observation window used for audit-derived rates. */
export const DASHBOARD_RATE_WINDOW_HOURS = 24;

/** Idle window after which a worktree naming no stored task is a disposal candidate (as `listWorktrees`). */
const UNPROVEN_TASKLESS_IDLE_MS = 7 * 24 * 60 * 60 * 1000;

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
    /** Worktree categories (T14274): in use, provably disposable, kept with a reason, undecidable. */
    active: number;
    redundant: number;
    keep: number;
    unknown: number;
    /**
     * Disposal candidates the proof did not judge (T14552): only set when the
     * dashboard ran with `proveWorktrees: false`; `cleo worktree list` proves them.
     */
    unproven: number;
    /** Worktrees carrying the `stale` annotation. */
    stale: number;
    dirty: number;
    unpushed: number;
    stalled: number;
  };
  stalledWorktrees: DashboardWorktreeState[];
  /**
   * Whether worktree categories come from the disposal proof plus dirty and
   * unpushed probes (`proven`), or from task status alone (`unproven`, T14552).
   */
  worktreeProof: 'proven' | 'unproven';
}

export interface CollectDashboardOptions {
  accessor?: DataAccessor;
  now?: Date;
  rateWindowHours?: number;
  /** Test hook: skip git worktree enumeration and use these status categories. */
  worktreeStatusCategories?: readonly string[];
  /** Test hook: skip git worktree enumeration and use these full worktree states. */
  worktreeStates?: readonly DashboardWorktreeState[];
  /**
   * Run the disposal proof and the dirty/unpushed probes per worktree
   * (default `true`). `false` reads one `git worktree list` and the owning
   * task statuses only, so the cost does not grow with the worktree count:
   * the spawn prompt summary uses it (T14552).
   */
  proveWorktrees?: boolean;
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
  const prove = options.proveWorktrees !== false;
  const worktreeStates =
    options.worktreeStates ??
    (options.worktreeStatusCategories
      ? statesFromCategories(options.worktreeStatusCategories)
      : prove
        ? await collectWorktreeStates(projectRoot)
        : await collectUnprovenWorktreeStates(projectRoot, now.getTime()));
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
    worktreeProof: prove ? 'proven' : 'unproven',
  };
}

/** One-line summary safe for spawn-prompt injection. */
export function formatDashboardPromptSummary(metrics: OrchestrateDashboardMetrics): string {
  const worktrees =
    metrics.worktreeProof === 'unproven'
      ? `worktrees=${metrics.activeWorktreeCount} active, ${metrics.worktrees.unproven} finished (unproven: cleo worktree list)`
      : `worktrees=${metrics.activeWorktreeCount} active (${metrics.worktrees.stalled} stalled: ${metrics.worktrees.dirty} dirty, ${metrics.worktrees.unpushed} unpushed)`;
  return `queue=${metrics.queueDepth} ready / ${metrics.queue.active} active; ${worktrees}; adminMerge=${formatRate(metrics.adminMergeRate)}/h; forceBypass=${formatRate(metrics.forceBypassRate)}/h (${metrics.forceBypassRate.windowHours}h)`;
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

/**
 * Worktree states from one `git worktree list` and the owning task statuses
 * (T14552): no disposal proof and no per-worktree git call, so a project with
 * hundreds of worktrees costs what a project with one does. The primary
 * checkout and worktrees of open tasks are `active`; a disposal candidate
 * (task done or cancelled, or no stored task and idle past the window) is
 * `unproven`, never `redundant`; an unreadable task store makes task
 * worktrees `unknown`.
 */
async function collectUnprovenWorktreeStates(
  projectRoot: string,
  nowMs: number,
): Promise<readonly DashboardWorktreeState[]> {
  let entries: ReturnType<typeof enumerateWorktrees>;
  try {
    entries = enumerateWorktrees(projectRoot);
  } catch {
    return [];
  }
  const adopted = new Map(readSentinelIndex(projectRoot).map((e) => [e.path, e.taskId]));
  const primary = resolvePrimaryWorktreePath(projectRoot);
  const rows = entries.map((entry) => ({
    entry,
    taskId:
      adopted.get(entry.path) ??
      taskIdFromBranch(entry.branch) ??
      taskIdFromWorktreeDir(entry.path),
  }));
  const ids = [...new Set(rows.flatMap((row) => (row.taskId ? [row.taskId] : [])))];
  const statuses = await loadOwningTaskStatuses(ids, projectRoot);
  return rows.map(({ entry, taskId }) => {
    const owningTaskStatus =
      taskId && statuses.success ? (statuses.data.get(taskId) ?? null) : null;
    const isPrimary = isPrimaryWorktree(entry.path, primary);
    const statusCategory =
      taskId !== null && !statuses.success
        ? 'unknown'
        : isDisposalCandidate({
              isPrimary,
              owningTaskStatus,
              idlePastWindow:
                owningTaskStatus === null &&
                !isPrimary &&
                idleMs(entry.path, nowMs) >= UNPROVEN_TASKLESS_IDLE_MS,
            })
          ? 'unproven'
          : 'active';
    return {
      path: entry.path,
      branch: entry.branch,
      taskId,
      statusCategory,
      isDirty: false,
      hasUnpushedCommits: false,
      isStalled: false,
      reasons: [],
    };
  });
}

/** Milliseconds since the directory last changed; 0 when it cannot be read. */
function idleMs(path: string, nowMs: number): number {
  try {
    return nowMs - statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function summarizeWorktrees(
  states: readonly DashboardWorktreeState[],
): OrchestrateDashboardMetrics['worktrees'] {
  const counts = {
    total: states.length,
    active: 0,
    redundant: 0,
    keep: 0,
    unknown: 0,
    unproven: 0,
    stale: 0,
    dirty: 0,
    unpushed: 0,
    stalled: 0,
  };
  for (const state of states) {
    const { statusCategory: category } = state;
    if (category === 'active') counts.active += 1;
    else if (category === 'redundant') counts.redundant += 1;
    else if (category === 'keep') counts.keep += 1;
    else if (category === 'unknown') counts.unknown += 1;
    else if (category === 'unproven') counts.unproven += 1;
    if (state.reasons.includes('stale')) counts.stale += 1;
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
    isStalled: false,
    reasons: [],
  }));
}

function describeWorktreeState(worktree: WorktreeInfo): DashboardWorktreeState {
  const isWorkerWorktree = worktree.taskId !== null;
  const isDirty = isWorkerWorktree && hasDirtyWorktree(worktree.path);
  const hasUnpushedCommits = isWorkerWorktree && hasUnpushedWork(worktree.path);
  const reasons = [
    ...(worktree.isStale ? ['stale'] : []),
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
