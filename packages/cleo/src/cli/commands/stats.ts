/**
 * CLI stats command — project statistics.
 *
 * Exposes project-wide stats and workflow compliance reporting:
 *
 *   cleo stats             — counts, completion rates, velocity
 *   cleo stats compliance  — agent workflow compliance dashboard (WF-001 through WF-005)
 *
 * @task T4535
 * @epic T4454
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import { isSubCommandDispatch } from '../lib/subcommand-guard.js';

/** cleo stats compliance — agent workflow compliance dashboard */
const complianceCommand = defineCommand({
  meta: {
    name: 'compliance',
    description: 'Agent workflow compliance dashboard (WF-001 through WF-005)',
  },
  args: {
    since: {
      type: 'string',
      description: 'Filter to tasks/events from this date (ISO 8601)',
    },
    json: {
      type: 'boolean',
      description: 'Output raw JSON instead of formatted dashboard',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'check',
      'workflow.compliance',
      {
        since: args.since,
        json: args.json,
      },
      { command: 'stats compliance', operation: 'check.workflow.compliance' },
    );
  },
});

/**
 * Root stats command — project statistics (counts, completion rates, velocity).
 *
 * Dispatches to `admin.stats` registry operation.
 */
export const statsCommand = defineCommand({
  meta: { name: 'stats', description: 'Project statistics (counts, completion rates, velocity)' },
  args: {
    period: {
      type: 'string',
      description: 'Analysis period: today/week/month/quarter/year or days',
      alias: 'p',
      default: '30',
    },
    verbose: {
      type: 'boolean',
      description: 'Show detailed breakdowns per category',
      alias: 'v',
    },
  },
  subCommands: {
    compliance: complianceCommand,
  },
  async run({ args, cmd, rawArgs }) {
    // Parent run() fires after subcommand per citty@0.2.x — skip default
    // stats so `cleo stats compliance` doesn't double-output. T1187-followup.
    if (isSubCommandDispatch(rawArgs, cmd.subCommands)) return;
    await dispatchFromCli(
      'query',
      'admin',
      'stats',
      {
        period: args.period ?? 30,
      },
      { command: 'stats', operation: 'admin.stats' },
    );
  },
});
