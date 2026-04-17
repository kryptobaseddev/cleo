/**
 * CLI verify command — view or modify verification gates for a task.
 *
 * Routes through the dispatch layer to check.gate.verify and check.gate.status.
 *
 * @task T4454
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/** cleo verify <task-id> — view or modify verification gates */
export const verifyCommand = defineCommand({
  meta: { name: 'verify', description: 'View or modify verification gates for a task' },
  args: {
    taskId: {
      type: 'positional',
      description: 'Task ID to inspect or update',
      required: true,
    },
    gate: {
      type: 'string',
      description: 'Set a specific gate by name',
    },
    value: {
      type: 'string',
      description: 'Gate value: true or false',
      default: 'true',
    },
    agent: {
      type: 'string',
      description: 'Agent setting the gate',
    },
    all: {
      type: 'boolean',
      description: 'Mark all required gates as passed',
    },
    reset: {
      type: 'boolean',
      description: 'Reset verification to initial state',
    },
  },
  async run({ args }) {
    const isWrite = !!(args.gate || args.all || args.reset);
    await dispatchFromCli(
      isWrite ? 'mutate' : 'query',
      'check',
      isWrite ? 'gate.set' : 'gate.status',
      {
        taskId: args.taskId,
        gate: args.gate as string | undefined,
        value: args.value === 'false' ? false : args.gate ? true : undefined,
        agent: args.agent as string | undefined,
        all: args.all as boolean | undefined,
        reset: args.reset as boolean | undefined,
      },
      { command: 'verify' },
    );
  },
});
