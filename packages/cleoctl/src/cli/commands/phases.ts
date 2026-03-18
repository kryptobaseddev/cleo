/**
 * CLI phases command - phase listing with progress (separate from phase.ts).
 * @task T4538, T5326
 * @epic T4454, T5323
 */

import type { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * Register the phases command group.
 * @task T4538, T5326
 */
export function registerPhasesCommand(program: Command): void {
  const phases = program
    .command('phases')
    .description('List phases with progress bars and statistics');

  // T5326: Migrated to dispatch
  phases
    .command('list')
    .description('List all phases with progress (default)')
    .action(async () => {
      await dispatchFromCli('query', 'pipeline', 'phase.list', {}, { command: 'phases' });
    });

  // T5326: Migrated to dispatch
  phases
    .command('show <phase>')
    .description('Show phase details and task counts')
    .action(async (phase: string) => {
      await dispatchFromCli(
        'query',
        'pipeline',
        'phase.show',
        { phaseId: phase },
        { command: 'phases' },
      );
    });

  // T5326: Migrated to dispatch
  phases
    .command('stats')
    .description('Show detailed phase statistics')
    .action(async () => {
      await dispatchFromCli('query', 'pipeline', 'phase.list', {}, { command: 'phases' });
    });
}
