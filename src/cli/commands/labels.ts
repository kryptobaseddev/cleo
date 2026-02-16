/**
 * CLI labels command - label management.
 * @task T4538
 * @epic T4454
 */

import { Command } from 'commander';
import {
  listLabels,
  showLabelTasks,
  getLabelStats,
} from '../../core/tasks/labels.js';
import { formatSuccess, formatError } from '../../core/output.js';
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
        const result = await listLabels();
        console.log(formatSuccess({ labels: result, count: result.length }));
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
        const result = await showLabelTasks(label);
        console.log(formatSuccess(result));
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
        const result = await getLabelStats();
        console.log(formatSuccess(result));
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
        const result = await listLabels();
        console.log(formatSuccess({ labels: result, count: result.length }));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
