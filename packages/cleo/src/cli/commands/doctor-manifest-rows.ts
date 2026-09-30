/**
 * `cleo doctor manifest-rows` — list, repair and roll back stored manifest
 * rows whose metadata violates the stored field contract (T12686).
 *
 * One such row (`T1171-w2a-10-audit`: `actionable` stored as an array) made
 * every strict manifest read fail. `orchestrate roll-up` now skips and names
 * it; this command fixes it. `--repair` plans the fix and writes nothing;
 * `--repair --apply` (or `--apply`) moves each offending field under
 * `_malformed` (an unparseable document is kept whole as `_malformed_raw`),
 * so nothing is lost, and writes a receipt first. `--rollback <receipt>`
 * restores the old bytes of every row not changed since. `--dry-run` is kept
 * as an alias for the plan: it overrides `--apply`, as in `cleo doctor
 * projects`.
 *
 * The read-only listing also reports `identity`: rows whose entry id, linked
 * task ids or file reference append now rejects, and linked task ids with no
 * task (T12829). These are reported, never rewritten.
 *
 * @task T12686
 * @task T12829
 */

import {
  listMalformedManifestRows,
  listManifestIdentityProblems,
  MANIFEST_ROW_APPLY_COMMAND,
  MANIFEST_ROW_REPAIR_COMMAND,
  repairMalformedManifestRows,
  rollbackManifestRepair,
} from '@cleocode/core/memory/pipeline-manifest-sqlite.js';
import { getProjectRoot } from '@cleocode/core/paths.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliOutput } from '../renderers/index.js';

/**
 * `cleo doctor manifest-rows` subcommand. Read-only unless `--apply` or
 * `--rollback`; exits non-zero while malformed rows remain unrepaired.
 *
 * @task T12686
 */
export const doctorManifestRowsCommand = defineCommand({
  meta: {
    name: 'manifest-rows',
    description:
      'List manifest rows whose metadata violates the stored field contract, and (read-only) rows with an invalid id, linked task id or file reference. --repair shows the plan (writes nothing); --repair --apply moves each bad field under _malformed (nothing lost) with a receipt; --rollback <receipt> undoes it.',
  },
  args: {
    repair: {
      type: 'boolean',
      description: 'Plan the repair of every malformed row; writes nothing',
    },
    apply: {
      type: 'boolean',
      description: 'Write the repair (writes a receipt first); implies --repair',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Plan only (the default for --repair); overrides --apply',
    },
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
    if (args.repair === true || args.apply === true) {
      const apply = args.apply === true && args['dry-run'] !== true;
      const receipt = await repairMalformedManifestRows(projectRoot, { dryRun: !apply });
      cliOutput(
        apply
          ? receipt
          : { ...receipt, apply: receipt.changes.length > 0 ? MANIFEST_ROW_APPLY_COMMAND : null },
        {
          command: 'doctor',
          operation: apply ? 'doctor.manifest-rows.apply' : 'doctor.manifest-rows.plan',
        },
      );
      return;
    }
    const rows = await listMalformedManifestRows(projectRoot);
    const identity = await listManifestIdentityProblems(projectRoot);
    cliOutput(
      { rows, repair: rows.length > 0 ? MANIFEST_ROW_REPAIR_COMMAND : null, identity },
      { command: 'doctor', operation: 'doctor.manifest-rows.run' },
    );
    // A malformed or unsafe identity fails the check; a missing linked task alone is a warning.
    const invalidIdentity = identity.some((r) => r.issues.some((i) => i.code === 'E_VALIDATION'));
    if (
      (rows.length > 0 || invalidIdentity) &&
      (process.exitCode === undefined || process.exitCode === 0)
    ) {
      process.exitCode = 1;
    }
  },
});
