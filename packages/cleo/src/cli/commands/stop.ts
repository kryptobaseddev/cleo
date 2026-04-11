/**
 * CLI stop command - stop working on the current task.
 * @task T4756
 * @epic T4732
 */

import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';

/**
 * Register the stop command.
 * @task T4756
 * @task T4666
 */
export function registerStopCommand(program: Command): void {
  program
    .command('stop')
    .description(
      'Stop working on the current task (clears the active task, returns {cleared: boolean, previousTask: string|null})',
    )
    .action(async () => {
      await dispatchFromCli('mutate', 'tasks', 'stop', {}, { command: 'stop' });
    });
}
