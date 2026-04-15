/**
 * CLI diagnostics command group — dispatches to the diagnostics domain.
 *
 * Provides CLI access to:
 *   cleo diagnostics enable   — opt-in to anonymous telemetry
 *   cleo diagnostics disable  — opt-out
 *   cleo diagnostics status   — show current config
 *   cleo diagnostics analyze  — surface failing/slow commands, push to BRAIN
 *   cleo diagnostics export   — JSON dump for external analysis
 *
 * @task T624
 */

import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';

/** Register the diagnostics command group. */
export function registerDiagnosticsCommand(program: Command): void {
  const diag = program
    .command('diagnostics')
    .description(
      'Autonomous self-improvement telemetry — opt-in command analytics that feed BRAIN observations',
    );

  diag
    .command('enable')
    .description('Opt in to anonymous command telemetry for self-improvement analysis')
    .action(async () => {
      await dispatchFromCli('mutate', 'diagnostics', 'enable', {}, { command: 'diagnostics' });
    });

  diag
    .command('disable')
    .description('Opt out of telemetry collection (existing data is preserved)')
    .action(async () => {
      await dispatchFromCli('mutate', 'diagnostics', 'disable', {}, { command: 'diagnostics' });
    });

  diag
    .command('status')
    .description('Show telemetry opt-in state and database path')
    .action(async () => {
      await dispatchFromCli('query', 'diagnostics', 'status', {}, { command: 'diagnostics' });
    });

  diag
    .command('analyze')
    .description(
      'Aggregate telemetry patterns: top failing commands, slowest commands, BRAIN observations',
    )
    .option('-d, --days <number>', 'Analysis window in days (default: 30)', parseInt)
    .option('--no-brain', 'Skip pushing high-signal patterns to BRAIN')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'diagnostics',
        'analyze',
        {
          days: typeof opts['days'] === 'number' ? opts['days'] : 30,
          noBrain: opts['brain'] === false,
        },
        { command: 'diagnostics' },
      );
    });

  diag
    .command('export')
    .description('Export all telemetry events as a JSON array for external analysis')
    .option('-d, --days <number>', 'Limit to last N days (default: all)', parseInt)
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'diagnostics',
        'export',
        {
          days: typeof opts['days'] === 'number' ? opts['days'] : undefined,
        },
        { command: 'diagnostics' },
      );
    });
}
