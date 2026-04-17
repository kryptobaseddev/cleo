/**
 * CLI complexity command — estimate complexity of a task.
 * @task T473
 * @epic T443
 */

import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/** cleo complexity estimate — estimate complexity of a single task */
const complexityEstimateCommand = defineCommand({
  meta: { name: 'estimate', description: 'Estimate complexity of a task (small / medium / large)' },
  args: { taskId: { type: 'positional', description: 'Task ID to estimate', required: true } },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'tasks',
      'complexity.estimate',
      { taskId: args.taskId as string },
      { command: 'complexity', operation: 'tasks.complexity.estimate' },
    );
  },
});

/**
 * Native citty command group for task complexity analysis.
 *
 * Exposes tasks.complexity.estimate as cleo complexity estimate <taskId>.
 * Returns a complexity estimate (small/medium/large) with reasoning.
 */
export const complexityCommand = defineCommand({
  meta: { name: 'complexity', description: 'Task complexity analysis' },
  subCommands: { estimate: complexityEstimateCommand },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
