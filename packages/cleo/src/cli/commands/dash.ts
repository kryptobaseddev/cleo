/**
 * CLI command: cleo dash — project health dashboard.
 *
 * Dispatches to `admin.dash` to show status summary, phase progress,
 * recent activity, and high-priority tasks. Use at session start for an
 * overall project overview.
 *
 * @task T4535
 * @epic T4454
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * Project health dashboard command.
 *
 * Shows status summary, phase progress, recent activity, and high-priority
 * tasks. Use for overall project status.
 */
export const dashCommand = defineCommand({
  meta: {
    name: 'dash',
    description:
      'Project health dashboard: status summary, phase progress, recent activity, high priority tasks. Use for overall project status.',
  },
  args: {
    'blocked-limit': {
      type: 'string',
      description: 'Max blocked tasks to show',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'admin',
      'dash',
      {
        blockedTasksLimit:
          args['blocked-limit'] !== undefined
            ? Number.parseInt(args['blocked-limit'], 10)
            : undefined,
      },
      { command: 'dash' },
    );
  },
});
