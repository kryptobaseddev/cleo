/**
 * CLI exists command - check if a task ID exists.
 * @task T4454
 */

import { Command } from 'commander';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { readJson } from '../../store/json.js';
import { getTodoPath, getArchivePath } from '../../core/paths.js';
import type { TodoFile } from '../../types/task.js';

/**
 * Check if a task exists in a todo file.
 */
async function taskExistsInTodoFile(taskId: string, filePath: string): Promise<boolean> {
  const data = await readJson<TodoFile>(filePath);
  if (!data) return false;
  return data.tasks.some((t) => t.id === taskId);
}

/**
 * Check if a task exists in the archive file.
 */
async function taskExistsInArchive(taskId: string, filePath: string): Promise<boolean> {
  const data = await readJson<{ archivedTasks?: Array<{ id: string }> }>(filePath);
  if (!data?.archivedTasks) return false;
  return data.archivedTasks.some((t) => t.id === taskId);
}

export function registerExistsCommand(program: Command): void {
  program
    .command('exists <task-id>')
    .description('Check if a task ID exists (exit 0=exists, 4=not found)')
    .option('--include-archive', 'Search archive file too')
    .option('--verbose', 'Show which file contains the task')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      try {
        const idPattern = /^T\d{3,}$/;
        if (!idPattern.test(taskId)) {
          throw new CleoError(ExitCode.INVALID_INPUT, `Invalid task ID format: ${taskId} (expected: T001, T002, etc.)`, {
            fix: 'Task IDs start with T followed by 3+ digits',
          });
        }

        const todoPath = getTodoPath();
        let found = false;
        let location = '';

        if (await taskExistsInTodoFile(taskId, todoPath)) {
          found = true;
          location = 'todo.json';
        }

        if (!found && opts['includeArchive']) {
          const archivePath = getArchivePath();
          if (await taskExistsInArchive(taskId, archivePath)) {
            found = true;
            location = 'todo-archive.json';
          }
        }

        if (found) {
          console.log(formatSuccess({
            exists: true,
            taskId,
            location,
          }));
        } else {
          console.log(formatSuccess({
            exists: false,
            taskId,
            searchedArchive: !!opts['includeArchive'],
          }));
          process.exit(ExitCode.NOT_FOUND);
        }
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
