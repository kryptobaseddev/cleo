/**
 * CLI log command — view audit log entries.
 *
 * Dispatches to `admin.log` via dispatchFromCli.
 *
 * @task T4538
 * @epic T4454
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * cleo log — view audit log entries (operations, timestamps, changes).
 */
export const logCommand = defineCommand({
  meta: { name: 'log', description: 'View audit log entries (operations, timestamps, changes)' },
  args: {
    limit: {
      type: 'string',
      description: 'Maximum entries to show',
      default: '20',
    },
    offset: {
      type: 'string',
      description: 'Skip N entries',
      default: '0',
    },
    operation: {
      type: 'string',
      description: 'Filter by operation type',
    },
    task: {
      type: 'string',
      description: 'Filter by task ID',
    },
    since: {
      type: 'string',
      description: 'Filter entries since date',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'admin',
      'log',
      {
        limit: args.limit ? Number(args.limit) : 20,
        offset: args.offset ? Number(args.offset) : 0,
        operation: args.operation as string | undefined,
        taskId: args.task as string | undefined,
        since: args.since as string | undefined,
      },
      { command: 'log', operation: 'admin.log' },
    );
  },
});
