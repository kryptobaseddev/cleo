/**
 * Task update logic.
 * @task T4461
 * @epic T4454
 */

import type { DataAccessor } from '../store/data-accessor.js';
import { getAccessor } from '../store/data-accessor.js';
import { safeAppendLog } from '../store/data-safety-central.js';
import { ExitCode } from '@cleocode/contracts';
import type { Task, TaskPriority, TaskSize, TaskStatus, TaskType } from '@cleocode/contracts';
import { CleoError } from '../errors.js';
import {
  normalizePriority,
  validateLabels,
  validateSize,
  validateStatus,
  validateTaskType,
  validateTitle,
} from './add.js';
import { completeTask } from './complete.js';
import { loadConfig } from '../config.js';
import { resolveHierarchyPolicy } from './hierarchy-policy.js';

const NON_STATUS_DONE_FIELDS: Array<keyof Omit<UpdateTaskOptions, 'taskId' | 'status'>> = [
  'title',
  'priority',
  'type',
  'size',
  'phase',
  'description',
  'labels',
  'addLabels',
  'removeLabels',
  'depends',
  'addDepends',
  'removeDepends',
  'notes',
  'acceptance',
  'files',
  'blockedBy',
  'parentId',
  'noAutoComplete',
];

function hasNonStatusDoneFields(options: UpdateTaskOptions): boolean {
  return NON_STATUS_DONE_FIELDS.some((field) => options[field] !== undefined);
}

/** Options for updating a task. */
export interface UpdateTaskOptions {
  taskId: string;
  title?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  type?: TaskType;
  size?: TaskSize;
  phase?: string;
  description?: string;
  labels?: string[];
  addLabels?: string[];
  removeLabels?: string[];
  depends?: string[];
  addDepends?: string[];
  removeDepends?: string[];
  notes?: string;
  acceptance?: string[];
  files?: string[];
  blockedBy?: string;
  parentId?: string | null;
  noAutoComplete?: boolean;
}

/** Result of updating a task. */
export interface UpdateTaskResult {
  task: Task;
  changes: string[];
}

/**
 * Update a task's fields.
 * @task T4461
 */
export async function updateTask(
  options: UpdateTaskOptions,
  cwd?: string,
  accessor?: DataAccessor,
): Promise<UpdateTaskResult> {
  const acc = accessor ?? (await getAccessor(cwd));
  const task = await acc.loadSingleTask(options.taskId);
  if (!task) {
    throw new CleoError(ExitCode.NOT_FOUND, `Task not found: ${options.taskId}`, {
      fix: `Use 'cleo find "${options.taskId}"' to search`,
    });
  }
  const changes: string[] = [];
  const now = new Date().toISOString();

  const isStatusOnlyDoneTransition =
    options.status === 'done' && task.status !== 'done' && !hasNonStatusDoneFields(options);

  if (isStatusOnlyDoneTransition) {
    const result = await completeTask({ taskId: options.taskId }, cwd, accessor);
    return { task: result.task, changes: ['status'] };
  }

  if (options.status === 'done' && task.status !== 'done') {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      'status=done must use complete flow; do not combine with other update fields',
      {
        fix: `Run 'cleo complete ${options.taskId}' first, then apply additional updates with 'cleo update ${options.taskId} ...'`,
      },
    );
  }

  // Update fields
  if (options.title !== undefined) {
    validateTitle(options.title);
    task.title = options.title;
    changes.push('title');
  }

  if (options.status !== undefined) {
    validateStatus(options.status);
    const oldStatus = task.status;
    task.status = options.status;
    changes.push('status');
    if (options.status === 'done' && oldStatus !== 'done') {
      task.completedAt = now;
    }
    if (options.status === 'cancelled' && oldStatus !== 'cancelled') {
      task.cancelledAt = now;
    }
  }

  if (options.priority !== undefined) {
    const normalizedPriority = normalizePriority(options.priority);
    task.priority = normalizedPriority;
    changes.push('priority');
  }

  if (options.type !== undefined) {
    validateTaskType(options.type);
    task.type = options.type;
    changes.push('type');
  }

  if (options.size !== undefined) {
    validateSize(options.size);
    task.size = options.size;
    changes.push('size');
  }

  if (options.phase !== undefined) {
    task.phase = options.phase;
    changes.push('phase');
  }

  if (options.description !== undefined) {
    task.description = options.description;
    changes.push('description');
  }

  if (options.labels !== undefined) {
    if (options.labels.length) validateLabels(options.labels);
    task.labels = options.labels;
    changes.push('labels');
  }

  if (options.addLabels?.length) {
    validateLabels(options.addLabels);
    const existing = new Set(task.labels ?? []);
    for (const l of options.addLabels) existing.add(l.trim());
    task.labels = [...existing];
    changes.push('labels');
  }

  if (options.removeLabels?.length) {
    const toRemove = new Set(options.removeLabels.map((l) => l.trim()));
    task.labels = (task.labels ?? []).filter((l) => !toRemove.has(l));
    changes.push('labels');
  }

  if (options.depends !== undefined) {
    task.depends = options.depends;
    changes.push('depends');
  }

  if (options.addDepends?.length) {
    const existing = new Set(task.depends ?? []);
    for (const d of options.addDepends) existing.add(d.trim());
    task.depends = [...existing];
    changes.push('depends');
  }

  if (options.removeDepends?.length) {
    const toRemove = new Set(options.removeDepends.map((d) => d.trim()));
    task.depends = (task.depends ?? []).filter((d) => !toRemove.has(d));
    changes.push('depends');
  }

  if (options.notes !== undefined) {
    const timestampedNote = `${new Date()
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d+Z$/, ' UTC')}: ${options.notes}`;
    if (!task.notes) task.notes = [];
    task.notes.push(timestampedNote);
    changes.push('notes');
  }

  if (options.acceptance !== undefined) {
    task.acceptance = options.acceptance;
    changes.push('acceptance');
  }

  if (options.files !== undefined) {
    task.files = options.files;
    changes.push('files');
  }

  if (options.blockedBy !== undefined) {
    task.blockedBy = options.blockedBy;
    changes.push('blockedBy');
  }

  if (options.noAutoComplete !== undefined) {
    task.noAutoComplete = options.noAutoComplete;
    changes.push('noAutoComplete');
  }

  // Handle parentId change (reparent) using targeted queries
  // Supports: parentId="T001" to set parent, parentId=null or parentId="" to promote to root
  if (options.parentId !== undefined) {
    const newParentId = options.parentId || null; // normalize "" to null
    const currentParentId = task.parentId ?? null;

    if (newParentId !== currentParentId) {
      const originalType = task.type;

      if (!newParentId) {
        // Promote to root
        task.parentId = null;
        if (task.type === 'subtask') task.type = 'task';
        changes.push('parentId');
        if (task.type !== originalType) changes.push('type');
      } else {
        // Validate target parent exists
        const newParent = await acc.loadSingleTask(newParentId);
        if (!newParent) {
          throw new CleoError(ExitCode.PARENT_NOT_FOUND, `Parent task ${newParentId} not found`);
        }
        if (newParent.type === 'subtask') {
          throw new CleoError(
            ExitCode.INVALID_PARENT_TYPE,
            `Cannot parent under subtask '${newParentId}'`,
          );
        }

        // Circular reference check: ensure newParentId is not a descendant of taskId
        const subtree = await acc.getSubtree(options.taskId);
        if (subtree.some((t) => t.id === newParentId)) {
          throw new CleoError(
            ExitCode.CIRCULAR_REFERENCE,
            `Moving '${options.taskId}' under '${newParentId}' would create a circular reference`,
          );
        }

        // Depth check
        const ancestors = await acc.getAncestorChain(newParentId);
        const parentDepth = ancestors.length;
        const config = await loadConfig(cwd);
        const policy = resolveHierarchyPolicy(config);
        if (parentDepth + 1 >= policy.maxDepth) {
          throw new CleoError(
            ExitCode.DEPTH_EXCEEDED,
            `Maximum nesting depth ${policy.maxDepth} would be exceeded`,
          );
        }

        // Apply reparent
        task.parentId = newParentId;
        const newDepth = parentDepth + 1;
        if (newDepth === 1) task.type = 'task';
        else if (newDepth >= 2) task.type = 'subtask';

        changes.push('parentId');
        if (task.type !== originalType) changes.push('type');
      }
    }
  }

  if (changes.length === 0) {
    throw new CleoError(ExitCode.NO_CHANGE, 'No changes specified');
  }

  task.updatedAt = now;

  await acc.upsertSingleTask(task);
  await safeAppendLog(
    acc,
    {
      id: `log-${Math.floor(Date.now() / 1000)}-${(await import('node:crypto')).randomBytes(3).toString('hex')}`,
      timestamp: new Date().toISOString(),
      action: 'task_updated',
      taskId: options.taskId,
      actor: 'system',
      details: { changes, title: task.title },
      before: null,
      after: { changes, title: task.title },
    },
    cwd,
  );

  return { task, changes };
}
