/**
 * CLI otel command group - OpenTelemetry token metrics tracking.
 * @task T4535
 * @epic T4454
 */

import { Command } from 'commander';
import {
  getOtelStatus,
  getOtelSummary,
  getOtelSessions,
  getOtelSpawns,
  getRealTokenUsage,
  clearOtelData,
} from '../../core/otel/index.js';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';

/**
 * Register the otel command group.
 * @task T4535
 */
export function registerOtelCommand(program: Command): void {
  const otel = program
    .command('otel')
    .description('Token metrics tracking - view status, summary, and manage tracking data');

  otel
    .command('status')
    .description('Show token tracking status and recent activity')
    .action(async () => {
      try {
        const result = await getOtelStatus();
        console.log(formatSuccess(result));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  otel
    .command('summary')
    .description('Show combined token usage summary')
    .action(async () => {
      try {
        const result = await getOtelSummary();
        console.log(formatSuccess(result));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  otel
    .command('sessions')
    .description('Show session-level token data')
    .option('--session <id>', 'Filter by session ID')
    .option('--task <id>', 'Filter by task ID')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const result = await getOtelSessions({
          session: opts['session'] as string | undefined,
          task: opts['task'] as string | undefined,
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

  otel
    .command('spawns')
    .description('Show spawn-level token data')
    .option('--task <id>', 'Filter by task ID')
    .option('--epic <id>', 'Filter by epic ID')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const result = await getOtelSpawns({
          task: opts['task'] as string | undefined,
          epic: opts['epic'] as string | undefined,
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

  otel
    .command('real')
    .description('Show REAL token usage from Claude Code API')
    .option('--session <id>', 'Filter by session ID')
    .option('--since <date>', 'Filter events since timestamp')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const result = await getRealTokenUsage({
          session: opts['session'] as string | undefined,
          since: opts['since'] as string | undefined,
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

  otel
    .command('clear')
    .description('Clear token tracking data (with backup)')
    .action(async () => {
      try {
        const result = await clearOtelData();
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
