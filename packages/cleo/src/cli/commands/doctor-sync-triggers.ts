/**
 * `cleo doctor sync-triggers` — the project store's trigger health, with an
 * on-demand repair (journal spec §2.3a rule 9; T12754).
 *
 * Read-only by default: the same `sync_triggers` row the full `cleo doctor`
 * report shows, including triggers that reference a missing table or column.
 * `--repair` runs the open pass's trigger steps now (recreate
 * `cleo_trigger_suspend`, re-run the owned DDL, make the capture triggers
 * match `sync.capture`) and reports the row before and after. A trigger CLEO
 * does not own is reported, never dropped.
 *
 * @task T12754
 */

import {
  repairSyncTriggers,
  syncTriggersDoctorCheck,
} from '@cleocode/core/doctor/sync-triggers.js';
import { getProjectRoot } from '@cleocode/core/paths.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliOutput } from '../renderers/index.js';

/**
 * `cleo doctor sync-triggers` subcommand. Exits non-zero while the row is an
 * error (after the repair, when `--repair` is given).
 *
 * @task T12754
 */
export const doctorSyncTriggersCommand = defineCommand({
  meta: {
    name: 'sync-triggers',
    description:
      "Check the project store's triggers: the suspension table, owned guard triggers, capture " +
      'triggers and triggers that reference a missing table or column. --repair fixes what CLEO owns.',
  },
  args: {
    repair: {
      type: 'boolean',
      description:
        'Recreate cleo_trigger_suspend, re-run the owned DDL of every differing trigger and make ' +
        'the capture triggers match sync.capture; reports the row before and after. Opens the ' +
        'store like any cleo command, so pending migrations are applied',
    },
    json: { type: 'boolean', description: 'Output as JSON' },
    human: { type: 'boolean', description: 'Force human-readable output' },
    quiet: { type: 'boolean', description: 'Suppress non-essential output' },
  },
  async run({ args }) {
    const projectRoot = getProjectRoot();
    if (args.repair === true) {
      const result = await repairSyncTriggers(projectRoot);
      cliOutput(result, { command: 'doctor', operation: 'doctor.sync-triggers.run' });
      if (result.after.status === 'error') process.exitCode = 1;
      return;
    }
    const check = syncTriggersDoctorCheck(projectRoot);
    cliOutput(check, { command: 'doctor', operation: 'doctor.sync-triggers.run' });
    if (check.status === 'error') process.exitCode = 1;
  },
});
