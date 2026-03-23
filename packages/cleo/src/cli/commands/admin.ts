/**
 * CLI admin command group — dispatches to the admin domain.
 *
 * Provides CLI access to admin.version, admin.health, admin.stats,
 * admin.runtime, admin.smoke via `cleo admin <subcommand>`.
 *
 * @task T132
 */

import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';

/** Register the admin command group. */
export function registerAdminCommand(program: Command): void {
  const admin = program.command('admin').description('System administration and diagnostics');

  admin
    .command('version')
    .description('Show CLEO version')
    .action(async () => {
      await dispatchFromCli('query', 'admin', 'version', {}, { command: 'admin' });
    });

  admin
    .command('health')
    .description('Run system health check')
    .option('--detailed', 'Show detailed results')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'admin',
        'health',
        { detailed: opts['detailed'] },
        { command: 'admin' },
      );
    });

  admin
    .command('stats')
    .description('Show project statistics')
    .option('--period <days>', 'Time period in days')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'admin',
        'stats',
        { period: opts['period'] ? Number(opts['period']) : undefined },
        { command: 'admin' },
      );
    });

  admin
    .command('runtime')
    .description('Show runtime diagnostics')
    .option('--detailed', 'Show detailed runtime info')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'admin',
        'runtime',
        { detailed: opts['detailed'] },
        { command: 'admin' },
      );
    });

  admin
    .command('smoke')
    .description('Run operational smoke tests across all domains')
    .action(async () => {
      await dispatchFromCli('query', 'admin', 'smoke', {}, { command: 'admin' });
    });
}
