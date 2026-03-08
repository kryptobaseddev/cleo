/**
 * CLI labels command - label management.
 * Routes through dispatch layer to tasks.label.list and tasks.label.show.
 * @task T4538
 * @epic T4454
 */

import type { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * Register the labels command group.
 * @task T4538
 */
export function registerLabelsCommand(program: Command): void {
  const labels = program
    .command('labels')
    .description('List all labels with counts or show tasks with specific label');

  labels
    .command('list')
    .description('List all labels with task counts (default)')
    .action(async () => {
      await dispatchFromCli('query', 'tasks', 'label.list', {}, { command: 'labels' });
    });

  labels
    .command('show <label>')
    .description('Show tasks with specific label')
    .action(async (label: string) => {
      await dispatchFromCli('query', 'tasks', 'label.show', { label }, { command: 'labels' });
    });

  labels
    .command('stats')
    .description('Show detailed label statistics')
    .action(async () => {
      // stats is essentially label.list with additional computed fields
      // For now, route through label.list since it provides the same base data
      await dispatchFromCli('query', 'tasks', 'label.list', {}, { command: 'labels' });
    });

  // Alias: tags -> labels
  program
    .command('tags')
    .description('Alias for labels command')
    .action(async () => {
      await dispatchFromCli('query', 'tasks', 'label.list', {}, { command: 'labels' });
    });
}
