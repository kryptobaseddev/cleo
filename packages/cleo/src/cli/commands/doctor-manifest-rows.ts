/**
 * `cleo doctor manifest-rows` — list, repair and roll back stored manifest
 * rows whose metadata violates the stored field contract (T12686).
 *
 * One such row (`T1171-w2a-10-audit`: `actionable` stored as an array) made
 * every strict manifest read fail. `orchestrate roll-up` now skips and names
 * it; this command fixes it. `--repair` moves each offending field under
 * `_malformed` (an unparseable document is kept whole as `_malformed_raw`),
 * so nothing is lost, and writes a receipt first; `--rollback <receipt>`
 * restores the old bytes of every row not changed since.
 *
 * @task T12686
 */

import {
  listMalformedManifestRows,
  MANIFEST_ROW_REPAIR_COMMAND,
  repairMalformedManifestRows,
  rollbackManifestRepair,
} from '@cleocode/core/memory/pipeline-manifest-sqlite.js';
import { getProjectRoot } from '@cleocode/core/paths.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliOutput } from '../renderers/index.js';

/**
 * `cleo doctor manifest-rows` subcommand. Read-only unless `--repair` or
 * `--rollback`; exits non-zero while malformed rows remain unrepaired.
 *
 * @task T12686
 */
export const doctorManifestRowsCommand = defineCommand({
  meta: {
    name: 'manifest-rows',
    description:
      'List manifest rows whose metadata violates the stored field contract. --repair moves each ' +
      'bad field under _malformed (nothing lost) with a receipt; --rollback <receipt> undoes it.',
  },
  args: {
    repair: { type: 'boolean', description: 'Repair every malformed row (writes a receipt first)' },
    'dry-run': { type: 'boolean', description: 'With --repair: show the plan, write nothing' },
    rollback: { type: 'string', description: 'Undo a repair from its receipt file' },
    json: { type: 'boolean', description: 'Output as JSON' },
    human: { type: 'boolean', description: 'Force human-readable output' },
    quiet: { type: 'boolean', description: 'Suppress non-essential output' },
  },
  async run({ args }) {
    const projectRoot = getProjectRoot();
    if (typeof args.rollback === 'string' && args.rollback !== '') {
      const result = await rollbackManifestRepair(args.rollback, projectRoot);
      cliOutput(result, { command: 'doctor', operation: 'doctor.manifest-rows.rollback' });
      return;
    }
    if (args.repair === true) {
      const receipt = await repairMalformedManifestRows(projectRoot, {
        dryRun: args['dry-run'] === true,
      });
      cliOutput(receipt, { command: 'doctor', operation: 'doctor.manifest-rows.repair' });
      return;
    }
    const rows = await listMalformedManifestRows(projectRoot);
    cliOutput(
      { rows, repair: rows.length > 0 ? MANIFEST_ROW_REPAIR_COMMAND : null },
      { command: 'doctor', operation: 'doctor.manifest-rows.run' },
    );
    if (rows.length > 0 && (process.exitCode === undefined || process.exitCode === 0)) {
      process.exitCode = 1;
    }
  },
});
