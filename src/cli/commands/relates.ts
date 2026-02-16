/**
 * CLI relates command - task relationship management.
 * @task T4538
 * @epic T4454
 */

import { Command } from 'commander';
import {
  suggestRelated,
  addRelation,
  discoverRelated,
  listRelations,
} from '../../core/tasks/relates.js';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';

/**
 * Register the relates command group.
 * @task T4538
 */
export function registerRelatesCommand(program: Command): void {
  const relates = program
    .command('relates')
    .description('Semantic relationship discovery and management between tasks');

  relates
    .command('suggest <taskId>')
    .description('Suggest related tasks based on shared attributes')
    .option('--threshold <n>', 'Minimum similarity threshold (0-100)', '50')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      try {
        const result = await suggestRelated(taskId, {
          threshold: opts['threshold'] ? Number(opts['threshold']) : 50,
        });
        console.log(formatSuccess(result));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  relates
    .command('add <from> <to> <type> <reason>')
    .description('Add a relates entry to a task')
    .action(async (from: string, to: string, type: string, reason: string) => {
      try {
        const result = await addRelation(from, to, type, reason);
        console.log(formatSuccess(result));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  relates
    .command('discover <taskId>')
    .description('Discover related tasks using various methods')
    .action(async (taskId: string) => {
      try {
        const result = await discoverRelated(taskId);
        console.log(formatSuccess(result));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  relates
    .command('list <taskId>')
    .description('Show existing relates entries for a task')
    .action(async (taskId: string) => {
      try {
        const result = await listRelations(taskId);
        console.log(formatSuccess(result));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
