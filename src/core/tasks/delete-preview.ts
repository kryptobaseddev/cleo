/**
 * Dry-run preview functions for task deletion.
 * Ported from lib/tasks/delete-preview.sh
 *
 * @epic T4454
 * @task T4529
 */

import type { Task } from '../../types/task.js';
import { getDescendants } from './hierarchy.js';

/** Impact severity levels. */
export type Severity = 'high' | 'medium' | 'low';

/** An impact warning. */
export interface DeleteWarning {
  severity: Severity;
  code: string;
  message: string;
}

/** Affected tasks info. */
export interface AffectedTasks {
  primary: Pick<Task, 'id' | 'title' | 'status' | 'type' | 'parentId' | 'labels'> | null;
  children: Pick<Task, 'id' | 'title' | 'status' | 'type' | 'parentId' | 'labels'>[];
  totalCount: number;
  error?: string;
}

/** Impact analysis. */
export interface DeleteImpact {
  pendingLost: number;
  activeLost: number;
  blockedLost: number;
  doneLost: number;
  dependentsAffected: string[];
}

/** Full preview result. */
export interface DeletePreview {
  success: boolean;
  dryRun: true;
  wouldDelete?: AffectedTasks;
  impact?: DeleteImpact;
  warnings?: DeleteWarning[];
  warningCount?: number;
  strategy?: string;
  reason?: string | null;
  timestamp?: string;
  error?: {
    code: string;
    message: string;
    suggestion?: string;
    childCount?: number;
  };
}

/**
 * Calculate which tasks would be affected by a delete operation.
 */
export function calculateAffectedTasks(
  taskId: string,
  strategy: string,
  tasks: Task[],
): AffectedTasks {
  const primary = tasks.find((t) => t.id === taskId);
  if (!primary) {
    return { primary: null, children: [], totalCount: 0, error: 'Task not found' };
  }

  const pick = (t: Task) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    type: t.type,
    parentId: t.parentId,
    labels: t.labels,
  });

  let children: ReturnType<typeof pick>[] = [];
  if (strategy === 'cascade') {
    children = getDescendants(taskId, tasks).map(pick);
  }

  return {
    primary: pick(primary),
    children,
    totalCount: 1 + children.length,
  };
}

/**
 * Calculate impact of deletion.
 */
export function calculateImpact(
  affected: AffectedTasks,
  tasks: Task[],
): DeleteImpact {
  const allAffected = affected.primary
    ? [affected.primary, ...affected.children]
    : affected.children;

  const affectedIds = new Set(allAffected.map((t) => t.id));

  const impact: DeleteImpact = {
    pendingLost: allAffected.filter((t) => t.status === 'pending').length,
    activeLost: allAffected.filter((t) => t.status === 'active').length,
    blockedLost: allAffected.filter((t) => t.status === 'blocked').length,
    doneLost: allAffected.filter((t) => t.status === 'done').length,
    dependentsAffected: [],
  };

  // Find tasks that depend on any affected task but aren't affected themselves
  for (const task of tasks) {
    if (affectedIds.has(task.id)) continue;
    if (task.depends?.some((depId) => affectedIds.has(depId))) {
      impact.dependentsAffected.push(task.id);
    }
  }

  return impact;
}

/**
 * Generate warnings based on impact analysis.
 */
export function generateWarnings(
  affected: AffectedTasks,
  impact: DeleteImpact,
  strategy: string,
): DeleteWarning[] {
  const warnings: DeleteWarning[] = [];

  // HIGH: Active tasks being cancelled
  if (impact.activeLost > 0) {
    warnings.push({
      severity: 'high',
      code: 'W_ACTIVE_CANCELLED',
      message: `${impact.activeLost} active task(s) would be cancelled`,
    });
  }

  // HIGH: Many dependents (5+)
  if (impact.dependentsAffected.length >= 5) {
    warnings.push({
      severity: 'high',
      code: 'W_MANY_DEPENDENTS',
      message: `${impact.dependentsAffected.length} dependent tasks would lose dependencies`,
    });
  } else if (impact.dependentsAffected.length > 0) {
    // MEDIUM: Some dependents (1-4)
    warnings.push({
      severity: 'medium',
      code: 'W_BROKEN_DEPS',
      message: `${impact.dependentsAffected.length} dependent task(s) would lose dependencies`,
    });
  }

  // MEDIUM: Pending tasks cancelled
  if (impact.pendingLost > 0) {
    warnings.push({
      severity: 'medium',
      code: 'W_PENDING_CANCELLED',
      message: `${impact.pendingLost} pending task(s) would be cancelled`,
    });
  }

  // MEDIUM: Cascade with children
  if (strategy === 'cascade' && affected.children.length > 0) {
    warnings.push({
      severity: 'medium',
      code: 'W_CASCADE_DELETE',
      message: `Cascade delete: ${affected.children.length} child task(s) would be deleted with parent`,
    });
  }

  // LOW: Task has focus
  if (affected.primary?.status === 'active') {
    warnings.push({
      severity: 'low',
      code: 'W_MAY_HAVE_FOCUS',
      message: 'Task may have current focus (status is active)',
    });
  }

  // LOW: Total affected
  if (affected.totalCount > 1) {
    warnings.push({
      severity: 'low',
      code: 'W_TOTAL_AFFECTED',
      message: `Total of ${affected.totalCount} task(s) would be affected`,
    });
  }

  return warnings;
}

/**
 * Main preview function - coordinates all preview calculations.
 */
export function previewDelete(
  taskId: string,
  tasks: Task[],
  options?: { strategy?: string; reason?: string },
): DeletePreview {
  const strategy = options?.strategy ?? 'block';
  const reason = options?.reason;

  if (!taskId) {
    return {
      success: false,
      dryRun: true,
      error: { code: 'E_MISSING_TASK_ID', message: 'Task ID is required' },
    };
  }

  const task = tasks.find((t) => t.id === taskId);
  if (!task) {
    return {
      success: false,
      dryRun: true,
      error: { code: 'E_TASK_NOT_FOUND', message: `Task not found: ${taskId}` },
    };
  }

  if (task.status === 'done') {
    return {
      success: false,
      dryRun: true,
      error: {
        code: 'E_TASK_COMPLETED',
        message: `Task is completed, use archive instead: ${taskId}`,
        suggestion: 'Use "cleo archive" to archive completed tasks',
      },
    };
  }

  // Block strategy: check for children
  if (strategy === 'block') {
    const childCount = tasks.filter((t) => t.parentId === taskId).length;
    if (childCount > 0) {
      return {
        success: false,
        dryRun: true,
        error: {
          code: 'E_HAS_CHILDREN',
          message: `Task has ${childCount} child task(s). Use --children=cascade or --children=orphan`,
          childCount,
        },
      };
    }
  }

  const affected = calculateAffectedTasks(taskId, strategy, tasks);
  if (affected.error) {
    return {
      success: false,
      dryRun: true,
      error: { code: 'E_CALCULATION_FAILED', message: affected.error },
    };
  }

  const impact = calculateImpact(affected, tasks);
  const warnings = generateWarnings(affected, impact, strategy);

  return {
    success: true,
    dryRun: true,
    wouldDelete: affected,
    impact,
    warnings,
    warningCount: warnings.length,
    strategy,
    reason: reason ?? null,
    timestamp: new Date().toISOString(),
  };
}
