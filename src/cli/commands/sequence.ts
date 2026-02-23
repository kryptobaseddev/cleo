/**
 * CLI sequence command - task ID sequence management.
 * @task T4538
 * @epic T4454
 */

import { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

export function registerSequenceCommand(program: Command): void {
  const sequence = program
    .command('sequence')
    .description('Inspect and manage task ID sequence (show/check/repair)');

  sequence
    .command('show')
    .description('Display current sequence state')
    .action(async () => {
      await dispatchFromCli('query', 'admin', 'sequence', { action: 'show' }, { command: 'sequence' });
    });

  sequence
    .command('check')
    .description('Verify counter >= max(todo + archive)')
    .action(async () => {
      await dispatchFromCli('query', 'admin', 'sequence', { action: 'check' }, { command: 'sequence' });
    });

  sequence
    .command('repair')
    .description('Reset counter to max + 1 if behind')
    .action(async () => {
      await dispatchFromCli('mutate', 'admin', 'sequence', { action: 'repair' }, { command: 'sequence' });
    });
}
