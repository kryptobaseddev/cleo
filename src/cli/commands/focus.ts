/**
 * CLI focus command group.
 * @task T4462
 * @epic T4454
 */

import { Command } from 'commander';
import { getStore } from '../../store/index.js';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';

/**
 * Register the focus command group.
 * @task T4462
 */
export function registerFocusCommand(program: Command): void {
  const focus = program
    .command('focus')
    .description('Manage task focus');

  focus
    .command('show')
    .description('Show current focus')
    .action(async () => {
      try {
        const store = await getStore();
        const result = await store.showFocus();
        console.log(formatSuccess(result));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  focus
    .command('set <taskId>')
    .description('Set focus to a task')
    .action(async (taskId: string) => {
      try {
        const store = await getStore();
        const result = await store.richSetFocus(taskId);
        console.log(formatSuccess(result));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  focus
    .command('clear')
    .description('Clear current focus')
    .action(async () => {
      try {
        const store = await getStore();
        const result = await store.richClearFocus();
        console.log(formatSuccess(result));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  focus
    .command('history')
    .description('Show focus history')
    .action(async () => {
      try {
        const store = await getStore();
        const result = await store.getFocusHistory();
        console.log(formatSuccess({ history: result }));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
