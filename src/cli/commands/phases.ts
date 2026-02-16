/**
 * CLI phases command - phase listing with progress (separate from phase.ts).
 * @task T4538
 * @epic T4454
 */

import { Command } from 'commander';
import {
  listPhases,
  showPhase,
} from '../../core/phases/index.js';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';

/**
 * Register the phases command group.
 * @task T4538
 */
export function registerPhasesCommand(program: Command): void {
  const phases = program
    .command('phases')
    .description('List phases with progress bars and statistics');

  phases
    .command('list')
    .description('List all phases with progress (default)')
    .action(async () => {
      try {
        const result = await listPhases();
        console.log(formatSuccess(result));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  phases
    .command('show <phase>')
    .description('Show phase details and task counts')
    .action(async (phase: string) => {
      try {
        const result = await showPhase(phase);
        console.log(formatSuccess(result));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  phases
    .command('stats')
    .description('Show detailed phase statistics')
    .action(async () => {
      try {
        const result = await listPhases();
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
