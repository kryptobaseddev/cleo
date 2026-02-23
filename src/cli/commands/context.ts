/**
 * CLI context command group - context window monitoring.
 * @task T4535
 * @epic T4454
 */

import { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

export function registerContextCommand(program: Command): void {
  const context = program
    .command('context')
    .description('Monitor context window usage for agent safeguard system');

  context
    .command('status')
    .description('Show current context state (default)')
    .option('--session <id>', 'Check specific CLEO session')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli('query', 'admin', 'context', {
        action: 'status', session: opts['session'],
      }, { command: 'context' });
    });

  context
    .command('check')
    .description('Check threshold, return exit code for scripting')
    .option('--session <id>', 'Check specific CLEO session')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli('query', 'admin', 'context', {
        action: 'check', session: opts['session'],
      }, { command: 'context' });
    });

  context
    .command('list')
    .description('List all context state files (multi-session)')
    .action(async () => {
      await dispatchFromCli('query', 'admin', 'context', {
        action: 'list',
      }, { command: 'context' });
    });
}
