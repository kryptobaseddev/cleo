/**
 * CLI reason command group — reasoning and intelligence operations.
 *
 * Surfaces task dependency intelligence as first-class CLI commands.
 *
 * Commands:
 *   cleo reason impact --change <text>  — predict impact of a free-text change (T043)
 *   cleo reason impact <taskId>         — downstream dependency impact for a known task
 *   cleo reason timeline <taskId>       — task history and audit trail
 *
 */

import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/** cleo reason impact — predict impact of a change or analyse downstream deps */
const impactCommand = defineCommand({
  meta: {
    name: 'impact',
    description:
      'Predict impact of a change. Use --change for free-text prediction, or pass a taskId for graph-based analysis.',
  },
  args: {
    taskId: {
      type: 'positional',
      description: 'Task ID for graph-based dependency impact analysis',
      required: false,
    },
    change: {
      type: 'string',
      description: 'Free-text description of the proposed change (T043)',
    },
    limit: {
      type: 'string',
      description: 'Maximum seed tasks to match when using --change (default: 5)',
      default: '5',
    },
    depth: {
      type: 'string',
      description: 'Maximum traversal depth when using taskId (default: 10)',
      default: '10',
    },
  },
  async run({ args }) {
    const change = args.change as string | undefined;
    const taskId = args.taskId as string | undefined;

    if (change) {
      await dispatchFromCli(
        'query',
        'tasks',
        'impact',
        {
          change,
          matchLimit: Number.parseInt(args.limit, 10),
        },
        { command: 'reason', operation: 'tasks.impact' },
      );
    } else if (taskId) {
      await dispatchFromCli(
        'query',
        'tasks',
        'depends',
        {
          taskId,
          action: 'impact',
          depth: Number.parseInt(args.depth, 10),
        },
        { command: 'reason', operation: 'tasks.depends' },
      );
    } else {
      process.stderr.write(
        'Error: reason impact requires either --change <description> or a <taskId>\n',
      );
      process.exit(1);
    }
  },
});

/** cleo reason timeline — show history and audit trail for a task */
const timelineCommand = defineCommand({
  meta: { name: 'timeline', description: 'Show history and audit trail for a task' },
  args: {
    taskId: {
      type: 'positional',
      description: 'Task ID to fetch history for',
      required: true,
    },
    limit: {
      type: 'string',
      description: 'Maximum number of history entries',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'tasks',
      'history',
      {
        taskId: args.taskId,
        limit: args.limit ? Number.parseInt(args.limit, 10) : undefined,
      },
      { command: 'reason', operation: 'tasks.history' },
    );
  },
});

/**
 * Root reason command group — reasoning and intelligence operations.
 *
 * Dispatches to `tasks.impact`, `tasks.depends`, and `tasks.history` registry operations.
 */
export const reasonCommand = defineCommand({
  meta: { name: 'reason', description: 'Reasoning and intelligence operations (impact, timeline)' },
  subCommands: {
    impact: impactCommand,
    timeline: timelineCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
