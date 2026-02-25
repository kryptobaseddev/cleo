/**
 * Unified hierarchy policy resolution and validation.
 * Single source of truth for all hierarchy enforcement paths.
 *
 * @epic T4454
 * @task T5001
 */

import type { Task } from '../../types/task.js';
import type { CleoConfig } from '../../types/config.js';
import { getChildren, getDepth, wouldCreateCircle } from './hierarchy.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HierarchyPolicy {
  maxDepth: number;
  maxSiblings: number;
  maxActiveSiblings: number;
  countDoneInLimit: boolean;
  enforcementProfile: 'llm-agent-first' | 'human-cognitive' | 'custom';
}

export interface HierarchyValidationResult {
  valid: boolean;
  error?: {
    code: string;
    message: string;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ENFORCEMENT_PROFILES = {
  'llm-agent-first': { maxSiblings: 0, maxActiveSiblings: 32, maxDepth: 3, countDoneInLimit: false },
  'human-cognitive':  { maxSiblings: 7, maxActiveSiblings: 3,  maxDepth: 3, countDoneInLimit: false },
} as const;

type ProfileName = keyof typeof ENFORCEMENT_PROFILES;

// ---------------------------------------------------------------------------
// Policy resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a full HierarchyPolicy from config, starting with a profile preset
 * and overriding with any explicitly set config.hierarchy fields.
 */
export function resolveHierarchyPolicy(config: CleoConfig): HierarchyPolicy {
  const hierarchy = config.hierarchy;

  const profileName: ProfileName =
    (hierarchy?.enforcementProfile as ProfileName | undefined) ?? 'llm-agent-first';

  const preset = ENFORCEMENT_PROFILES[profileName] ?? ENFORCEMENT_PROFILES['llm-agent-first'];

  const resolved: HierarchyPolicy = {
    enforcementProfile: profileName in ENFORCEMENT_PROFILES ? profileName : 'custom',
    maxDepth: preset.maxDepth,
    maxSiblings: preset.maxSiblings,
    maxActiveSiblings: preset.maxActiveSiblings,
    countDoneInLimit: preset.countDoneInLimit,
  };

  // Override with explicit config values when present
  if (hierarchy) {
    if (typeof hierarchy.maxDepth === 'number') {
      resolved.maxDepth = hierarchy.maxDepth;
    }
    if (typeof hierarchy.maxSiblings === 'number') {
      resolved.maxSiblings = hierarchy.maxSiblings;
    }
    if (typeof hierarchy.maxActiveSiblings === 'number') {
      resolved.maxActiveSiblings = hierarchy.maxActiveSiblings as number;
    }
    if (typeof hierarchy.countDoneInLimit === 'boolean') {
      resolved.countDoneInLimit = hierarchy.countDoneInLimit as boolean;
    }
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Assert that a parent task exists in the task list.
 * Returns an error result if not found, null if OK.
 */
export function assertParentExists(
  parentId: string,
  tasks: Task[],
): HierarchyValidationResult | null {
  const parent = tasks.find((t) => t.id === parentId);
  if (!parent) {
    return {
      valid: false,
      error: { code: 'E_PARENT_NOT_FOUND', message: `Parent task ${parentId} not found` },
    };
  }
  return null;
}

/**
 * Assert that re-parenting would not create a cycle.
 * Returns an error result if a cycle is detected, null if OK.
 */
export function assertNoCycle(
  taskId: string,
  newParentId: string,
  tasks: Task[],
): HierarchyValidationResult | null {
  if (wouldCreateCircle(taskId, newParentId, tasks)) {
    return {
      valid: false,
      error: {
        code: 'E_CIRCULAR_REFERENCE',
        message: `Setting parent to ${newParentId} would create a circular reference for task ${taskId}`,
      },
    };
  }
  return null;
}

/**
 * Count active (non-done, non-cancelled, non-archived) children of a parent.
 */
export function countActiveChildren(parentId: string, tasks: Task[]): number {
  const activeStatuses = new Set(['pending', 'active', 'blocked']);
  return tasks.filter(
    (t) => t.parentId === parentId && activeStatuses.has(t.status),
  ).length;
}

// ---------------------------------------------------------------------------
// Primary validation
// ---------------------------------------------------------------------------

/**
 * Validate whether a new task can be placed under the given parent
 * according to the resolved hierarchy policy.
 */
export function validateHierarchyPlacement(
  parentId: string | null,
  tasks: Task[],
  policy: HierarchyPolicy,
): HierarchyValidationResult {
  // Root placement is always allowed
  if (parentId === null) {
    return { valid: true };
  }

  // Parent must exist
  const parentError = assertParentExists(parentId, tasks);
  if (parentError) return parentError;

  // Depth check
  const parentDepth = getDepth(parentId, tasks);
  if (parentDepth + 1 >= policy.maxDepth) {
    return {
      valid: false,
      error: {
        code: 'E_DEPTH_EXCEEDED',
        message: `Maximum nesting depth ${policy.maxDepth} would be exceeded`,
      },
    };
  }

  // Sibling limit (0 = unlimited)
  if (policy.maxSiblings > 0) {
    const children = getChildren(parentId, tasks);
    const counted = policy.countDoneInLimit
      ? children.length
      : children.filter((t) => t.status !== 'done').length;

    if (counted >= policy.maxSiblings) {
      return {
        valid: false,
        error: {
          code: 'E_SIBLING_LIMIT',
          message: `Parent ${parentId} already has ${counted} children (limit: ${policy.maxSiblings})`,
        },
      };
    }
  }

  // Active sibling limit
  if (policy.maxActiveSiblings > 0) {
    const activeCount = countActiveChildren(parentId, tasks);
    if (activeCount >= policy.maxActiveSiblings) {
      return {
        valid: false,
        error: {
          code: 'E_ACTIVE_SIBLING_LIMIT',
          message: `Parent ${parentId} already has ${activeCount} active children (limit: ${policy.maxActiveSiblings})`,
        },
      };
    }
  }

  return { valid: true };
}
