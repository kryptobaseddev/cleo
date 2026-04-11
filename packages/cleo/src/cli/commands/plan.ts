/**
 * CLI plan command - composite planning view.
 * @task T4914
 * @epic T4454
 */

import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';

export function registerPlanCommand(program: Command): void {
  program
    .command('plan')
    .description(
      'Task prioritization view: in-progress epics, ready tasks, blocked tasks, open bugs with scoring. Use when deciding what to work on next.',
    )
    .action(async () => {
      await dispatchFromCli(
        'query',
        'tasks',
        'plan',
        {},
        { command: 'plan', operation: 'tasks.plan' },
      );
    });
}
