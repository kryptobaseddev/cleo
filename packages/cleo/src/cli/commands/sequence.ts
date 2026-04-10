/**
 * CLI sequence command - task ID sequence management.
 * @task T4538
 * @epic T4454
 * @task T480 — fix sequence repair: route to systemSequenceRepair instead of
 *              misrouted config.set (admin.sequence mutate was removed in T5615
 *              but no correct CLI path remained).
 */

import { getProjectRoot } from '@cleocode/core/internal';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';
import { cliOutput } from '../renderers/index.js';

export function registerSequenceCommand(program: Command): void {
  const sequence = program
    .command('sequence')
    .description('Inspect and manage task ID sequence (show/check/repair)');

  sequence
    .command('show')
    .description('Display current sequence state')
    .action(async () => {
      await dispatchFromCli(
        'query',
        'admin',
        'sequence',
        { action: 'show' },
        { command: 'sequence' },
      );
    });

  sequence
    .command('check')
    .description('Verify counter >= max(todo + archive)')
    .action(async () => {
      await dispatchFromCli(
        'query',
        'admin',
        'sequence',
        { action: 'check' },
        { command: 'sequence' },
      );
    });

  sequence
    .command('repair')
    .description('Reset counter to max + 1 if behind')
    .action(async () => {
      // admin.sequence (mutate) was removed in T5615 with no CLI path retained.
      // Call the engine function directly, mirroring the detect command pattern.
      const { systemSequenceRepair } = await import('../../dispatch/engines/system-engine.js');
      const projectRoot = getProjectRoot();
      const result = await systemSequenceRepair(projectRoot);
      cliOutput(result, { command: 'sequence', operation: 'admin.sequence.repair' });
    });
}
