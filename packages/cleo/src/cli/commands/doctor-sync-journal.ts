/**
 * `cleo doctor sync-journal` — the repair diff of the project store's suspect tables
 * (journal spec §4.4; S3d, T12987).
 *
 * Read-only by default: plans each suspect table's repair (the I, U and D
 * ops it would emit) and writes nothing. `--repair` seals pending captures,
 * emits the repair ops in a `repair` frame per table, seals them, verifies
 * the table (a clean rescan, the ledger equal to the count) and clears its
 * suspect key.
 *
 * @task T12987
 */

import { runSyncRepair } from '@cleocode/core/doctor/sync-repair.js';
import { getProjectRoot } from '@cleocode/core/paths.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliOutput } from '../renderers/index.js';

/**
 * `cleo doctor sync-journal` subcommand. Exits non-zero when the repair was refused
 * or a table stays suspect after `--repair`.
 *
 * @task T12987
 */
export const doctorSyncJournalCommand = defineCommand({
  meta: {
    name: 'sync-journal',
    description:
      "Plan the repair diff of the project store's suspect tables (rows written uncaptured). " +
      '--repair emits the repair ops, seals them, verifies each table and clears its suspect mark.',
  },
  args: {
    repair: {
      type: 'boolean',
      description:
        'Seal pending captures, emit I/U/D repair ops for every row of each suspect table in a ' +
        'repair frame, seal them, verify (clean rescan, ledger equals count) and clear the ' +
        'suspect mark. Opens the store like any cleo command, so pending migrations are applied',
    },
    json: { type: 'boolean', description: 'Output as JSON' },
    human: { type: 'boolean', description: 'Force human-readable output' },
    quiet: { type: 'boolean', description: 'Suppress non-essential output' },
  },
  async run({ args }) {
    const result = await runSyncRepair(getProjectRoot(), { repair: args.repair === true });
    cliOutput(result, { command: 'doctor', operation: 'doctor.sync-journal.run' });
    if (args.repair === true && (result.report.refused !== null || result.suspect.length > 0)) {
      process.exitCode = 1;
    }
  },
});
