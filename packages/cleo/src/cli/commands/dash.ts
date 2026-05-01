/**
 * CLI command: cleo dash — project health dashboard.
 *
 * Dispatches to `admin.dash` to show status summary, phase progress,
 * recent activity, and high-priority tasks. Use at session start for an
 * overall project overview.
 *
 * T1636: adds a hygiene section note after the main dashboard output,
 * pointing users to `cleo memory digest --hygiene` for the latest
 * sentient background hygiene scan results.
 *
 * @task T4535 T1636
 * @epic T4454
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * Project health dashboard command.
 *
 * Shows status summary, phase progress, recent activity, and high-priority
 * tasks. Use for overall project status.
 *
 * After the main dashboard, prints a hygiene section note linking to the
 * sentient background loop hygiene digest (T1636).
 */
export const dashCommand = defineCommand({
  meta: {
    name: 'dash',
    description:
      'Project health dashboard: status summary, phase progress, recent activity, high priority tasks. Use for overall project status.',
  },
  args: {
    'blocked-limit': {
      type: 'string',
      description: 'Max blocked tasks to show',
    },
    'no-hygiene': {
      type: 'boolean',
      description: 'Suppress the hygiene section note',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'admin',
      'dash',
      {
        blockedTasksLimit:
          args['blocked-limit'] !== undefined
            ? Number.parseInt(args['blocked-limit'], 10)
            : undefined,
      },
      { command: 'dash' },
    );

    // T1636: hygiene section note — always shown unless suppressed.
    // Keeps the main dashboard output unchanged; the note is informational only.
    if (!args['no-hygiene']) {
      process.stdout.write(
        '\n--- Sentient Hygiene (T1636) ---\n' +
          'Background scan runs every 4h (dream cycle). ' +
          'Run `cleo memory digest --hygiene` to see the latest hygiene observations ' +
          '(orphan tasks, top-level tasks without an epic, content defects, premature-close leaks).\n',
      );
    }
  },
});
