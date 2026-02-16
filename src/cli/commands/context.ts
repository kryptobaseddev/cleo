/**
 * CLI context command group - context window monitoring.
 * @task T4535
 * @epic T4454
 */

import { Command } from 'commander';
import {
  getContextStatus,
  checkContextThreshold,
  listContextSessions,
} from '../../core/context/index.js';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';

/**
 * Register the context command group.
 * @task T4535
 */
export function registerContextCommand(program: Command): void {
  const context = program
    .command('context')
    .description('Monitor context window usage for agent safeguard system');

  context
    .command('status')
    .description('Show current context state (default)')
    .option('--session <id>', 'Check specific CLEO session')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const result = await getContextStatus({
          session: opts['session'] as string | undefined,
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

  context
    .command('check')
    .description('Check threshold, return exit code for scripting')
    .option('--session <id>', 'Check specific CLEO session')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const result = await checkContextThreshold({
          session: opts['session'] as string | undefined,
        });
        console.log(formatSuccess(result));
        if (result.exitCode) {
          process.exit(result.exitCode);
        }
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  context
    .command('list')
    .description('List all context state files (multi-session)')
    .action(async () => {
      try {
        const result = await listContextSessions();
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
