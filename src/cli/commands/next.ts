/**
 * CLI next command - suggest next task to work on.
 * Delegates scoring algorithm to core/tasks/task-ops.coreTaskNext.
 * @task T4454
 * @task T4795
 */

import { Command } from 'commander';
import { formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { cliOutput } from '../renderers/index.js';
import { coreTaskNext } from '../../core/tasks/task-ops.js';
import { getProjectRoot } from '../../core/paths.js';

export function registerNextCommand(program: Command): void {
  program
    .command('next')
    .description('Suggest next task to work on based on priority and dependencies')
    .option('--explain', 'Show detailed reasoning for suggestion')
    .option('-n, --count <n>', 'Show top N suggestions', '1')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const projectRoot = getProjectRoot();
        const count = parseInt(opts['count'] as string, 10) || 1;
        const explain = !!opts['explain'];

        const result = await coreTaskNext(projectRoot, { count, explain });

        if (result.suggestions.length === 0) {
          cliOutput({
            suggestion: null,
            reason: 'No pending tasks with satisfied dependencies',
          }, { command: 'next', operation: 'tasks.next' });
          process.exit(ExitCode.NO_DATA);
          return;
        }

        if (count === 1) {
          const s = result.suggestions[0]!;
          cliOutput({
            suggestion: s,
            totalCandidates: result.totalCandidates,
          }, { command: 'next', operation: 'tasks.next' });
        } else {
          cliOutput({
            suggestions: result.suggestions,
            totalCandidates: result.totalCandidates,
          }, { command: 'next', operation: 'tasks.next' });
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
