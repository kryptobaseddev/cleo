/**
 * CLI cancel command — soft-cancel a task (reversible via tasks.restore).
 *
 * Dispatches to `tasks.cancel` (mutate). The cancelled state is a soft
 * terminal state — tasks can be un-cancelled via `cleo restore task <id>`.
 *
 * @task T473
 * @epic T443
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * cleo cancel <taskId> — cancel a task (soft terminal state; reversible via restore).
 *
 * Dispatches to the `tasks.cancel` registry operation.
 */
export const cancelCommand = defineCommand({
  meta: {
    name: 'cancel',
    description: 'Cancel a task (soft terminal state; reversible via restore)',
  },
  args: {
    taskId: {
      type: 'positional',
      description: 'Task ID to cancel',
      required: true,
    },
    reason: {
      type: 'string',
      description: 'Reason for cancellation',
    },
    children: {
      type: 'string',
      description:
        'Child handling mode: block (default), cascade (cancel subtree), or reparent (move children under --to)',
      default: 'block',
    },
    to: {
      type: 'string',
      description:
        'Target parent ID for --children reparent (T11811): children move under this epic',
    },
    force: {
      type: 'boolean',
      description: 'Required waiver for cascade cancellation above the subtree threshold',
      default: false,
    },
    cascadeThreshold: {
      type: 'string',
      description: 'Maximum descendant count allowed for cascade without --force (default: 10)',
    },
    kind: {
      type: 'string',
      description:
        'Why (T14267): abandoned, superseded, duplicate or obsolete. A superseded or duplicate ' +
        'child whose --replaced-by task is done needs no --waive-cancelled-children on its parent',
    },
    'replaced-by': {
      type: 'string',
      description: 'The task that replaced this one (with --kind superseded or duplicate)',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'tasks',
      'cancel',
      {
        taskId: args.taskId,
        reason: args.reason as string | undefined,
        children: args.children as 'block' | 'cascade' | 'reparent' | undefined,
        reparentTo: typeof args.to === 'string' && args.to.length > 0 ? args.to : undefined,
        force: args.force === true,
        cascadeThreshold:
          typeof args.cascadeThreshold === 'string' && args.cascadeThreshold.length > 0
            ? Number.parseInt(args.cascadeThreshold, 10)
            : undefined,
        kind: typeof args.kind === 'string' && args.kind.length > 0 ? args.kind : undefined,
        replacedBy:
          typeof args['replaced-by'] === 'string' && args['replaced-by'].length > 0
            ? args['replaced-by']
            : undefined,
      },
      { command: 'cancel', operation: 'tasks.cancel' },
    );
  },
});
