/**
 * CLI claim / unclaim commands — the caller session's leased task claim.
 * @task T473
 * @task T12502
 * @epic T443
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * Native citty command for `cleo claim` — take, renew or override the caller
 * session's leased claim on a task (T12502). The human assignee is separate
 * (`cleo assignee`) and never written here.
 *
 * Dispatches to tasks.claim (mutate). Requires a bound session: the lease
 * names it as the holder.
 */
export const claimCommand = defineCommand({
  meta: {
    name: 'claim',
    description:
      "Take, renew (--renew) or override (--take-over expired, --force-claim live) your session's leased claim on a task",
  },
  args: {
    taskId: { type: 'positional', description: 'Task ID to claim', required: true },
    agent: {
      type: 'string',
      description:
        "Agent ID recorded with the lease (default: the session's agent / CLEO_AGENT_ID)",
    },
    renew: { type: 'boolean', description: 'Renew your own lease on the task' },
    'take-over': {
      type: 'boolean',
      description: "Take over another session's EXPIRED lease (audited)",
    },
    'force-claim': {
      type: 'boolean',
      description: "Take over another session's LIVE lease (audited)",
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'tasks',
      'claim',
      {
        taskId: args.taskId as string,
        ...(typeof args.agent === 'string' && args.agent ? { agentId: args.agent } : {}),
        ...(args.renew === true ? { renew: true } : {}),
        ...(args['take-over'] === true ? { takeOver: true } : {}),
        ...(args['force-claim'] === true ? { forceClaim: true } : {}),
      },
      { command: 'claim', operation: 'tasks.claim' },
    );
  },
});

/**
 * Native citty command for `cleo unclaim` — release your session's claim
 * lease on a task (T12502). `--force-claim` releases another session's lease
 * (audited).
 *
 * Dispatches to tasks.unclaim (mutate).
 */
export const unclaimCommand = defineCommand({
  meta: {
    name: 'unclaim',
    description: "Release your session's claim lease on a task (--force-claim: another session's)",
  },
  args: {
    taskId: { type: 'positional', description: 'Task ID to unclaim', required: true },
    'force-claim': {
      type: 'boolean',
      description: "Release another session's lease (audited)",
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'tasks',
      'unclaim',
      {
        taskId: args.taskId as string,
        ...(args['force-claim'] === true ? { forceClaim: true } : {}),
      },
      { command: 'unclaim', operation: 'tasks.unclaim' },
    );
  },
});
