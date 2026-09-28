/**
 * `cleo doctor twin-collapse` — report, and with `--retry` re-run, the twin
 * collapses that keep `tasks_schema_meta` and `brain_sticky_tags` in step
 * with their bare legacy tables (T12535).
 *
 * The collapse runs inside every open of the project store. When it fails
 * (no space for its snapshot, an unusable `.cleo/backups/sqlite`, a merge
 * error), reads keep working and every mutating command is refused with
 * `E_TWIN_COLLAPSE_FAILED`. This command reads the store without binding a
 * domain: it names the cause, the snapshot path and the space needed, and
 * `--retry` runs the collapse once after the cause is cleared. The restore path is documented in
 * `packages/core/src/doctor/twin-collapse.ts`.
 *
 * @task T12535
 */

import {
  inspectProjectTwinCollapse,
  retryTwinCollapse,
} from '@cleocode/core/doctor/twin-collapse.js';
import { CleoError } from '@cleocode/core/errors';
import { getProjectRoot } from '@cleocode/core/paths.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliError, cliOutput } from '../renderers/index.js';

/**
 * `cleo doctor twin-collapse` subcommand. Exits non-zero when a collapse
 * failed or a pending one cannot write its snapshot.
 *
 * @task T12535
 */
export const doctorTwinCollapseCommand = defineCommand({
  meta: {
    name: 'twin-collapse',
    description:
      'Report the twin collapses (bare schema_meta / sticky_tags kept in step with their prefixed ' +
      'twins): state, last failure, snapshot path and space needed. --retry re-runs them.',
  },
  args: {
    retry: {
      type: 'boolean',
      description: 'Run the collapse once now (after clearing the reported cause)',
    },
    json: { type: 'boolean', description: 'Output as JSON' },
    human: { type: 'boolean', description: 'Force human-readable output' },
    quiet: { type: 'boolean', description: 'Suppress non-essential output' },
  },
  async run({ args }) {
    const projectRoot = getProjectRoot();
    if (args.retry === true) {
      try {
        const receipts = await retryTwinCollapse(projectRoot);
        cliOutput(
          { kind: 'generic', receipts },
          { command: 'doctor', operation: 'doctor.twin-collapse.retry' },
        );
      } catch (error) {
        if (!(error instanceof CleoError)) throw error;
        cliError(error.message, 'E_TWIN_COLLAPSE_FAILED', {
          name: 'CleoError',
          fix: error.fix,
          details: error.details,
        });
        process.exitCode = error.code;
      }
      return;
    }
    const report = inspectProjectTwinCollapse(projectRoot);
    cliOutput(report, { command: 'doctor', operation: 'doctor.twin-collapse.run' });
    const failed = report.pairs.some((p) => p.state === 'failed') || report.preflight?.ok === false;
    if (failed && (process.exitCode === undefined || process.exitCode === 0)) {
      process.exitCode = 1;
    }
  },
});
