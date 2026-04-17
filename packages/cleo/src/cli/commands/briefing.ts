/**
 * CLI briefing command — show composite session-start context.
 *
 * Aggregates session-start context from multiple sources:
 * - Last session handoff
 * - Current focus
 * - Top-N next tasks
 * - Open bugs
 * - Blocked tasks
 * - Active epics
 * - Pipeline stage
 *
 * @task T4916
 * @epic T4914
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * Root briefing command — show composite session-start context.
 *
 * Dispatches to `session.briefing.show` with optional scope and result-count
 * limits. Use at session start to restore context quickly.
 *
 * @task T4916
 * @epic T4914
 */
export const briefingCommand = defineCommand({
  meta: {
    name: 'briefing',
    description:
      'Session resume context: last handoff, current task, next tasks, bugs, blockers, epics, and memory. Use at session start to restore context.',
  },
  args: {
    scope: {
      type: 'string',
      description: 'Scope filter (global or epic:T###)',
      alias: 's',
    },
    'max-next': {
      type: 'string',
      description: 'Maximum next tasks to show',
      default: '5',
    },
    'max-bugs': {
      type: 'string',
      description: 'Maximum bugs to show',
      default: '10',
    },
    'max-blocked': {
      type: 'string',
      description: 'Maximum blocked tasks to show',
      default: '10',
    },
    'max-epics': {
      type: 'string',
      description: 'Maximum active epics to show',
      default: '5',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'session',
      'briefing.show',
      {
        scope: args.scope as string | undefined,
        maxNextTasks: parseInt(args['max-next'], 10),
        maxBugs: parseInt(args['max-bugs'], 10),
        maxBlocked: parseInt(args['max-blocked'], 10),
        maxEpics: parseInt(args['max-epics'], 10),
      },
      { command: 'briefing' },
    );
  },
});
