/**
 * CLI focus command group (backward compatibility).
 *
 * Preserved as aliases for the new start/stop/current commands.
 * - `cleo focus show`   → `cleo current`
 * - `cleo focus set`    → `cleo start`
 * - `cleo focus clear`  → `cleo stop`
 * - `cleo focus history` → work history
 *
 * @task T4756
 * @epic T4732
 */

import { Command } from 'commander';
import { getAccessor } from '../../store/data-accessor.js';
import * as taskWork from '../../core/task-work/index.js';
import { formatError } from '../../core/output.js';
import { cliOutput } from '../renderers/index.js';
import { CleoError } from '../../core/errors.js';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * Register the focus command group (backward-compat aliases).
 * @task T4756
 */
export function registerFocusCommand(program: Command): void {
  const focus = program
    .command('focus')
    .description('Manage task focus (deprecated: use start/stop/current)');

  focus
    .command('show')
    .description('Show current task (use "cleo current" instead)')
    .action(async () => {
      await dispatchFromCli('query', 'tasks', 'current', {}, { command: 'focus' });
    });

  focus
    .command('set <taskId>')
    .description('Start working on a task (use "cleo start" instead)')
    .action(async (taskId: string) => {
      await dispatchFromCli('mutate', 'tasks', 'start', { taskId }, { command: 'focus' });
    });

  focus
    .command('clear')
    .description('Stop working on current task (use "cleo stop" instead)')
    .action(async () => {
      await dispatchFromCli('mutate', 'tasks', 'stop', {}, { command: 'focus' });
    });

  focus
    .command('history')
    .description('Show work history')
    .action(async () => {
      try {
        const accessor = await getAccessor();
        const result = await taskWork.getWorkHistory(undefined, accessor);
        cliOutput({ history: result }, { command: 'focus' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
