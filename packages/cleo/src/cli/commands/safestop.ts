/**
 * CLI safestop command - graceful shutdown for agents approaching context limits.
 * Ported from scripts/safestop.sh
 *
 * @task T4551
 * @epic T4545
 * @task T4904
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * cleo safestop — graceful shutdown for agents approaching context limits.
 *
 * Saves session state, optionally commits pending changes, and ends the
 * current session with a handoff note.
 */
export const safestopCommand = defineCommand({
  meta: {
    name: 'safestop',
    description: 'Graceful shutdown for agents approaching context limits',
  },
  args: {
    reason: {
      type: 'string',
      description: 'Reason for stopping',
      required: true,
    },
    commit: {
      type: 'boolean',
      description: 'Commit pending git changes with WIP message',
      default: false,
    },
    handoff: {
      type: 'string',
      description: 'Generate handoff document (use - for stdout)',
    },
    'no-session-end': {
      type: 'boolean',
      description: 'Update notes but do not end session',
      default: false,
    },
    'dry-run': {
      type: 'boolean',
      description: 'Show actions without executing',
      default: false,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'admin',
      'safestop',
      {
        reason: args.reason,
        commit: args.commit,
        handoff: args.handoff as string | undefined,
        noSessionEnd: args['no-session-end'],
        dryRun: args['dry-run'],
      },
      { command: 'safestop', operation: 'admin.safestop' },
    );
  },
});
