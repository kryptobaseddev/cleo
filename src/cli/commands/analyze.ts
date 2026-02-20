/**
 * CLI analyze command - task triage with leverage scoring.
 * @task T4538
 * @epic T4454
 */

import { Command } from 'commander';
import { getAccessor } from '../../store/data-accessor.js';
import { analyzeTaskPriority } from '../../core/tasks/analyze.js';
import { formatError } from '../../core/output.js';
import { cliOutput } from '../renderers/index.js';
import { CleoError } from '../../core/errors.js';

/**
 * Register the analyze command.
 * @task T4538
 */
export function registerAnalyzeCommand(program: Command): void {
  program
    .command('analyze')
    .description('Task triage with leverage scoring and bottleneck detection')
    .option('--auto-start', 'Automatically start working on recommended task')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const accessor = await getAccessor();
        const result = await analyzeTaskPriority({
          autoStart: opts['autoStart'] as boolean | undefined,
        }, accessor);
        cliOutput(result, { command: 'analyze' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
