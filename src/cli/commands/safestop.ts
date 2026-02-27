/**
 * CLI safestop command - graceful shutdown for agents approaching context limits.
 * Ported from scripts/safestop.sh
 * @task T4551
 * @epic T4545
 * @task T4904
 */

import { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * Register the safestop command.
 * @task T4551
 */
export function registerSafestopCommand(program: Command): void {
  program
    .command('safestop')
    .description('Graceful shutdown for agents approaching context limits')
    .requiredOption('--reason <reason>', 'Reason for stopping')
    .option('--commit', 'Commit pending git changes with WIP message')
    .option('--handoff <file>', 'Generate handoff document (use - for stdout)')
    .option('--no-session-end', 'Update notes but do not end session')
    .option('--dry-run', 'Show actions without executing')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli('mutate', 'admin', 'safestop', {
        reason: opts['reason'],
        commit: opts['commit'],
        handoff: opts['handoff'],
        noSessionEnd: opts['sessionEnd'] === false,
        dryRun: opts['dryRun'],
      }, { command: 'safestop', operation: 'admin.safestop' });
    });
}
