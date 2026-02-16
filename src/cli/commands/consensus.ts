/**
 * CLI consensus command - consensus protocol validation.
 * @task T4537
 * @epic T4454
 */

import { Command } from 'commander';
import {
  validateConsensusTask,
  checkConsensusManifest,
} from '../../core/validation/protocols/consensus.js';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';

/**
 * Register the consensus command group.
 * @task T4537
 */
export function registerConsensusCommand(program: Command): void {
  const consensus = program
    .command('consensus')
    .description('Validate consensus protocol compliance for multi-agent decision tasks');

  consensus
    .command('validate <taskId>')
    .description('Validate consensus protocol compliance for task')
    .option('--strict', 'Exit with error code on violations')
    .option('--voting-matrix <file>', 'Path to voting matrix JSON file')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      try {
        const result = await validateConsensusTask(taskId, {
          strict: opts['strict'] as boolean | undefined,
          votingMatrixFile: opts['votingMatrix'] as string | undefined,
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

  consensus
    .command('check <manifestFile>')
    .description('Validate manifest entry directly')
    .option('--strict', 'Exit with error code on violations')
    .option('--voting-matrix <file>', 'Path to voting matrix JSON file')
    .action(async (manifestFile: string, opts: Record<string, unknown>) => {
      try {
        const result = await checkConsensusManifest(manifestFile, {
          strict: opts['strict'] as boolean | undefined,
          votingMatrixFile: opts['votingMatrix'] as string | undefined,
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
}
