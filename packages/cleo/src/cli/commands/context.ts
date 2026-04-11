/**
 * CLI context command group - context window monitoring.
 * @task T4535
 * @epic T4454
 */

import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';

export function registerContextCommand(program: Command): void {
  const context = program
    .command('context')
    .description('Monitor context window usage for agent safeguard system');

  context
    .command('status', { isDefault: true })
    .description('Show current context state (default)')
    .option('--session <id>', 'Check specific CLEO session')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'admin',
        'context',
        {
          action: 'status',
          session: opts['session'],
        },
        { command: 'context' },
      );
    });

  context
    .command('check')
    .description('Show context window state (same as status)')
    .option('--session <id>', 'Check specific CLEO session')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'admin',
        'context',
        {
          action: 'check',
          session: opts['session'],
        },
        { command: 'context' },
      );
    });

  context
    .command('list')
    .description('Show context window state including all sessions')
    .action(async () => {
      await dispatchFromCli(
        'query',
        'admin',
        'context',
        {
          action: 'list',
        },
        { command: 'context' },
      );
    });
}
