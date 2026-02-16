/**
 * CLI lifecycle command group.
 * @task T4467
 * @epic T4454
 */

import { Command } from 'commander';
import {
  getLifecycleState,
  startStage,
  completeStage,
  skipStage,
  checkGate,
} from '../../core/lifecycle/index.js';
import type { LifecycleStage } from '../../core/lifecycle/index.js';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';

/**
 * Register the lifecycle command group.
 * @task T4467
 */
export function registerLifecycleCommand(program: Command): void {
  const lifecycle = program
    .command('lifecycle')
    .description('RCSD pipeline lifecycle management');

  lifecycle
    .command('show <epicId>')
    .description('Show lifecycle state for an epic')
    .action(async (epicId: string) => {
      try {
        const result = await getLifecycleState(epicId);
        console.log(formatSuccess(result));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  lifecycle
    .command('start <epicId> <stage>')
    .description('Start a lifecycle stage')
    .action(async (epicId: string, stage: string) => {
      try {
        const result = await startStage(epicId, stage as LifecycleStage);
        console.log(formatSuccess(result));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  lifecycle
    .command('complete <epicId> <stage>')
    .description('Complete a lifecycle stage')
    .option('--artifacts <artifacts>', 'Comma-separated artifact paths')
    .option('--notes <notes>', 'Completion notes')
    .action(async (epicId: string, stage: string, opts: Record<string, unknown>) => {
      try {
        const artifacts = opts['artifacts']
          ? (opts['artifacts'] as string).split(',').map(s => s.trim())
          : undefined;
        const result = await completeStage(epicId, stage as LifecycleStage, artifacts);
        console.log(formatSuccess(result));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  lifecycle
    .command('skip <epicId> <stage>')
    .description('Skip a lifecycle stage')
    .requiredOption('--reason <reason>', 'Reason for skipping')
    .action(async (epicId: string, stage: string, opts: Record<string, unknown>) => {
      try {
        const result = await skipStage(epicId, stage as LifecycleStage, opts['reason'] as string);
        console.log(formatSuccess(result));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  lifecycle
    .command('gate <epicId> <stage>')
    .description('Check lifecycle gate for a stage')
    .action(async (epicId: string, stage: string) => {
      try {
        const result = await checkGate(epicId, stage as LifecycleStage);
        console.log(formatSuccess(result));
        if (!result.allowed) {
          process.exit(80); // LIFECYCLE_GATE_FAILED
        }
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
