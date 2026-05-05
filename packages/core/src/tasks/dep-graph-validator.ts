/**
 * Dep-graph validator — orphan, circular, cross-epic gap, stale-dep detection.
 *
 * Pure tier-0 graph traversal (no LLM). Extends the existing dependency-check
 * infrastructure with three additional diagnostic categories that are not
 * covered by the base `validateDependencies` function:
 *
 *   - `E_ORPHAN`           — non-epic task with no parentId and status not terminal
 *   - `E_CROSS_EPIC_GAP`   — task A deps on task B, but A's epic has no dep on B's epic
 *   - `E_STALE_DEP`        — dep to cancelled task or done-but-gates-not-passed task
 *   - `E_MISSING_REF`      — re-exported alias for E_DEP_NOT_FOUND (base validator)
 *   - `E_CIRCULAR`         — re-exported alias for E_CIRCULAR_DEP (base validator)
 *
 * DRY contract: detectCircularDeps + validateDependencyRefs are imported from
 * dependency-check.ts and called here — NOT reimplemented.
 *
 * @task T1857
 * @epic T1855
 */

import type { Task } from '@cleocode/contracts';
import { detectCircularDeps, validateDependencyRefs } from './dependency-check.js';

// ---------------------------------------------------------------------------
// Issue types
// ---------------------------------------------------------------------------

/** Issue code union for dep-graph validation. */
export type DepGraphIssueCode =
  | 'E_ORPHAN'
  | 'E_CIRCULAR'
  | 'E_CROSS_EPIC_GAP'
  | 'E_STALE_DEP'
  | 'E_MISSING_REF';

/** A single dep-graph issue. */
export interface DepGraphIssue {
  /** Machine-readable issue code. */
  code: DepGraphIssueCode;
  /** The task ID where the issue originates. */
  taskId: string;
  /** Human-readable description. */
  message: string;
  /** Related task IDs (dep IDs, cycle members, etc.). */
  relatedIds?: string[];
  /** Source epic ID (for cross-epic gap issues). */
  epicA?: string;
  /** Target epic ID (for cross-epic gap issues). */
  epicB?: string;
}

/** Result of running the full dep-graph validation. */
export interface DepGraphValidateResult {
  /** True when no issues were found. */
  valid: boolean;
  /** All detected issues. Empty when valid. */
  issues: DepGraphIssue[];
  /** Human-readable summary line. */
  summary: string;
}

// ---------------------------------------------------------------------------
// Scope filter
// ---------------------------------------------------------------------------

/** Scope for validation — which tasks to include. */
export type DepValidateScope = 'all' | 'open' | 'critical';

const TERMINAL_STATUSES = new Set(['done', 'cancelled', 'archived']);

function applyScope(tasks: Task[], scope: DepValidateScope): Task[] {
  if (scope === 'open') {
    return tasks.filter((t) => !TERMINAL_STATUSES.has(t.status));
  }
  if (scope === 'critical') {
    return tasks.filter((t) => t.priority === 'critical' || t.type === 'epic');
  }
  return tasks;
}

// ---------------------------------------------------------------------------
// Core helpers (exported for reuse by T1858 / T1859)
// ---------------------------------------------------------------------------

/**
 * Walk up the parentId chain until reaching an epic-typed task.
 * Returns the nearest ancestor epic ID, or null if none exists.
 *
 * @param taskId - Starting task ID.
 * @param taskMap - Map of all tasks keyed by ID.
 * @returns The ID of the nearest ancestor epic, or null.
 */
export function nearestEpic(taskId: string, taskMap: Map<string, Task>): string | null {
  let current = taskMap.get(taskId);
  while (current) {
    if (current.type === 'epic') return current.id;
    current = current.parentId ? taskMap.get(current.parentId) : undefined;
  }
  return null;
}

/**
 * Detect orphaned tasks: non-epic tasks with no parentId that are not in a
 * terminal state (done / cancelled / archived).
 *
 * An orphan is any task where:
 *   - `task.type !== 'epic'`
 *   - `!task.parentId`
 *   - `task.status not in { done, cancelled, archived }`
 *
 * @param tasks - Full task list to analyse.
 * @returns Array of `E_ORPHAN` issues.
 */
export function detectOrphans(tasks: Task[]): DepGraphIssue[] {
  return tasks
    .filter(
      (t) =>
        t.type !== 'epic' &&
        !t.parentId &&
        !TERMINAL_STATUSES.has(t.status) &&
        t.status !== 'proposed',
    )
    .map((t) => ({
      code: 'E_ORPHAN' as const,
      taskId: t.id,
      message: `Task ${t.id} ("${t.title}") has no parent epic`,
    }));
}

/**
 * Detect cross-epic dependency gaps.
 *
 * A gap exists when task A (in epic X) depends on task B (in epic Y), but
 * epic X has no explicit dep on epic Y. Only nearest-epic-level gaps are
 * reported (grandparent cascading is NOT checked — Q2 approved default).
 *
 * @param tasks - Full task list.
 * @returns Array of `E_CROSS_EPIC_GAP` issues.
 */
export function detectCrossEpicGaps(tasks: Task[]): DepGraphIssue[] {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const issues: DepGraphIssue[] = [];

  for (const task of tasks) {
    const epicA = nearestEpic(task.id, taskMap);
    if (!epicA) continue; // top-level tasks (no epic ancestor) are not cross-epic

    for (const depId of task.depends ?? []) {
      const epicB = nearestEpic(depId, taskMap);
      if (!epicB || epicA === epicB) continue; // same epic or dep has no epic — skip

      // Cross-epic dep detected: verify epicA has an explicit dep on epicB
      const epicATask = taskMap.get(epicA);
      if (!(epicATask?.depends ?? []).includes(epicB)) {
        issues.push({
          code: 'E_CROSS_EPIC_GAP',
          taskId: task.id,
          message: `Task ${task.id} (epic ${epicA}) depends on ${depId} (epic ${epicB}) but epic ${epicA} has no dep on epic ${epicB}`,
          relatedIds: [depId],
          epicA,
          epicB,
        });
      }
    }
  }

  return issues;
}

/**
 * Detect stale dependencies: deps pointing to cancelled tasks, or deps pointing
 * to done tasks whose verification gates were not all passed.
 *
 * @param tasks - Full task list.
 * @returns Array of `E_STALE_DEP` issues.
 */
export function detectStaleDeps(tasks: Task[]): DepGraphIssue[] {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const issues: DepGraphIssue[] = [];

  for (const task of tasks) {
    if (TERMINAL_STATUSES.has(task.status)) continue; // skip terminal tasks as sources

    for (const depId of task.depends ?? []) {
      const dep = taskMap.get(depId);
      if (!dep) continue; // missing refs handled separately by E_MISSING_REF

      if (dep.status === 'cancelled') {
        issues.push({
          code: 'E_STALE_DEP',
          taskId: task.id,
          message: `Task ${task.id} depends on ${depId} which is cancelled`,
          relatedIds: [depId],
        });
        continue;
      }

      // done-but-gates-not-passed: check verification.passed
      if (dep.status === 'done' && dep.verification && !dep.verification.passed) {
        issues.push({
          code: 'E_STALE_DEP',
          taskId: task.id,
          message: `Task ${task.id} depends on ${depId} which is done but verification gates were not passed`,
          relatedIds: [depId],
        });
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Main validator
// ---------------------------------------------------------------------------

/**
 * Run the full dep-graph validation over a task set.
 *
 * Runs (in order):
 *   1. Missing-ref detection (E_MISSING_REF) via validateDependencyRefs
 *   2. Circular-dep detection (E_CIRCULAR) via detectCircularDeps
 *   3. Orphan detection (E_ORPHAN)
 *   4. Cross-epic gap detection (E_CROSS_EPIC_GAP)
 *   5. Stale-dep detection (E_STALE_DEP)
 *
 * @param tasks - Tasks to validate (already filtered by scope if applicable).
 * @returns Structured validation result with all issues.
 */
export function validateDepGraph(tasks: Task[]): DepGraphValidateResult {
  const issues: DepGraphIssue[] = [];

  // 1. Missing references (delegate to base validator)
  const missingRefErrors = validateDependencyRefs(tasks);
  for (const e of missingRefErrors) {
    issues.push({
      code: 'E_MISSING_REF',
      taskId: e.taskId,
      message: e.message,
      relatedIds: e.relatedIds,
    });
  }

  // 2. Circular deps (delegate to base detector)
  const visited = new Set<string>();
  for (const task of tasks) {
    if (visited.has(task.id)) continue;
    if (!task.depends?.length) continue;

    const cycle = detectCircularDeps(task.id, tasks);
    if (cycle.length > 0) {
      issues.push({
        code: 'E_CIRCULAR',
        taskId: task.id,
        message: `Circular dependency detected: ${cycle.join(' -> ')}`,
        relatedIds: cycle,
      });
      for (const id of cycle) visited.add(id);
    }
  }

  // 3. Orphans
  issues.push(...detectOrphans(tasks));

  // 4. Cross-epic gaps
  issues.push(...detectCrossEpicGaps(tasks));

  // 5. Stale deps
  issues.push(...detectStaleDeps(tasks));

  const summary =
    issues.length === 0
      ? `Dep graph valid — ${tasks.length} task(s) checked, no issues found`
      : `Dep graph has ${issues.length} issue(s) across ${tasks.length} task(s): ${[...new Set(issues.map((i) => i.code))].join(', ')}`;

  return {
    valid: issues.length === 0,
    issues,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Scoped entry point (used by CLI validate command and T1858 ready guard)
// ---------------------------------------------------------------------------

/**
 * Run dep-graph validation over a task set with optional epic scoping and
 * scope filtering.
 *
 * @param allTasks - All tasks in the project.
 * @param opts - Optional epic scope and task scope filter.
 * @returns Validation result.
 */
export function runValidation(
  allTasks: Task[],
  opts: { epicId?: string; scope?: DepValidateScope } = {},
): DepGraphValidateResult {
  const { epicId, scope = 'all' } = opts;

  let tasks = applyScope(allTasks, scope);

  if (epicId) {
    // Scope to direct children of the epic (plus the epic itself for dep checks)
    const epicChildIds = new Set(
      allTasks.filter((t) => t.parentId === epicId || t.id === epicId).map((t) => t.id),
    );
    tasks = tasks.filter((t) => epicChildIds.has(t.id));
  }

  return validateDepGraph(tasks);
}
