/**
 * CLI history command - completion timeline, audit log, and task work history.
 * @task T4538
 * @epic T4454
 * @task T5323
 */

import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/** cleo history log — show operation audit log with optional date range */
const logCommand = defineCommand({
  meta: { name: 'log', description: 'Show operation audit log' },
  args: {
    days: {
      type: 'string',
      description: 'Show last N days',
      default: '30',
    },
    since: {
      type: 'string',
      description: 'Show completions since date (YYYY-MM-DD)',
    },
    until: {
      type: 'string',
      description: 'Show completions until date (YYYY-MM-DD)',
    },
    'no-chart': {
      type: 'boolean',
      description: 'Disable bar charts',
      default: false,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'admin',
      'log',
      {
        days: Number.parseInt(args.days, 10),
        since: args.since as string | undefined,
        until: args.until as string | undefined,
      },
      { command: 'history' },
    );
  },
});

/** cleo history work — show time tracked per task */
const workCommand = defineCommand({
  meta: { name: 'work', description: 'Show task work history (time tracked per task)' },
  async run() {
    await dispatchFromCli('query', 'tasks', 'history', {}, { command: 'history' });
  },
});

/**
 * Root history command group — completion timeline and productivity analytics.
 *
 * Dispatches to `admin.log` (audit log) and `tasks.history` (work history).
 */
export const historyCommand = defineCommand({
  meta: { name: 'history', description: 'Completion timeline and productivity analytics' },
  subCommands: {
    log: logCommand,
    work: workCommand,
  },
  async run({ cmd }) {
    await showUsage(cmd);
  },
});
