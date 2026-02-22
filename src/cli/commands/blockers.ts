/**
 * CLI blockers command - show blocked tasks and analyze blocking chains.
 * @task T4454
 */

import { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

export function registerBlockersCommand(program: Command): void {
  program
    .command('blockers')
    .description('Show blocked tasks and analyze blocking chains')
    .option('--analyze', 'Show full blocking chain analysis')
    .action(async (opts: Record<string, unknown>) => {
      const analyze = !!opts['analyze'];
      await dispatchFromCli('query', 'tasks', 'blockers', { analyze }, { command: 'blockers' });
    });
}
