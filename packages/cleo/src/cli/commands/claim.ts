/**
 * CLI claim / unclaim commands — assign a task to an agent or session.
 * @task T473
 * @epic T443
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * Native citty command for claiming a task by assigning it to an agent.
 *
 * Dispatches to tasks.claim (mutate). Requires an active session.
 */
export const claimCommand = defineCommand({
  meta: { name: 'claim', description: 'Claim a task by assigning it to an agent' },
  args: {
    taskId: { type: 'positional', description: 'Task ID to claim', required: true },
    agent: { type: 'string', description: 'Agent ID to assign the task to', required: true },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'tasks',
      'claim',
      { taskId: args.taskId as string, agentId: args.agent as string },
      { command: 'claim', operation: 'tasks.claim' },
    );
  },
});

/**
 * Native citty command for unclaiming a task by removing its current assignee.
 *
 * Dispatches to tasks.unclaim (mutate). Requires an active session.
 */
export const unclaimCommand = defineCommand({
  meta: { name: 'unclaim', description: 'Unclaim a task by removing its current assignee' },
  args: { taskId: { type: 'positional', description: 'Task ID to unclaim', required: true } },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'tasks',
      'unclaim',
      { taskId: args.taskId as string },
      { command: 'unclaim', operation: 'tasks.unclaim' },
    );
  },
});
