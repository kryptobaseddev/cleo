/**
 * CLI verify command - manage verification gates for tasks.
 * Routes through dispatch layer to check.gate.verify.
 * @task T4454
 */

import type { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

export function registerVerifyCommand(program: Command): void {
  program
    .command('verify <task-id>')
    .description('View or modify verification gates for a task')
    .option('--gate <name>', 'Set specific gate')
    .option('--value <bool>', 'Gate value: true or false', 'true')
    .option('--agent <name>', 'Agent setting the gate')
    .option('--all', 'Mark all required gates as passed')
    .option('--reset', 'Reset verification to initial state')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'check',
        'gate.status',
        {
          taskId,
          gate: opts['gate'] as string | undefined,
          value: opts['value'] === 'false' ? false : opts['gate'] ? true : undefined,
          agent: opts['agent'] as string | undefined,
          all: opts['all'] as boolean | undefined,
          reset: opts['reset'] as boolean | undefined,
        },
        { command: 'verify' },
      );
    });
}
