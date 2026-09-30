/**
 * `cleo doctor ac-bindings` — evidence bindings whose acceptance criterion is gone.
 *
 * `tasks_evidence_ac_bindings.ac_id` carries no foreign key, so ACs removed
 * before T12790 left their bindings behind. Read-only unless `--fix` is
 * given; `--fix` removes them through the task accessor, recording each
 * removed row in the task audit log first.
 *
 * @task T12790
 */

import { ExitCode } from '@cleocode/contracts';
import { scanOrphanAcBindings } from '@cleocode/core/doctor/orphan-ac-bindings.js';
import { getProjectRoot } from '@cleocode/core/paths.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliError, cliOutput } from '../renderers/index.js';

/**
 * `cleo doctor ac-bindings` subcommand.
 *
 * Exits non-zero while orphan bindings remain, so it can gate a cleanup step.
 * After a successful `--fix` the rows are gone and the exit code is 0.
 *
 * @task T12790
 */
export const doctorAcBindingsCommand = defineCommand({
  meta: {
    name: 'ac-bindings',
    description:
      'Report evidence bindings whose acceptance criterion no longer exists (dangling ' +
      'tasks_evidence_ac_bindings rows). Read-only unless --fix is given; --fix removes them, ' +
      'recording each removed row in the task audit log (ac.bindings.pruned).',
  },
  args: {
    fix: {
      type: 'boolean',
      description:
        'Delete the orphan bindings in one transaction, after writing each row to the task ' +
        'audit log so binding history (alias-drift detection) is kept.',
    },
    limit: {
      type: 'string',
      description: 'Maximum orphan rows echoed in the report (default 50; counts are exact)',
    },
    json: { type: 'boolean', description: 'Output as JSON' },
    human: { type: 'boolean', description: 'Force human-readable output' },
    quiet: { type: 'boolean', description: 'Suppress non-essential output' },
  },
  async run({ args }) {
    let limit: number | undefined;
    if (typeof args.limit === 'string') {
      if (!/^\d+$/.test(args.limit.trim())) {
        cliError(
          `--limit must be a non-negative integer (got '${args.limit}')`,
          ExitCode.VALIDATION_ERROR,
          { name: 'E_VALIDATION' },
        );
        return;
      }
      limit = Number.parseInt(args.limit, 10);
    }
    const report = await scanOrphanAcBindings(getProjectRoot(), {
      fix: args.fix === true,
      limit,
    });

    cliOutput(report, {
      command: 'doctor',
      operation: 'doctor.ac-bindings.run',
    });

    const unresolved = report.orphanCount > report.removed;
    if (unresolved && (process.exitCode === undefined || process.exitCode === 0)) {
      process.exitCode = 1;
    }
  },
});
