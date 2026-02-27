/**
 * CLI labels command - label management.
 * @task T4538
 * @epic T4454
 */
// TODO T4894: operation not yet in registry — no tasks.labels dispatch route for list/show/stats operations

import { Command } from 'commander';
import { getAccessor } from '../../store/data-accessor.js';
import * as labelsCore from '../../core/tasks/labels.js';
import { formatError } from '../../core/output.js';
import { cliOutput } from '../renderers/index.js';
import { CleoError } from '../../core/errors.js';

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
      try {
        const accessor = await getAccessor();
        const result = await labelsCore.listLabels(undefined, accessor);
        cliOutput({ labels: result, count: result.length }, { command: 'labels' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  labels
    .command('show <label>')
    .description('Show tasks with specific label')
    .action(async (label: string) => {
      try {
        const accessor = await getAccessor();
        const result = await labelsCore.showLabelTasks(label, undefined, accessor);
        cliOutput(result, { command: 'labels' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  labels
    .command('stats')
    .description('Show detailed label statistics')
    .action(async () => {
      try {
        const accessor = await getAccessor();
        const result = await labelsCore.getLabelStats(undefined, accessor);
        cliOutput(result, { command: 'labels' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  // Alias: tags -> labels
  program
    .command('tags')
    .description('Alias for labels command')
    .action(async () => {
      try {
        const accessor = await getAccessor();
        const result = await labelsCore.listLabels(undefined, accessor);
        cliOutput({ labels: result, count: result.length }, { command: 'labels' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
