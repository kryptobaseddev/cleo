/**
 * Task reparenting, promotion, and reopen operations.
 * @task T10064
 * @epic T9834
 */

import { randomBytes } from 'node:crypto';
import type { Task, TaskStatus } from '@cleocode/contracts';
import { isAllowedWorkGraphParentType, TASK_STATUSES } from '@cleocode/contracts';
import { getTaskAccessor } from '../store/data-accessor.js';
import { getHierarchyLimits } from './task-tree.js';

/** Task record shape expected from the data layer. */
type TaskRecord = Task;

function typeForParent(
  parentType: TaskRecord['type'] | null,
  currentType?: TaskRecord['type'],
): TaskRecord['type'] {
  if (currentType === 'saga') return 'saga';
  if (currentType === 'epic') return 'epic';
  if (parentType === 'task') return 'subtask';
  if (parentType === 'epic') return 'task';
  return currentType === 'subtask' ? 'task' : (currentType ?? 'task');
}

function taskLogId(): string {
  return `log-${Math.floor(Date.now() / 1000)}-${randomBytes(3).toString('hex')}`;
}

/**
 * Move task under a different parent.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @param taskId - The task ID to reparent
 * @param newParentId - The new parent task ID, or null to promote to root level
 * @returns Confirmation with old and new parent IDs and optional type change
 *
 * @remarks
 * Validates against circular references, depth limits, and sibling limits from
 * the project hierarchy config. Automatically adjusts task type based on new depth
 * (depth 1 = "task", depth >= 2 = "subtask").
 *
 * @example
 * ```typescript
 * const result = await coreTaskReparent('/project', 'T015', 'T010');
 * console.log(`Moved from ${result.oldParent} to ${result.newParent}`);
 * ```
 *
 * @task T4790
 */
export async function coreTaskReparent(
  projectRoot: string,
  taskId: string,
  newParentId: string | null,
): Promise<{
  task: string;
  reparented: boolean;
  oldParent: string | null;
  newParent: string | null;
  newType?: string;
  ancestorsReopened: string[];
  subtreeUpdated: string[];
}> {
  const accessor = await getTaskAccessor(projectRoot);

  const task = await accessor.loadSingleTask(taskId);
  if (!task) {
    throw new Error(`Task '${taskId}' not found`);
  }

  const oldParent = task.parentId ?? null;
  const effectiveParentId = newParentId || null;
  const now = new Date().toISOString();
  const subtree = await accessor.getSubtree(taskId);
  const reparentLimits = getHierarchyLimits(projectRoot);

  if (effectiveParentId === taskId) {
    throw new Error(`Moving '${taskId}' under itself would create circular reference`);
  }

  let parentDepth = 0;
  let newParent: TaskRecord | null = null;
  let newParentAncestors: TaskRecord[] = [];

  if (effectiveParentId) {
    newParent = await accessor.loadSingleTask(effectiveParentId);
    if (!newParent) {
      throw new Error(`Parent task '${effectiveParentId}' not found`);
    }

    if (newParent.type === 'subtask') {
      throw new Error(`Cannot parent under subtask '${effectiveParentId}'`);
    }

    // Check circular reference using subtree
    if (subtree.some((t: TaskRecord) => t.id === effectiveParentId)) {
      throw new Error(
        `Moving '${taskId}' under '${effectiveParentId}' would create circular reference`,
      );
    }

    // Check depth limit using ancestor chain
    newParentAncestors = await accessor.getAncestorChain(effectiveParentId);
    parentDepth = newParentAncestors.length;

    // Check sibling limit (0 = unlimited)
    const children = await accessor.getChildren(effectiveParentId);
    const siblingCount = children.filter((t: TaskRecord) => t.id !== taskId).length;
    if (reparentLimits.maxSiblings > 0 && siblingCount >= reparentLimits.maxSiblings) {
      throw new Error(
        `Cannot add child to ${effectiveParentId}: max siblings (${reparentLimits.maxSiblings}) exceeded`,
      );
    }
  }

  const newDepth = effectiveParentId ? parentDepth + 1 : 1;
  const subtreeByParent = new Map<string | null, TaskRecord[]>();
  for (const node of subtree) {
    const parentId = node.parentId ?? null;
    const siblings = subtreeByParent.get(parentId) ?? [];
    siblings.push(node);
    subtreeByParent.set(parentId, siblings);
  }

  const plannedDepths = new Map<string, number>([[task.id, newDepth]]);
  const plannedParentTypes = new Map<string, TaskRecord['type'] | null>([
    [task.id, newParent?.type ?? null],
  ]);
  const plannedTypes = new Map<string, TaskRecord['type']>([
    [task.id, typeForParent(newParent?.type ?? null, task.type)],
  ]);
  const rootParentType = plannedParentTypes.get(task.id) ?? null;
  const rootPlannedType = plannedTypes.get(task.id)!;
  if (rootParentType && !isAllowedWorkGraphParentType(rootPlannedType, rootParentType)) {
    throw new Error(
      `Invalid parent type for ${task.id}: parent type '${rootParentType}' cannot contain '${rootPlannedType}'`,
    );
  }
  const visitDescendants = (parentId: string, parentDepthForNode: number): void => {
    const parentPlannedType = plannedTypes.get(parentId) ?? null;
    for (const child of subtreeByParent.get(parentId) ?? []) {
      const childDepth = parentDepthForNode + 1;
      plannedDepths.set(child.id, childDepth);
      plannedParentTypes.set(child.id, parentPlannedType);
      const childPlannedType = typeForParent(parentPlannedType, child.type);
      plannedTypes.set(child.id, childPlannedType);
      if (parentPlannedType && !isAllowedWorkGraphParentType(childPlannedType, parentPlannedType)) {
        throw new Error(
          `Invalid parent type for ${child.id}: parent type '${parentPlannedType}' cannot contain '${childPlannedType}'`,
        );
      }
      visitDescendants(child.id, childDepth);
    }
  };
  visitDescendants(task.id, newDepth);

  const deepestDepth = Math.max(...plannedDepths.values());
  if (deepestDepth > reparentLimits.maxDepth) {
    throw new Error(`Move would exceed max depth of ${reparentLimits.maxDepth}`);
  }

  const affectedAncestors = new Map<string, TaskRecord>();
  const collectAncestorChain = async (
    parentId: string | null,
    preloaded?: TaskRecord[],
  ): Promise<void> => {
    if (!parentId) return;
    const parent =
      parentId === effectiveParentId && newParent
        ? newParent
        : await accessor.loadSingleTask(parentId);
    if (parent) affectedAncestors.set(parent.id, parent);
    const ancestors = preloaded ?? (await accessor.getAncestorChain(parentId));
    for (const ancestor of ancestors) affectedAncestors.set(ancestor.id, ancestor);
  };

  await collectAncestorChain(oldParent);
  await collectAncestorChain(effectiveParentId, newParentAncestors);

  task.parentId = effectiveParentId;
  const tasksToPersist = [task, ...subtree];
  const subtreeUpdated: string[] = [];
  for (const node of tasksToPersist) {
    const depth = plannedDepths.get(node.id);
    if (depth === undefined) continue;
    node.type = plannedTypes.get(node.id) ?? node.type;
    node.updatedAt = now;
    subtreeUpdated.push(node.id);
  }

  const ancestorsReopened: string[] = [];
  for (const ancestor of affectedAncestors.values()) {
    ancestor.updatedAt = now;
    if (ancestor.status === 'done') {
      ancestor.status = 'pending';
      ancestor.completedAt = undefined;
      if (!ancestor.notes) ancestor.notes = [];
      ancestor.notes.push(`[${now}] Reopened by reparent of ${taskId} (hierarchy changed)`);
      ancestorsReopened.push(ancestor.id);
    }
  }

  for (const node of tasksToPersist) {
    await accessor.upsertSingleTask(node);
  }
  for (const ancestor of affectedAncestors.values()) {
    await accessor.upsertSingleTask(ancestor);
  }

  await accessor.appendLog({
    id: taskLogId(),
    timestamp: now,
    action: 'task_reparented',
    taskId,
    actor: 'system',
    details: {
      oldParent,
      newParent: effectiveParentId,
      newType: task.type,
      ancestorsReopened,
      subtreeUpdated,
    },
    before: { parentId: oldParent },
    after: { parentId: effectiveParentId, type: task.type },
  });

  return {
    task: taskId,
    reparented: true,
    oldParent,
    newParent: effectiveParentId,
    newType: task.type,
    ancestorsReopened,
    subtreeUpdated,
  };
}

/**
 * Promote a subtask to task or task to root.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @param taskId - The task ID to promote
 * @returns Confirmation with previous parent and whether the type changed
 *
 * @remarks
 * Removes the task's parentId, making it a root-level task. If the task was
 * a "subtask", its type is changed to "task". No-op if the task is already root-level.
 *
 * @example
 * ```typescript
 * const result = await coreTaskPromote('/project', 'T025');
 * if (result.promoted) console.log('Detached from', result.previousParent);
 * ```
 *
 * @task T4790
 */
export async function coreTaskPromote(
  projectRoot: string,
  taskId: string,
): Promise<{
  task: string;
  promoted: boolean;
  previousParent: string | null;
  typeChanged: boolean;
}> {
  const accessor = await getTaskAccessor(projectRoot);

  const task = await accessor.loadSingleTask(taskId);
  if (!task) {
    throw new Error(`Task '${taskId}' not found`);
  }

  if (!task.parentId) {
    return { task: taskId, promoted: false, previousParent: null, typeChanged: false };
  }

  const oldParent = task.parentId;
  task.parentId = null;
  task.updatedAt = new Date().toISOString();

  let typeChanged = false;
  if (task.type === 'subtask') {
    task.type = 'task';
    typeChanged = true;
  }

  await accessor.upsertSingleTask(task);

  return { task: taskId, promoted: true, previousParent: oldParent, typeChanged };
}

/**
 * Reopen a completed task.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @param taskId - The completed task ID to reopen
 * @param params - Optional reopen options
 * @param params.status - Target status after reopening ("pending" or "active", default: "pending")
 * @param params.reason - Optional reason appended to the task's notes
 * @param params.regressionOf - Optional task ID this reopen is a regression of (AC2: regression_of path documented)
 * @param params.reopenAncestors - When true (default), reopen any done ancestors in the hierarchy (AC1)
 * @returns Confirmation with previous and new status, plus any ancestor IDs that were reopened
 *
 * @remarks
 * Only tasks with status "done" can be reopened. Preserves the prior `completedAt` timestamp
 * in the task's notes before clearing it (AC3: completion history preserved). When
 * `reopenAncestors` is true, all done ancestors are also set back to "pending" so the
 * hierarchy reflects the unsatisfied state (AC1: required unsatisfied child reopens ancestors).
 * When `regressionOf` is supplied, a note is appended that links the reopen to the original
 * completed task (AC2: regression_of path documented).
 *
 * @example
 * ```typescript
 * const result = await coreTaskReopen('/project', 'T033', {
 *   status: 'active',
 *   reason: 'Tests failed',
 *   regressionOf: 'T033',
 *   reopenAncestors: true,
 * });
 * console.log(`${result.previousStatus} -> ${result.newStatus}, ancestors: ${result.ancestorsReopened}`);
 * ```
 *
 * @task T4790
 * @task T10605
 */
export async function coreTaskReopen(
  projectRoot: string,
  taskId: string,
  params?: {
    status?: string;
    reason?: string;
    /** Task ID that this reopen is a regression of. Appended to notes for traceability. */
    regressionOf?: string;
    /** When true (default), reopen any done ancestors so the hierarchy is consistent. */
    reopenAncestors?: boolean;
  },
): Promise<{
  task: string;
  reopened: boolean;
  previousStatus: string;
  newStatus: string;
  /** IDs of ancestor tasks that were transitioned from done → pending. */
  ancestorsReopened: string[];
}> {
  const accessor = await getTaskAccessor(projectRoot);

  const task = await accessor.loadSingleTask(taskId);
  if (!task) {
    throw new Error(`Task '${taskId}' not found`);
  }

  if (task.status !== 'done') {
    throw new Error(
      `Task '${taskId}' is not completed (status: ${task.status}). Only done tasks can be reopened.`,
    );
  }

  const targetStatus = params?.status || 'pending';
  if (targetStatus !== 'pending' && targetStatus !== 'active') {
    throw new Error(`Invalid target status: ${targetStatus}. Must be 'pending' or 'active'.`);
  }

  const previousStatus = task.status;
  const previousCompletedAt = task.completedAt;
  const now = new Date().toISOString();

  task.status = targetStatus as TaskStatus;
  task.completedAt = undefined;
  task.updatedAt = now;

  if (!task.notes) task.notes = [];

  // AC3: preserve completion history — record the prior completedAt before clearing it
  if (previousCompletedAt) {
    task.notes.push(`[${now}] completion-history: completedAt=${previousCompletedAt}`);
  }

  // AC2: regression_of path — document which completed task this reopen traces back to.
  // Use the schema/AC spelling (`regression_of`) in persisted history so notes are grepable
  // and distinguish this lifecycle edge from free-form prose.
  if (params?.regressionOf) {
    task.notes.push(`[${now}] regression_of: ${params.regressionOf}`);
  }

  const reason = params?.reason;
  task.notes.push(`[${now}] Reopened from ${previousStatus}${reason ? ': ' + reason : ''}`);

  await accessor.upsertSingleTask(task);

  // AC1: reopen done ancestors so the hierarchy stays consistent
  const ancestorsReopened: string[] = [];
  const shouldReopenAncestors = params?.reopenAncestors !== false; // default true
  if (shouldReopenAncestors) {
    const ancestors = await accessor.getAncestorChain(taskId);
    for (const ancestor of ancestors) {
      if (ancestor.status === 'done') {
        const ancestorPreviousCompletedAt = ancestor.completedAt;
        ancestor.status = 'pending';
        ancestor.completedAt = undefined;
        ancestor.updatedAt = now;
        if (!ancestor.notes) ancestor.notes = [];
        // Preserve ancestor's completion history too
        if (ancestorPreviousCompletedAt) {
          ancestor.notes.push(
            `[${now}] completion-history: completedAt=${ancestorPreviousCompletedAt}`,
          );
        }
        ancestor.notes.push(`[${now}] Reopened by child ${taskId} (required unsatisfied child)`);
        await accessor.upsertSingleTask(ancestor);
        ancestorsReopened.push(ancestor.id);
      }
    }
  }

  return {
    task: taskId,
    reopened: true,
    previousStatus,
    newStatus: targetStatus,
    ancestorsReopened,
  };
}

/**
 * Change task position within its sibling group.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @param taskId - The task ID to reorder
 * @param position - Target 1-based position within the sibling group
 * @returns Confirmation with the new position and total sibling count
 *
 * @remarks
 * Reorders by adjusting `position` and `positionVersion` fields on all siblings.
 * Position is clamped to valid bounds. Uses bulk field updates for efficiency.
 *
 * @example
 * ```typescript
 * const result = await coreTaskReorder('/project', 'T012', 1);
 * console.log(`Moved to position ${result.newPosition} of ${result.totalSiblings}`);
 * ```
 *
 * @task T4790
 */
export async function coreTaskReorder(
  projectRoot: string,
  taskId: string,
  position: number,
): Promise<{ task: string; reordered: boolean; newPosition: number; totalSiblings: number }> {
  const accessor = await getTaskAccessor(projectRoot);

  const task = await accessor.loadSingleTask(taskId);
  if (!task) {
    throw new Error(`Task '${taskId}' not found`);
  }

  // Get siblings: tasks with same parentId
  const parentFilter = task.parentId ? { parentId: task.parentId } : {};
  const { tasks: siblingCandidates } = await accessor.queryTasks(parentFilter);
  // For root-level tasks (no parentId), filter to only those without a parentId
  const allSiblings = task.parentId
    ? siblingCandidates.sort(
        (a: TaskRecord, b: TaskRecord) => (a.position ?? 0) - (b.position ?? 0),
      )
    : siblingCandidates
        .filter((t: TaskRecord) => !t.parentId)
        .sort((a: TaskRecord, b: TaskRecord) => (a.position ?? 0) - (b.position ?? 0));

  const currentIndex = allSiblings.findIndex((t: TaskRecord) => t.id === taskId);
  const newIndex = Math.max(0, Math.min(position - 1, allSiblings.length - 1));

  allSiblings.splice(currentIndex, 1);
  allSiblings.splice(newIndex, 0, task);

  // Use bulk SQL for position updates (T025) — updateTaskFields is lighter than upsertSingleTask
  const now = new Date().toISOString();
  for (let i = 0; i < allSiblings.length; i++) {
    const sibling = allSiblings[i]!;
    const newPos = i + 1;
    const newVersion = ((sibling.positionVersion as number | undefined) ?? 0) + 1;
    // Only update if position actually changed
    if (sibling.position !== newPos || sibling.id === taskId) {
      await accessor.updateTaskFields(sibling.id, {
        position: newPos,
        positionVersion: newVersion,
        updatedAt: now,
      });
    }
    sibling.position = newPos;
    sibling.positionVersion = newVersion;
    sibling.updatedAt = now;
  }

  return {
    task: taskId,
    reordered: true,
    newPosition: newIndex + 1,
    totalSiblings: allSiblings.length,
  };
}

/**
 * Restore a cancelled task back to pending.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @param taskId - The cancelled task ID to restore
 * @param params - Optional restore options
 * @param params.cascade - When true, also restores cancelled child tasks recursively
 * @param params.notes - Optional note appended to each restored task's notes array
 * @returns The task ID, list of restored task IDs, and total count
 *
 * @remarks
 * Only tasks with status "cancelled" can be restored. Restored tasks are set to
 * "pending" with cancellation metadata cleared. A timestamped note is appended.
 *
 * @example
 * ```typescript
 * const { restored, count } = await coreTaskRestore('/project', 'T099', { cascade: true });
 * console.log(`Restored ${count} tasks:`, restored);
 * ```
 *
 * @task T4790
 */
export async function coreTaskRestore(
  projectRoot: string,
  taskId: string,
  params?: { cascade?: boolean; notes?: string },
): Promise<{ task: string; restored: string[]; count: number }> {
  const accessor = await getTaskAccessor(projectRoot);

  const task = await accessor.loadSingleTask(taskId);
  if (!task) {
    throw new Error(`Task '${taskId}' not found`);
  }

  if (task.status !== 'cancelled') {
    throw new Error(
      `Task '${taskId}' is not cancelled (status: ${task.status}). Only cancelled tasks can be restored.`,
    );
  }

  const tasksToRestore: TaskRecord[] = [task];
  if (params?.cascade) {
    const findCancelledChildren = async (parentId: string): Promise<void> => {
      const children = await accessor.getChildren(parentId);
      const cancelledChildren = children.filter((t: TaskRecord) => t.status === 'cancelled');
      for (const child of cancelledChildren) {
        tasksToRestore.push(child);
        await findCancelledChildren(child.id);
      }
    };
    await findCancelledChildren(taskId);
  }

  const now = new Date().toISOString();
  const restored: string[] = [];

  for (const t of tasksToRestore) {
    t.status = 'pending';
    t.cancelledAt = undefined;
    t.cancellationReason = undefined;
    t.updatedAt = now;
    // T871: when a task was cancelled, pipelineStage was advanced to the
    // terminal `cancelled` marker. On restore we re-enter the active chain
    // — reset to a sensible default so `updateTask`'s forward-only
    // validator doesn't treat the task as permanently terminal.
    if (t.pipelineStage === 'cancelled') {
      t.pipelineStage = t.type === 'epic' ? 'research' : 'implementation';
    }

    if (!t.notes) t.notes = [];
    t.notes.push(`[${now}] Restored from cancelled${params?.notes ? ': ' + params.notes : ''}`);
    restored.push(t.id);
  }

  for (const t of tasksToRestore) {
    await accessor.upsertSingleTask(t);
  }

  return { task: taskId, restored, count: restored.length };
}

/**
 * Move an archived task back to active tasks.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @param taskId - The archived task ID to unarchive
 * @param params - Optional unarchive options
 * @param params.status - Target status for the restored task (default: "pending")
 * @param params.preserveStatus - When true, keeps the task's original archived status
 * @returns Confirmation with task ID, title, and resulting status
 *
 * @remarks
 * Removes the task from the archive file and upserts it into the active task store.
 * Throws if the task already exists in active tasks or is not found in the archive.
 *
 * @example
 * ```typescript
 * const result = await coreTaskUnarchive('/project', 'T055', { status: 'active' });
 * console.log(`${result.title} is now ${result.status}`);
 * ```
 *
 * @task T4790
 */
export async function coreTaskUnarchive(
  projectRoot: string,
  taskId: string,
  params?: { status?: string; preserveStatus?: boolean },
): Promise<{ task: string; unarchived: boolean; title: string; status: string }> {
  const accessor = await getTaskAccessor(projectRoot);

  // Check if task already exists in active tasks
  const existingTask = await accessor.taskExists(taskId);
  if (existingTask) {
    throw new Error(`Task '${taskId}' already exists in active tasks`);
  }

  const archive = await accessor.loadArchive();
  if (!archive?.archivedTasks) {
    throw new Error('No archive file found');
  }

  const taskIndex = archive.archivedTasks.findIndex((t: TaskRecord) => t.id === taskId);
  if (taskIndex === -1) {
    throw new Error(`Task '${taskId}' not found in archive`);
  }

  const task = archive.archivedTasks[taskIndex]!;

  // Remove archive metadata if present on the raw record
  if ('_archive' in task) {
    Reflect.deleteProperty(task, '_archive');
  }

  if (!params?.preserveStatus) {
    const rawStatus = params?.status || 'pending';
    if (!(TASK_STATUSES as readonly string[]).includes(rawStatus)) {
      throw new Error(`Invalid status: ${rawStatus}`);
    }
    // rawStatus is validated above as a member of TASK_STATUSES
    const targetStatus = rawStatus as TaskStatus;
    if (targetStatus !== 'done') {
      task.completedAt = undefined;
    }
  }

  task.updatedAt = new Date().toISOString();

  // Fine-grained: upsert the restored task (now active)
  await accessor.upsertSingleTask(task);

  return { task: taskId, unarchived: true, title: task.title, status: task.status };
}
