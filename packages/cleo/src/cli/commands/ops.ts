/**
 * CLI ops command — progressive disclosure for operations.
 *
 * Shows available CLEO operations filtered by disclosure tier. Tier 0 shows
 * basic operations, tier 1 adds memory/check, tier 2 shows everything.
 *
 * @task T4362
 * @task T487
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * cleo ops — show available operations filtered to disclosure tier.
 *
 * Dispatches to `admin.help` via the query gateway.
 */
export const opsCommand = defineCommand({
  meta: {
    name: 'ops',
    description: 'Show available operations filtered to disclosure tier',
  },
  args: {
    tier: {
      type: 'string',
      description: 'Disclosure tier: 0=basic (default), 1=+memory/check, 2=all',
      alias: 't',
      default: '0',
    },
  },
  async run({ args }) {
    const tier = Number.parseInt(args.tier, 10);
    await dispatchFromCli('query', 'admin', 'help', { tier }, { command: 'ops' });
  },
});
