/**
 * Strategy pattern for child handling during task deletion/cancellation.
 * Ported from lib/tasks/deletion-strategy.sh
 *
 * Strategies: block (fail if has children), cascade (cancel all), orphan (remove parent ref)
 *
 * @epic T4454
 * @task T4529
 */

import type { Task } from '../../types/task.js';
import { getChildren, getDescendants } from './hierarchy.js';

/** Valid child handling strategies. */
export type ChildStrategy = 'block' | 'cascade' | 'orphan';

export const VALID_STRATEGIES: ChildStrategy[] = ['block', 'cascade', 'orphan'];

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
 */
export function handleChildren(
  taskId: string,
  strategy: ChildStrategy,
  tasks: Task[],
  options?: { force?: boolean; cascadeThreshold?: number; allowCascade?: boolean },
): { tasks: Task[]; result: StrategyResult } {
  switch (strategy) {
    case 'block':
      return handleBlock(taskId, tasks);
    case 'cascade':
      return handleCascade(taskId, tasks, options);
    case 'orphan':
      return handleOrphan(taskId, tasks);
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
          suggestion: 'Use --children=cascade to cancel children or --children=orphan to make them root tasks',
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
          suggestion: 'Set cancellation.allowCascade=true in config or use --children=orphan',
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
 * Orphan strategy: make direct children root tasks by removing parentId.
 */
function handleOrphan(taskId: string, tasks: Task[]): { tasks: Task[]; result: StrategyResult } {
  const children = getChildren(taskId, tasks);

  if (children.length === 0) {
    return {
      tasks,
      result: {
        success: true,
        strategy: 'orphan',
        taskId,
        affectedTasks: [],
        message: 'Task has no children to orphan',
      },
    };
  }

  const childIds = new Set(children.map((c) => c.id));
  const updatedTasks = tasks.map((t) => {
    if (childIds.has(t.id)) {
      const { parentId, ...rest } = t;
      return { ...rest, parentId: null, updatedAt: new Date().toISOString() };
    }
    return t;
  });

  return {
    tasks: updatedTasks,
    result: {
      success: true,
      strategy: 'orphan',
      taskId,
      affectedTasks: [...childIds],
      affectedCount: childIds.size,
      message: `Successfully orphaned ${childIds.size} child task(s)`,
    },
  };
}
