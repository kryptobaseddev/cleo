/**
 * CLI sequence command - task ID sequence management.
 * @task T4538
 * @epic T4454
 */

import { Command } from 'commander';
import {
  showSequence,
  checkSequence,
  repairSequence,
} from '../../core/sequence/index.js';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';

/**
 * Register the sequence command group.
 * @task T4538
 */
export function registerSequenceCommand(program: Command): void {
  const sequence = program
    .command('sequence')
    .description('Inspect and manage task ID sequence (show/check/repair)');

  sequence
    .command('show')
    .description('Display current sequence state')
    .action(async () => {
      try {
        const result = await showSequence();
        console.log(formatSuccess(result));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  sequence
    .command('check')
    .description('Verify counter >= max(todo + archive)')
    .action(async () => {
      try {
        const result = await checkSequence();
        console.log(formatSuccess(result));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  sequence
    .command('repair')
    .description('Reset counter to max + 1 if behind')
    .action(async () => {
      try {
        const result = await repairSequence();
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
