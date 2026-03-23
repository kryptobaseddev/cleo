/**
 * CLI exists command - check if a task ID exists.
 *
 * Fix #68: Calls getTask() from core directly instead of dispatching through
 * MCP (tasks.exists was never registered in the operation registry).
 *
 * @task T4454
 */

import { ExitCode } from '@cleocode/contracts';
import { getTask, resolveProjectRoot } from '@cleocode/core/internal';
import type { ShimCommand as Command } from '../commander-shim.js';
import { cliOutput } from '../renderers/index.js';

/**
 * Register the exists command.
 *
 * @param program - Root CLI program instance.
 *
 * @example
 * ```ts
 * registerExistsCommand(rootCommand);
 * // cleo exists T001 → exit 0 if found, exit 4 if not
 * ```
 */
export function registerExistsCommand(program: Command): void {
  program
    .command('exists <task-id>')
    .description('Check if a task ID exists (exit 0=exists, 4=not found)')
    .option('--verbose', 'Show task title and status when found')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      const cwd = resolveProjectRoot();
      let task: Awaited<ReturnType<typeof getTask>>;

      try {
        task = await getTask(taskId, cwd);
      } catch (err) {
        console.error(`exists: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(ExitCode.GENERAL_ERROR);
      }

      if (!task) {
        const data = { exists: false, taskId };
        cliOutput(data, { command: 'exists', operation: 'tasks.exists' });
        process.exit(ExitCode.NOT_FOUND);
      }

      const data: Record<string, unknown> = { exists: true, taskId };
      if (opts['verbose']) {
        data['title'] = task.title;
        data['status'] = task.status;
      }

      cliOutput(data, { command: 'exists', operation: 'tasks.exists' });
    });
}
