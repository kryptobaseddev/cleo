/**
 * CLI start command - start working on a task.
 * @task T4756
 * @epic T4732
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * Native citty command for `cleo start` — sets a task as the current active
 * task in the active session and takes that session's leased claim on it.
 * Another session's claim refuses the start with `E_TASK_CLAIMED`;
 * `--take-over` (expired lease) and `--force-claim` (live lease) override it,
 * audited (T12502).
 *
 * @task T4756
 * @task T4666
 * @task T12502
 * @epic T487
 */
export const startCommand = defineCommand({
  meta: {
    name: 'start',
    description:
      "Start working on a task (sets it as the current task and takes your session's claim lease)",
  },
  args: {
    taskId: {
      type: 'positional',
      description: 'ID of the task to start',
      required: true,
    },
    'take-over': {
      type: 'boolean',
      description: "Take over another session's EXPIRED claim lease on the task (audited)",
    },
    'force-claim': {
      type: 'boolean',
      description: "Take over another session's LIVE claim lease on the task (audited)",
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'tasks',
      'start',
      {
        taskId: args.taskId,
        ...(args['take-over'] === true ? { takeOver: true } : {}),
        ...(args['force-claim'] === true ? { forceClaim: true } : {}),
      },
      { command: 'start' },
    );
  },
});
