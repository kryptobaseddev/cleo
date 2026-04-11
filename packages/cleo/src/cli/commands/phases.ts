/**
 * CLI phases command - phase listing with progress (separate from phase.ts).
 * @deprecated Use `cleo phase` instead.
 * @task T4538, T5326
 * @epic T4454, T5323
 */

import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';

/**
 * Register the phases command group.
 * @deprecated Use `cleo phase` instead.
 * @task T4538, T5326
 */
export function registerPhasesCommand(program: Command): void {
  const phases = program
    .command('phases')
    .description(
      'DEPRECATED: Use `cleo phase` instead. List phases with progress bars and statistics',
    );

  // T5326: Migrated to dispatch
  phases
    .command('list', { isDefault: true })
    .description('List all phases with progress (default)')
    .action(async () => {
      console.error('[DEPRECATED] cleo phases is deprecated. Use: cleo phase list');
      await dispatchFromCli('query', 'pipeline', 'phase.list', {}, { command: 'phases' });
    });

  // T5326: Migrated to dispatch
  phases
    .command('show <phase>')
    .description('Show phase details and task counts')
    .action(async (phase: string) => {
      console.error('[DEPRECATED] cleo phases is deprecated. Use: cleo phase show');
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
      console.error('[DEPRECATED] cleo phases is deprecated. Use: cleo phase list');
      await dispatchFromCli('query', 'pipeline', 'phase.list', {}, { command: 'phases' });
    });
}
