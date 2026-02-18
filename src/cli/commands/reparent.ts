/**
 * CLI reparent command - move a task to a different parent.
 * @task T4454
 */

import { Command } from 'commander';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { getAccessor } from '../../store/data-accessor.js';
import { computeChecksum } from '../../store/json.js';
import { loadConfig } from '../../core/config.js';
import type { Task } from '../../types/task.js';

/**
 * Calculate depth of a task in the hierarchy.
 */
function getDepth(taskId: string, taskMap: Map<string, Task>): number {
  let depth = 0;
  let current = taskMap.get(taskId);
  while (current?.parentId) {
    depth++;
    current = taskMap.get(current.parentId);
    if (depth > 10) break; // safety valve
  }
  return depth;
}

/**
 * Check if moving child under newParent would create a circular reference.
 */
function wouldCreateCircular(childId: string, newParentId: string, taskMap: Map<string, Task>): boolean {
  let current = taskMap.get(newParentId);
  while (current) {
    if (current.id === childId) return true;
    if (!current.parentId) break;
    current = taskMap.get(current.parentId);
  }
  return false;
}

export function registerReparentCommand(program: Command): void {
  program
    .command('reparent <task-id>')
    .description('Move task to a different parent in hierarchy')
    .requiredOption('--to <parent-id>', 'Target parent task ID (or "" to make root)')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      try {
        const idPattern = /^T\d{3,}$/;
        if (!idPattern.test(taskId)) {
          throw new CleoError(ExitCode.INVALID_INPUT, `Invalid task ID: ${taskId}`);
        }

        const targetParent = (opts['to'] as string) || '';

        if (targetParent && !idPattern.test(targetParent)) {
          throw new CleoError(ExitCode.INVALID_INPUT, `Invalid parent ID: ${targetParent}`);
        }

        const accessor = await getAccessor();
        const data = await accessor.loadTodoFile();

        const taskMap = new Map(data.tasks.map((t) => [t.id, t]));
        const task = taskMap.get(taskId);
        if (!task) {
          throw new CleoError(ExitCode.NOT_FOUND, `Task ${taskId} not found`);
        }

        // Handle removing parent (promote to root)
        if (!targetParent) {
          task.parentId = null;
          task.type = task.type === 'subtask' ? 'task' : task.type;
          task.updatedAt = new Date().toISOString();

          data._meta.checksum = computeChecksum(data.tasks);
          data.lastUpdated = new Date().toISOString();
          await accessor.saveTodoFile(data);

          console.log(formatSuccess({
            task: taskId,
            reparented: true,
            newParent: null,
          }));
          return;
        }

        const newParent = taskMap.get(targetParent);
        if (!newParent) {
          throw new CleoError(ExitCode.PARENT_NOT_FOUND, `Parent task ${targetParent} not found`);
        }

        // Validate parent type
        if (newParent.type === 'subtask') {
          throw new CleoError(ExitCode.INVALID_PARENT_TYPE, `Cannot parent under subtask ${targetParent}`);
        }

        // Check circular reference
        if (wouldCreateCircular(taskId, targetParent, taskMap)) {
          throw new CleoError(ExitCode.CIRCULAR_REFERENCE, `Moving ${taskId} under ${targetParent} would create circular reference`);
        }

        // Check depth limit
        const config = await loadConfig();
        const maxDepth = config.hierarchy.maxDepth;
        const parentDepth = getDepth(targetParent, taskMap);
        if (parentDepth + 1 >= maxDepth) {
          throw new CleoError(ExitCode.DEPTH_EXCEEDED, `Move would exceed max depth of ${maxDepth}`);
        }

        // Check sibling limit
        const maxSiblings = config.hierarchy.maxSiblings;
        const siblingCount = data.tasks.filter((t) => t.parentId === targetParent).length;
        if (siblingCount >= maxSiblings) {
          throw new CleoError(ExitCode.SIBLING_LIMIT, `Parent ${targetParent} already has ${siblingCount} children (max: ${maxSiblings})`);
        }

        // Perform reparent
        const oldParent = task.parentId;
        task.parentId = targetParent;

        // Update type based on new depth
        const newDepth = parentDepth + 1;
        if (newDepth === 1) task.type = 'task';
        else if (newDepth >= 2) task.type = 'subtask';

        task.updatedAt = new Date().toISOString();

        data._meta.checksum = computeChecksum(data.tasks);
        data.lastUpdated = new Date().toISOString();

        await accessor.saveTodoFile(data);

        console.log(formatSuccess({
          task: taskId,
          reparented: true,
          oldParent: oldParent ?? null,
          newParent: targetParent,
          newType: task.type,
        }));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
