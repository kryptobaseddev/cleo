/**
 * Intelligence CLI commands — Predictive Quality Analysis
 *
 * Commands:
 *   cleo intelligence predict --task <id> [--stage <stage>] [--json]
 *   cleo intelligence suggest --task <id> [--json]
 *   cleo intelligence learn-errors [--limit <n>] [--json]
 *   cleo intelligence confidence --task <id> [--json]
 *   cleo intelligence match --task <id> [--json]
 *
 * @task T549
 * @epic T5149
 */

import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';

/**
 * Register the `cleo intelligence` command group.
 *
 * All sub-commands dispatch via the IntelligenceHandler (query gateway).
 * Output is in LAFS envelope format when --json is used.
 */
export function registerIntelligenceCommand(program: Command): void {
  const intel = program
    .command('intelligence')
    .description('Predictive intelligence and quality analysis');

  // -- predict --
  intel
    .command('predict')
    .description('Calculate risk score for a task, or predict validation outcome for a stage')
    .requiredOption('--task <taskId>', 'Task ID to assess')
    .option('--stage <stage>', 'Lifecycle stage for validation outcome prediction')
    .option('--json', 'Output as JSON')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'intelligence',
        'predict',
        { taskId: opts['task'], stage: opts['stage'] },
        { command: 'intelligence', operation: 'intelligence.predict' },
      );
    });

  // -- suggest --
  intel
    .command('suggest')
    .description('Suggest verification gate focus for a task')
    .requiredOption('--task <taskId>', 'Task ID to analyze')
    .option('--json', 'Output as JSON')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'intelligence',
        'suggest',
        { taskId: opts['task'] },
        { command: 'intelligence', operation: 'intelligence.suggest' },
      );
    });

  // -- learn-errors --
  intel
    .command('learn-errors')
    .description('Extract recurring failure patterns from task and brain history')
    .option('--limit <n>', 'Maximum number of patterns to return', parseInt)
    .option('--json', 'Output as JSON')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'intelligence',
        'learn-errors',
        { limit: opts['limit'] },
        { command: 'intelligence', operation: 'intelligence.learn-errors' },
      );
    });

  // -- confidence --
  intel
    .command('confidence')
    .description('Score verification confidence for a task based on its current gate state')
    .requiredOption('--task <taskId>', 'Task ID to score')
    .option('--json', 'Output as JSON')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'intelligence',
        'confidence',
        { taskId: opts['task'] },
        { command: 'intelligence', operation: 'intelligence.confidence' },
      );
    });

  // -- match --
  intel
    .command('match')
    .description('Match known brain patterns against a task')
    .requiredOption('--task <taskId>', 'Task ID to match')
    .option('--json', 'Output as JSON')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'intelligence',
        'match',
        { taskId: opts['task'] },
        { command: 'intelligence', operation: 'intelligence.match' },
      );
    });
}
