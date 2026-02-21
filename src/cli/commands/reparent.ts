/**
 * CLI reparent command - move a task to a different parent.
 * Delegates to src/core/tasks/reparent.ts (canonical implementation).
 *
 * @task T4807
 * @epic T4454
 */

import { Command } from 'commander';
import { formatError } from '../../core/output.js';
import { cliOutput } from '../renderers/index.js';
import { CleoError } from '../../core/errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { getAccessor } from '../../store/data-accessor.js';
import { reparentTask } from '../../core/tasks/reparent.js';

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
        const data = await accessor.loadTaskFile();

        const result = await reparentTask(data, {
          taskId,
          newParentId: targetParent || null,
        });

        await accessor.saveTaskFile(data);

        cliOutput({
          task: taskId,
          reparented: true,
          oldParent: result.oldParent,
          newParent: result.newParent,
          newType: result.newType,
        }, { command: 'reparent' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
