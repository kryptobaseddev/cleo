/**
 * CLI analyze command - task triage with leverage scoring.
 * @task T4538
 * @epic T4454
 */

import { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * Register the analyze command.
 * @task T4538
 */
export function registerAnalyzeCommand(program: Command): void {
  program
    .command('analyze')
    .description('Task triage with leverage scoring and bottleneck detection')
    .option('--auto-start', 'Automatically start working on recommended task')
    .action(async () => {
      await dispatchFromCli('query', 'tasks', 'analyze', {}, { command: 'analyze' });
    });
}
