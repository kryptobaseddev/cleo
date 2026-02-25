/**
 * Canonical reparent logic — move a task to a different parent in the hierarchy.
 * Both CLI (reparent command) and core (updateTask) delegate here.
 *
 * This module operates on an in-memory TaskFile. The caller is responsible
 * for loading and saving the data (via DataAccessor or direct JSON I/O).
 *
 * @task T4807
 * @epic T4454
 */

import type { TaskFile } from '../../types/task.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import {
  wouldCreateCircle,
  getDepth,
} from './hierarchy.js';
import { resolveHierarchyPolicy, validateHierarchyPlacement } from './hierarchy-policy.js';
import type { HierarchyPolicy } from './hierarchy-policy.js';

/** Options for reparenting a task. */
export interface ReparentOptions {
  taskId: string;
  /** New parent ID, or null to promote to root. */
  newParentId: string | null;
  /** Optional resolved hierarchy policy. If not provided, uses llm-agent-first defaults. */
  policy?: HierarchyPolicy;
}

/** @deprecated Use ReparentOptions */
export type ReparentTaskOptions = ReparentOptions;

/** Result of a reparent operation. */
export interface ReparentResult {
  oldParent: string | null;
  newParent: string | null;
  newType: string;
}

/** @deprecated Use ReparentResult */
export type ReparentTaskResult = ReparentResult;

/**
 * Reparent a task within a TaskFile.
 *
 * Mutates the task in-place within `data.tasks`. Updates `parentId`, `type`,
 * and `updatedAt` on the target task, and `lastUpdated` on the TaskFile.
 *
 * @param data  The loaded TaskFile (mutated in place)
 * @param opts  Reparent options (taskId, newParentId)
 * @returns     Result with old/new parent and new type
 */
export async function reparentTask(
  data: TaskFile,
  opts: ReparentOptions,
): Promise<ReparentResult> {
  const { taskId, newParentId } = opts;

  const task = data.tasks.find((t) => t.id === taskId);
  if (!task) {
    throw new CleoError(
      ExitCode.NOT_FOUND,
      `Task not found: ${taskId}`,
      { fix: `Use 'cleo find "${taskId}"' to search` },
    );
  }

  const oldParent = task.parentId ?? null;
  const effectiveNewParent = newParentId || null;

  // Promote to root
  if (!effectiveNewParent) {
    task.parentId = null;
    if (task.type === 'subtask') {
      task.type = 'task';
    }
    task.updatedAt = new Date().toISOString();
    data.lastUpdated = new Date().toISOString();

    return {
      oldParent,
      newParent: null,
      newType: task.type ?? 'task',
    };
  }

  // Validate target parent exists and hierarchy constraints (depth + sibling limits)
  const effectivePolicy = opts.policy ?? resolveHierarchyPolicy({
    hierarchy: {
      maxDepth: 3,
      maxSiblings: 0,
      maxActiveSiblings: 32,
      cascadeDelete: false,
      countDoneInLimit: false,
      enforcementProfile: 'llm-agent-first',
    },
  } as any);
  const validation = validateHierarchyPlacement(effectiveNewParent, data.tasks, effectivePolicy);
  if (!validation.valid) {
    const code = validation.error?.code === 'E_PARENT_NOT_FOUND'
      ? ExitCode.PARENT_NOT_FOUND
      : validation.error?.code === 'E_DEPTH_EXCEEDED'
        ? ExitCode.DEPTH_EXCEEDED
        : validation.error?.code === 'E_SIBLING_LIMIT'
          ? ExitCode.SIBLING_LIMIT
          : ExitCode.INVALID_INPUT;

    throw new CleoError(
      code,
      validation.error?.message ?? `Cannot reparent under ${effectiveNewParent}`,
      { fix: `Check hierarchy constraints with 'cleo show ${effectiveNewParent}'` },
    );
  }

  const newParentTask = data.tasks.find((t) => t.id === effectiveNewParent);

  // Cannot parent under a subtask
  if (newParentTask?.type === 'subtask') {
    throw new CleoError(
      ExitCode.INVALID_PARENT_TYPE,
      `Cannot parent under subtask '${effectiveNewParent}'`,
      { fix: `Choose a task or epic as the parent instead` },
    );
  }

  // Check circular reference
  if (wouldCreateCircle(taskId, effectiveNewParent, data.tasks)) {
    throw new CleoError(
      ExitCode.CIRCULAR_REFERENCE,
      `Moving '${taskId}' under '${effectiveNewParent}' would create a circular reference`,
      { fix: `The target parent is a descendant of the task being moved` },
    );
  }

  // Apply the reparent
  task.parentId = effectiveNewParent;

  // Update type based on new depth in the hierarchy
  const newDepth = getDepth(taskId, data.tasks);
  if (newDepth === 1) {
    task.type = 'task';
  } else if (newDepth >= 2) {
    task.type = 'subtask';
  }

  task.updatedAt = new Date().toISOString();
  data.lastUpdated = new Date().toISOString();

  return {
    oldParent,
    newParent: effectiveNewParent,
    newType: task.type ?? 'task',
  };
}
