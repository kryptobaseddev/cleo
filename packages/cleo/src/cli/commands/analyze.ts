/**
 * CLI analyze command — task triage with leverage scoring and bottleneck detection.
 *
 * Dispatches to `tasks.analyze` (query) to surface the highest-leverage
 * tasks and identify workflow bottlenecks.
 *
 * @task T4538
 * @epic T4454
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * cleo analyze — task triage with leverage scoring and bottleneck detection.
 *
 * Dispatches to the `tasks.analyze` registry operation.
 */
export const analyzeCommand = defineCommand({
  meta: {
    name: 'analyze',
    description: 'Task triage with leverage scoring and bottleneck detection',
  },
  args: {
    'auto-start': {
      type: 'boolean',
      description: 'Automatically start working on recommended task',
    },
  },
  async run() {
    await dispatchFromCli('query', 'tasks', 'analyze', {}, { command: 'analyze' });
  },
});
