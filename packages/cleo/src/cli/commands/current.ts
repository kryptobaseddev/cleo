/**
 * CLI current command — show the current task being worked on.
 *
 * Dispatches to `tasks.current` (query) and returns:
 * `{ currentTask: string | null, currentPhase: string | null }`.
 *
 * @task T4756
 * @epic T4732
 * @task T4666
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * cleo current — show the current task being worked on.
 *
 * Returns: `{ currentTask: string | null, currentPhase: string | null }`.
 * Dispatches to the `tasks.current` registry operation.
 */
export const currentCommand = defineCommand({
  meta: {
    name: 'current',
    description:
      'Show the current task being worked on. Returns: {currentTask: string|null, currentPhase: string|null}',
  },
  async run() {
    await dispatchFromCli('query', 'tasks', 'current', {}, { command: 'current' });
  },
});
