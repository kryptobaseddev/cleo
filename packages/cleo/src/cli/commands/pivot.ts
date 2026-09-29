/**
 * `cleo pivot` — first-class CLI verb for context-switches.
 *
 * Records an audited pivot from one task to another, replacing silent
 * reframes. The reason flag is REQUIRED — no silent pivots.
 *
 * @task T1596
 * @epic T-FOUNDATION-LOCKDOWN
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import { negatedFlag } from '../lib/negated-flag.js';

/**
 * `cleo pivot <fromTaskId> <toTaskId> --reason "<text>" [--no-blocks-from] [--take-over | --force-claim]`.
 */
export const pivotCommand = defineCommand({
  meta: {
    name: 'pivot',
    description:
      'Record an audited context switch from one task to another (replaces silent reframes)',
  },
  args: {
    fromTaskId: {
      type: 'positional',
      description: 'Currently-active task ID being paused',
      required: true,
    },
    toTaskId: {
      type: 'positional',
      description: 'Task ID becoming active in the current session',
      required: true,
    },
    reason: {
      type: 'string',
      description: 'Free-form rationale for the pivot (REQUIRED — no silent pivots)',
      required: true,
    },
    'no-blocks-from': {
      type: 'boolean',
      description:
        'Skip adding toTaskId as a dependency on fromTaskId (advisory pivot — default is to block)',
    },
    'take-over': {
      type: 'boolean',
      description: "Take over another session's EXPIRED claim on toTaskId (audited)",
    },
    'force-claim': {
      type: 'boolean',
      description: "Take over another session's LIVE claim on toTaskId (audited)",
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'orchestrate',
      'pivot',
      {
        fromTaskId: args.fromTaskId,
        toTaskId: args.toTaskId,
        reason: args.reason,
        blocksFrom: !negatedFlag(args, 'blocks-from'),
        ...(args['take-over'] === true ? { takeOver: true } : {}),
        ...(args['force-claim'] === true ? { forceClaim: true } : {}),
      },
      { command: 'pivot' },
    );
  },
});
