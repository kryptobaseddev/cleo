/**
 * CLI plan command - composite planning view.
 * @task T4914
 * @epic T4454
 */

import { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

export function registerPlanCommand(program: Command): void {
  program
    .command('plan')
    .description('Composite planning view: in-progress epics, ready tasks, blocked tasks, open bugs')
    .action(async () => {
      await dispatchFromCli('query', 'tasks', 'plan', {}, { command: 'plan', operation: 'tasks.plan' });
    });
}
