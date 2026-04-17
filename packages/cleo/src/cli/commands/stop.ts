/**
 * CLI stop command - stop working on the current task.
 * @task T4756
 * @epic T4732
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * Native citty command for `cleo stop` — clears the active task from the
 * current session, returning `{cleared: boolean, previousTask: string|null}`.
 *
 * @task T4756
 * @task T4666
 * @epic T487
 */
export const stopCommand = defineCommand({
  meta: {
    name: 'stop',
    description:
      'Stop working on the current task (clears the active task, returns {cleared: boolean, previousTask: string|null})',
  },
  async run() {
    await dispatchFromCli('mutate', 'tasks', 'stop', {}, { command: 'stop' });
  },
});
