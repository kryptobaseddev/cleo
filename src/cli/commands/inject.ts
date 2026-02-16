/**
 * CLI inject command - prepare tasks for TodoWrite injection.
 * @task T4539
 * @epic T4454
 */

import { Command } from 'commander';
import {
  injectTasks,
} from '../../core/inject/index.js';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';

/**
 * Register the inject command.
 * @task T4539
 */
export function registerInjectCommand(program: Command): void {
  program
    .command('inject')
    .description('Inject/prepare tasks for TodoWrite format (session start)')
    .option('--max-tasks <n>', 'Maximum tasks to inject', '8')
    .option('--focused-only', 'Only inject the focused task')
    .option('--phase <slug>', 'Filter tasks to specific phase')
    .option('--output <file>', 'Write to file instead of stdout')
    .option('--save-state', 'Save session state for extraction', true)
    .option('--dry-run', 'Preview without writing')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const result = await injectTasks({
          maxTasks: opts['maxTasks'] ? Number(opts['maxTasks']) : 8,
          focusedOnly: opts['focusedOnly'] as boolean | undefined,
          phase: opts['phase'] as string | undefined,
          output: opts['output'] as string | undefined,
          saveState: opts['saveState'] as boolean | undefined,
          dryRun: opts['dryRun'] as boolean | undefined,
        });
        console.log(formatSuccess(result));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
