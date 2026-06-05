/**
 * Strategy pattern for child handling during task cancellation.
 * Ported from lib/tasks/deletion-strategy.sh
 *
 * Strategies (T11811 — orphan-prevention guard):
 *   - `block`    — fail if the task has children (the lowest-blast-radius
 *                  default; the operator must opt into a disposition).
 *   - `cascade`  — cancel the whole subtree.
 *   - `reparent` — move the direct children under an existing parent so they
 *                  stay attached (routed through `coreTaskReparent` so the
 *                  type-matrix / depth / sibling checks run).
 *
 * The legacy `orphan` strategy (set `parentId: null` to detach children to
 * root) was DELETED by T11811: detaching manufactures the exact orphan the
 * containment guard rejects. `reparent` is its safe replacement.
 *
 * @epic T4454
 * @task T4529
 * @task T11811 — delete `orphan`/detach in favour of `reparent`
 */

import type { Task } from '@cleocode/contracts';
import { getChildren, getDescendants } from './hierarchy.js';

/** Valid child handling strategies. */
export type ChildStrategy = 'block' | 'cascade' | 'reparent';

export const VALID_STRATEGIES: ChildStrategy[] = ['block', 'cascade', 'reparent'];

/** Result from a strategy handler. */
export interface StrategyResult {
  success: boolean;
  strategy: ChildStrategy;
  taskId: string;
  affectedTasks: string[];
  affectedCount?: number;
  message: string;
  error?: {
    code: string;
    message: string;
    childCount?: number;
    childIds?: string[];
    suggestion?: string;
  };
}

/**
 * Validate a strategy name.
 */
export function isValidStrategy(strategy: string): strategy is ChildStrategy {
  return VALID_STRATEGIES.includes(strategy as ChildStrategy);
}

/**
 * Handle children using the specified strategy.
 * Returns the modified tasks array and the strategy result.
 *
 * @param taskId - The parent task being cancelled.
 * @param strategy - Child disposition strategy (`block` | `cascade` | `reparent`).
 * @param tasks - The full in-memory task set (mutated copy returned).
 * @param options - Strategy tuning. `reparentTo` is REQUIRED for `reparent`.
 */
export function handleChildren(
  taskId: string,
  strategy: ChildStrategy,
  tasks: Task[],
  options?: {
    force?: boolean;
    cascadeThreshold?: number;
    allowCascade?: boolean;
    /** Target parent ID for the `reparent` strategy (T11811). */
    reparentTo?: string;
  },
): { tasks: Task[]; result: StrategyResult } {
  switch (strategy) {
    case 'block':
      return handleBlock(taskId, tasks);
    case 'cascade':
      return handleCascade(taskId, tasks, options);
    case 'reparent':
      return handleReparent(taskId, tasks, options?.reparentTo);
    default:
      return {
        tasks,
        result: {
          success: false,
          strategy,
          taskId,
          affectedTasks: [],
          message: `Unknown strategy: ${strategy}`,
          error: {
            code: 'E_INVALID_STRATEGY',
            message: `Unknown child handling strategy: ${strategy}`,
          },
        },
      };
  }
}

/**
 * Block strategy: fail if task has children.
 */
function handleBlock(taskId: string, tasks: Task[]): { tasks: Task[]; result: StrategyResult } {
  const children = getChildren(taskId, tasks);

  if (children.length > 0) {
    return {
      tasks,
      result: {
        success: false,
        strategy: 'block',
        taskId,
        affectedTasks: [],
        message: `Task ${taskId} has ${children.length} child task(s) and cannot be deleted`,
        error: {
          code: 'E_HAS_CHILDREN',
          message: `Task ${taskId} has ${children.length} child task(s) and cannot be deleted`,
          childCount: children.length,
          childIds: children.map((c) => c.id),
          suggestion:
            'Use --children=cascade to cancel the subtree or --children=reparent --to <epicId> to move the children under another parent',
        },
      },
    };
  }

  return {
    tasks,
    result: {
      success: true,
      strategy: 'block',
      taskId,
      affectedTasks: [],
      message: 'Task has no children',
    },
  };
}

/**
 * Cascade strategy: cancel all descendants recursively.
 */
function handleCascade(
  taskId: string,
  tasks: Task[],
  options?: { force?: boolean; cascadeThreshold?: number; allowCascade?: boolean },
): { tasks: Task[]; result: StrategyResult } {
  const { force = false, cascadeThreshold = 10, allowCascade = true } = options ?? {};

  const children = getChildren(taskId, tasks);
  if (children.length === 0) {
    return {
      tasks,
      result: {
        success: true,
        strategy: 'cascade',
        taskId,
        affectedTasks: [],
        message: 'Task has no children (leaf task)',
      },
    };
  }

  if (!allowCascade) {
    return {
      tasks,
      result: {
        success: false,
        strategy: 'cascade',
        taskId,
        affectedTasks: [],
        message: 'Cascade cancellation is disabled in configuration',
        error: {
          code: 'E_CASCADE_DISABLED',
          message: 'Cascade cancellation is disabled in configuration',
          suggestion:
            'Set cancellation.allowCascade=true in config or use --children=reparent --to <epicId>',
        },
      },
    };
  }

  const descendants = getDescendants(taskId, tasks);
  const descendantIds = descendants.map((d) => d.id);

  if (descendantIds.length > cascadeThreshold && !force) {
    return {
      tasks,
      result: {
        success: false,
        strategy: 'cascade',
        taskId,
        affectedTasks: [],
        message: `Cascade would affect ${descendantIds.length} tasks, exceeding threshold of ${cascadeThreshold}`,
        error: {
          code: 'E_CASCADE_THRESHOLD_EXCEEDED',
          message: `Cascade would affect ${descendantIds.length} tasks, exceeding threshold of ${cascadeThreshold}`,
          suggestion: 'Use --force to proceed or reduce the cascade threshold in config',
        },
      },
    };
  }

  // Perform cascade cancellation
  const timestamp = new Date().toISOString();
  const descendantIdSet = new Set(descendantIds);
  const updatedTasks = tasks.map((t) => {
    if (descendantIdSet.has(t.id)) {
      return {
        ...t,
        status: 'cancelled' as const,
        cancelledAt: timestamp,
        cancellationReason: 'Parent task cancelled (cascade)',
        updatedAt: timestamp,
        // T877: DB invariant requires status='cancelled' ↔ pipeline_stage='cancelled'.
        // Without this, descendants whose pipelineStage was 'research' (or any
        // non-'cancelled' value) would trip the BEFORE-UPDATE trigger on persist.
        // T9838 fix: mirror coreTaskCancel's invariant treatment.
        pipelineStage: 'cancelled' as const,
      };
    }
    return t;
  });

  return {
    tasks: updatedTasks,
    result: {
      success: true,
      strategy: 'cascade',
      taskId,
      affectedTasks: descendantIds,
      affectedCount: descendantIds.length,
      message: `Successfully cancelled ${descendantIds.length} descendant task(s)`,
    },
  };
}

/**
 * Reparent strategy (T11811): move the direct children under an existing
 * parent so they stay attached to the containment tree instead of being
 * detached to root (the deleted `orphan` behaviour).
 *
 * This is a pure in-memory transform — it re-points `parentId` to
 * `reparentTo`. The authoritative type-matrix / depth / sibling validation
 * lives in `coreTaskReparent`, which the live cancel path uses for the actual
 * write; this handler exists for the in-memory dispatcher contract and rejects
 * the obvious failure (no target supplied).
 *
 * @param taskId - The parent task being cancelled.
 * @param tasks - Full in-memory task set.
 * @param reparentTo - REQUIRED target parent ID the children move under.
 */
function handleReparent(
  taskId: string,
  tasks: Task[],
  reparentTo: string | undefined,
): { tasks: Task[]; result: StrategyResult } {
  const children = getChildren(taskId, tasks);

  if (children.length === 0) {
    return {
      tasks,
      result: {
        success: true,
        strategy: 'reparent',
        taskId,
        affectedTasks: [],
        message: 'Task has no children to reparent',
      },
    };
  }

  if (!reparentTo) {
    return {
      tasks,
      result: {
        success: false,
        strategy: 'reparent',
        taskId,
        affectedTasks: [],
        message: `Reparent strategy requires a target parent for ${taskId}'s children`,
        error: {
          code: 'E_REPARENT_TARGET_REQUIRED',
          message: 'Reparent strategy requires a target parent ID',
          childCount: children.length,
          childIds: children.map((c) => c.id),
          suggestion: 'Pass --children=reparent --to <epicId> to name the new parent',
        },
      },
    };
  }

  const childIds = new Set(children.map((c) => c.id));
  const updatedTasks = tasks.map((t) => {
    if (childIds.has(t.id)) {
      return { ...t, parentId: reparentTo, updatedAt: new Date().toISOString() };
    }
    return t;
  });

  return {
    tasks: updatedTasks,
    result: {
      success: true,
      strategy: 'reparent',
      taskId,
      affectedTasks: [...childIds],
      affectedCount: childIds.size,
      message: `Successfully reparented ${childIds.size} child task(s) under ${reparentTo}`,
    },
  };
}
